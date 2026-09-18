import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext, TenantStore } from '@vibesandbox/contracts';
import {
  anna,
  bertil,
  förväntaFel,
  nyButik,
  nyttAppId,
  skapaTempDataDir,
  tenant,
} from './hjalp.ts';

describe('Scope: en app kan hålla isär olika användares data', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;
  let app: TenantContext;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
    app = tenant(nyttAppId());
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

  it('Bertil kan inte läsa Annas personliga dokument i en listning', async () => {
    await store.createDocument(app, anna, 'svar', 'user', { svar: 'Ja' });

    const sida = await store.listDocuments(app, bertil, 'svar', 'user');

    expect(sida.documents).toEqual([]);
  });

  it('Bertil kan inte hämta Annas personliga dokument med dess id', async () => {
    const dok = await store.createDocument(app, anna, 'svar', 'user', { svar: 'Ja' });

    await förväntaFel(store.getDocument(app, bertil, 'svar', dok.id), 'not_found');
  });

  it('Bertil kan inte ersätta Annas personliga dokument, och det förblir oförändrat', async () => {
    const dok = await store.createDocument(app, anna, 'svar', 'user', { svar: 'Ja' });

    await förväntaFel(
      store.replaceDocument(app, bertil, 'svar', dok.id, { svar: 'Nej' }),
      'not_found',
    );

    const fortfarandeAnnas = await store.getDocument(app, anna, 'svar', dok.id);
    expect(fortfarandeAnnas.data).toEqual({ svar: 'Ja' });
  });

  it('Bertil kan inte radera Annas personliga dokument, och det finns kvar', async () => {
    const dok = await store.createDocument(app, anna, 'svar', 'user', { svar: 'Ja' });

    await förväntaFel(store.deleteDocument(app, bertil, 'svar', dok.id), 'not_found');

    const fortfarandeDär = await store.getDocument(app, anna, 'svar', dok.id);
    expect(fortfarandeDär.data).toEqual({ svar: 'Ja' });
  });

  it('gemensamma dokument syns för alla som får öppna appen', async () => {
    await store.createDocument(app, anna, 'anslag', 'app', { rubrik: 'Fika fredag' });

    const sida = await store.listDocuments(app, bertil, 'anslag', 'app');

    expect(sida.documents).toHaveLength(1);
    expect(sida.documents[0]?.data).toEqual({ rubrik: 'Fika fredag' });
  });

  it('scope låses vid skapande: en personlig kollektion kan inte listas som gemensam', async () => {
    await store.createDocument(app, anna, 'svar', 'user', { svar: 'Ja' });

    await förväntaFel(store.listDocuments(app, bertil, 'svar', 'app'), 'scope_mismatch');
  });

  it('en läsning låser ingenting: efter en listning som gemensam kan kollektionen skapas som personlig', async () => {
    // Kontraktet: bara första createDocument skapar kollektionen och låser dess scope. Annars
    // kunde Bertil hinna före appen och låsa en tänkt personlig kollektion som gemensam.
    const sida = await store.listDocuments(app, bertil, 'nyupptackt', 'app');
    expect(sida.documents).toEqual([]);
    expect(sida.nextCursor).toBeUndefined();

    const dok = await store.createDocument(app, anna, 'nyupptackt', 'user', { x: 1 });
    expect(dok.data).toEqual({ x: 1 });

    // Det var skapandet som låste: kollektionen är nu personlig, inte gemensam.
    await förväntaFel(store.listDocuments(app, bertil, 'nyupptackt', 'app'), 'scope_mismatch');
    const bertilsSida = await store.listDocuments(app, bertil, 'nyupptackt', 'user');
    expect(bertilsSida.documents).toEqual([]);
  });

  it('scope låses vid skapande: både listning och skapande med annat scope nekas därefter', async () => {
    await store.createDocument(app, anna, 'nyupptackt', 'user', { x: 1 });

    await förväntaFel(store.listDocuments(app, anna, 'nyupptackt', 'app'), 'scope_mismatch');
    await förväntaFel(
      store.createDocument(app, anna, 'nyupptackt', 'app', { x: 2 }),
      'scope_mismatch',
    );

    // Det nekade skapandet lämnade inga spår.
    const sida = await store.listDocuments(app, anna, 'nyupptackt', 'user');
    expect(sida.documents.map((dok) => dok.data)).toEqual([{ x: 1 }]);
  });
});
