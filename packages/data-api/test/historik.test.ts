/**
 * Ändringshistoriken i data-API:t: skrivs i samma transaktion som ändringen, syns efter samma
 * regler som dokumenten, gallras efter kvarhållningstiden och ryms inom appens lagringskvot.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_LIMITS, type HistoryPage, type TenantContext, type TenantStore } from '@vibesandbox/contracts';
import { createTenantStore } from '@vibesandbox/data-api';
import { anna, bertil, förväntaFel, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

type HistoryStore = TenantStore & Required<Pick<TenantStore, 'readDocumentHistory' | 'readCollectionHistory' | 'restoreDocument'>>;

function medHistorik(dataDir: string, extra: Partial<Parameters<typeof createTenantStore>[0]> = {}): HistoryStore {
  const store = createTenantStore({ dataDir, history: { retentionDays: 365 }, ...extra });
  if (store.readDocumentHistory === undefined || store.readCollectionHistory === undefined || store.restoreDocument === undefined) {
    throw new Error('Historiken saknas trots att den slagits på.');
  }
  return store as HistoryStore;
}

function databasfil(dataDir: string, app: TenantContext): string {
  return join(dataDir, `${app.appId}-${app.kind}`, 'data.sqlite');
}

function tabeller(fil: string): string[] {
  const db = new DatabaseSync(fil, { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((rad) => String(rad['name']));
  } finally {
    db.close();
  }
}

function sammanfatta(sida: HistoryPage) {
  return sida.entries.map((rad) => ({ event: rad.event, userId: rad.userId, data: rad.data }));
}

describe('ändringshistorik i data-API:t', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: HistoryStore;
  let app: TenantContext;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = medHistorik(dataDir);
    app = tenant(nyttAppId());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
    await städa();
  });

  describe('avstängd som standard', () => {
    it('utan valet finns inga historikmetoder och ingen historiktabell', async () => {
      const utan = createTenantStore({ dataDir: join(dataDir, 'utan') });
      try {
        expect(utan.readDocumentHistory).toBeUndefined();
        expect(utan.readCollectionHistory).toBeUndefined();
        expect(utan.restoreDocument).toBeUndefined();
        await utan.createDocument(app, anna, 'poster', 'app', { a: 1 });
        expect(tabeller(databasfil(join(dataDir, 'utan'), app))).toEqual(['collections', 'documents']);
      } finally {
        await utan.close();
      }
    });

    it('ogiltig kvarhållningstid stoppar uppstarten', () => {
      for (const retentionDays of [0, -1, 1.5, Number.NaN, 'abc', '', '12x', 100_000]) {
        expect(() => createTenantStore({ dataDir, history: { retentionDays } })).toThrow(TypeError);
      }
    });

    it('kvarhållningstiden kan anges som text ur miljön, och saknas den gäller standardvärdet', async () => {
      await createTenantStore({ dataDir, history: { retentionDays: '30' } }).close();
      await createTenantStore({ dataDir, history: { retentionDays: undefined } }).close();
      await createTenantStore({ dataDir, history: {} }).close();
    });
  });

  describe('skrivs vid varje ändring', () => {
    it('skapa, ersätta och radera ger var sin rad, nyast först, med den inloggade och innehållet', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { status: 'ny' });
      const ersatt = await store.replaceDocument(app, bertil, 'arenden', dok.id, { status: 'klar' });
      await store.deleteDocument(app, anna, 'arenden', dok.id);

      const sida = await store.readDocumentHistory(app, bertil, 'arenden', dok.id);
      expect(sammanfatta(sida)).toEqual([
        { event: 'delete', userId: 'anv-anna', data: { status: 'klar' } },
        { event: 'replace', userId: 'anv-bertil', data: { status: 'klar' } },
        { event: 'create', userId: 'anv-anna', data: { status: 'ny' } },
      ]);
      expect(sida.entries[1]?.at).toBe(ersatt.updatedAt);
      expect(sida.entries[2]?.at).toBe(dok.createdAt);
      expect(sida.entries.every((rad) => rad.collection === 'arenden' && rad.documentId === dok.id)).toBe(true);
      expect(JSON.stringify(sida)).not.toContain('@');
    });

    it('ett dokument som inte har någon historik "finns inte"', async () => {
      await förväntaFel(store.readDocumentHistory(app, anna, 'arenden', '0'.repeat(26)), 'not_found');
      await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      await förväntaFel(store.readDocumentHistory(app, anna, 'arenden', '0'.repeat(26)), 'not_found');
    });
  });

  describe('misslyckade skrivningar ger ingen rad', () => {
    it('nekad ersättning, nekad radering, fel scope och ogiltigt innehåll lämnar historiken orörd', async () => {
      const dok = await store.createDocument(app, anna, 'privat', 'user', { anteckning: 'hemlig' });
      await förväntaFel(store.replaceDocument(app, bertil, 'privat', dok.id, { anteckning: 'kapad' }), 'not_found');
      await förväntaFel(store.deleteDocument(app, bertil, 'privat', dok.id), 'not_found');
      await förväntaFel(store.createDocument(app, anna, 'privat', 'app', { a: 1 }), 'scope_mismatch');
      await förväntaFel(store.replaceDocument(app, anna, 'privat', dok.id, { fel: undefined } as never), 'invalid_request');
      await förväntaFel(
        store.replaceDocument(app, anna, 'privat', dok.id, { stor: 'x'.repeat(DEFAULT_TENANT_LIMITS.maxDocumentBytes) }),
        'too_large',
      );

      const sida = await store.readDocumentHistory(app, anna, 'privat', dok.id);
      expect(sammanfatta(sida)).toEqual([{ event: 'create', userId: 'anv-anna', data: { anteckning: 'hemlig' } }]);
    });

    it('går historikraden inte att skriva blir ändringen inte av (samma transaktion)', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { status: 'ny' });
      // En annan anslutning lägger en utlösare som stoppar varje ny historikrad.
      const db = new DatabaseSync(databasfil(dataDir, app));
      db.exec("CREATE TRIGGER stoppa BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'stopp'); END");
      db.close();

      await förväntaFel(store.replaceDocument(app, anna, 'arenden', dok.id, { status: 'klar' }), 'internal');
      await förväntaFel(store.deleteDocument(app, anna, 'arenden', dok.id), 'internal');
      await förväntaFel(store.createDocument(app, anna, 'arenden', 'app', { status: 'två' }), 'internal');

      expect((await store.getDocument(app, anna, 'arenden', dok.id)).data).toEqual({ status: 'ny' });
      expect((await store.listDocuments(app, anna, 'arenden', 'app')).documents).toHaveLength(1);
    });
  });

  describe('synlighet', () => {
    it('ett personligt dokuments historik syns bara för ägaren', async () => {
      const dok = await store.createDocument(app, anna, 'privat', 'user', { anteckning: 'hemlig' });
      await förväntaFel(store.readDocumentHistory(app, bertil, 'privat', dok.id), 'not_found');
      expect((await store.readDocumentHistory(app, anna, 'privat', dok.id)).entries).toHaveLength(1);
    });

    it('kollektionens historik: gemensam för alla, personlig bara ens egen', async () => {
      await store.createDocument(app, anna, 'privat', 'user', { vem: 'anna' });
      await store.createDocument(app, bertil, 'privat', 'user', { vem: 'bertil' });
      await store.createDocument(app, anna, 'arenden', 'app', { vem: 'anna' });

      expect(sammanfatta(await store.readCollectionHistory(app, bertil, 'privat'))).toEqual([
        { event: 'create', userId: 'anv-bertil', data: { vem: 'bertil' } },
      ]);
      expect((await store.readCollectionHistory(app, bertil, 'arenden')).entries).toHaveLength(1);
      expect((await store.readCollectionHistory(app, bertil, 'finns-inte')).entries).toEqual([]);
    });

    it('en annan app, och utkastet, ser inte appens historik', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      await förväntaFel(store.readDocumentHistory(tenant(nyttAppId()), anna, 'arenden', dok.id), 'not_found');
      await förväntaFel(store.readDocumentHistory(tenant(app.appId, 'draft'), anna, 'arenden', dok.id), 'not_found');
      expect((await store.readCollectionHistory(tenant(nyttAppId()), anna, 'arenden')).entries).toEqual([]);
    });

    it('läsning av en app som aldrig sparat något skapar inget på disk', async () => {
      const tom = tenant(nyttAppId());
      await store.readCollectionHistory(tom, anna, 'arenden');
      await förväntaFel(store.readDocumentHistory(tom, anna, 'arenden', '0'.repeat(26)), 'not_found');
      expect(existsSync(databasfil(dataDir, tom))).toBe(false);
    });
  });

  describe('fientliga indata', () => {
    it('dokument-id och kollektionsnamn med ../, NUL eller fel skiftläge avvisas', async () => {
      for (const id of ['../../etc/passwd', '..', `${'0'.repeat(25)}\u0000`, '0'.repeat(25).toUpperCase() + 'A']) {
        await förväntaFel(store.readDocumentHistory(app, anna, 'arenden', id), 'invalid_request');
        await förväntaFel(store.restoreDocument(app, anna, 'arenden', id, new Date().toISOString()), 'invalid_request');
      }
      for (const namn of ['../x', 'Arenden', '', 'a'.repeat(65)]) {
        await förväntaFel(store.readCollectionHistory(app, anna, namn), 'invalid_request');
      }
    });

    it('ogiltig tid, sidstorlek och markör avvisas', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      for (const since of ['igår', '2026-01-01', '2026-13-01T00:00:00.000Z', 42 as unknown as string]) {
        await förväntaFel(store.readCollectionHistory(app, anna, 'arenden', { since }), 'invalid_request');
      }
      for (const at of ['nu', '', '2026-01-01T00:00:00Z']) {
        await förväntaFel(store.restoreDocument(app, anna, 'arenden', dok.id, at), 'invalid_request');
      }
      await förväntaFel(store.readDocumentHistory(app, anna, 'arenden', dok.id, { limit: 0 }), 'invalid_request');
      for (const cursor of ['x', 'aDE6MQ', Buffer.from('h1:-1').toString('base64url'), 'a'.repeat(500)]) {
        await förväntaFel(store.readDocumentHistory(app, anna, 'arenden', dok.id, { cursor }), 'invalid_request');
      }
    });
  });

  describe('sidindelning och "sedan"', () => {
    it('sidor nyast först med markör, och kollektionens historik efter en tidpunkt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { n: 0 });
      for (let n = 1; n <= 4; n++) {
        vi.setSystemTime(new Date(`2026-09-0${n + 1}T10:00:00.000Z`));
        await store.replaceDocument(app, anna, 'arenden', dok.id, { n });
      }

      const forsta = await store.readDocumentHistory(app, anna, 'arenden', dok.id, { limit: 2 });
      expect(forsta.entries.map((rad) => rad.data['n'])).toEqual([4, 3]);
      expect(forsta.nextCursor).toBeTypeOf('string');
      const andra = await store.readDocumentHistory(app, anna, 'arenden', dok.id, { limit: 2, cursor: forsta.nextCursor ?? '' });
      expect(andra.entries.map((rad) => rad.data['n'])).toEqual([2, 1]);
      const tredje = await store.readDocumentHistory(app, anna, 'arenden', dok.id, { limit: 2, cursor: andra.nextCursor ?? '' });
      expect(tredje.entries.map((rad) => rad.data['n'])).toEqual([0]);
      expect(tredje.nextCursor).toBeUndefined();

      const sedan = await store.readCollectionHistory(app, anna, 'arenden', { since: '2026-09-03T10:00:00.000Z' });
      expect(sedan.entries.map((rad) => rad.data['n'])).toEqual([4, 3]);
    });
  });

  describe('återställning', () => {
    it('skriver en ny version med innehållet från den tidpunkten, och loggar den', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { status: 'ny' });
      vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
      await store.replaceDocument(app, bertil, 'arenden', dok.id, { status: 'fel' });
      vi.setSystemTime(new Date('2026-09-03T10:00:00.000Z'));

      const aterstallt = await store.restoreDocument(app, anna, 'arenden', dok.id, dok.createdAt);
      expect(aterstallt).toMatchObject({ id: dok.id, data: { status: 'ny' }, createdAt: dok.createdAt, updatedAt: '2026-09-03T10:00:00.000Z' });
      expect((await store.getDocument(app, bertil, 'arenden', dok.id)).data).toEqual({ status: 'ny' });
      const [overst] = (await store.readDocumentHistory(app, anna, 'arenden', dok.id)).entries;
      expect(overst).toMatchObject({ event: 'restore', userId: 'anv-anna', data: { status: 'ny' }, at: '2026-09-03T10:00:00.000Z' });
    });

    it('ett raderat dokument återskapas med samma id och samma ägare', async () => {
      const dok = await store.createDocument(app, anna, 'privat', 'user', { anteckning: 'viktig' });
      await store.deleteDocument(app, anna, 'privat', dok.id);
      await förväntaFel(store.getDocument(app, anna, 'privat', dok.id), 'not_found');

      const aterskapat = await store.restoreDocument(app, anna, 'privat', dok.id, dok.createdAt);
      expect(aterskapat.id).toBe(dok.id);
      expect((await store.getDocument(app, anna, 'privat', dok.id)).data).toEqual({ anteckning: 'viktig' });
      await förväntaFel(store.getDocument(app, bertil, 'privat', dok.id), 'not_found');
    });

    it('en tid som inte finns ger not_found, en radering går inte att återställa till', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      await förväntaFel(store.restoreDocument(app, anna, 'arenden', dok.id, '2001-01-01T00:00:00.000Z'), 'not_found');
      vi.setSystemTime(new Date('2026-09-01T10:00:01.000Z'));
      await store.deleteDocument(app, anna, 'arenden', dok.id);
      const [radering] = (await store.readDocumentHistory(app, anna, 'arenden', dok.id)).entries;
      await förväntaFel(store.restoreDocument(app, anna, 'arenden', dok.id, radering?.at ?? ''), 'invalid_request');
    });

    it('tiderna är strikt stigande per dokument, även inom samma millisekund och med bakåtställd klocka', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { v: 1 });
      const andra = await store.replaceDocument(app, anna, 'arenden', dok.id, { v: 2 });
      vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
      await store.replaceDocument(app, anna, 'arenden', dok.id, { v: 3 });
      await store.deleteDocument(app, anna, 'arenden', dok.id);

      const tider = (await store.readDocumentHistory(app, anna, 'arenden', dok.id)).entries.map((rad) => rad.at);
      expect(tider).toEqual([
        '2026-09-01T10:00:00.003Z',
        '2026-09-01T10:00:00.002Z',
        '2026-09-01T10:00:00.001Z',
        '2026-09-01T10:00:00.000Z',
      ]);
      expect(andra.updatedAt).toBe('2026-09-01T10:00:00.001Z');
      // Varje tid pekar ut exakt en version.
      expect((await store.restoreDocument(app, anna, 'arenden', dok.id, dok.createdAt)).data).toEqual({ v: 1 });
      expect((await store.restoreDocument(app, anna, 'arenden', dok.id, andra.updatedAt)).data).toEqual({ v: 2 });
    });

    it('någon annans personliga dokument kan inte återställas, och försöket syns inte', async () => {
      const dok = await store.createDocument(app, anna, 'privat', 'user', { anteckning: 'hemlig' });
      await förväntaFel(store.restoreDocument(app, bertil, 'privat', dok.id, dok.createdAt), 'not_found');
      await förväntaFel(store.restoreDocument(tenant(nyttAppId()), anna, 'privat', dok.id, dok.createdAt), 'not_found');
      expect((await store.readDocumentHistory(app, anna, 'privat', dok.id)).entries).toHaveLength(1);
    });
  });

  describe('gallring', () => {
    it('rader äldre än kvarhållningstiden syns inte och rensas vid nästa skrivning', async () => {
      await store.close();
      store = medHistorik(dataDir, { history: { retentionDays: 30 } });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { v: 'gammal' });
      vi.setSystemTime(new Date('2026-01-20T00:00:00.000Z'));
      await store.replaceDocument(app, anna, 'arenden', dok.id, { v: 'mellan' });

      vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
      expect((await store.readDocumentHistory(app, anna, 'arenden', dok.id)).entries.map((r) => r.data['v'])).toEqual(['mellan']);
      await förväntaFel(store.restoreDocument(app, anna, 'arenden', dok.id, dok.createdAt), 'not_found');

      await store.replaceDocument(app, anna, 'arenden', dok.id, { v: 'ny' });
      const db = new DatabaseSync(databasfil(dataDir, app), { readOnly: true });
      const antal = db.prepare('SELECT count(*) AS antal FROM history').get()?.['antal'];
      db.close();
      expect(antal).toBe(2);
    });
  });

  describe('lagringskvoten', () => {
    const LITEN = { ...DEFAULT_TENANT_LIMITS, maxDatabaseBytes: 64 * 1024 };

    it('historiken ryms inom kvoten: de äldsta raderna får ge vika före appens egna dokument', async () => {
      await store.close();
      store = medHistorik(dataDir, { limits: LITEN });
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { v: 0, fyllnad: 'x'.repeat(2000) });
      // Många versioner av samma dokument: utan gallring efter plats skulle appen bli full av historik.
      for (let v = 1; v <= 200; v++) {
        await store.replaceDocument(app, anna, 'arenden', dok.id, { v, fyllnad: 'x'.repeat(2000) });
      }
      const sida = await store.readDocumentHistory(app, anna, 'arenden', dok.id, { limit: 100 });
      expect(sida.entries[0]?.data['v']).toBe(200);
      expect(sida.entries.length).toBeLessThan(201);
    });

    it('en full app går fortfarande att radera ur, och raderingen loggas', async () => {
      await store.close();
      store = medHistorik(dataDir, { limits: LITEN });
      const ids: string[] = [];
      for (;;) {
        try {
          ids.push((await store.createDocument(app, anna, 'poster', 'app', { fyllnad: 'x'.repeat(1000) })).id);
        } catch (fel) {
          expect(fel).toMatchObject({ code: 'quota_exceeded' });
          break;
        }
        if (ids.length > 500) throw new Error('Appen blev aldrig full.');
      }
      const sista = ids.at(-1) ?? '';
      await store.deleteDocument(app, anna, 'poster', sista);
      const [radering] = (await store.readDocumentHistory(app, anna, 'poster', sista)).entries;
      expect(radering?.event).toBe('delete');
    });
  });
});
