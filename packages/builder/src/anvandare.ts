/**
 * Bryggan till identiteten — den enda vägen från byggverktyget till vilka adresser som får logga in.
 *
 * Byggverktyget har en egen databas och når inte identitetens. Utan en väg dit blir två saker
 * fel: `AdminOverview.users` kan bara vara nollor, och ägarens adress saknas för appar som
 * skapades innan control hade en åtkomstlista (se atkomst.ts). Bryggan är svaret på båda — och
 * den är smal med FLIT: fem anrop, exakt det kontrollrummet behöver. Inga sessioner, inga
 * utmaningar, ingen inloggning. Plattformen kopplar in den (`createBuilder({ users })`); saknas
 * den fungerar byggverktyget som förut, med nollor i översikten och `unavailable` på
 * användarrutterna. En nolla är ärligare än en gissning, och ett tydligt "inte inkopplat" är
 * ärligare än en tom lista.
 *
 * Anropen är synkrona, som byggverktygets egen lagring: identiteten är en SQLite-fil på samma
 * maskin.
 *
 * Fel signaleras med `DataApiError` (kontraktets fel), inte med egna klasser:
 *   - `invalid_request` — ogiltig adress eller okänd roll
 *   - `not_found`       — ett användar-id som inte finns
 */
import type { Role } from '@vibesandbox/contracts';

/** En adress som får logga in. Samma rad som identitetens `UserRecord`, plus när den bjöds in. */
export interface BuilderUser {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /**
   * När adressen lades in, ISO 8601 — eller `null` när tidpunkten inte går att veta. `null` och
   * en tom sträng är olika saker: ett fält som alltid är tomt ser ut som ett svar, och
   * gränssnittet kan bara visa ett ärligt streck om det får veta skillnaden.
   */
  readonly createdAt: string | null;
}

export interface BuilderUserDirectory {
  /** Alla adresser som får logga in, äldst först. */
  list(): readonly BuilderUser[];
  /** Antal adresser per roll. Alla tre rollerna finns alltid som nycklar, även när de är noll. */
  countByRole(): Record<Role, number>;
  /**
   * Adresserna för de id som finns; ett okänt id saknas i kartan (och gissas aldrig). EN vändning
   * för hela listan — kontrollrummet slår aldrig upp en app i taget.
   */
  emails(userIds: readonly string[]): ReadonlyMap<string, string>;
  /**
   * Bjuder in adressen eller HÖJER dess roll. Sänker aldrig — en inbjudan kan inte användas för
   * att ta ifrån någon behörighet i smyg. `now`: millisekunder sedan 1970.
   *
   * Den enda som är asynkron: inbjudan går genom identitetens egen inbjudningsväg, som utöver
   * raden i användartabellen också för in en händelse i identitetens logg. Att någon fick rätt
   * att logga in ska gå att se i efterhand, precis som att någon fick sin roll sänkt.
   */
  invite(email: string, role: Role, now: number): Promise<BuilderUser>;
  /** Sätter rollen rakt av — den enda vägen att SÄNKA en roll. */
  setRole(userId: string, role: Role, now: number): BuilderUser;
}
