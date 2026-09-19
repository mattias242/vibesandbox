/**
 * Drivrutinen `docker`: varje bygge i en ENGÅNGSCONTAINER.
 *
 *   docker run --rm --name <slumpat> --network none --read-only
 *     --tmpfs /work:rw,size=…,mode=1777 --tmpfs /tmp:rw,size=…,mode=1777
 *     --cap-drop ALL --security-opt no-new-privileges --pids-limit … --memory …m --memory-swap …m
 *     --cpus … --user 10001:10001 [--runtime runsc] -v <in>:/in:ro -v <ut>:/out:rw <avbild>
 *
 * Inget nät (inget kan hämtas eller läcka), skrivskyddat rotfilsystem, inga rättigheter, egna
 * gränser för minne, CPU och processer, och inga hemligheter i miljön — bara gränserna. Värden
 * litar inte på containern: den läser resultatet som opålitlig data, mäter och kopierar /out
 * utan att följa länkar och kör checkBuiltBundle själv. Tidsgräns ⇒ `docker kill`.
 *
 * Kräver åtkomst till Docker-daemonen, vilket i praktiken är root på värden. Plattformen i drift
 * har därför INTE den åtkomsten; där används `spool` (se README).
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildResult, BuildRunner, Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkBuiltBundle, checkSourceFiles } from '@vibesandbox/policy';
import { capDiagnostics } from './diagnostics.ts';
import type { BuildLimits } from './limits.ts';
import { failedResult, succeededResult } from './local.ts';
import { copyTreeSafely, measureTree } from './output.ts';
import { memoryLimitDiagnostic, outputTooLargeDiagnostic, timeoutDiagnostic } from './pipeline.ts';
import { runProcess } from './process.ts';
import { createSerialQueue } from './queue.ts';

export interface DockerRunnerOptions {
  readonly templateDirectory: string;
  readonly limits: BuildLimits;
  readonly image: string;
  readonly runtime: 'runc' | 'runsc';
  readonly tempDirectory?: string;
  /** Docker-kommandot. Standard `docker`. */
  readonly dockerCommand?: string;
}

/** Tid för att starta containern utöver byggets egen tidsgräns. */
const STARTUP_GRACE_MS = 15_000;

/** Miljön för docker-KLIENTEN (inte containern): den behöver hitta daemonen och sin konfiguration. */
function dockerClientEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function dockerRunArguments(options: {
  readonly name: string;
  readonly image: string;
  readonly runtime: 'runc' | 'runsc';
  readonly limits: BuildLimits;
  readonly inDirectory: string;
  readonly outDirectory: string;
}): string[] {
  const { limits } = options;
  return [
    'run',
    '--rm',
    '--name',
    options.name,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    `/work:rw,size=${limits.workTmpfsMb}m,mode=1777`,
    '--tmpfs',
    `/tmp:rw,size=${limits.tmpTmpfsMb}m,mode=1777`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(limits.pidsLimit),
    '--memory',
    `${limits.memoryMb}m`,
    '--memory-swap',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--user',
    '10001:10001',
    ...(options.runtime === 'runsc' ? ['--runtime', 'runsc'] : []),
    // Bara gränserna — inga hemligheter, inget från värdens miljö.
    '--env',
    `BUILD_TIMEOUT_MS=${limits.timeoutMs}`,
    '--env',
    `BUILD_MEMORY_MB=${limits.memoryMb}`,
    '--env',
    `BUILD_MAX_OUTPUT_BYTES=${limits.maxOutputBytes}`,
    '--volume',
    `${options.inDirectory}:/in:ro`,
    '--volume',
    `${options.outDirectory}:/out:rw`,
    options.image,
  ];
}

const SOURCES = new Set(['policy', 'typecheck', 'build']);

/** Containerns rapport är opålitlig data: bara väntade fält, i väntad form, trimmade. */
export function parseContainerReport(stdout: string): { ok: boolean; diagnostics: Diagnostic[] } | undefined {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { ok, diagnostics } = parsed as { ok?: unknown; diagnostics?: unknown };
  if (typeof ok !== 'boolean' || !Array.isArray(diagnostics)) return undefined;
  const clean: Diagnostic[] = [];
  for (const item of diagnostics.slice(0, 50)) {
    if (typeof item !== 'object' || item === null) continue;
    const { source, rule, file, line: at, message } = item as Record<string, unknown>;
    if (typeof source !== 'string' || !SOURCES.has(source) || typeof message !== 'string') continue;
    clean.push({
      source: source as Diagnostic['source'],
      ...(typeof rule === 'string' && /^[a-z-]{1,40}$/.test(rule) ? { rule } : {}),
      ...(typeof file === 'string' && /^src\/[A-Za-z0-9_/.-]{1,200}$/.test(file) ? { file } : {}),
      ...(typeof at === 'number' && Number.isInteger(at) && at > 0 ? { line: at } : {}),
      message: message.slice(0, 1000),
    });
  }
  return { ok, diagnostics: clean };
}

