/**
 * Drivrutinen `spool`: för en plattform som INTE får tala med Docker-daemonen.
 *
 * I drift kör plattformen i en container på ett internt nät utan Docker-socket (socketen vore
 * detsamma som root på värden). Bygget görs i stället av en separat, långlivad BYGGARBETARE i en
 * egen container: `network_mode: none`, skrivskyddat rotfilsystem, inga hemligheter, egna gränser
 * för minne och processer. De delar bara en katalog:
 *
 *   <jobb>/tmp/        halvfärdiga filer; blir synliga först genom `rename` (atomiskt)
 *   <jobb>/incoming/   <id>.json — jobb som väntar (plattformen lägger dit)
 *   <jobb>/running/    <id>.json — jobb som arbetaren tagit (flyttat hit med `rename`)
 *   <jobb>/done/<id>/  result.json + dist/ — arbetarens svar (hela katalogen flyttas dit med `rename`)
 *   <jobb>/cancel/<id> plattformen har gett upp jobbet (tidsgräns eller avbrott)
 *
 * Förtroendet går åt ETT håll: arbetaren bygger opålitlig kod och kan i värsta fall vara
 * komprometterad. Plattformen läser därför svaret som opålitlig data — tvättar diagnoserna,
 * följer inga länkar, kopierar resultatet till en egen katalog och granskar det själv.
 * Arbetaren kör i sin tur policykontrollen igen och litar inte på jobbfilens form.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildResult, BuildRunner, Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkBuiltBundle, checkSourceFiles } from '@vibesandbox/policy';
import { capDiagnostics } from './diagnostics.ts';
import { parseContainerReport } from './docker.ts';
import type { BuildLimits } from './limits.ts';
import { resolveLimits } from './limits.ts';
import { failedResult, succeededResult } from './local.ts';
import { copyTreeSafely, measureTree } from './output.ts';
import { buildInWorkspace, outputTooLargeDiagnostic, timeoutDiagnostic } from './pipeline.ts';
import { abortError, createSerialQueue } from './queue.ts';

const JOB_NAME = /^(\d{13}-[0-9a-f]{16})\.json$/;
const JOB_ID = /^\d{13}-[0-9a-f]{16}$/;
const MAX_JOB_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const DIRECTORIES = ['tmp', 'incoming', 'running', 'done', 'cancel'] as const;

interface Job {
  readonly version: 1;
  readonly id: string;
  /** Epokmillisekunder. Efter det väntar plattformen inte längre. */
  readonly deadline: number;
  readonly files: SourceFiles;
}

