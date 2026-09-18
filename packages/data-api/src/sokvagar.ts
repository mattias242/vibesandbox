/**
 * Var en hyresgästs databas ligger på disk.
 *
 * Säkerhetsregeln: data från en app används ALDRIG för att bygga en filsökväg. Sökvägen härleds
 * enbart ur `tenant.appId` och `tenant.kind` — och de valideras här en gång till, trots att
 * gatewayn redan ska ha gjort det. Ett TenantContext är bara en TypeScript-typ; i körning är det
 * ett vanligt objekt, och en bugg uppströms får inte bli en katalogtraversering här.
 *
 * Layout: <dataDir>/<appId>-<kind>/data.sqlite (+ SQLite:s egna -wal och -shm bredvid).
 * `published` och `draft` får olika kataloger och är därmed olika hyresgäster: utkast är
 * ogranskad kod och får aldrig dela data med den publicerade appen.
 */
import { resolve, sep } from 'node:path';
import { APP_ID_PATTERN, type TenantContext } from '@vibesandbox/contracts';
import { dataApiError } from './fel.ts';

/**
 * Tillåtna värden för `kind` och det katalogsuffix var och en ger. En Map i stället för ett
 * objekt, så att nycklar som "constructor" eller "__proto__" inte kan ge träff via prototypen.
 */
const KIND_SUFFIX: ReadonlyMap<unknown, string> = new Map([
  ['published', 'published'],
  ['draft', 'draft'],
]);

const DATABASE_FILE_NAME = 'data.sqlite';

export interface TenantPaths {
  /** Entydig nyckel för hyresgästen; används av handtagscachen. Samma som katalognamnet. */
  readonly key: string;
  /** Hyresgästens katalog. Allt i den tillhör hyresgästen och raderas vid avveckling. */
  readonly directory: string;
  readonly databaseFile: string;
}

export function tenantPaths(dataDir: string, tenant: TenantContext): TenantPaths {
  const appId: unknown = tenant?.appId;
  const suffix = KIND_SUFFIX.get(tenant?.kind);
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || suffix === undefined) {
    // Klienten kan inte ha orsakat detta på ett legitimt sätt — det är ett fel i plattformen.
    // Därför `internal` (syns i övervakningen) och inget eko av det ogiltiga värdet.
    throw dataApiError('internal', 'Appens identitet kunde inte fastställas.');
  }

  const key = `${appId}-${suffix}`;
  const root = resolve(dataDir);
  const directory = resolve(root, key);

  // Hängslen och livrem: mönstret ovan tillåter bara [0-9a-z], så detta kan inte slå till i dag.
  // Kontrollen finns kvar för den dag någon ändrar mönstret eller layouten.
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (!directory.startsWith(rootPrefix) || resolve(directory, '..') !== root) {
    throw dataApiError('internal', 'Appens identitet kunde inte fastställas.');
  }

  return { key, directory, databaseFile: resolve(directory, DATABASE_FILE_NAME) };
}