async function writeSources(inDirectory: string, files: SourceFiles): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const destination = path.join(inDirectory, file);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, content, { flag: 'wx', mode: 0o644 });
  }
  // mkdir med recursive tar hänsyn till umask; se till att containerns användare kan läsa.
  await chmod(path.join(inDirectory, 'src'), 0o755);
}

export function createDockerBuildRunner(options: DockerRunnerOptions): BuildRunner {
  const queue = createSerialQueue();
  const tempDirectory = options.tempDirectory ?? tmpdir();
  const docker = options.dockerCommand ?? 'docker';
  const { limits } = options;

  async function kill(name: string): Promise<void> {
    await runProcess({ command: docker, args: ['kill', name], cwd: tempDirectory, env: dockerClientEnvironment(), timeoutMs: 15_000 }).catch(() => undefined);
  }

  async function buildOnce(files: SourceFiles, signal?: AbortSignal): Promise<BuildResult> {
    const started = performance.now();
    const policy = checkSourceFiles(files);
    if (policy.length > 0) return failedResult(policy, started);

    // mkdtemp ger 0700: ingen annan användare på värden når in, fast in/ut själva är öppna
    // för containerns uid 10001.
    const baseDir = await mkdtemp(path.join(tempDirectory, 'vibesandbox-docker-'));
    try {
      const inDirectory = path.join(baseDir, 'in');
      const outDirectory = path.join(baseDir, 'ut');
      await mkdir(path.join(inDirectory, 'src'), { recursive: true });
      await chmod(inDirectory, 0o755);
      await writeSources(inDirectory, files);
      await mkdir(outDirectory);
      await chmod(outDirectory, 0o777);

      const name = `vibesandbox-bygge-${randomBytes(8).toString('hex')}`;
      let run;
      try {
        run = await runProcess({
          command: docker,
          args: dockerRunArguments({ name, image: options.image, runtime: options.runtime, limits, inDirectory, outDirectory }),
          cwd: baseDir,
          env: dockerClientEnvironment(),
          timeoutMs: limits.timeoutMs + STARTUP_GRACE_MS,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        await kill(name);
        throw error;
      }
      if (run.timedOut) {
        await kill(name);
        return failedResult([timeoutDiagnostic(limits.timeoutMs)], started);
      }

      const report = parseContainerReport(run.stdout);
      // 137 = dödad med SIGKILL: minnesgränsen (OOM), eller processgränsen.
      if (run.exitCode === 137) return failedResult([memoryLimitDiagnostic(limits.memoryMb)], started);
      if (report === undefined) {
        return failedResult([{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades oväntat. Försök igen; om felet består, förenkla appen.' }], started);
      }
      if (!report.ok || run.exitCode !== 0) {
        return failedResult(report.diagnostics.length > 0 ? report.diagnostics : [{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades.' }], started);
      }

      // Värden granskar själv det containern lämnade.
      const produced = path.join(outDirectory, 'dist');
      const size = await measureTree(produced);
      if (size.rejected.length > 0) {
        return failedResult([{ source: 'build', rule: 'output-invalid', message: 'Bygget gav något annat än vanliga filer. Det är inte tillåtet.' }], started);
      }
      if (size.bytes > limits.maxOutputBytes) return failedResult([outputTooLargeDiagnostic(size.bytes, limits.maxOutputBytes)], started);

      const owned = await mkdtemp(path.join(tempDirectory, 'vibesandbox-app-'));
      const outputDirectory = path.join(owned, 'dist');
      try {
        await copyTreeSafely(produced, outputDirectory, limits.maxOutputBytes);
        const bundle = await checkBuiltBundle(outputDirectory);
        if (bundle.length > 0) {
          await rm(owned, { recursive: true, force: true });
          return failedResult(capDiagnostics(bundle), started);
        }
      } catch (error) {
        await rm(owned, { recursive: true, force: true });
        throw error;
      }
      return succeededResult(outputDirectory, owned, started);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  }

  return {
    build: (files, buildOptions) => queue.run((signal) => buildOnce(files, signal), buildOptions?.signal),
  };
}
