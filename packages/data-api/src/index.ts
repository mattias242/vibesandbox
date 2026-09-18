import type { TenantLimits, TenantStore } from '@vibesandbox/contracts';

export interface TenantStoreOptions {
  /** Rotkatalog för all appdata. Varje hyresgäst får en egen underkatalog som plattformen namnger. */
  readonly dataDir: string;
  readonly limits?: TenantLimits;
  /** Högsta antal samtidigt öppna SQLite-databaser; de minst nyligen använda stängs. */
  readonly maxOpenDatabases?: number;
}

export function createTenantStore(_options: TenantStoreOptions): TenantStore {
  throw new Error('inte implementerat');
}
