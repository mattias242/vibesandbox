/**
 * Hårda fall: säkerhetsegenskaper som inte syns på den lyckliga vägen.
 *
 * Varje test här motsvarar ett löfte i implementationen som annars bara hade stått i en kommentar:
 * ägarfiltret håller över sidgränser, markören ger ingen behörighet, läsningar lämnar inga spår
 * på disk, ett fabricerat TenantContext blir aldrig en filsökväg, och kvoten är hård på riktigt.
 */
import { readdir, stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DataApiError,
  DEFAULT_TENANT_LIMITS,
  unsafeCreateTenantContext,
  type AppId,
  type CollectionScope,
  type Identity,
  type TenantContext,
  type TenantKind,
  type TenantStore,
} from '@vibesandbox/contracts';
import {
  allaFiler,
  anna,
  bertil,
  förväntaFel,
  nyButik,
  nyttAppId,
  skapaTempDataDir,
  tenant,
} from './hjalp.ts';

const GILTIGT_MEN_OBEFINTLIGT_ID = '0'.repeat(26);

/** Följer markören till listans slut och ger alla dokument i den ordning de kom. */
async function allaSidor(
  store: TenantStore,
  app: TenantContext,
  vem: Identity,
  kollektion: string,
  scope: CollectionScope,
  limit: number,
): Promise<Array<{ id: string; data: unknown }>> {
  const alla: Array<{ id: string; data: unknown }> = [];
  let cursor: string | undefined;
  do {
    const sida = await store.listDocuments(
      app,
      vem,
      kollektion,
      scope,
      cursor === undefined ? { limit } : { limit, cursor },
    );
    alla.push(...sida.documents.map((dok) => ({ id: dok.id, data: dok.data })));
    cursor = sida.nextCursor;
  } while (cursor !== undefined);
  return alla;
}

