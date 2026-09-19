/**
 * Driftloggning. Gatewayn skriver aldrig själv till konsol eller fil — den som startar den
 * skickar in en `logger`. Standard är tyst.
 *
 * Typen ÄR skyddet: en loggpost har bara de fält som står här, och inget av dem kan bära en
 * e-postadress, ett `Authorization`-värde, en kaka, en kropp eller en sökväg (SPA-adresser kan
 * innehålla personuppgifter). Användare anges med `identity.userId`.
 */
import type { AppId, TenantKind } from '@vibesandbox/contracts';

export interface GatewayLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  /**
   * `app_access_denied`: inloggad, appen finns, men användaren saknar roll för versionen. Svaret är
   * detsamma som för en app som inte finns — det är bara här i driftloggen skillnaden syns.
   * `app_registry_failed`: registret kunde inte svara på en åtkomstfråga (och förfrågan nekades).
   */
  readonly event:
    | 'request'
    | 'identity_provider_failed'
    | 'internal_error'
    | 'app_access_denied'
    | 'app_registry_failed';
  readonly method?: string;
  /** Vilken sorts rutt, aldrig den faktiska sökvägen. */
  readonly route?: 'api' | 'static' | 'auth' | 'builder';
  readonly status?: number;
  readonly code?: string;
  /** De första 8 tecknen. Hela app-id:t är den hemliga delningslänken och hör inte hemma i en logg. */
  readonly appIdPrefix?: string;
  readonly kind?: TenantKind;
  readonly userId?: string;
  /** Felets klassnamn och anropsstack UTAN felmeddelandet — meddelanden kan innehålla data. */
  readonly errorName?: string;
  readonly stackFrames?: readonly string[];
}

export type GatewayLogger = (entry: GatewayLogEntry) => void;

export const silentLogger: GatewayLogger = () => {};

export function appIdPrefix(appId: AppId): string {
  return appId.slice(0, 8);
}

export function describeError(error: unknown): Pick<GatewayLogEntry, 'errorName' | 'stackFrames'> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 12)
    .map((line) => line.trim());
  return { errorName: error.name, stackFrames: frames };
}

/** En logger som kastar får aldrig påverka svaret till användaren. */
export function safeLogger(logger: GatewayLogger): GatewayLogger {
  return (entry) => {
    try {
      logger(entry);
    } catch {
      // Medvetet tomt: loggning är inte värd att fälla en förfrågan för.
    }
  };
}
