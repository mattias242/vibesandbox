/**
 * Den del av control som byggverktyget använder. Smalt med flit: byggverktyget kan skapa appar,
 * lägga in byggda versioner, peka ut utkast, publicera och sköta appens åtkomstlista — men inte ta
 * bort appar eller läsa andras filer. `@vibesandbox/control` uppfyller gränssnittet som det är.
 */
import { isAppId } from '@vibesandbox/contracts';
import type { AppAccessRole, AppId } from '@vibesandbox/contracts';

/** En rad i control:s åtkomstlista, så som byggverktyget läser den. */
export interface BuilderAccessEntry {
  readonly userId: string;
  readonly role: AppAccessRole;
  /** Saknas för en ägare som lades in utan adress (appar från före åtkomstlistan). */
  readonly email: string | null;
}

export interface BuilderControl {
  createApp(): Promise<AppId>;
  importVersion(appId: AppId, directory: string): Promise<string>;
  setDraft(appId: AppId, versionId: string): Promise<void>;
  publish(appId: AppId, versionId: string): Promise<void>;
  /** Idempotent. En ägare nedgraderas aldrig; en andra ägare ⇒ fel med koden `access_rejected`. */
  grantAccess(appId: AppId, userId: string, role: AppAccessRole, email: string | null): Promise<void>;
  /** Okänd rad ⇒ inget händer. Ägaren går inte att ta bort (`access_rejected`). */
  revokeAccess(appId: AppId, userId: string): Promise<void>;
  /** Ägaren först, sedan användarna i den ordning de lades till. */
  listAccess(appId: AppId): Promise<readonly BuilderAccessEntry[]>;
}

/**
 * Control:s fel har en fast `code` (`ControlError`). Byggverktyget bygger bara mot kontrakten och
 * kan inte importera klassen, så koden läses av strukturellt.
 */
export function controlErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** App-id ur byggverktygets egen databas; kontrolleras ändå innan det lämnas vidare. */
export function storedAppId(value: string): AppId {
  if (!isAppId(value)) throw new Error('Ett sparat app-id har fel format.');
  return value;
}
