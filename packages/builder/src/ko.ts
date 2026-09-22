/**
 * Jobbkön: EN tur åt gången för hela plattformen (VPS XS — agenten och bygget är det tunga), i den
 * ordning önskemålen kom.
 *
 * Kön lever i minnet; databasen är facit för varje jobbs status. Vid start finns därför inga köade
 * jobb att återuppta — allt som var `queued` eller `running` när processen dog markeras `failed`
 * med en förklaring (se `failInterruptedJobs`). Hellre ett tydligt "försök igen" än ett jobb som
 * körs en gång till utan att någon väntar på det.
 */
import { MAX_EVENT_DIAGNOSTICS, MAX_EVENT_DIAGNOSTIC_CHARS } from '@vibesandbox/contracts';
import type {
  AgentEvent,
  AgentTurnResult,
  BuildResult,
  Classification,
  ClassificationSource,
  Diagnostic,
  RedlineCategory,
  SourceFiles,
  Agent,
} from '@vibesandbox/contracts';
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

/**
 * Beskedet när ett önskemål stoppas av en röd linje. Det ska läsas som ett BESLUT, inte som en
 * krasch: inget "försök igen om en stund", ingen felkod, ingen antydan om att plattformen gick
 * sönder. Kategorin står inte här — den är vårt eget ordval och hör hemma i kontrollrummet.
 */
const REDLINE_MESSAGE =
  'Det här bygger vi inte. Beskrivningen rör en användning av AI som lagen och plattformens ' +
  'regler inte tillåter, och då blir det ingen app. Det är inget som gick sönder — beskriv vad ' +
  'appen ska göra på ett annat sätt, så provar vi igen.';

/** Längsta sammanfattning från agenten som sparas i samtalet. */
const MAX_SUMMARY_CHARS = 8000;
const MAX_EVENT_TEXT = 1000;
const MAX_EVENT_PATHS = 100;
const MAX_EVENT_PATH_CHARS = 200;
const MAX_EVENT_RULE_CHARS = 100;
const DIAGNOSTIC_SOURCES: ReadonlySet<string> = new Set(['policy', 'typecheck', 'build']);

/** Ett fel ur en kontrollhändelse, med bara kontraktets fält — eller `null` om det inte är ett fel. */
function sanitizeDiagnostic(value: unknown): Diagnostic | null {
  if (value === null || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  const source = d['source'];
  const message = d['message'];
  if (typeof source !== 'string' || !DIAGNOSTIC_SOURCES.has(source) || typeof message !== 'string') return null;
  const rule = d['rule'];
  const file = d['file'];
  const line = d['line'];
  return {
    source: source as Diagnostic['source'],
    ...(typeof rule === 'string' ? { rule: truncate(rule, MAX_EVENT_RULE_CHARS) } : {}),
    ...(typeof file === 'string' ? { file: truncate(file, MAX_EVENT_PATH_CHARS) } : {}),
    ...(typeof line === 'number' && Number.isInteger(line) && line > 0 ? { line } : {}),
    message: truncate(message, MAX_EVENT_DIAGNOSTIC_CHARS),
  };
}

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
  /**
   * Prövar önskemålet mot de röda linjerna. Saknas den prövas ingenting — byggverktyget ska gå
   * att köra utan policy-paketet, precis som utan bryggan till användarregistret.
   */
  readonly checkRedlines?: ((request: string) => RedlineCategory | null) | undefined;
  /**
   * Klassar önskemålet: hur känsliga uppgifter appen kommer att hantera. Saknas den klassas
   * ingenting och appen står kvar som oklassad i registret — som läses som den strängaste klassen.
   * Att sakna klassning kan alltså aldrig se ofarligare ut än att ha den.
   *
   * Funktionen får INTE kasta: allt som går fel ska den själv göra om till `fail-closed`. Kön
   * fångar ändå, men ett bygge ska aldrig falla på att klassningen strulade.
   */
  readonly classifyRequest?:
    | ((request: string, signal: AbortSignal) => Promise<{ classification: Classification; source: ClassificationSource }>)
    | undefined;
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
      // Felen följer bara med ett underkänt bygge, och bara de som följer kontraktet.
      const raw = e['diagnostics'];
      const diagnostics =
        e['ok'] || !Array.isArray(raw)
          ? []
          : raw
              .map(sanitizeDiagnostic)
              .filter((d): d is Diagnostic => d !== null)
              .slice(0, MAX_EVENT_DIAGNOSTICS);
      return diagnostics.length === 0
        ? { type: 'check', ok: e['ok'], problems }
        : { type: 'check', ok: e['ok'], problems, diagnostics };
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

    // De röda linjerna prövas HÄR: efter att jobbet markerats igång, men före agenten. Spärren
    // måste sitta före modellen — prövas texten efteråt har den redan lämnat servern, och då är
    // steget en efterhandskontroll i stället för ett skydd. Inget utkast rörs, ingen tur startas.
    const category = options.checkRedlines?.(request) ?? null;
    if (category !== null) {
      storage.stopJob(appId, jobId, REDLINE_MESSAGE, category, iso(), { type: 'done', ok: false, message: REDLINE_MESSAGE });
      // Kategorin är fast text ur vår egen kod och får loggas. Önskemålet får aldrig loggas.
      log({ level: 'info', event: 'request_stopped', ...base, category });
      finish({ status: 'failed' }, { reason: 'redline' });
      return;
    }

    // Klassningen sitter EFTER de röda linjerna och FÖRE agenten. Ordningen är inte
    // godtycklig: ett önskemål som stoppats ska aldrig skickas till en modell, inte ens för att
    // klassas — spärren före modellen vore meningslös om nästa rad ändå skickade texten dit.
    //
    // Den får inte fälla bygget. Går klassningen fel blir klassen den strängaste (det är vad
    // `fail-closed` betyder), och appen byggs ändå: klassen styr hur appen får förvaltas, inte
    // om den får finnas. Kastar funktionen ändå — vilket den inte ska — höjs ingenting, och
    // appen står kvar som oklassad, vilket läses som den strängaste klassen.
    if (options.classifyRequest !== undefined) {
      try {
        const verdict = await options.classifyRequest(request, controller.signal);
        const stored = storage.raiseClassification(appId, verdict, iso());
        // Klass och källa är fasta ord ur vår egen kod och får loggas. Önskemålet får det aldrig.
        //
        // Båda läses ur `stored`, inte ur `verdict`: loggen ska säga vad appen ÄR efter det här
        // önskemålet. Blev bedömningen avvisad för att den var mildare än det som redan stod, vore
        // det missvisande att logga den avvisade bedömningens källa bredvid den kvarstående klassen.
        log({
          level: 'info',
          event: 'request_classified',
          ...base,
          classification: stored.classification,
          classificationSource: stored.source,
        });
      } catch (error) {
        log({ level: 'warn', event: 'internal_error', reason: 'classification_failed', ...describeError(error) });
      }
    }

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
