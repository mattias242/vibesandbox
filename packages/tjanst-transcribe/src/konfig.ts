/**
 * Tjänstens inställningar, ur `SVC_TRANSCRIBE_…`. Ett ogiltigt värde stoppar plattformen vid start
 * med ett meddelande som namnger variabeln — hellre det än en tjänst som beter sig oväntat i drift.
 */

/**
 * Bergets gräns för en ljudfil: 100 MB per anrop (och högst 30 minuters bearbetning). Källa:
 * Bergets dokumentation för `/v1/audio/transcriptions`, återgiven på https://ostt.ai/reference/providers/berget.
 * Räknat som 100 000 000 byte — det försiktiga av "MB" och "MiB".
 */
export const BERGET_MAX_FILE_BYTES = 100_000_000;

/** Berget bearbetar högst 30 minuter per anrop; efter det är svaret ändå förlorat. */
const BERGET_MAX_PROCESSING_SECONDS = 30 * 60;

export interface TranscribeConfig {
  readonly model: string;
  /** Hur många utskrifter som körs mot Berget samtidigt, för alla appar tillsammans. */
  readonly concurrency: number;
  readonly retentionDays: number;
  readonly minutesPerAppDay: number;
  readonly maxFileBytes: number;
  readonly timeoutMs: number;
  /** Köade och pågående jobb per app. Skyddar kön mot en enda app som beställer i en loop. */
  readonly maxPendingPerApp: number;
}

/** KB-Whisper: KBLab:s svenska Whisper, med ungefär hälften så många fel på svenska som whisper-large-v3. */
export const DEFAULT_MODEL = 'KBLab/kb-whisper-large';

/** Modell-id som Berget använder: `organisation/modell`, utan blanktecken eller styrtecken. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = /^[0-9]{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} ska vara ett heltal mellan ${min} och ${max} (tal till text, tjänsten transcribe).`);
  }
  return value;
}

export function readConfig(env: Readonly<Record<string, string | undefined>>): TranscribeConfig {
  const model = env['SVC_TRANSCRIBE_MODEL'] ?? DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(`SVC_TRANSCRIBE_MODEL ska vara ett modell-id hos Berget, t.ex. ${DEFAULT_MODEL}.`);
  }
  return {
    model,
    concurrency: integer(env, 'SVC_TRANSCRIBE_CONCURRENCY', 2, 1, 16),
    retentionDays: integer(env, 'SVC_TRANSCRIBE_RETENTION_DAYS', 7, 1, 365),
    minutesPerAppDay: integer(env, 'SVC_TRANSCRIBE_MINUTES_PER_APP_DAY', 120, 1, 24 * 60 * 10),
    maxFileBytes: integer(env, 'SVC_TRANSCRIBE_MAX_FILE_BYTES', BERGET_MAX_FILE_BYTES, 1, BERGET_MAX_FILE_BYTES),
    timeoutMs: integer(env, 'SVC_TRANSCRIBE_TIMEOUT_SECONDS', BERGET_MAX_PROCESSING_SECONDS + 60, 1, 2 * 3600) * 1000,
    maxPendingPerApp: 10,
  };
}