describe('Hårda fall', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
  });

  afterEach(async () => {
    try {
      await store?.close();
    } finally {
      await städa?.();
    }
  });

  describe('sidindelning i en personlig kollektion', () => {
    it('Anna och Bertil får var och en exakt sina egna dokument, över alla sidor', async () => {
      const app = tenant(nyttAppId());
      const annasId: string[] = [];
      const bertilsId: string[] = [];
      // Omlott, så att den enes rader ligger inflätade mellan den andres i id-ordning.
      for (let i = 0; i < 60; i++) {
        annasId.push((await store.createDocument(app, anna, 'svar', 'user', { vems: 'anna', i })).id);
        bertilsId.push(
          (await store.createDocument(app, bertil, 'svar', 'user', { vems: 'bertil', i })).id,
        );
      }
      for (let i = 60; i < 75; i++) {
        bertilsId.push(
          (await store.createDocument(app, bertil, 'svar', 'user', { vems: 'bertil', i })).id,
        );
      }

      const annas = await allaSidor(store, app, anna, 'svar', 'user', 7);
      const bertils = await allaSidor(store, app, bertil, 'svar', 'user', 7);

      expect(annas.map((dok) => dok.id).sort()).toEqual([...annasId].sort());
      expect(bertils.map((dok) => dok.id).sort()).toEqual([...bertilsId].sort());
      expect(annas.every((dok) => (dok.data as { vems: string }).vems === 'anna')).toBe(true);
      expect(bertils.every((dok) => (dok.data as { vems: string }).vems === 'bertil')).toBe(true);
    });
  });

  describe('markören ger en position, aldrig en behörighet', () => {
    let app: TenantContext;
    let annasMarkör: string;

    beforeEach(async () => {
      app = tenant(nyttAppId());
      for (let i = 0; i < 5; i++) {
        await store.createDocument(app, anna, 'mina', 'user', { vems: 'anna', i });
        await store.createDocument(app, bertil, 'mina', 'user', { vems: 'bertil', i });
        await store.createDocument(app, anna, 'anslag', 'app', { i });
      }
      const sida = await store.listDocuments(app, anna, 'mina', 'user', { limit: 2 });
      if (sida.nextCursor === undefined) throw new Error('testfel: ingen markör att pröva med');
      annasMarkör = sida.nextCursor;
    });

    it('Bertil ser bara sina egna dokument även med Annas markör', async () => {
      const sida = await store.listDocuments(app, bertil, 'mina', 'user', { cursor: annasMarkör });

      expect(sida.documents.length).toBeGreaterThan(0);
      expect(sida.documents.every((dok) => dok.data['vems'] === 'bertil')).toBe(true);
    });

    it('Bertil ser bara sina egna dokument även med en egenhändigt byggd markör från början', async () => {
      // Den som listat ut formatet ska inte vinna något på det. Testet känner formatet med flit.
      const hembyggd = Buffer.from(`v1:user:mina:${GILTIGT_MEN_OBEFINTLIGT_ID}`).toString(
        'base64url',
      );

      const sida = await store.listDocuments(app, bertil, 'mina', 'user', { cursor: hembyggd });

      expect(sida.documents).toHaveLength(5);
      expect(sida.documents.every((dok) => dok.data['vems'] === 'bertil')).toBe(true);
    });

    it('en markör från en annan kollektion eller ett annat scope avvisas', async () => {
      const annatScope = Buffer.from(`v1:app:mina:${GILTIGT_MEN_OBEFINTLIGT_ID}`).toString(
        'base64url',
      );

      await förväntaFel(
        store.listDocuments(app, anna, 'anslag', 'app', { cursor: annasMarkör }),
        'invalid_request',
      );
      await förväntaFel(
        store.listDocuments(app, anna, 'mina', 'user', { cursor: annatScope }),
        'invalid_request',
      );
    });

    it.each([
      ['påhängt tecken', (giltig: string): unknown => `${giltig}A`],
      ['påhängd utfyllnad', (giltig: string): unknown => `${giltig}=`],
      ['5000 tecken', (_giltig: string): unknown => 'x'.repeat(5000)],
      ['tom sträng', (_giltig: string): unknown => ''],
      ['ett tal i stället för en sträng', (_giltig: string): unknown => 42],
      ['null', (_giltig: string): unknown => null],
    ])('en manipulerad markör (%s) avvisas med invalid_request', async (_beskrivning, förvanska) => {
      const cursor = förvanska(annasMarkör) as string;

      await förväntaFel(
        store.listDocuments(app, anna, 'mina', 'user', { cursor }),
        'invalid_request',
      );
    });
  });

  describe('efter close()', () => {
    it('ger varje anrop ett DataApiError i stället för en krasch, och close() går att upprepa', async () => {
      const app = tenant(nyttAppId());
      const dok = await store.createDocument(app, anna, 'poster', 'app', { v: 1 });

      await store.close();
      await expect(store.close()).resolves.toBeUndefined();

      await förväntaFel(store.listDocuments(app, anna, 'poster', 'app'), 'internal');
      await förväntaFel(store.createDocument(app, anna, 'poster', 'app', {}), 'internal');
      await förväntaFel(store.getDocument(app, anna, 'poster', dok.id), 'internal');
      await förväntaFel(store.replaceDocument(app, anna, 'poster', dok.id, {}), 'internal');
      await förväntaFel(store.deleteDocument(app, anna, 'poster', dok.id), 'internal');
      await förväntaFel(store.destroyTenant(app), 'internal');
    });
  });

  describe('spår på disk', () => {
    it('läsningar och avveckling av en aldrig skriven hyresgäst lämnar dataDir tom', async () => {
      // Annars kunde vem som helst som når en app-adress fylla disken med tomma databaser.
      const app = tenant(nyttAppId());

      const sida = await store.listDocuments(app, anna, 'poster', 'app');
      expect(sida.documents).toEqual([]);
      await förväntaFel(
        store.getDocument(app, anna, 'poster', GILTIGT_MEN_OBEFINTLIGT_ID),
        'not_found',
      );
      await förväntaFel(
        store.replaceDocument(app, anna, 'poster', GILTIGT_MEN_OBEFINTLIGT_ID, { v: 1 }),
        'not_found',
      );
      await förväntaFel(
        store.deleteDocument(app, anna, 'poster', GILTIGT_MEN_OBEFINTLIGT_ID),
        'not_found',
      );
      await store.destroyTenant(app);

      expect(await readdir(dataDir)).toEqual([]);
    });

    it('avvisade skrivningar (ogiltigt namn, ogiltig data, för stort) lämnar dataDir tom', async () => {
      const app = tenant(nyttAppId());
      const förStort = { fyllnad: 'x'.repeat(DEFAULT_TENANT_LIMITS.maxDocumentBytes) };

      await förväntaFel(store.createDocument(app, anna, '../x', 'app', {}), 'invalid_request');
      await förväntaFel(
        store.createDocument(app, anna, 'poster', 'app', { v: Number.NaN }),
        'invalid_request',
      );
      await förväntaFel(store.createDocument(app, anna, 'poster', 'app', förStort), 'too_large');

      expect(await readdir(dataDir)).toEqual([]);
    });
  });

  describe('ett fabricerat TenantContext blir aldrig en filsökväg', () => {
    const giltigtAppId = 'a'.repeat(26);
    const fientliga: Array<[beskrivning: string, appId: unknown, kind: unknown]> = [
      ['katalogtraversering i app-id', '../../etc', 'published'],
      ['giltigt app-id följt av /..', `${giltigtAppId}/..`, 'published'],
      ['NUL-byte i app-id', `${'a'.repeat(25)}${String.fromCharCode(0)}`, 'published'],
      ['versaler i app-id', 'A'.repeat(26), 'published'],
      ['tomt app-id', '', 'published'],
      ['app-id saknas', undefined, 'published'],
      ['app-id är ett tal', 42, 'published'],
      ['katalogtraversering i kind', giltigtAppId, '../draft'],
      ['kind som finns på Object.prototype', giltigtAppId, 'constructor'],
      ['kind saknas', giltigtAppId, undefined],
    ];

    it.each(fientliga)('%s ⇒ fel, och ingenting skapas på disk', async (_beskrivning, appId, kind) => {
      // Castningen är avsikten: TenantContext är bara en typ, och en bugg uppströms får inte
      // kunna bli en katalogtraversering här.
      const fientlig = unsafeCreateTenantContext(appId as AppId, kind as TenantKind);

      await förväntaFel(store.createDocument(fientlig, anna, 'poster', 'app', {}), 'internal');
      await förväntaFel(store.listDocuments(fientlig, anna, 'poster', 'app'), 'internal');
      await förväntaFel(store.destroyTenant(fientlig), 'internal');

      expect(await readdir(dataDir)).toEqual([]);
    });
  });

  describe('identitet', () => {
    it.each([
      ['tomt', ''],
      ['saknat', undefined],
      ['ett tal', 7],
    ])('%s userId ⇒ unauthenticated — okända användare får aldrig dela ägare', async (_b, userId) => {
      const app = tenant(nyttAppId());
      const okänd = { ...anna, userId } as unknown as Identity;

      await förväntaFel(store.createDocument(app, okänd, 'svar', 'user', {}), 'unauthenticated');
      await förväntaFel(store.listDocuments(app, okänd, 'svar', 'user'), 'unauthenticated');
      await förväntaFel(
        store.getDocument(app, okänd, 'svar', GILTIGT_MEN_OBEFINTLIGT_ID),
        'unauthenticated',
      );
    });
  });

  describe('kvoten är hård', () => {
    it('efter fyll-tills-fullt går varje radering igenom, och databasfilen överstiger aldrig maxDatabaseBytes', async () => {
      const maxDatabaseBytes = 20_000;
      const full = nyButik(dataDir, {
        limits: { ...DEFAULT_TENANT_LIMITS, maxDocumentBytes: 5000, maxDatabaseBytes },
      });
      try {
        const app = tenant(nyttAppId());

        async function databasfilensStorlek(): Promise<number> {
          const filer = (await allaFiler(dataDir)).filter((fil) => fil.endsWith('.sqlite'));
          expect(filer).toHaveLength(1);
          const fil = filer[0];
          if (fil === undefined) throw new Error('testfel: databasfilen saknas');
          return (await stat(fil)).size;
        }

        // Tre varv: fyll med blandade storlekar tills även ett litet dokument nekas, radera sedan
        // allt. Varv två och tre går mot en fil som redan är fullstor och full av frisidor.
        const storlekar = [4000, 1500, 300, 2500, 40, 900];
        for (let varv = 0; varv < 3; varv++) {
          const skapade: string[] = [];
          let nekadeIRad = 0;
          for (let i = 0; nekadeIRad < storlekar.length; i++) {
            const storlek = storlekar[i % storlekar.length] ?? 40;
            try {
              const dok = await full.createDocument(app, anna, 'poster', 'app', {
                fyllnad: 'x'.repeat(storlek),
              });
              skapade.push(dok.id);
              nekadeIRad = 0;
            } catch (fel) {
              expect(fel).toBeInstanceOf(DataApiError);
              expect((fel as DataApiError).code).toBe('quota_exceeded');
              nekadeIRad += 1;
            }
            expect(await databasfilensStorlek()).toBeLessThanOrEqual(maxDatabaseBytes);
            if (i > 500) throw new Error('testfel: kvoten tog aldrig slut');
          }
          expect(skapade.length).toBeGreaterThan(0);

          // Varannan först, resten sedan — så att raderingarna inte sker i trädets ordning.
          const ordning = [
            ...skapade.filter((_id, i) => i % 2 === 0),
            ...skapade.filter((_id, i) => i % 2 === 1).reverse(),
          ];
          for (const id of ordning) {
            await full.deleteDocument(app, anna, 'poster', id);
            expect(await databasfilensStorlek()).toBeLessThanOrEqual(maxDatabaseBytes);
          }
          const tom = await full.listDocuments(app, anna, 'poster', 'app');
          expect(tom.documents).toEqual([]);
        }

        // Vid stängning förs allt i WAL-filen över till databasfilen; gränsen ska hålla även då.
        await full.close();
        expect(await databasfilensStorlek()).toBeLessThanOrEqual(maxDatabaseBytes);
      } finally {
        await full.close();
      }
    });
  });
});
