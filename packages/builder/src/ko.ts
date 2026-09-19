/**
 * Jobbkön: EN tur åt gången för hela plattformen (VPS XS — agenten och bygget är det tunga), i den
 * ordning önskemålen kom.
 *
 * Kön lever i minnet; databasen är facit för varje jobbs status. Vid start finns därför inga köade
 * jobb att återuppta — allt som var `queued` eller `running` när processen dog markeras `failed`
 * med en förklaring (se `failInterruptedJobs`). Hellre ett tydligt "försök igen" än ett jobb som
 * körs en gång till utan att någon väntar på det.
 */
import type { AgentEvent, AgentTurnResult, BuildResult, SourceFiles, Agent } from '@vibesandbox/contracts';
import { storedAppId } from './control.ts';
import type { BuilderControl } from './control.ts';
import type { JobOutcome, Storage } from './lagring.ts';
import { appIdPrefix, describeError } from './logg.ts';
import type { BuilderLogger } from './logg.ts';

export const RESTART_MESSAGE = 'Plattformen startades om under arbetet — försök igen.';
const TIMEOUT_MESSAGE = 'Arbetet tog för lång tid och avbröts. Försök igen, gärna med ett kortare önskemål.';
const UNEXPECTED_MESSAGE = 'Något gick fel hos plattformen medan appen byggdes. Försök igen om en stund.';
const SAVE_FAILED_MESSAGE = 'Appen byggdes, men plattformen kunde inte spara den som utkast. Försök igen.';
const NO_SUMMARY_MESSAGE = 'Det gick inte att bygga appen den här gången. Försök igen, gärna med andra ord.';

/** Längsta sammanfattning från agenten som sparas i samtalet. */
const MAX_SUMMARY_CHARS = 8000;
const MAX_EVENT_TEXT = 1000;
const MAX_EVENT_PATHS = 100;
const MAX_EVENT_PATH_CHARS = 200;

/** Standard för hur länge en tur får pågå innan kön går vidare. */
export const DEFAULT_JOB_TIMEOUT_MS = 20 * 60 * 1000;
/** Så länge `close` väntar på en pågående tur efter att ha bett den avbryta. */
const CLOSE_GRACE_MS = 10_000;

export interface JobRunnerOptions {
  readonly storage: Storage;
  readonly control: BuilderControl;
  readonly agent: Agent;
  readonly starterFiles: SourceFiles;
  readonly log: BuilderLogger;
  readonly now: () => Date;
  readonly jobTimeoutMs: number;
}

export interface JobRunner {
  enqueue(jobId: string): void;
  close(): Promise<void>;
}

