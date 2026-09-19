/**
 * Tjänsten `transcribe` (`/_api/transcribe`): tal till text, asynkront.
 *
 *   POST /_api/transcribe          { fileId, language?: 'sv' | 'en' } → 202 { jobId }
 *   GET  /_api/transcribe/:jobId   → { status, text?, segments?, error? }
 *
 * Ljudet läses genom `files` med förfrågans hyresgäst — ett fil-id från en annan app finns inte.
 * Jobbet ägs av den som startade det; appens ägare kan också läsa det. För alla andra "finns" det
 * inte (samma svar som för ett okänt id), så att ingen kan pröva sig fram till andras jobb.
 */
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppFileReader,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
} from '@vibesandbox/contracts';
import { ProviderError, transcribeWithBerget } from './berget.ts';
import type { TranscribeConfig } from './konfig.ts';
import { detectAudio, estimateSeconds } from './ljud.ts';
import type { DetectedAudio } from './ljud.ts';
import { JOB_ID_PATTERN, newJobId, openAudioStore, openJobStore } from './lagring.ts';
import type { Job, JobFailure } from './lagring.ts';

export const SERVICE_NAME = 'transcribe';

/** `{ fileId, language }` ryms med råge; ljudet kommer aldrig i kroppen. */
const MAX_BODY_BYTES = 4096;

/** Fil-id är plattformens egna; vi tar bara det som rimligen kan vara ett id. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const DAY_MS = 24 * 3600 * 1000;

/** Gallringen körs högst så här ofta (vid förfrågningar), så att den inte kostar något per anrop. */
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

const FAILURE_MESSAGES: Readonly<Record<JobFailure, string>> = {
  provider: 'Det gick inte att göra om ljudet till text just nu. Försök igen om en stund.',
  timeout: 'Utskriften tog för lång tid och avbröts. Försök med en kortare inspelning.',
  restart: 'Utskriften avbröts när plattformen startades om och kunde inte göras klar. Försök igen.',
  audio_missing: 'Ljudet för utskriften finns inte längre. Ladda upp filen och försök igen.',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

function reply(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function error(code: ApiErrorCode, message: string): AppServiceResponse {
  return reply(API_ERROR_STATUS[code], { error: { code, message } });
}

const NOT_FOUND_JOB = (): AppServiceResponse => error('not_found', 'Utskriften finns inte, eller så har den gallrats bort.');
const INVALID = (): AppServiceResponse =>
  error('invalid_request', 'Begäran ska innehålla fileId och kan ange language som "sv" eller "en".');

interface StartRequest {
  readonly fileId: string;
  readonly language: 'sv' | 'en' | undefined;
}

function parseStart(body: Uint8Array | undefined): StartRequest | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  // Okända fält nekas: ett `appId` eller `userId` i kroppen ska aldrig se ut att ha betydelse.
  if (Object.keys(record).some((key) => key !== 'fileId' && key !== 'language')) return undefined;
  const { fileId, language } = record;
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) return undefined;
  if (language !== undefined && language !== 'sv' && language !== 'en') return undefined;
  return { fileId, language };
}

function shortAppId(appId: string): string {
  return appId.slice(0, 8);
}

