/**
 * Testhjälp för @vibesandbox/data-api. Ingen produktionskod importerar detta.
 *
 * Håller nere upprepning i testfilerna: fabriker för app-id, identiteter och
 * tillfälliga datakataloger, samt en gemensam assert-hjälp för DataApiError.
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — här är det
 * explicit tillåtet eftersom det är den enda vägen att bygga ett TenantContext
 * i ett enhetstest.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  DataApiError,
  isAppId,
  unsafeCreateTenantContext,
  type ApiErrorCode,
  type AppId,
  type Identity,
  type TenantContext,
  type TenantKind,
  type TenantStore,
} from '@vibesandbox/contracts';
import { createTenantStore, type TenantStoreOptions } from '@vibesandbox/data-api';

/** Crockford-base32-alfabetet som app-id och dokument-id byggs av (utesluter i, l, o, u). */
const ALFABET = '0123456789abcdefghjkmnpqrstvwxyz';

function bas32(tal: number, längd: number): string {
  let resultat = '';
  let n = tal;
  for (let i = 0; i < längd; i++) {
    resultat = ALFABET[n % 32] + resultat;
    n = Math.floor(n / 32);
  }
  return resultat;
}

let appIdRäknare = 0;

/** Ger ett nytt, giltigt app-id varje gång — garanterat unikt inom en testkörning. */
export function nyttAppId(): AppId {
  appIdRäknare += 1;
  const kandidat = bas32(appIdRäknare, 26);
  if (!isAppId(kandidat)) {
    throw new Error(
      `Testhjälpen genererade ett app-id som inte matchar APP_ID_PATTERN: ${kandidat}`,
    );
  }
  return kandidat;
}

/** Enda tillåtna platsen utanför gatewayn att skapa ett TenantContext. */
export function tenant(appId: AppId, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

export const anna: Identity = {
  userId: 'anv-anna',
  email: 'anna.andersson@exempel.se',
  roles: ['viewer'],
};

export const bertil: Identity = {
  userId: 'anv-bertil',
  email: 'bertil.bertilsson@exempel.se',
  roles: ['viewer'],
};

/** Skapar en tom, temporär datakatalog. Kör den returnerade städfunktionen i afterEach. */
export async function skapaTempDataDir(): Promise<{
  dataDir: string;
  städa: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-data-api-'));
  return {
    dataDir,
    städa: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** Bekvämlighetsomslag runt createTenantStore mot en given datakatalog. */
export function nyButik(
  dataDir: string,
  tillägg: Partial<TenantStoreOptions> = {},
): TenantStore {
  return createTenantStore({ dataDir, ...tillägg });
}

/** Väntar in att ett löfte avvisas med en DataApiError av given felkod — aldrig på meddelandetext. */
export async function förväntaFel(löfte: Promise<unknown>, kod: ApiErrorCode): Promise<void> {
  await expect(löfte).rejects.toBeInstanceOf(DataApiError);
  await expect(löfte).rejects.toMatchObject({ code: kod });
}

/** Alla filer (inte kataloger) under en katalog, som fullständiga sökvägar i sorterad ordning. */
export async function allaFiler(rot: string): Promise<string[]> {
  const poster = await readdir(rot, { recursive: true, withFileTypes: true });
  return poster
    .filter((post) => post.isFile())
    .map((post) => join(post.parentPath, post.name))
    .sort();
}
