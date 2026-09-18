import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataApiError, DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import { anna, förväntaFel, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

describe('Kvoter: en app kan inte ta mer än sin del av servern', () => {
  let dataDir: string;
  let städa: () => Promise<void>;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
  });

  afterEach(async () => {
    await städa();
  });

  it('ett dokument över maxDocumentBytes avvisas med too_large', async () => {
    const store = nyButik(dataDir, {
      limits: { ...DEFAULT_TENANT_LIMITS, maxDocumentBytes: 1000 },
    });
    try {
      const app = tenant(nyttAppId());

      await förväntaFel(
        store.createDocument(app, anna, 'poster', 'app', { fyllnad: 'x'.repeat(2000) }),
        'too_large',
      );
    } finally {
      // Stäng även när en förväntan ovan fallerar, så att inga handtag blir hängande.
      await store.close();
    }
  });

  it(
    'en databas som nått maxDatabaseBytes nekar fler skrivningar, men läsning, radering och ' +
      'andra hyresgäster fungerar fortfarande',
    async () => {
      const store = nyButik(dataDir, {
        limits: { ...DEFAULT_TENANT_LIMITS, maxDocumentBytes: 5000, maxDatabaseBytes: 20_000 },
      });
      try {
        const full = tenant(nyttAppId());
        const annan = tenant(nyttAppId());
        const data = { fyllnad: 'x'.repeat(1000) };

        let sistaLyckadeId: string | undefined;
        let kvotenTogSlut = false;
        for (let i = 0; i < 100 && !kvotenTogSlut; i++) {
          try {
            const dok = await store.createDocument(full, anna, 'poster', 'app', data);
            sistaLyckadeId = dok.id;
          } catch (fel) {
            expect(fel).toBeInstanceOf(DataApiError);
            expect((fel as DataApiError).code).toBe('quota_exceeded');
            kvotenTogSlut = true;
          }
        }
        expect(kvotenTogSlut).toBe(true);
        if (sistaLyckadeId === undefined) {
          throw new Error('testfel: inget dokument hann skapas innan kvoten tog slut');
        }

        // Läsning fungerar fortfarande i den fulla appen.
        const hämtat = await store.getDocument(full, anna, 'poster', sistaLyckadeId);
        expect(hämtat.data).toEqual(data);

        // Radering fungerar fortfarande.
        await store.deleteDocument(full, anna, 'poster', sistaLyckadeId);

        // En annan hyresgäst märker ingenting av att den fulla appen är full.
        const dokAnnan = await store.createDocument(annan, anna, 'poster', 'app', { v: 1 });
        expect(dokAnnan.data).toEqual({ v: 1 });
      } finally {
        // Stäng även när en förväntan ovan fallerar, så att inga handtag blir hängande.
        await store.close();
      }
    },
  );

  it('fler kollektioner än maxCollections ger quota_exceeded', async () => {
    const store = nyButik(dataDir, { limits: { ...DEFAULT_TENANT_LIMITS, maxCollections: 3 } });
    try {
      const app = tenant(nyttAppId());

      await store.createDocument(app, anna, 'kollektion-1', 'app', {});
      await store.createDocument(app, anna, 'kollektion-2', 'app', {});
      await store.createDocument(app, anna, 'kollektion-3', 'app', {});

      await förväntaFel(
        store.createDocument(app, anna, 'kollektion-4', 'app', {}),
        'quota_exceeded',
      );
    } finally {
      // Stäng även när en förväntan ovan fallerar, så att inga handtag blir hängande.
      await store.close();
    }
  });
});
