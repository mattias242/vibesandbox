/**
 * Driftloggning. Byggverktyget skriver aldrig själv till konsol eller fil — den som startar det
 * skickar in en `logger`. Standard är tyst.
 *
 * Typen ÄR skyddet: en loggpost har bara de fält som står här, och inget av dem kan bära ett
 * önskemål, källkod, en sammanfattning från agenten, ett appnamn eller en e-postadress. Användare
 * anges med `userId`, appar med de första 8 tecknen av id:t — hela id:t är den hemliga länken.
 */

export type BuilderLogEvent =
  | 'app_created'
  /** Ägaren döpte sin app. Namnet loggas ALDRIG — det är hennes text om sin egen app. */
  | 'app_renamed'
  | 'job_queued'
  | 'job_started'
  | 'job_finished'
  | 'job_timed_out'
  /** Ett önskemål stoppades av en röd linje: ingen tur startades, ingen modell anropades. */
  | 'request_stopped'
  /** Ett önskemål klassades. Står i loggen för att en fail-closed ska gå att se utan databasen. */
  | 'request_classified'
  | 'jobs_failed_on_startup'
  /** Ägaren begärde publicering. Ingen app gick ut — en granskare måste säga ja först. */
  | 'review_requested'
  /** En granskare avgjorde ett ärende. Beslutet står i `status`; skälet loggas ALDRIG. */
  | 'review_decided'
  | 'app_published'
  | 'publish_failed'
  /** Ägaren hämtade ut appens innehåll. Antalet dokument står i `count`; inget innehåll loggas. */
  | 'app_exported'
  /** Appen avvecklades: data och filer raderade, registerposten arkiverad. Gallringsbeviset. */
  | 'app_decommissioned'
  | 'decommission_failed'
  | 'app_shared'
  | 'share_failed'
  | 'share_rate_limited'
  | 'feedback_sent'
  | 'feedback_liked'
  | 'feedback_failed'
  | 'feedback_rate_limited'
  | 'owners_granted_on_startup'
  | 'owner_grant_failed'
  | 'access_revoked'
  | 'ui_file_skipped'
  | 'ui_unavailable'
  | 'internal_error';

export interface BuilderLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: BuilderLogEvent;
  readonly appIdPrefix?: string;
  readonly userId?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly rounds?: number;
  /** Antal, t.ex. hur många jobb som markerades som misslyckade vid start. */
  readonly count?: number;
  /** Antal filer, t.ex. hur många som raderades vid en avveckling. */
  readonly files?: number;
  /** Varför något hoppades över — en fast kod, aldrig en sökväg eller ett meddelande. */
  readonly reason?: string;
  /**
   * Vilken röd linje ett önskemål stoppades av. Fast text ur vår egen kod — ALDRIG något som
   * kommit in med önskemålet, som kan bära personuppgifter.
   */
  readonly category?: string;
  /**
   * Appens klass EFTER klassningen, och hur den sattes. Båda är fasta ord ur kontraktet —
   * `CLASSIFICATIONS` och `CLASSIFICATION_SOURCES` — och aldrig något som kommit in med
   * önskemålet. Att de finns här är hur en rad fail-closed i följd syns som ett driftfel och inte
   * bara som en sträng rad i registret.
   *
   * Fältet heter `classificationSource` och inte `source`: plattformens egen loggrad har redan ett
   * `source` (vilken modul raden kom från), och en post härifrån breds ut i den. Ett fält som
   * heter likadant hade tyst skrivit över det.
   */
  readonly classification?: string;
  readonly classificationSource?: string;
  /** Felets klassnamn och anropsstack UTAN felmeddelandet — meddelanden kan innehålla data. */
  readonly errorName?: string;
  readonly stackFrames?: readonly string[];
}

export type BuilderLogger = (entry: BuilderLogEntry) => void;

export const silentLogger: BuilderLogger = () => {};

export function appIdPrefix(appId: string): string {
  return appId.slice(0, 8);
}

export function describeError(error: unknown): Pick<BuilderLogEntry, 'errorName' | 'stackFrames'> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 12)
    .map((line) => line.trim());
  // Klassnamnet kan i princip sättas av vem som helst; kapa det så att det inte blir en databärare.
  return { errorName: error.name.slice(0, 40), stackFrames: frames };
}

/** En logger som kastar får aldrig påverka svaret eller jobbet. */
export function safeLogger(logger: BuilderLogger): BuilderLogger {
  return (entry) => {
    try {
      logger(entry);
    } catch {
      // Medvetet tomt: loggning är inte värd att fälla en förfrågan för.
    }
  };
}