export function createTranscribeService(
  dependencies: AppServiceDependencies,
  files: AppFileReader,
  berget: { readonly baseUrl: string; readonly apiKey: string },
  config: TranscribeConfig,
): AppService {
  const { log, now } = dependencies;
  const jobs = openJobStore(dependencies.dataDir);
  const audio = openAudioStore(dependencies.dataDir);

  // ── Omstart ────────────────────────────────────────────────────────────────
  // Ett jobb som stod som pågående när processen dog körs om: utskriften har inga bieffekter
  // utöver kostnaden, och den som beställde väntar på resultatet. Men ett jobb som redan kraschat
  // processen en gång kan göra det igen — efter MAX_ATTEMPTS försök markeras det failed i stället
  // för att fälla plattformen i en loop.
  const recovered = jobs.recover(now().getTime());
  for (const jobId of recovered.failed) void audio.remove(jobId);
  audio.removeAllExcept(jobs.unfinished());
  if (recovered.requeued + recovered.failed.length > 0) {
    log({ level: 'warn', event: 'transcribe_recovered', requeued: recovered.requeued, failed: recovered.failed.length });
  }

  // ── Kön ────────────────────────────────────────────────────────────────────
  const shutdown = new AbortController();
  const running = new Map<string, Promise<void>>();
  let closed = false;
  let lastPurge = Number.NEGATIVE_INFINITY;

  function purge(): void {
    const at = now().getTime();
    if (at - lastPurge < PURGE_INTERVAL_MS) return;
    lastPurge = at;
    const removed = jobs.purge(at - config.retentionDays * DAY_MS);
    if (removed > 0) log({ level: 'info', event: 'transcribe_purged', jobs: removed });
  }

  async function run(job: Job): Promise<void> {
    const started = Date.now();
    const app = shortAppId(job.appId);
    const body = await audio.read(job.jobId);
    // Formatet lagrades i jobbet; kontrollen igen fångar en kopia som inte längre är samma sorts ljud.
    const detected: DetectedAudio | null = body === undefined ? null : detectAudio(`audio/${job.format}`, body);
    if (body === undefined || detected === null) {
      jobs.fail(job.jobId, 'audio_missing', now().getTime(), 0);
      await audio.remove(job.jobId);
      log({ level: 'error', event: 'transcribe_failed', app, reason: 'audio_missing' });
      return;
    }
    try {
      const transcript = await transcribeWithBerget({
        baseUrl: berget.baseUrl,
        apiKey: berget.apiKey,
        model: config.model,
        audio: body,
        detected,
        ...(job.language === undefined ? {} : { language: job.language }),
        timeoutMs: config.timeoutMs,
        signal: shutdown.signal,
      });
      const charged = transcript.durationSeconds === undefined ? undefined : Math.max(1, Math.ceil(transcript.durationSeconds));
      jobs.finish(job.jobId, { text: transcript.text, segments: transcript.segments, chargedSeconds: charged }, now().getTime());
      await audio.remove(job.jobId);
      log({ level: 'info', event: 'transcribe_done', app, seconds: charged ?? -1, ms: Date.now() - started });
    } catch (cause) {
      const failure = cause instanceof ProviderError ? cause.failure : 'provider';
      if (failure === 'aborted') {
        // Plattformen stängs: jobbet går tillbaka i kön och görs klart efter omstarten.
        jobs.requeue(job.jobId);
        log({ level: 'info', event: 'transcribe_requeued', app });
        return;
      }
      jobs.fail(job.jobId, failure, now().getTime());
      await audio.remove(job.jobId);
      const status = cause instanceof ProviderError && cause.status !== undefined ? { status: cause.status } : {};
      log({ level: 'error', event: 'transcribe_failed', app, reason: failure, ...status, ms: Date.now() - started });
    }
  }

  function pump(): void {
    while (!closed && running.size < config.concurrency) {
      const job = jobs.claimNext();
      if (job === undefined) return;
      const work = run(job)
        .catch((cause: unknown) => {
          // Något oväntat (t.ex. disken): jobbet får inte bli stående som pågående.
          jobs.fail(job.jobId, 'provider', now().getTime());
          log({ level: 'error', event: 'transcribe_failed', app: shortAppId(job.appId), reason: 'internal', name: cause instanceof Error ? cause.name : 'unknown' });
        })
        .finally(() => {
          running.delete(job.jobId);
          pump();
        });
      running.set(job.jobId, work);
    }
  }

  // Jobb som låg i kön vid omstarten fortsätter direkt, i bakgrunden — starten väntar inte på dem.
  setImmediate(pump);

  // ── Förfrågningar ──────────────────────────────────────────────────────────

  async function start(request: AppServiceRequest): Promise<AppServiceResponse> {
    const parsed = parseStart(request.body);
    if (parsed === undefined) return INVALID();
    const { tenant } = request;

    if (jobs.pending(tenant.appId) >= config.maxPendingPerApp) {
      return error('rate_limited', 'Appen har redan många utskrifter på gång. Vänta tills någon är klar och försök igen.');
    }

    const file = await files.read(tenant, parsed.fileId);
    if (file === null) return error('not_found', 'Filen finns inte.');
    if (file.body.byteLength > config.maxFileBytes) {
      const mb = Math.floor(config.maxFileBytes / 1_000_000);
      return error('too_large', `Ljudfilen är för stor. Den får vara högst ${mb} MB.`);
    }
    const detected = detectAudio(file.contentType, file.body);
    if (detected === null) {
      return error('invalid_request', 'Bara ljudfiler (mp3, m4a, mp4, wav eller webm) kan skrivas ut.');
    }

    const seconds = estimateSeconds(detected.format, file.body);
    const quotaLeft = (): boolean => {
      const used = jobs.chargedSince(tenant.appId, now().getTime() - DAY_MS);
      return used + seconds <= config.minutesPerAppDay * 60;
    };
    const quotaError = () => error('rate_limited', 'Appens ljudminuter för det senaste dygnet är slut. Försök igen senare.');
    // Först en snabb kontroll, så att ingen kopia skrivs i onödan …
    if (!quotaLeft()) return quotaError();

    // … sedan kopian, INNAN jobbet finns i kön — annars kunde kön ta jobbet innan ljudet fanns.
    const jobId = newJobId();
    await audio.write(jobId, file.body);
    // … och till sist kontrollen igen och reservationen, synkront utan `await` emellan: två
    // samtidiga beställningar kan inte båda få plats i samma sista minuter.
    if (closed || !quotaLeft()) {
      await audio.remove(jobId);
      return closed ? error('internal', 'Tjänsten stängs just nu. Försök igen om en stund.') : quotaError();
    }
    jobs.create({
      jobId,
      tenant,
      userId: request.identity.userId,
      language: parsed.language,
      format: detected.format,
      chargedSeconds: seconds,
      now: now().getTime(),
    });
    log({ level: 'info', event: 'transcribe_queued', app: shortAppId(tenant.appId), bytes: file.body.byteLength, seconds });
    pump();
    return reply(202, { jobId });
  }

  function status(request: AppServiceRequest, jobId: string): AppServiceResponse {
    if (!JOB_ID_PATTERN.test(jobId)) return NOT_FOUND_JOB();
    const job = jobs.get(request.tenant, jobId);
    if (job === undefined) return NOT_FOUND_JOB();
    if (job.userId !== request.identity.userId && request.access !== 'owner') return NOT_FOUND_JOB();
    switch (job.status) {
      case 'done':
        return reply(200, { status: 'done', text: job.text ?? '', segments: job.segments ?? [] });
      case 'failed':
        return reply(200, { status: 'failed', error: FAILURE_MESSAGES[job.failure ?? 'provider'] });
      default:
        return reply(200, { status: job.status });
    }
  }

  return {
    name: SERVICE_NAME,
    maxBodyBytes: MAX_BODY_BYTES,

    async handle(request) {
      purge();
      const { method, segments } = request;
      if (segments.length === 0) {
        return method === 'POST' ? start(request) : error('method_not_allowed', 'Använd POST för att beställa en utskrift.');
      }
      if (segments.length === 1 && segments[0] !== undefined) {
        return method === 'GET' || method === 'HEAD'
          ? status(request, segments[0])
          : error('method_not_allowed', 'En utskrift kan bara läsas.');
      }
      return error('not_found', 'Det finns ingenting här.');
    },

    async close() {
      if (closed) return;
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...running.values()]);
      jobs.close();
    },
  };
}
