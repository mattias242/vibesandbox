/**
 * Driftloggning. Typen ÄR skyddet: en loggpost har bara fälten här, och inget av dem kan bära en
 * adress, en kod, ett kakvärde eller ett sessionsvärde. Användare anges med `userId`.
 */

export type IdentityEvent =
  | 'user_added'
  /** En roll sattes rakt av — den enda vägen att SÄNKA en behörighet. Se `setUserRole`. */
  | 'role_changed'
  | 'invited'
  | 'challenge_created'
  | 'login_succeeded'
  | 'login_failed'
  | 'origin_rejected'
  | 'rate_limited'
  | 'bad_request'
  | 'logout'
  | 'handoff_created'
  | 'handoff_succeeded'
  | 'handoff_failed'
  | 'mail_failed'
  | 'cleanup';

/** Varför en inloggning misslyckades — fasta värden ur koden, aldrig indata. */
export type LoginFailure =
  | 'no_challenge'
  | 'ambiguous_cookie'
  | 'wrong_host'
  | 'expired'
  | 'wrong_code'
  | 'exhausted'
  | 'not_invited'
  | 'cross_site';

export interface IdentityLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: IdentityEvent;
  readonly userId?: string;
  readonly reason?: LoginFailure | 'address' | 'client' | 'global' | 'verify';
  /** Felets klassnamn — aldrig meddelandet, som kan bära data. */
  readonly errorName?: string;
  /** Antal rader (vid städning). */
  readonly count?: number;
}

export type IdentityLogger = (entry: IdentityLogEntry) => void;

export function safeLogger(logger: IdentityLogger | undefined): IdentityLogger {
  if (logger === undefined) return () => {};
  return (entry) => {
    try {
      logger(entry);
    } catch {
      // Medvetet tomt: loggning är inte värd att fälla en inloggning för.
    }
  };
}
