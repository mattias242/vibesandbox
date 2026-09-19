/**
 * Tjänstens inställningar ur `SVC_OCR_…`. Läses en gång vid start; ett fel stoppar plattformen
 * med ett meddelande som säger vad som ska rättas.
 */

/** Modellnamnet som väljer Bergets dokument-API (`POST /v1/ocr`) i stället för en bildmodell. */
export const DOCUMENT_ENGINE = 'berget-ocr';

export interface OcrSettings {
  /** En bildförstående chattmodell hos Berget (fullständigt id), eller `DOCUMENT_ENGINE`. */
  readonly model: string;
  readonly pagesPerAppDay: number;
  readonly pagesPerUserHour: number;
  readonly maxFileBytes: number;
  readonly maxPixels: number;
  readonly maxPdfPages: number;
  readonly timeoutMs: number;
}

const DEFAULTS = {
  SVC_OCR_PAGES_PER_APP_DAY: 200,
  SVC_OCR_PAGES_PER_USER_HOUR: 50,
  SVC_OCR_MAX_FILE_BYTES: 10 * 1024 * 1024,
  SVC_OCR_MAX_PIXELS: 40_000_000,
  SVC_OCR_MAX_PDF_PAGES: 30,
  SVC_OCR_TIMEOUT_MS: 60_000,
} as const;

/**
 * Filen skickas base64-kodad i ett JSON-anrop (en tredjedel större) — över det här blir anropet
 * orimligt stort oavsett vad som ställts in.
 */
const MAX_FILE_BYTES_CEILING = 25 * 1024 * 1024;

/** Modell-id som Berget skriver dem: `organisation/namn`, utan blanktecken eller kontrolltecken. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;

function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: keyof typeof DEFAULTS, ceiling = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return DEFAULTS[name];
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new Error(`${name} ska vara ett positivt heltal (fick "${raw.slice(0, 20)}").`);
  const value = Number(raw);
  if (value > ceiling) throw new Error(`${name} får vara högst ${ceiling}.`);
  return value;
}

export function readSettings(env: Readonly<Record<string, string | undefined>>): OcrSettings {
  const model = env['SVC_OCR_MODEL']?.trim() ?? '';
  if (model === '') {
    throw new Error(
      `SVC_OCR_MODEL saknas. Ange en bildförstående modell hos Berget (t.ex. google/gemma-4-31B-it) eller "${DOCUMENT_ENGINE}" för Bergets dokument-API.`,
    );
  }
  if (!MODEL_PATTERN.test(model)) throw new Error('SVC_OCR_MODEL innehåller otillåtna tecken.');
  return {
    model,
    pagesPerAppDay: positiveInteger(env, 'SVC_OCR_PAGES_PER_APP_DAY'),
    pagesPerUserHour: positiveInteger(env, 'SVC_OCR_PAGES_PER_USER_HOUR'),
    maxFileBytes: positiveInteger(env, 'SVC_OCR_MAX_FILE_BYTES', MAX_FILE_BYTES_CEILING),
    maxPixels: positiveInteger(env, 'SVC_OCR_MAX_PIXELS'),
    maxPdfPages: positiveInteger(env, 'SVC_OCR_MAX_PDF_PAGES'),
    timeoutMs: positiveInteger(env, 'SVC_OCR_TIMEOUT_MS', 10 * 60_000),
  };
}
