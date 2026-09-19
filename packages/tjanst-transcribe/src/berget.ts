/**
 * Anropet till Berget: `POST <baseUrl>/audio/transcriptions` (OpenAI-kompatibelt), multipart med
 * ljudet, modellen och `response_format=verbose_json` — som ger text, längd och segment med tider.
 *
 * Kroppen byggs med standardbibliotekets `FormData`/`Blob`. Filnamnet till Berget är alltid
 * `ljud.<ext>`: uppladdarens filnamn ("Intervju med Anna Svensson.m4a") är en personuppgift som
 * Berget inte behöver.
 *
 * Allt Berget svarar granskas: bara väldefinierade fält går vidare, och vid fel går varken status-
 * text eller kropp vidare — bara en av våra egna felkoder.
 */
import type { DetectedAudio } from './ljud.ts';

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface Transcript {
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
  /** Ljudets längd enligt Berget, om den fanns med i svaret. */
  readonly durationSeconds?: number;
}

/** `timeout`: tog för lång tid. `aborted`: plattformen stängs. `provider`: allt annat. */
export type ProviderFailure = 'provider' | 'timeout' | 'aborted';

export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  /** HTTP-status från Berget, för loggen. Aldrig kroppen. */
  readonly status: number | undefined;

  constructor(failure: ProviderFailure, status?: number) {
    super(`Berget: ${failure}`);
    this.name = 'ProviderError';
    this.failure = failure;
    this.status = status;
  }
}

/** Större svar än så tas inte emot. En timmes tal är i storleksordningen 100 kB text. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_SEGMENTS = 50_000;

export interface BergetRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly audio: Uint8Array;
  readonly detected: DetectedAudio;
  readonly language?: 'sv' | 'en';
  readonly timeoutMs: number;
  /** Avbryts när plattformen stängs. */
  readonly signal: AbortSignal;
}

function cleanSegments(candidate: unknown): TranscriptSegment[] {
  if (!Array.isArray(candidate)) return [];
  const segments: TranscriptSegment[] = [];
  for (const item of candidate.slice(0, MAX_SEGMENTS)) {
    if (typeof item !== 'object' || item === null) continue;
    const { start, end, text } = item as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
    segments.push({ start, end, text: text.trim() });
  }
  return segments;
}

export async function transcribeWithBerget(request: BergetRequest): Promise<Transcript> {
  const form = new FormData();
  // Kopian gör att Blob får en egen ArrayBuffer, oavsett vad `audio` är en vy av.
  form.append('file', new Blob([new Uint8Array(request.audio)], { type: request.detected.mimeType }), `ljud.${request.detected.extension}`);
  form.append('model', request.model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (request.language !== undefined) form.append('language', request.language);

  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([request.signal, timeout]);
  const failure = (): ProviderError =>
    new ProviderError(request.signal.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'provider');

  // Kroppen serialiseras i förväg (standardbibliotekets egen multipart-kodning, via `Response`).
  // Att låta fetch strömma FormData direkt gav ohanterade avvisningar inne i undici när anropet
  // avbröts mitt i uppladdningen — i drift hade det kunnat fälla processen.
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type') ?? '';
  const body = new Uint8Array(await encoded.arrayBuffer());

  let response: Response;
  try {
    response = await fetch(`${request.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.apiKey}`, accept: 'application/json', 'content-type': contentType },
      body,
      signal,
      // En omdirigering skulle kunna skicka nyckel och ljud någon annanstans.
      redirect: 'error',
    });
  } catch {
    throw failure();
  }

  let raw: string;
  try {
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('provider', response.status);
    }
    raw = await response.text();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw failure();
  }
  if (!response.ok) throw new ProviderError('provider', response.status);
  if (raw.length > MAX_RESPONSE_BYTES) throw new ProviderError('provider', response.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError('provider', response.status);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ProviderError('provider', response.status);
  const { text, segments, duration } = parsed as Record<string, unknown>;
  if (typeof text !== 'string') throw new ProviderError('provider', response.status);

  return {
    text: text.trim(),
    segments: cleanSegments(segments),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationSeconds: duration } : {}),
  };
}
