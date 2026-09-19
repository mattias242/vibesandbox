/**
 * Tjänsten search mot en RIKTIG TenantStore (data-api) i en temporär katalog och en fejkad
 * inbäddare. Säkerhetsegenskaperna prövas med fientliga indata.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppService, AppServiceResponse, Identity, JsonObject, TenantContext, TenantStore } from '@vibesandbox/contracts';
import { createTenantStore } from '@vibesandbox/data-api';
import { EmbeddingError } from '../src/inbaddning.ts';
import { createSearchService } from '../src/tjanst.ts';
import type { SearchLimits, SearchServiceOptions } from '../src/tjanst.ts';
import { APP_B, anna, bertil, fejkadInbaddare, forfragan, json, tempKatalog, tenant } from './hjalp.ts';
import type { FejkadInbaddare } from './hjalp.ts';

type Logg = Record<string, unknown>;

let stada: () => Promise<void>;
let katalog: string;
let store: TenantStore;
let inbaddare: FejkadInbaddare;
let loggar: Logg[];
let nu: Date;
let tjanst: AppService;

function starta(limits: Partial<SearchLimits> = {}, extra: Partial<SearchServiceOptions> = {}): AppService {
  tjanst = createSearchService({
    store,
    dataDir: join(katalog, 'search'),
    embedder: inbaddare,
    now: () => nu,
    log: (entry) => loggar.push({ ...entry }),
    limits,
    ...extra,
  });
  return tjanst;
}

beforeEach(async () => {
  ({ katalog, stada } = await tempKatalog());
  store = createTenantStore({ dataDir: join(katalog, 'data') });
  inbaddare = fejkadInbaddare();
  loggar = [];
  nu = new Date('2026-09-19T10:00:00Z');
  starta();
});

afterEach(async () => {
  await tjanst.close?.();
  await store.close();
  await stada();
});

async function spara(data: JsonObject, val: { identity?: Identity; tenant?: TenantContext; collection?: string; personal?: boolean } = {}) {
  return store.createDocument(val.tenant ?? tenant(), val.identity ?? anna, val.collection ?? 'arenden', val.personal ? 'user' : 'app', data);
}

async function sok(body: Record<string, unknown>, val: Parameters<typeof forfragan>[1] = {}): Promise<AppServiceResponse> {
  return tjanst.handle(forfragan({ collection: 'arenden', ...body }, val));
}

function traffar(svar: AppServiceResponse): { id: string; score: number }[] {
  expect(svar.status, String(svar.body)).toBe(200);
  return json(svar.body)['results'] as { id: string; score: number }[];
}

function felkod(svar: AppServiceResponse): string {
  const fel = json(svar.body)['error'] as { code: string; message: string };
  expect(fel.message.length).toBeGreaterThan(0);
  return fel.code;
}

describe('sökning', () => {
  it('ger id och likhet, mest lika först', async () => {
    const kaffe = await spara({ rubrik: 'Kaffemaskinen läcker vatten i köket' });
    const cykel = await spara({ rubrik: 'Cykeln blev stulen från cykelstället' });
    const lista = traffar(await sok({ query: 'stulen cykel' }));
    expect(lista.map((t) => t.id)).toEqual([cykel.id, kaffe.id]);
    expect(lista[0]!.score).toBeGreaterThan(lista[1]!.score);
    expect(lista[0]!.score).toBeLessThanOrEqual(1);
    expect(Object.keys(lista[0]!).sort()).toEqual(['id', 'score']);
  });

  it('svarar som JSON utan cache', async () => {
    const svar = await sok({ query: 'x' });
    expect(svar.headers['Content-Type']).toMatch(/^application\/json/);
    expect(svar.headers['Cache-Control']).toBe('no-store');
  });

  it('en kollektion som inte finns ger inga träffar — och frågan skickas inte ens iväg', async () => {
    expect(traffar(await sok({ collection: 'finnsinte', query: 'x' }))).toEqual([]);
    expect(inbaddare.anrop).toEqual([]);
  });

  it('limit begränsar antalet träffar', async () => {
    for (let i = 0; i < 5; i += 1) await spara({ rubrik: `Ärende ${i}` });
    expect(traffar(await sok({ query: 'ärende', limit: 2 }))).toHaveLength(2);
    expect(traffar(await sok({ query: 'ärende' }))).toHaveLength(5);
  });

  it('fields väljer vilka fält som söks i', async () => {
    const a = await spara({ rubrik: 'Kaffe', kommentar: 'cykel cykel cykel' });
    const b = await spara({ rubrik: 'Cykel', kommentar: 'kaffe kaffe kaffe' });
    expect(traffar(await sok({ query: 'cykel', fields: ['rubrik'] }))[0]?.id).toBe(b.id);
    expect(traffar(await sok({ query: 'cykel', fields: ['kommentar'] }))[0]?.id).toBe(a.id);
  });

  it('dokument utan text bäddas inte in och blir ingen träff', async () => {
    await spara({ antal: 3 });
    expect(traffar(await sok({ query: 'x' }))).toEqual([]);
    expect(inbaddare.allt().filter((t) => t.startsWith('passage'))).toEqual([]);
  });

  it('bäddar in lat: bara nya och ändrade dokument, och i satser', async () => {
    for (let i = 0; i < 70; i += 1) await spara({ rubrik: `Ärende nummer ${i}` });
    await sok({ query: 'ärende' });
    const dokumentanrop = inbaddare.anrop.filter((a) => a[0]?.startsWith('passage: '));
    expect(dokumentanrop.length).toBeGreaterThan(1);
    expect(dokumentanrop.flat()).toHaveLength(70);

    inbaddare.anrop.length = 0;
    await sok({ query: 'ärende' });
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: '))).toEqual([]);
  });

  it('ett ändrat dokument bäddas in igen och hittas på sitt nya innehåll', async () => {
    const kaffe = await spara({ rubrik: 'Kaffemaskinen läcker vatten' });
    await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    await store.replaceDocument(tenant(), anna, 'arenden', kaffe.id, { rubrik: 'Skrivaren har fastnat' });
    inbaddare.anrop.length = 0;
    expect(traffar(await sok({ query: 'skrivaren fastnat' }))[0]?.id).toBe(kaffe.id);
    expect(inbaddare.allt()).toContain('passage: Skrivaren har fastnat');
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: '))).toHaveLength(1);
  });

  it('ett raderat dokument blir ingen träff, och dess vektor tas bort', async () => {
    const cykel = await spara({ rubrik: 'Cykeln blev stulen' });
    await spara({ rubrik: 'Kaffemaskinen läcker' });
    await sok({ query: 'cykel' });
    await store.deleteDocument(tenant(), anna, 'arenden', cykel.id);
    const lista = traffar(await sok({ query: 'cykel' }));
    expect(lista.map((t) => t.id)).not.toContain(cykel.id);
    expect(lista).toHaveLength(1);
  });

  it('indexet överlever en omstart: inget bäddas in igen', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    await tjanst.close?.();
    starta();
    inbaddare.anrop.length = 0;
    expect(traffar(await sok({ query: 'cykel' }))).toHaveLength(1);
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: '))).toEqual([]);
  });

  it('en ny modell bäddar in allt igen (vektorer från olika modeller jämförs aldrig)', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    await tjanst.close?.();
    inbaddare = fejkadInbaddare('annan/modell');
    starta();
    await sok({ query: 'cykel' });
    expect(inbaddare.allt()).toContain('Cykeln blev stulen');
  });

  it('indexet ligger i tjänstens egen katalog', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    expect((await readdir(join(katalog, 'search'))).some((f) => f.endsWith('.sqlite'))).toBe(true);
  });
});

describe('vem som får se vad', () => {
  it('någon annans personliga dokument blir aldrig en träff — och skickas inte ens iväg i hens sökning', async () => {
    await spara({ text: 'Koden till cykellåset är 4711' }, { collection: 'anteckningar', personal: true });
    // Anna söker först, så att hennes dokument redan finns i indexet.
    expect(traffar(await sok({ collection: 'anteckningar', personal: true, query: 'cykellåset' }))).toHaveLength(1);
    inbaddare.anrop.length = 0;
    expect(traffar(await sok({ collection: 'anteckningar', personal: true, query: 'cykellåset' }, { identity: bertil }))).toEqual([]);
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: '))).toEqual([]);
  });

  it('var och en hittar sina egna personliga dokument', async () => {
    const annas = await spara({ text: 'Annas cykel' }, { collection: 'anteckningar', personal: true });
    const bertils = await spara({ text: 'Bertils cykel' }, { collection: 'anteckningar', personal: true, identity: bertil });
    expect(traffar(await sok({ collection: 'anteckningar', personal: true, query: 'cykel' })).map((t) => t.id)).toEqual([annas.id]);
    expect(traffar(await sok({ collection: 'anteckningar', personal: true, query: 'cykel' }, { identity: bertil })).map((t) => t.id)).toEqual([bertils.id]);
  });

  it('en personlig kollektion kan inte sökas som gemensam', async () => {
    await spara({ text: 'hemligt' }, { collection: 'anteckningar', personal: true });
    const svar = await sok({ collection: 'anteckningar', query: 'hemligt' }, { identity: bertil });
    expect(svar.status).toBe(409);
    expect(felkod(svar)).toBe('scope_mismatch');
  });

  it('en annan apps dokument syns inte', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    expect(traffar(await sok({ query: 'cykel' }, { tenant: tenant(APP_B) }))).toEqual([]);
  });

  it('utkast och publicerad version delar inte index', async () => {
    const publicerat = await spara({ rubrik: 'Cykeln blev stulen' });
    await sok({ query: 'cykel' });
    const utkast = await spara({ rubrik: 'Cykel i utkastet' }, { tenant: tenant(undefined, 'draft') });
    const lista = traffar(await sok({ query: 'cykel' }, { tenant: tenant(undefined, 'draft') }));
    expect(lista.map((t) => t.id)).toEqual([utkast.id]);
    expect(lista.map((t) => t.id)).not.toContain(publicerat.id);
  });

  it('app-id eller användar-id i kroppen eller frågesträngen påverkar ingenting', async () => {
    const svar = await sok({ query: 'x', appId: APP_B });
    expect(svar.status).toBe(400);
    const medFraga = await sok({ query: 'x' }, { query: `appId=${APP_B}` });
    expect(medFraga.status).toBe(400);
  });
});

describe('fientliga indata', () => {
  it.each([
    ['../arenden'],
    ['arenden/../x'],
    ['Arenden'],
    ['a\u0000b'],
    [''],
    ['a'.repeat(65)],
    [42],
    [null],
  ])('ogiltigt kollektionsnamn %j ⇒ 400', async (collection) => {
    const svar = await sok({ collection, query: 'x' });
    expect(svar.status).toBe(400);
    expect(felkod(svar)).toBe('invalid_request');
  });

  it.each([
    ['jättelång fråga', 'x'.repeat(20_000)],
    ['tom fråga', ''],
    ['bara blanksteg', '   '],
    ['NUL', 'a\u0000b'],
    ['inte en sträng', 42],
    ['saknas', undefined],
  ])('ogiltig fråga (%s) ⇒ 400, och inget skickas iväg', async (_namn, query) => {
    const svar = await sok({ query });
    expect(svar.status).toBe(400);
    expect(felkod(svar)).toBe('invalid_request');
    expect(inbaddare.anrop).toEqual([]);
  });

  it.each([[0], [51], [1.5], ['10'], [-1]])('ogiltig limit %j ⇒ 400', async (limit) => {
    expect((await sok({ query: 'x', limit })).status).toBe(400);
  });

  it.each([[[]], ['rubrik'], [['../x']], [[1]], [Array.from({ length: 21 }, (_, i) => `f${i}`)], [['a'.repeat(65)]]])(
    'ogiltiga fields %j ⇒ 400',
    async (fields) => {
      expect((await sok({ query: 'x', fields })).status).toBe(400);
    },
  );

  it.each([['ja'], [1], [null]])('ogiltig personal %j ⇒ 400', async (personal) => {
    expect((await sok({ query: 'x', personal })).status).toBe(400);
  });

  it('okända fält i kroppen ⇒ 400', async () => {
    expect((await sok({ query: 'x', userId: 'anv-bertil' })).status).toBe(400);
  });

  it.each([
    ['inte JSON', new TextEncoder().encode('{inte json')],
    ['en lista', new TextEncoder().encode('[]')],
    ['ogiltig UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ['tom', new Uint8Array()],
  ])('kroppen är %s ⇒ 400', async (_namn, raw) => {
    expect((await sok({}, { raw })).status).toBe(400);
  });

  it('fel innehållstyp ⇒ 415', async () => {
    expect((await sok({ query: 'x' }, { contentType: 'text/plain' })).status).toBe(415);
  });

  it('GET ⇒ 405, och en undersökväg finns inte', async () => {
    expect((await sok({ query: 'x' }, { method: 'GET' })).status).toBe(405);
    expect((await sok({ query: 'x' }, { segments: ['..'] })).status).toBe(404);
    expect((await sok({ query: 'x' }, { segments: ['admin'] })).status).toBe(404);
  });

  it('har en liten gräns för kroppen', () => {
    expect(tjanst.maxBodyBytes).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('dataskydd', () => {
  it('personnummer och telefonnummer maskas i både dokument och fråga innan något skickas', async () => {
    await spara({ text: 'Ring mig på 070-123 45 67, personnummer 19811218-9876' });
    traffar(await sok({ query: 'vem har 070-123 45 67?' }));
    const skickat = inbaddare.allt().join('\n');
    expect(skickat).not.toContain('070-123 45 67');
    expect(skickat).not.toContain('19811218-9876');
    expect(skickat).toContain('[TELEFON]');
  });

  it('loggarna innehåller aldrig frågan eller dokumentens text', async () => {
    await spara({ text: 'Hemlig anteckning om cykellåset' });
    await sok({ query: 'unik-fraga-cykellås' });
    inbaddare.fel = new EmbeddingError('unavailable');
    await sok({ query: 'unik-fraga-två' });
    const allt = JSON.stringify(loggar);
    expect(loggar.length).toBeGreaterThan(0);
    for (const hemligt of ['Hemlig', 'cykellås', 'unik-fraga', anna.email, anna.userId, 'arenden']) expect(allt).not.toContain(hemligt);
  });
});

describe('fel hos leverantören', () => {
  it('ger 503 i klarspråk', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    inbaddare.fel = new EmbeddingError('unavailable');
    const svar = await sok({ query: 'cykel' });
    expect(svar.status).toBe(503);
    expect(felkod(svar)).toBe('internal');
    expect((json(svar.body)['error'] as { message: string }).message).toMatch(/sökningen/i);
  });

  it('ett oväntat fel i inbäddaren blir också 503, utan detaljer', async () => {
    await spara({ rubrik: 'Cykeln blev stulen' });
    inbaddare.fel = new Error('hemlig detalj');
    const svar = await sok({ query: 'cykel' });
    expect(svar.status).toBe(503);
    expect(String(svar.body)).not.toContain('hemlig detalj');
  });

  it('det som hann bäddas in före felet sparas', async () => {
    for (let i = 0; i < 40; i += 1) await spara({ rubrik: `Ärende ${i}` });
    let anrop = 0;
    const riktig = inbaddare.embed.bind(inbaddare);
    inbaddare.embed = async (texts) => {
      anrop += 1;
      if (anrop === 2) throw new EmbeddingError('unavailable');
      return riktig(texts);
    };
    expect((await sok({ query: 'ärende' })).status).toBe(503);
    inbaddare.embed = riktig;
    inbaddare.anrop.length = 0;
    traffar(await sok({ query: 'ärende' }));
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: ')).length).toBeLessThan(40);
  });
});

describe('kvoter', () => {
  it('tokens per app och dygn: överskriden ⇒ 429 quota_exceeded, och nästa dygn går det igen', async () => {
    await tjanst.close?.();
    starta({ tokensPerAppDay: 500 });
    for (let i = 0; i < 4; i += 1) await spara({ text: `Ärende ${i}: ` + 'lång text om budgeten '.repeat(10) });
    const forsta = await sok({ query: 'budget' });
    expect(forsta.status).toBe(429);
    expect(felkod(forsta)).toBe('quota_exceeded');
    // Kvoten gäller appen, inte användaren.
    expect(felkod(await sok({ query: 'budget' }, { identity: bertil }))).toBe('quota_exceeded');
    // En annan app påverkas inte.
    expect((await sok({ query: 'budget' }, { tenant: tenant(APP_B) })).status).toBe(200);

    nu = new Date('2026-09-20T00:00:01Z');
    expect((await sok({ query: 'budget' })).status).toBe(200);
  });

  it('kvoten överlever en omstart', async () => {
    await tjanst.close?.();
    starta({ tokensPerAppDay: 100 });
    await spara({ text: 'x'.repeat(200) });
    await sok({ query: 'x' });
    await tjanst.close?.();
    starta({ tokensPerAppDay: 100 });
    expect(felkod(await sok({ query: 'x' }))).toBe('quota_exceeded');
  });

  it('frågor per användare och minut: för många ⇒ 429 rate_limited; andra användare påverkas inte', async () => {
    await tjanst.close?.();
    starta({ queriesPerUserMinute: 3 });
    await spara({ rubrik: 'Cykeln blev stulen' });
    for (let i = 0; i < 3; i += 1) expect((await sok({ query: 'x' })).status).toBe(200);
    const fjarde = await sok({ query: 'x' });
    expect(fjarde.status).toBe(429);
    expect(felkod(fjarde)).toBe('rate_limited');
    expect(inbaddare.anrop.filter((a) => a[0]?.startsWith('query: '))).toHaveLength(3);
    expect((await sok({ query: 'x' }, { identity: bertil })).status).toBe(200);
    nu = new Date(nu.getTime() + 61_000);
    expect((await sok({ query: 'x' })).status).toBe(200);
  });

  it('för många dokument i kollektionen ⇒ 413 i klarspråk, och inget bäddas in', async () => {
    await tjanst.close?.();
    starta({ maxDocuments: 5 });
    for (let i = 0; i < 6; i += 1) await spara({ rubrik: `Ärende ${i}` });
    const svar = await sok({ query: 'ärende' });
    expect(svar.status).toBe(413);
    expect(felkod(svar)).toBe('too_large');
    expect((json(svar.body)['error'] as { message: string }).message).toContain('5');
    expect(inbaddare.anrop).toEqual([]);
  });

  it('tak för antal vektorer per app ⇒ quota_exceeded', async () => {
    await tjanst.close?.();
    starta({ maxVectorsPerApp: 3 });
    for (let i = 0; i < 4; i += 1) await spara({ rubrik: `Ärende ${i}` });
    expect(felkod(await sok({ query: 'ärende' }))).toBe('quota_exceeded');
  });
});

describe('samtidighet', () => {
  it('två samtidiga sökningar bäddar inte in samma dokument två gånger', async () => {
    for (let i = 0; i < 10; i += 1) await spara({ rubrik: `Ärende ${i}` });
    const [a, b] = await Promise.all([sok({ query: 'ärende' }), sok({ query: 'ärende' })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(inbaddare.allt().filter((t) => t.startsWith('passage: '))).toHaveLength(10);
  });
});