async function ensureDirectories(jobsDirectory: string): Promise<void> {
  for (const name of DIRECTORIES) await mkdir(path.join(jobsDirectory, name), { recursive: true, mode: 0o770 });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** Läser en vanlig fil (aldrig via länk) med ett tak. */
async function readBounded(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Filen är för stor eller inte en vanlig fil.');
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

// ── Plattformens sida ────────────────────────────────────────────────────────

export interface SpoolRunnerOptions {
  readonly jobsDirectory: string;
  /** Hur länge plattformen väntar på ett jobb, inklusive tid i arbetarens kö. */
  readonly timeoutMs: number;
  /** Tak för den byggda katalogen. Standard som `DEFAULT_LIMITS`. */
  readonly maxOutputBytes?: number;
  readonly pollIntervalMs?: number;
  /** Där plattformens egen kopia av resultatet hamnar. Standard: operativsystemets temp. */
  readonly tempDirectory?: string;
}

export function createSpoolBuildRunner(options: SpoolRunnerOptions): BuildRunner {
  const queue = createSerialQueue();
  const { jobsDirectory } = options;
  const maxOutputBytes = options.maxOutputBytes ?? resolveLimits(undefined).maxOutputBytes;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const tempDirectory = options.tempDirectory ?? tmpdir();

  /** Tar tillbaka ett jobb som arbetaren inte börjat på, annars ber den avbryta. */
  async function withdraw(id: string): Promise<void> {
    try {
      await rename(path.join(jobsDirectory, 'incoming', `${id}.json`), path.join(jobsDirectory, 'tmp', `${id}.tillbakadraget`));
      await rm(path.join(jobsDirectory, 'tmp', `${id}.tillbakadraget`), { force: true });
    } catch {
      await writeFile(path.join(jobsDirectory, 'cancel', id), '', { flag: 'w' }).catch(() => undefined);
      // Svaret kan ha hunnit komma precis nu; ingen kommer att hämta det.
      await rm(path.join(jobsDirectory, 'done', id), { recursive: true, force: true });
    }
  }

  async function collect(id: string, started: number): Promise<BuildResult> {
    const resultDirectory = path.join(jobsDirectory, 'done', id);
    try {
      let report: ReturnType<typeof parseContainerReport>;
      try {
        report = parseContainerReport(await readBounded(path.join(resultDirectory, 'result.json'), MAX_RESULT_BYTES));
      } catch {
        report = undefined;
      }
      if (report === undefined) {
        return failedResult([{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades oväntat. Försök igen; om felet består, förenkla appen.' }], started);
      }
      if (!report.ok) {
        return failedResult(report.diagnostics.length > 0 ? report.diagnostics : [{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades.' }], started);
      }
      const produced = path.join(resultDirectory, 'dist');
      const info = await lstat(produced).catch(() => undefined);
      const size = info?.isDirectory() === true ? await measureTree(produced) : undefined;
      if (size === undefined || size.rejected.length > 0) {
        return failedResult([{ source: 'build', rule: 'output-invalid', message: 'Bygget gav något annat än vanliga filer. Det är inte tillåtet.' }], started);
      }
      if (size.bytes > maxOutputBytes) return failedResult([outputTooLargeDiagnostic(size.bytes, maxOutputBytes)], started);

      const owned = await mkdtemp(path.join(tempDirectory, 'vibesandbox-app-'));
      const outputDirectory = path.join(owned, 'dist');
      try {
        await copyTreeSafely(produced, outputDirectory, maxOutputBytes);
        const bundle = await checkBuiltBundle(outputDirectory);
        if (bundle.length > 0) {
          await rm(owned, { recursive: true, force: true });
          return failedResult(capDiagnostics(bundle), started);
        }
      } catch {
        await rm(owned, { recursive: true, force: true });
        return failedResult([{ source: 'build', rule: 'output-invalid', message: 'Bygget gav något annat än vanliga filer. Det är inte tillåtet.' }], started);
      }
      return succeededResult(outputDirectory, owned, started);
    } finally {
      await rm(resultDirectory, { recursive: true, force: true });
    }
  }

  async function buildOnce(files: SourceFiles, signal?: AbortSignal): Promise<BuildResult> {
    const started = performance.now();
    const policy = checkSourceFiles(files);
    if (policy.length > 0) return failedResult(policy, started);

    await ensureDirectories(jobsDirectory);
    // Tidsstämpeln först i namnet ger arbetaren FIFO-ordning genom att bara sortera namnen.
    const id = `${String(Date.now()).padStart(13, '0')}-${randomBytes(8).toString('hex')}`;
    const job: Job = { version: 1, id, deadline: Date.now() + options.timeoutMs, files };
    const staging = path.join(jobsDirectory, 'tmp', `${id}.json`);
    await writeFile(staging, JSON.stringify(job), { flag: 'wx', mode: 0o660 });
    await rename(staging, path.join(jobsDirectory, 'incoming', `${id}.json`));

    const deadline = performance.now() + options.timeoutMs;
    for (;;) {
      if (signal?.aborted === true) {
        await withdraw(id);
        throw abortError(signal);
      }
      if (await exists(path.join(jobsDirectory, 'done', id))) return collect(id, started);
      if (performance.now() >= deadline) {
        await withdraw(id);
        return failedResult([timeoutDiagnostic(options.timeoutMs)], started);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - performance.now())), signal);
    }
  }

  return {
    build: (files, buildOptions) => queue.run((signal) => buildOnce(files, signal), buildOptions?.signal),
  };
}

// ── Byggarbetarens sida ──────────────────────────────────────────────────────

export interface SpoolWorkerOptions {
  readonly jobsDirectory: string;
  readonly templateDirectory: string;
  /** Avbruten ⇒ pågående bygge avbryts och funktionen återvänder. */
  readonly signal: AbortSignal;
  readonly limits?: Partial<BuildLimits>;
  readonly pollIntervalMs?: number;
  /** Resultat, halvfärdiga filer och övergivna jobb äldre än så tas bort. Standard 10 minuter. */
  readonly maxJobAgeMs?: number;
  /** Arbetskataloger. Standard: operativsystemets temp (i containern en tmpfs). */
  readonly tempDirectory?: string;
}

function parseJob(text: string, expectedId: string): Job | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { version, id, deadline, files } = parsed as Record<string, unknown>;
  if (version !== 1 || id !== expectedId || typeof deadline !== 'number' || typeof files !== 'object' || files === null || Array.isArray(files)) return undefined;
  const clean: Record<string, string> = {};
  for (const [file, content] of Object.entries(files)) {
    if (typeof content !== 'string') return undefined;
    clean[file] = content;
  }
  return { version: 1, id: expectedId, deadline, files: clean };
}

/**
 * Byggarbetaren: tar ett jobb i taget ur `incoming/`, bygger det med samma pipeline som `local`
 * och lämnar svaret i `done/<id>/`. Får köras med NODE_ENV=production — den ÄR sandlådan;
 * spärren i `local` gäller när bygget skulle ske inne i plattformsprocessen.
 */
export async function runSpoolWorker(options: SpoolWorkerOptions): Promise<void> {
  const { jobsDirectory, signal } = options;
  const limits = resolveLimits(options.limits);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxJobAgeMs = options.maxJobAgeMs ?? 10 * 60_000;
  const tempDirectory = options.tempDirectory ?? tmpdir();
  const dir = (name: (typeof DIRECTORIES)[number], entry = ''): string => path.join(jobsDirectory, name, entry);

  await ensureDirectories(jobsDirectory);
  // Jobb som låg i running/ när arbetaren startade har ingen ägare längre (arbetaren dog mitt i).
  for (const entry of await readdir(dir('running'))) await rm(dir('running', entry), { recursive: true, force: true });

  let lastCleanup = 0;
  async function cleanup(): Promise<void> {
    lastCleanup = Date.now();
    const cutoff = Date.now() - maxJobAgeMs;
    for (const name of ['done', 'tmp', 'cancel', 'incoming'] as const) {
      for (const entry of await readdir(dir(name)).catch(() => [] as string[])) {
        const info = await lstat(dir(name, entry)).catch(() => undefined);
        if (info === undefined) continue;
        const invalid = name === 'incoming' && !JOB_NAME.test(entry);
        if (invalid || info.mtimeMs < cutoff) await rm(dir(name, entry), { recursive: true, force: true });
      }
    }
  }

  async function publish(id: string, report: { ok: boolean; diagnostics: readonly Diagnostic[] }, distDirectory?: string): Promise<void> {
    if (await exists(dir('cancel', id))) return;
    const staging = dir('tmp', `${id}.svar-${randomBytes(4).toString('hex')}`);
    await mkdir(staging);
    try {
      await writeFile(path.join(staging, 'result.json'), JSON.stringify({ ok: report.ok, diagnostics: capDiagnostics(report.diagnostics) }), { flag: 'wx' });
      if (distDirectory !== undefined) await copyTreeSafely(distDirectory, path.join(staging, 'dist'), limits.maxOutputBytes);
      await rename(staging, dir('done', id));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function handle(id: string): Promise<void> {
    const claimed = dir('running', `${id}.json`);
    let job: Job | undefined;
    try {
      job = parseJob(await readBounded(claimed, MAX_JOB_BYTES), id);
    } catch {
      job = undefined;
    }
    if (job === undefined) {
      await publish(id, { ok: false, diagnostics: [{ source: 'build', rule: 'build-failed', message: 'Byggjobbet gick inte att läsa.' }] });
      return;
    }
    if (job.deadline <= Date.now() || (await exists(dir('cancel', id)))) return;

    const policy = checkSourceFiles(job.files);
    if (policy.length > 0) {
      await publish(id, { ok: false, diagnostics: policy });
      return;
    }

    // Avbryts om arbetaren stängs eller om plattformen ger upp jobbet.
    const controller = new AbortController();
    const onStop = (): void => controller.abort(abortError(signal));
    signal.addEventListener('abort', onStop, { once: true });
    const watcher = setInterval(() => {
      void exists(dir('cancel', id)).then((cancelled) => {
        if (cancelled) controller.abort(new DOMException('Plattformen gav upp jobbet', 'AbortError'));
      });
    }, Math.max(50, pollIntervalMs));

    const baseDir = await mkdtemp(path.join(tempDirectory, 'vibesandbox-arbetare-'));
    try {
      const timeoutMs = Math.max(1, Math.min(limits.timeoutMs, job.deadline - Date.now()));
      const result = await buildInWorkspace({
        templateDirectory: options.templateDirectory,
        files: job.files,
        baseDir,
        limits: { ...limits, timeoutMs },
        signal: controller.signal,
      });
      await publish(id, { ok: result.distDirectory !== undefined, diagnostics: result.diagnostics }, result.distDirectory);
    } catch (error) {
      if (!controller.signal.aborted) {
        await publish(id, { ok: false, diagnostics: [{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades oväntat.' }] });
      }
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    } finally {
      clearInterval(watcher);
      signal.removeEventListener('abort', onStop);
      await rm(baseDir, { recursive: true, force: true });
    }
  }

  while (!signal.aborted) {
    if (Date.now() - lastCleanup > Math.min(maxJobAgeMs, 30_000)) await cleanup();

    const waiting = (await readdir(dir('incoming')).catch(() => [] as string[])).filter((entry) => JOB_NAME.test(entry)).sort();
    const next = waiting[0];
    if (next === undefined) {
      await sleep(pollIntervalMs, signal);
      continue;
    }
    const id = next.replace(/\.json$/, '');
    try {
      // Atomiskt anspråk: bara en arbetare lyckas flytta filen.
      await rename(dir('incoming', next), dir('running', next));
    } catch {
      continue;
    }
    try {
      if (JOB_ID.test(id)) await handle(id);
    } catch {
      // Ett trasigt jobb får inte stoppa arbetaren; nästa jobb väntar.
    } finally {
      // Stängs arbetaren mitt i ett jobb läggs jobbet tillbaka, så att nästa arbetare tar det.
      if (signal.aborted && !(await exists(dir('done', id)))) await rename(dir('running', next), dir('incoming', next)).catch(() => undefined);
      await rm(dir('running', next), { force: true });
      await rm(dir('cancel', id), { force: true });
    }
  }
}