class JobTimeout extends Error {
  constructor() {
    super('Jobbet tog för lång tid.');
    this.name = 'JobTimeout';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Agentens händelser visas för användaren och sparas. Bara kontraktets fält kopieras, med kapade
 * texter — en agent (eller en modell som styr dess texter) ska inte kunna fylla databasen eller
 * smyga med fält som gränssnittet sedan råkar visa.
 */
export function sanitizeEvent(event: unknown): AgentEvent | null {
  if (event === null || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' ? truncate(value, MAX_EVENT_TEXT) : null);
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  switch (e['type']) {
    case 'status': {
      const message = text(e['message']);
      return message === null ? null : { type: 'status', message };
    }
    case 'progress': {
      const outputChars = count(e['outputChars']);
      return outputChars === null ? null : { type: 'progress', outputChars };
    }
    case 'files': {
      const paths = e['paths'];
      if (!Array.isArray(paths)) return null;
      return {
        type: 'files',
        paths: paths
          .filter((path): path is string => typeof path === 'string')
          .slice(0, MAX_EVENT_PATHS)
          .map((path) => truncate(path, MAX_EVENT_PATH_CHARS)),
      };
    }
    case 'check': {
      const problems = count(e['problems']);
      if (typeof e['ok'] !== 'boolean' || problems === null) return null;
      return { type: 'check', ok: e['ok'], problems };
    }
    case 'done': {
      const message = text(e['message']);
      if (typeof e['ok'] !== 'boolean' || message === null) return null;
      return { type: 'done', ok: e['ok'], message };
    }
    default:
      return null;
  }
}

async function disposeQuietly(build: BuildResult | undefined, log: BuilderLogger): Promise<void> {
  if (build === undefined) return;
  try {
    await build.dispose();
  } catch (error) {
    log({ level: 'warn', event: 'internal_error', reason: 'dispose_failed', ...describeError(error) });
  }
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { storage, control, agent, starterFiles, log } = options;
  const iso = (): string => options.now().toISOString();

  const queue: string[] = [];
  let current: Promise<void> | null = null;
  let currentAbort: AbortController | null = null;
  let scheduled = false;
  let closing = false;

  function schedule(): void {
    if (scheduled || closing) return;
    scheduled = true;
    // Nästa varv i händelseslingan: svaret på förfrågan som köade jobbet går iväg först.
    setImmediate(() => {
      scheduled = false;
      pump();
    });
  }

  function pump(): void {
    if (closing || current !== null) return;
    const jobId = queue.shift();
    if (jobId === undefined) return;
    current = runJob(jobId)
      .catch((error: unknown) => {
        log({ level: 'error', event: 'internal_error', reason: 'job_runner', ...describeError(error) });
      })
      .finally(() => {
        current = null;
        currentAbort = null;
        schedule();
      });
  }

  async function runJob(jobId: string): Promise<void> {
    const job = storage.jobForRun(jobId);
    if (job === null || job.status !== 'queued') return;
    if (!storage.markRunning(jobId, iso())) return;

    const { appId } = job;
    const startedMs = options.now().getTime();
    const base = { appIdPrefix: appIdPrefix(appId), userId: job.ownerUserId };
    log({ level: 'info', event: 'job_started', ...base });

    const request = storage.messageText(appId, job.messageSeq) ?? '';
    const history = storage.historyBefore(appId, job.messageSeq);
    const currentFiles = storage.latestRevision(appId)?.files ?? starterFiles;

    const controller = new AbortController();
    currentAbort = controller;
    let accepting = true;
    const onEvent = (event: AgentEvent): void => {
      if (!accepting) return;
      const clean = sanitizeEvent(event);
      if (clean === null) return;
      try {
        storage.appendEvent(jobId, clean);
      } catch (error) {
        log({ level: 'warn', event: 'internal_error', reason: 'event_not_saved', ...describeError(error) });
      }
    };

    const finish = (outcome: JobOutcome, extra: Record<string, unknown> = {}): void => {
      log({
        level: outcome.status === 'done' ? 'info' : 'warn',
        event: 'job_finished',
        ...base,
        status: outcome.status,
        durationMs: options.now().getTime() - startedMs,
        ...(outcome.model === undefined ? {} : { model: outcome.model.slice(0, 100) }),
        ...(outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens }),
        ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
        ...extra,
      });
    };

    const fail = (message: string, outcome: JobOutcome, withDoneEvent: boolean): void => {
      storage.failJob(appId, jobId, message, outcome, iso(), withDoneEvent ? { type: 'done', ok: false, message } : null);
    };

    let result: AgentTurnResult;
    try {
      result = await runWithTimeout(
        agent.runTurn({ request, history, currentFiles, signal: controller.signal, onEvent }),
        controller,
      );
    } catch (error) {
      accepting = false;
      const outcome: JobOutcome = { status: 'failed' };
      if (error instanceof JobTimeout) {
        fail(TIMEOUT_MESSAGE, outcome, true);
        log({ level: 'warn', event: 'job_timed_out', ...base });
        finish(outcome, { reason: 'timeout' });
      } else {
        fail(closing ? RESTART_MESSAGE : UNEXPECTED_MESSAGE, outcome, true);
        finish(outcome, describeError(error));
      }
      return;
    }
    accepting = false;

    const outcomeBase = {
      model: typeof result.model === 'string' ? result.model : undefined,
      inputTokens: tokenCount(result.usage?.inputTokens),
      outputTokens: tokenCount(result.usage?.outputTokens),
    };
    const extra = typeof result.rounds === 'number' ? { rounds: result.rounds } : {};
    const summary =
      typeof result.summary === 'string' && result.summary.trim().length > 0
        ? truncate(result.summary, MAX_SUMMARY_CHARS)
        : NO_SUMMARY_MESSAGE;

    const build = result.build;
    const outputDirectory = result.ok ? build?.outputDirectory : undefined;
    if (!result.ok || build === undefined || typeof outputDirectory !== 'string') {
      await disposeQuietly(build, log);
      const outcome: JobOutcome = { status: 'failed', ...outcomeBase };
      // Ett "ok" utan bygge går inte att importera; agenten har då brutit mot kontraktet.
      fail(result.ok ? SAVE_FAILED_MESSAGE : summary, outcome, result.ok);
      finish(outcome, result.ok ? { ...extra, reason: 'ok_without_build' } : extra);
      return;
    }

    try {
      if (controller.signal.aborted) throw new JobTimeout();
      const versionId = await control.importVersion(storedAppId(appId), outputDirectory);
      if (controller.signal.aborted) throw new JobTimeout();
      await control.setDraft(storedAppId(appId), versionId);
      const outcome: JobOutcome = { status: 'done', ...outcomeBase };
      storage.completeGreenJob(appId, jobId, result.files, versionId, summary, outcome, iso());
      finish(outcome, extra);
    } catch (error) {
      const outcome: JobOutcome = { status: 'failed', ...outcomeBase };
      fail(closing ? RESTART_MESSAGE : SAVE_FAILED_MESSAGE, outcome, true);
      finish(outcome, { ...extra, reason: 'import_failed', ...describeError(error) });
    } finally {
      await disposeQuietly(build, log);
    }
  }

  /**
   * En tur som aldrig blir klar får inte stoppa kön för alla andra. Vid tidsgränsen avbryts turen
   * och kön går vidare; blir den ändå klar senare städas dess bygge bort och ingenting importeras.
   */
  function runWithTimeout(turn: Promise<AgentTurnResult>, controller: AbortController): Promise<AgentTurnResult> {
    return new Promise<AgentTurnResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new JobTimeout());
      }, options.jobTimeoutMs);
      timer.unref?.();
      turn.then(
        (result) => {
          clearTimeout(timer);
          if (settled) {
            void disposeQuietly(result?.build, log);
            return;
          }
          settled = true;
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  return {
    enqueue(jobId) {
      queue.push(jobId);
      schedule();
    },

    async close() {
      closing = true;
      queue.length = 0;
      currentAbort?.abort();
      const running = current;
      if (running === null) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Vid start: allt som var aktivt när processen stannade blir `failed` med en förklaring. */
export function failInterruptedJobs(storage: Storage, now: () => Date, log: BuilderLogger): void {
  const active = storage.listActiveJobs();
  for (const { jobId, appId } of active) {
    storage.failJob(appId, jobId, RESTART_MESSAGE, { status: 'failed' }, now().toISOString(), {
      type: 'done',
      ok: false,
      message: RESTART_MESSAGE,
    });
  }
  if (active.length > 0) log({ level: 'warn', event: 'jobs_failed_on_startup', count: active.length });
}
