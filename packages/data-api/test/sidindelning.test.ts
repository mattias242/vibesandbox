import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_LIMITS, type TenantContext, type TenantStore } from '@vibesandbox/contracts';
import { anna, förväntaFel, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

const ANTAL_DOKUMENT = 250;

/**
 * `exactOptionalPropertyTypes` tillåter inte `{ cursor: undefined }` för en valfri
 * egenskap — bygg options-objektet så att nyckeln saknas helt när det inte finns
 * någon markör att skicka med.
 */
function sidoOptioner(cursor: string | undefined): { readonly cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

describe('Sidindelning av långa listor', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;
  let app: TenantContext;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
    app = tenant(nyttAppId());
    for (let i = 0; i < ANTAL_DOKUMENT; i++) {
      await store.createDocument(app, anna, 'poster', 'app', { index: i });
    }
  });

  afterEach(async () => {
    // Kastar beforeEach innan `store` hunnit skapas får det inte hindra städningen — annars
    // blir den temporära katalogen kvar på disk efter varje rött test.
    try {
      await store?.close();
    } finally {
      await städa?.();
    }
  });

  async function hämtaAllaSidor(): Promise<string[]> {
    const alla: string[] = [];
    let cursor: string | undefined;
    do {
      const sida = await store.listDocuments(app, anna, 'poster', 'app', sidoOptioner(cursor));
      expect(sida.documents.length).toBeLessThanOrEqual(DEFAULT_TENANT_LIMITS.maxPageSize);
      alla.push(...sida.documents.map((dok) => dok.id));
      cursor = sida.nextCursor;
    } while (cursor !== undefined);
    return alla;
  }

  it('en sida innehåller högst maxPageSize dokument och en markör till nästa sida', async () => {
    const sida = await store.listDocuments(app, anna, 'poster', 'app');

    expect(sida.documents.length).toBeLessThanOrEqual(DEFAULT_TENANT_LIMITS.maxPageSize);
    expect(sida.nextCursor).toBeDefined();
  });

  it('att följa markören ger alla dokument exakt en gång', async () => {
    const alla = await hämtaAllaSidor();

    expect(alla).toHaveLength(ANTAL_DOKUMENT);
    expect(new Set(alla).size).toBe(ANTAL_DOKUMENT);
  });

  it('sista sidan saknar nextCursor', async () => {
    let cursor: string | undefined;
    let sistaSvaret: Awaited<ReturnType<TenantStore['listDocuments']>> | undefined;
    do {
      sistaSvaret = await store.listDocuments(app, anna, 'poster', 'app', sidoOptioner(cursor));
      cursor = sistaSvaret.nextCursor;
    } while (cursor !== undefined);

    if (sistaSvaret === undefined) {
      throw new Error('testfel: listDocuments anropades aldrig');
    }
    expect(sistaSvaret.nextCursor).toBeUndefined();
  });

  it('ordningen är stabil mellan två identiska genomlöpningar', async () => {
    const första = await hämtaAllaSidor();
    const andra = await hämtaAllaSidor();

    expect(andra).toEqual(första);
  });

  it('en limit över maxPageSize kläms till maxPageSize', async () => {
    const sida = await store.listDocuments(app, anna, 'poster', 'app', {
      limit: DEFAULT_TENANT_LIMITS.maxPageSize * 10,
    });

    expect(sida.documents.length).toBeLessThanOrEqual(DEFAULT_TENANT_LIMITS.maxPageSize);
  });

  it('en ogiltig markör avvisas med invalid_request', async () => {
    await förväntaFel(
      store.listDocuments(app, anna, 'poster', 'app', { cursor: 'uppenbart-ogiltig-markör' }),
      'invalid_request',
    );
  });
});
