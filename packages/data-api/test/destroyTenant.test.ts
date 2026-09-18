import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantStore } from '@vibesandbox/contracts';
import { allaFiler, anna, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

describe('destroyTenant: avveckling av en hyresgäst', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
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

  it('raderar all data och filerna på disk för hyresgästen, men rör inte andra', async () => {
    const skaAvvecklas = tenant(nyttAppId());
    const oberörd = tenant(nyttAppId());

    await store.createDocument(skaAvvecklas, anna, 'poster', 'app', { v: 1 });
    await store.createDocument(oberörd, anna, 'poster', 'app', { v: 2 });

    const filerFöre = await allaFiler(dataDir);

    await store.destroyTenant(skaAvvecklas);

    const filerEfter = await allaFiler(dataDir);
    expect(filerEfter.length).toBeLessThan(filerFöre.length);

    const listaAvvecklad = await store.listDocuments(skaAvvecklas, anna, 'poster', 'app');
    expect(listaAvvecklad.documents).toEqual([]);

    const listaOberörd = await store.listDocuments(oberörd, anna, 'poster', 'app');
    expect(listaOberörd.documents).toHaveLength(1);
    expect(listaOberörd.documents[0]?.data).toEqual({ v: 2 });
  });

  it('hyresgästen går att använda igen efteråt, och börjar tom', async () => {
    const app = tenant(nyttAppId());
    await store.createDocument(app, anna, 'poster', 'app', { v: 1 });

    await store.destroyTenant(app);

    const sida = await store.listDocuments(app, anna, 'poster', 'app');
    expect(sida.documents).toEqual([]);

    const nytt = await store.createDocument(app, anna, 'poster', 'app', { v: 'nytt liv' });
    expect(nytt.data).toEqual({ v: 'nytt liv' });

    const hämtat = await store.getDocument(app, anna, 'poster', nytt.id);
    expect(hämtat.data).toEqual({ v: 'nytt liv' });
  });
});
