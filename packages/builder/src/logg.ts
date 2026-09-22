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
  | 'job_queued'
  | 'job_started'
  | 'job_finished'
  | 'job_timed_out'
  /** Ett önskemål stoppades av en röd linje: ingen tur startades, ingen modell anropades. */
  | 'request_stopped'
  | 'jobs_failed_on_startup'
  | 'app_published'
  | 'publish_failed'
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
  /** Varför något hoppades över — en fast kod, aldrig en sökväg eller ett meddelande. */
  readonly reason?: string;
  /**
   * Vilken röd linje ett önskemål stoppades av. Fast text ur vår egen kod — ALDRIG något som
   * kommit in med önskemålet, som kan bära personuppgifter.
   */
  readonly category?: string;
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
