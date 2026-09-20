/**
 * Tjänstens inställningar ur `SVC_EXTRACT_…`. Läses en gång vid start; ett fel stoppar
 * plattformen med ett meddelande som säger vad som ska rättas. Alla har ett rimligt
 * standardvärde — tjänsten behöver ingen konfiguration för att fungera.
 *
 * Ett TOMT värde räknas som "inte satt". docker compose skickar in varje variabel, även de som
 * inte är ifyllda, och en tjänst som fäller plattformen på en tom sträng gör `main` odriftsättbar.
 */

export interface ExtractSettings {
  /** Största fil som läses alls. */
  readonly maxFileBytes: number;
  /** Största sammanlagda storlek ett arkiv får packas upp till. */
  readonly maxUnpackedBytes: number;
  /** Antal filer ett arkiv får innehålla. */
  readonly maxZipEntries: number;
  /** Hur många gånger större ett arkiv får bli när det packas upp (skydd mot zip-bomb). */
  readonly maxExpansion: number;
  /** Tecken i svaret. Mer än så kapas och svaret säger `truncated: true`. */
  readonly maxChars: number;
  /** Sidor i en PDF. */
  readonly maxPdfPages: number;
  readonly callsPerAppDay: number;
  readonly callsPerUserHour: number;
  /** Tidsgräns för själva läsningen. */
  readonly timeoutMs: number;
}

const DEFAULTS = {
  SVC_EXTRACT_MAX_FILE_BYTES: 20 * 1024 * 1024,
  SVC_EXTRACT_MAX_UNPACKED_BYTES: 200 * 1024 * 1024,
  SVC_EXTRACT_MAX_ZIP_ENTRIES: 200,
  SVC_EXTRACT_MAX_EXPANSION: 50,
  SVC_EXTRACT_MAX_CHARS: 200_000,
  SVC_EXTRACT_MAX_PDF_PAGES: 300,
  SVC_EXTRACT_CALLS_PER_APP_DAY: 500,
  SVC_EXTRACT_CALLS_PER_USER_HOUR: 100,
  SVC_EXTRACT_TIMEOUT_MS: 30_000,
} as const;

/** Gatewayns tak för en tjänsts kropp är 25 MB; en större fil kan ändå aldrig laddas upp. */
const MAX_FILE_BYTES_CEILING = 25 * 1024 * 1024;
const MAX_UNPACKED_CEILING = 1024 * 1024 * 1024;
const MAX_CHARS_CEILING = 5_000_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

function positiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: keyof typeof DEFAULTS,
  ceiling = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return DEFAULTS[name];
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new Error(`${name} ska vara ett positivt heltal (fick "${raw.slice(0, 20)}").`);
  const value = Number(raw);
  if (value > ceiling) throw new Error(`${name} får vara högst ${ceiling}.`);
  return value;
}

export function readSettings(env: Readonly<Record<string, string | undefined>>): ExtractSettings {
  const settings: ExtractSettings = {
    maxFileBytes: positiveInteger(env, 'SVC_EXTRACT_MAX_FILE_BYTES', MAX_FILE_BYTES_CEILING),
    maxUnpackedBytes: positiveInteger(env, 'SVC_EXTRACT_MAX_UNPACKED_BYTES', MAX_UNPACKED_CEILING),
    maxZipEntries: positiveInteger(env, 'SVC_EXTRACT_MAX_ZIP_ENTRIES', 100_000),
    maxExpansion: positiveInteger(env, 'SVC_EXTRACT_MAX_EXPANSION', 10_000),
    maxChars: positiveInteger(env, 'SVC_EXTRACT_MAX_CHARS', MAX_CHARS_CEILING),
    maxPdfPages: positiveInteger(env, 'SVC_EXTRACT_MAX_PDF_PAGES', 100_000),
    callsPerAppDay: positiveInteger(env, 'SVC_EXTRACT_CALLS_PER_APP_DAY'),
    callsPerUserHour: positiveInteger(env, 'SVC_EXTRACT_CALLS_PER_USER_HOUR'),
    timeoutMs: positiveInteger(env, 'SVC_EXTRACT_TIMEOUT_MS', MAX_TIMEOUT_MS),
  };
  if (settings.maxUnpackedBytes < settings.maxFileBytes) {
    throw new Error('SVC_EXTRACT_MAX_UNPACKED_BYTES får inte vara mindre än SVC_EXTRACT_MAX_FILE_BYTES.');
  }
  return settings;
}
