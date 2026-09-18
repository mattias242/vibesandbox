import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext, TenantStore } from '@vibesandbox/contracts';
import { anna, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

describe('Handtagshantering: fler hyresgäster än maxOpenDatabases', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir, { maxOpenDatabases: 2 });
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

  it('data blandas inte och inget kraschar när fler hyresgäster än öppna handtag växlas mellan', async () => {
    const appar: TenantContext[] = Array.from({ length: 5 }, () => tenant(nyttAppId()));
    const dokumentId: string[] = [];

    for (const [i, appTenant] of appar.entries()) {
      const skapat = await store.createDocument(appTenant, anna, 'poster', 'app', { index: i });
      dokumentId.push(skapat.id);
    }

    // Läs i omvänd ordning så handtag som stängts (LRU) med säkerhet måste öppnas om.
    for (let i = appar.length - 1; i >= 0; i--) {
      const appTenant = appar[i];
      const id = dokumentId[i];
      if (appTenant === undefined || id === undefined) {
        throw new Error('testfel: index utanför gränserna');
      }
      const hämtat = await store.getDocument(appTenant, anna, 'poster', id);
      expect(hämtat.data).toEqual({ index: i });
    }

    // Ännu en runda, framlänges, för att verifiera att handtagsväxlingen är stabil över tid.
    for (const [i, appTenant] of appar.entries()) {
      const id = dokumentId[i];
      if (id === undefined) {
        throw new Error('testfel: index utanför gränserna');
      }
      const hämtat = await store.getDocument(appTenant, anna, 'poster', id);
      expect(hämtat.data).toEqual({ index: i });
    }
  });
});
