/**
 * Plattformens driftlogg: EN funktion som tar emot poster från alla delar, märkta med varifrån de
 * kommer. Varje del har sin egen, snävt typade loggpost — typen ÄR skyddet mot att en adress, en
 * kod, ett önskemål eller ett sessionsvärde hamnar i loggen — och här läggs bara `source` till.
 */
import type { BuilderLogEntry } from '@vibesandbox/builder';
import type { GatewayLogEntry } from '@vibesandbox/gateway';
import type { IdentityLogEntry } from '@vibesandbox/identity';

/** Plattformens egna händelser vid ihopsättningen. */
export interface PlatformEventEntry {
  readonly level: 'info' | 'warn' | 'error';
  /** `invitation_noted`: testläget har ingen mejltjänst, så en inbjudan noteras bara — utan adressen. */
  readonly event: 'invitation_noted';
  /** Den som bjöd in. Aldrig den inbjudnas adress. */
  readonly userId?: string;
  readonly role?: string;
}

export type PlatformLogEntry =
  | ({ readonly source: 'gateway' } & GatewayLogEntry)
  | ({ readonly source: 'builder' } & BuilderLogEntry)
  | ({ readonly source: 'identity' } & IdentityLogEntry)
  | ({ readonly source: 'platform' } & PlatformEventEntry);

export type PlatformLogger = (entry: PlatformLogEntry) => void;
