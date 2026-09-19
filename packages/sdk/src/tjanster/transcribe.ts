/**
 * Tal till text (`/_api/transcribe`): gör om en uppladdad ljudfil till text, t.ex. ett möte
 * eller en intervju. Ljudet laddas först upp med `files`; här anges bara filens id.
 *
 *   import { transcribe } from '@vibesandbox/sdk';
 *   const { text, segments } = await transcribe.transcribe(fileId, { language: 'sv' });
 *
 * Utskriften tar tid (ungefär en minut per 15–25 minuter ljud, plus kö), så den görs som ett jobb:
 * `start` beställer, `status` frågar hur det går, och `transcribe` gör båda och väntar.
 * Anropa tjänsten bara genom `callService` i ./anrop.ts.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

export type TranscribeLanguage = 'sv' | 'en';

/** En bit av texten med tider i sekunder från inspelningens början. */
export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface Transcript {
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
}

export type TranscribeJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface TranscribeJob {
  readonly status: TranscribeJobStatus;
  /** Finns när `status` är `done`. */
  readonly text?: string;
  readonly segments?: readonly TranscriptSegment[];
  /** Finns när `status` är `failed`: klarspråk, går att visa för användaren. */
  readonly error?: string;
}

export interface TranscribeOptions {
  /** Talat språk. Utelämnat känns språket igen automatiskt; ange `'sv'` för svenska när det går. */
  readonly language?: TranscribeLanguage;
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

export interface WaitOptions extends TranscribeOptions {
  /** Längsta väntan innan `transcribe` ger upp. Standard: 45 minuter. */
  readonly maxWaitMs?: number;
  /** Bara för tester. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bara för tester. */
  readonly now?: () => number;
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

const FIRST_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 10_000;
/** Berget arbetar högst 30 minuter per fil; med kö och marginal räcker 45. */
const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000;

function fetchOption(options: TranscribeOptions): { fetch?: ServiceFetch } {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}

/** Beställer en utskrift av en uppladdad ljudfil. Ger jobbets id direkt; texten kommer senare. */
export async function start(fileId: string, options: TranscribeOptions = {}): Promise<{ jobId: string }> {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) throw new SdkError('invalid_request');
  const { language } = options;
  if (language !== undefined && language !== 'sv' && language !== 'en') throw new SdkError('invalid_request');
  const result = await callService('transcribe', 'POST', '', {
    json: language === undefined ? { fileId } : { fileId, language },
    ...fetchOption(options),
  });
  const jobId = (result as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new SdkError('internal');
  return { jobId };
}

/** Hur det går med en utskrift. Bara den som beställde den (och appens ägare) kan läsa den. */
export async function status(jobId: string, options: Pick<TranscribeOptions, 'fetch'> = {}): Promise<TranscribeJob> {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw new SdkError('invalid_request');
  const result = await callService('transcribe', 'GET', `/${jobId}`, fetchOption(options));
  const job = result as TranscribeJob | null;
  if (job === null || typeof job !== 'object' || !['queued', 'running', 'done', 'failed'].includes(job.status)) {
    throw new SdkError('internal');
  }
  return job;
}

/**
 * Beställer en utskrift och väntar tills den är klar. Kastar `SdkError` om den misslyckas, med ett
 * meddelande som går att visa som det är. För långa inspelningar: använd `start` och `status`
 * och låt användaren göra annat under tiden.
 */
export async function transcribe(fileId: string, options: WaitOptions = {}): Promise<Transcript> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  const { jobId } = await start(fileId, options);
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    await sleep(pause);
    const job = await status(jobId, fetchOption(options));
    if (job.status === 'done') return { text: job.text ?? '', segments: job.segments ?? [] };
    if (job.status === 'failed') throw new SdkError('internal', job.error);
    if (now() >= deadline) {
      throw new SdkError('internal', 'Utskriften tar lång tid. Försök igen senare, eller dela upp inspelningen.');
    }
    // Växande pauser med ett tak: snabbt svar på korta klipp, lite trafik under långa.
    pause = Math.min(Math.round(pause * 1.5), MAX_PAUSE_MS);
  }
}
