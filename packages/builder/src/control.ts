/**
 * Den del av control som byggverktyget använder. Smalt med flit: byggverktyget kan skapa appar,
 * lägga in byggda versioner, peka ut utkast och publicera — men inte ta bort appar eller läsa
 * andras filer. `@vibesandbox/control` uppfyller gränssnittet som det är.
 */
import { isAppId } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';

export interface BuilderControl {
  createApp(): Promise<AppId>;
  importVersion(appId: AppId, directory: string): Promise<string>;
  setDraft(appId: AppId, versionId: string): Promise<void>;
  publish(appId: AppId, versionId: string): Promise<void>;
}

/** App-id ur byggverktygets egen databas; kontrolleras ändå innan det lämnas vidare. */
export function storedAppId(value: string): AppId {
  if (!isAppId(value)) throw new Error('Ett sparat app-id har fel format.');
  return value;
}
