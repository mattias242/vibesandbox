/**
 * Tjänsten `notify` genom sitt kontrakt (`AppService.handle` och `AppNotifier`), med fejkad
 * medlemslista och utkorg. Fientligt: någon annans id, utkast, avstängda mottagare, gränser,
 * trasiga kroppar — och att varken svar eller loggar någonsin innehåller en adress eller texten.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ERROR_STATUS, unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppId,
  AppServiceDependencies,
  AppServiceInstance,
  AppServiceResponse,
  Identity,
  TenantKind,
  TenantStore,
} from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';

const APP = '01h8xgk3m2abcdefghjkmnpqrs' as AppId;
const ANNAN_APP = '01h8xgk3m2abcdefghjkmnpqrt' as AppId;
const URL_FOR = (appId: string) => `https://${appId}.appar.example/`;

const ANNA: Identity = { userId: 'u-anna', email: 'anna.a@example.org', roles: ['viewer'] };
const BERTIL: Identity = { userId: 'u-bertil', email: 'bertil@example.org', roles: ['viewer'] };
const CECILIA: Identity = { userId: 'u-cecilia', email: 'cecilia@example.org', roles: ['viewer'] };

const MEDLEMMAR: Record<string, { userId: string; role: AppAccessRole; email: string | null }[]> = {
  [APP]: [
    { userId: ANNA.userId, role: 'owner', email: ANNA.email },
    { userId: BERTIL.userId, role: 'user', email: BERTIL.email },
    { userId: 'u-utan-adress', role: 'user', email: null },
  ],
  [ANNAN_APP]: [{ userId: CECILIA.userId, role: 'owner', email: CECILIA.email }],
};

interface Mejl {
  to: string;
  subject: string;
  text: string;
}

let katalog: string;
let utkorg: Mejl[];
let loggar: Record<string, unknown>[];
let nu: Date;
let instans: AppServiceInstance | undefined;
let felandeMottagare: string | undefined;

function beroenden(env: Record<string, string> = {}, utanMejl = false): AppServiceDependencies {
  return {
    dataDir: katalog,
    env,
    log: (entry) => loggar.push({ ...entry }),
    now: () => nu,
    members: { members: async (appId) => MEDLEMMAR[appId] ?? [] },
    store: {} as TenantStore,
    publishedUrl: URL_FOR,
    ...(utanMejl
      ? {}
      : {
          mailer: {
            async send(m) {
              if (m.to === felandeMottagare) throw new Error(`kunde inte nå ${m.to}`);
              utkorg.push({ ...m });
            },
          },
        }),
  };
}

function tjanst(): AppServiceInstance {
  if (instans === undefined) throw new Error('Tjänsten är inte skapad.');
  return instans;
}

function skapa(env: Record<string, string> = {}): AppServiceInstance {
  if (factory === undefined) throw new Error('Fabriken saknas.');
  // Den föregående instansen (från beforeEach) stängs först — close är synkron under ytan.
  void instans?.service.close?.();
  instans = factory(beroenden(env));
  return instans;
}

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'tjanst-notify-'));
  utkorg = [];
  loggar = [];
  nu = new Date('2026-09-19T10:00:00Z');
  felandeMottagare = undefined;
  skapa();
});

afterEach(async () => {
  await tjanst().service.close?.();
  await rm(katalog, { recursive: true, force: true });
});

function anrop(
  vem: Identity,
  metod: string,
  segments: string[],
  kropp?: unknown,
  kind: TenantKind = 'published',
  appId: AppId = APP,
  access: AppAccessRole = vem === ANNA ? 'owner' : 'user',
): Promise<AppServiceResponse> {
  return tjanst().service.handle({
    method: metod,
    segments,
    query: '',
    headers: {},
    tenant: unsafeCreateTenantContext(appId, kind),
    identity: vem,
    access,
    ...(kropp === undefined ? {} : { body: new TextEncoder().encode(typeof kropp === 'string' ? kropp : JSON.stringify(kropp)) }),
  });
}

function skicka(vem: Identity, kropp: unknown, kind: TenantKind = 'published', appId: AppId = APP) {
  return anrop(vem, 'POST', [], kropp, kind, appId);
}

function json(svar: AppServiceResponse): Record<string, unknown> {
  return JSON.parse(String(svar.body)) as Record<string, unknown>;
}

const VANLIGT = { subject: 'Mötet är flyttat', text: 'Vi ses på torsdag.' };

describe('fabriken', () => {
  it('kräver en mejltjänst och säger hur man ordnar det', () => {
    expect(() => factory?.(beroenden({}, true))).toThrow(/notify kräver mejl — sätt MAILGUN_/);
  });

  it.each(['0', '-1', 'tio', '1.5', '99999999999'])('avvisar en orimlig gräns %j', (varde) => {
    expect(() => factory?.(beroenden({ SVC_NOTIFY_PER_USER_HOUR: varde }))).toThrow(/SVC_NOTIFY_PER_USER_HOUR/);
  });

  it('delar med sig av en notifier och heter notify', () => {
    expect(tjanst().service.name).toBe('notify');
    expect(tjanst().notifier).toBeDefined();
  });
});

describe('POST /_api/notify', () => {
  it("'all' mejlar alla medlemmar med adress, och svaret röjer ingen adress", async () => {
    const svar = await skicka(ANNA, { to: 'all', ...VANLIGT });
    expect(svar.status).toBe(200);
    expect(json(svar)).toEqual({ sent: 2 });
    expect(utkorg.map((m) => m.to).sort()).toEqual([ANNA.email, BERTIL.email].sort());
    expect(String(svar.body)).not.toContain('@');
  });

  it("'owner' mejlar bara ägaren", async () => {
    const svar = await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    expect(json(svar)).toEqual({ sent: 1 });
    expect(utkorg.map((m) => m.to)).toEqual([ANNA.email]);
  });

  it('en lista med id mejlar bara de medlemmar som finns; okända och andra appars id hoppas över tyst', async () => {
    const svar = await skicka(ANNA, { to: [BERTIL.userId, CECILIA.userId, 'finns-inte', BERTIL.userId], ...VANLIGT });
    expect(json(svar)).toEqual({ sent: 1 });
    expect(utkorg.map((m) => m.to)).toEqual([BERTIL.email]);

    const annanApp = await skicka(ANNA, { to: [CECILIA.userId], ...VANLIGT });
    const okand = await skicka(ANNA, { to: ['finns-inte'], ...VANLIGT });
    expect(annanApp).toEqual(okand);
  });

  it('mejlet visar avsändarens visningsnamn, länken till appen och varför man får det', async () => {
    await skicka(ANNA, { to: [BERTIL.userId], ...VANLIGT });
    const mejl = utkorg[0] as Mejl;
    expect(mejl.subject).toContain('Mötet är flyttat');
    expect(mejl.text).toContain('anna.a');
    expect(mejl.text).not.toContain(ANNA.email);
    expect(mejl.text).toContain(URL_FOR(APP));
    expect(mejl.text).toContain('Vi ses på torsdag.');
    expect(mejl.text).toMatch(/eftersom du har tillgång till appen/);
    expect(mejl.text).toMatch(/stänga av/);
    expect(mejl.text).toContain('en app');
  });

  it.each([
    ['en webbadress', { to: 'all', subject: 'Hej', text: 'Logga in: https://evil.example' }],
    ['en förklädd adress', { to: 'all', subject: 'Hej', text: 'hxxp://evil[.]example' }],
    ['www utan schema', { to: 'all', subject: 'Hej', text: 'www.evil.example' }],
    ['ett internationellt domännamn', { to: 'all', subject: 'Hej', text: 'bänkid.se' }],
    ['en adress i ämnet', { to: 'all', subject: 'evil.com', text: 'Hej' }],
    ['en jättelång text', { to: 'all', subject: 'Hej', text: 'a'.repeat(20_000) }],
    ['ett för långt ämne', { to: 'all', subject: 'a'.repeat(151), text: 'Hej' }],
    ['okänd mottagare', { to: 'everyone', subject: 'Hej', text: 'Hej' }],
    ['tom lista', { to: [], subject: 'Hej', text: 'Hej' }],
    ['id som inte är text', { to: [1], subject: 'Hej', text: 'Hej' }],
    ['för många id', { to: Array.from({ length: 101 }, (_, i) => `u-${i}`), subject: 'Hej', text: 'Hej' }],
    ['e-postadress som mottagare', { to: ['bertil@example.org'], subject: 'Hej', text: 'Hej' }],
    ['extra fält', { to: 'all', subject: 'Hej', text: 'Hej', from: 'vd@example.org' }],
    ['en lista i stället för ett objekt', [{ to: 'all', subject: 'Hej', text: 'Hej' }]],
    ['saknad text', { to: 'all', subject: 'Hej' }],
  ])('avvisar %s med 400 och skickar inget', async (_namn, kropp) => {
    const svar = await skicka(ANNA, kropp);
    expect(svar.status).toBe(400);
    expect((json(svar)['error'] as { code: string }).code).toBe('invalid_request');
    expect(utkorg).toEqual([]);
  });

  it.each([
    ['trasig JSON', '{"to":'],
    ['ingen kropp', undefined],
    ['ett rått NUL i JSON', '{"to":"all","subject":"Hej\u0000","text":"Hej"}'],
  ])('avvisar %s med 400', async (_namn, kropp) => {
    expect((await anrop(ANNA, 'POST', [], kropp)).status).toBe(400);
  });

  it('ett kodat NUL i ämnet tas bort — mejlet går, men utan tecknet', async () => {
    const svar = await anrop(ANNA, 'POST', [], '{"to":"owner","subject":"Hej\\u0000då","text":"Hej"}');
    expect(svar.status).toBe(200);
    expect(utkorg[0]?.subject).toMatch(/^Hejdå/);
  });

  it('ogiltig UTF-8 avvisas', async () => {
    const svar = await tjanst().service.handle({
      method: 'POST',
      segments: [],
      query: '',
      headers: {},
      tenant: unsafeCreateTenantContext(APP, 'published'),
      identity: ANNA,
      access: 'owner',
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(svar.status).toBe(400);
  });

  it('radbrytningar i ämnet blir aldrig ett eget mejlhuvud', async () => {
    await skicka(ANNA, { to: [BERTIL.userId], subject: 'Hej\r\nBcc: alla\r\n\r\nkropp', text: 'Hej' });
    expect(utkorg[0]?.subject).not.toMatch(/[\r\n]/);
  });

  it('appens egen adress får stå i texten', async () => {
    const svar = await skicka(ANNA, { to: [BERTIL.userId], subject: 'Hej', text: `Se ${URL_FOR(APP)}kalender` });
    expect(json(svar)).toEqual({ sent: 1 });
  });

  it('en annan apps adress får inte stå i texten', async () => {
    const svar = await skicka(ANNA, { to: [BERTIL.userId], subject: 'Hej', text: `Se ${URL_FOR(ANNAN_APP)}` });
    expect(svar.status).toBe(400);
  });

  it('ett mejl som inte går fram räknas inte som skickat, och resten skickas ändå', async () => {
    felandeMottagare = ANNA.email;
    const svar = await skicka(BERTIL, { to: 'all', ...VANLIGT });
    expect(json(svar)).toEqual({ sent: 1 });
    expect(JSON.stringify(loggar)).not.toContain('@');
  });

  it('fel metod ger 405 och okänd väg 404', async () => {
    expect((await anrop(ANNA, 'GET', [])).status).toBe(405);
    expect((await anrop(ANNA, 'DELETE', ['settings'])).status).toBe(405);
    expect((await anrop(ANNA, 'GET', ['nagot'])).status).toBe(404);
    expect((await anrop(ANNA, 'GET', ['settings', 'x'])).status).toBe(404);
  });
});

describe('utkast', () => {
  it('ett utkast mejlar bara ägaren, oavsett mottagare, och säger det', async () => {
    const svar = await skicka(ANNA, { to: 'all', ...VANLIGT }, 'draft');
    expect(svar.status).toBe(200);
    const kropp = json(svar);
    expect(kropp['sent']).toBe(1);
    expect(kropp['onlyOwner']).toBe(true);
    expect(String(kropp['message'])).toMatch(/utkast/);
    expect(utkorg.map((m) => m.to)).toEqual([ANNA.email]);
    expect(utkorg[0]?.text).toMatch(/förhandsvisning/);
  });

  it('även en lista med andras id går bara till ägaren', async () => {
    await skicka(ANNA, { to: [BERTIL.userId], ...VANLIGT }, 'draft');
    expect(utkorg.map((m) => m.to)).toEqual([ANNA.email]);
  });

  it('avstängning gäller var för sig för utkast och publicerad app', async () => {
    await anrop(ANNA, 'PUT', ['settings'], { muted: true }, 'draft');
    expect(json(await anrop(ANNA, 'GET', ['settings'], undefined, 'draft'))).toEqual({ muted: true });
    expect(json(await anrop(ANNA, 'GET', ['settings'], undefined, 'published'))).toEqual({ muted: false });
  });
});

describe('avstängning', () => {
  it('är av från början, går att slå på och av, och gäller per app', async () => {
    expect(json(await anrop(BERTIL, 'GET', ['settings']))).toEqual({ muted: false });
    expect(json(await anrop(BERTIL, 'PUT', ['settings'], { muted: true }))).toEqual({ muted: true });
    expect(json(await anrop(BERTIL, 'GET', ['settings']))).toEqual({ muted: true });
    expect(json(await anrop(BERTIL, 'GET', ['settings'], undefined, 'published', ANNAN_APP))).toEqual({ muted: false });
    expect(json(await anrop(BERTIL, 'PUT', ['settings'], { muted: false }))).toEqual({ muted: false });
    expect(json(await anrop(BERTIL, 'GET', ['settings']))).toEqual({ muted: false });
  });

  it('en avstängd mottagare hoppas över', async () => {
    await anrop(BERTIL, 'PUT', ['settings'], { muted: true });
    const svar = await skicka(ANNA, { to: 'all', ...VANLIGT });
    expect(json(svar)).toEqual({ sent: 1 });
    expect(utkorg.map((m) => m.to)).toEqual([ANNA.email]);
  });

  it.each([{ muted: 'ja' }, { muted: 1 }, {}, { muted: true, userId: 'u-anna' }, null])('avvisar %j', async (kropp) => {
    expect((await anrop(BERTIL, 'PUT', ['settings'], kropp)).status).toBe(400);
  });

  it('gäller den inloggade — ett userId i kroppen kan inte stänga av någon annan', async () => {
    await anrop(BERTIL, 'PUT', ['settings'], { muted: true, userId: ANNA.userId });
    expect(json(await anrop(ANNA, 'GET', ['settings']))).toEqual({ muted: false });
  });
});

describe('hastighetsgränser', () => {
  it("per avsändare och timme, där 'all' räknas per mottagare, och inget skickas över gränsen", async () => {
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '3' });
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(200);
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(200);
    const svar = await skicka(BERTIL, { to: 'all', ...VANLIGT });
    expect(svar.status).toBe(API_ERROR_STATUS.rate_limited);
    const fel = json(svar)['error'] as { code: string; message: string };
    expect(fel.code).toBe('rate_limited');
    expect(fel.message).toMatch(/för många aviseringar/);
    expect(utkorg).toHaveLength(2);
    // Någon annan avsändare påverkas inte.
    expect((await skicka(ANNA, { to: 'owner', ...VANLIGT })).status).toBe(200);
  });

  it('gränsen per timme släpper efter en timme', async () => {
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '1' });
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(200);
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(429);
    nu = new Date(nu.getTime() + 61 * 60 * 1000);
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(200);
  });

  it('per avsändare och dygn', async () => {
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '10', SVC_NOTIFY_PER_USER_DAY: '2' });
    await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    nu = new Date(nu.getTime() + 2 * 60 * 60 * 1000);
    await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    nu = new Date(nu.getTime() + 2 * 60 * 60 * 1000);
    const svar = await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    expect(svar.status).toBe(429);
    expect((json(svar)['error'] as { message: string }).message).toMatch(/dygn/);
  });

  it('per app och dygn, oavsett avsändare', async () => {
    skapa({ SVC_NOTIFY_PER_APP_DAY: '2' });
    await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    await skicka(ANNA, { to: [BERTIL.userId], ...VANLIGT });
    const svar = await skicka(ANNA, { to: [BERTIL.userId], ...VANLIGT });
    expect(svar.status).toBe(429);
    expect((json(svar)['error'] as { message: string }).message).toMatch(/Appen/);
    // En annan app har sin egen gräns.
    expect((await skicka(CECILIA, { to: 'owner', ...VANLIGT }, 'published', ANNAN_APP)).status).toBe(200);
  });

  it('gränserna överlever en omstart', async () => {
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '1' });
    await skicka(BERTIL, { to: 'owner', ...VANLIGT });
    await tjanst().service.close?.();
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '1' });
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(429);
  });

  it('ett anrop som inte når någon räknas inte', async () => {
    skapa({ SVC_NOTIFY_PER_USER_HOUR: '1' });
    await skicka(BERTIL, { to: ['finns-inte'], ...VANLIGT });
    expect((await skicka(BERTIL, { to: 'owner', ...VANLIGT })).status).toBe(200);
  });
});

describe('loggar', () => {
  it('innehåller antal, app-prefix och userId — aldrig adresser, ämnen eller text', async () => {
    await skicka(ANNA, { to: 'all', ...VANLIGT });
    await skicka(ANNA, { to: 'all', subject: 'Hej', text: 'https://evil.example' });
    const text = JSON.stringify(loggar);
    expect(text).not.toContain('@');
    expect(text).not.toContain('Mötet');
    expect(text).not.toContain('torsdag');
    expect(text).not.toContain('evil');
    expect(text).not.toContain(APP);
    const skickat = loggar.find((l) => l['event'] === 'notify_sent');
    expect(skickat).toMatchObject({ app: APP.slice(0, 8), userId: ANNA.userId, sent: 2 });
  });
});

describe('AppNotifier (för schedule)', () => {
  it('skickar enligt samma regler, som en påminnelse från appen', async () => {
    const svar = await tjanst().notifier?.notify(APP, { to: 'all', ...VANLIGT });
    expect(svar).toEqual({ sent: 2 });
    expect(utkorg[0]?.text).toMatch(/en påminnelse från appen/);
  });

  it('okända id hoppas över och avstängda får inget', async () => {
    await anrop(BERTIL, 'PUT', ['settings'], { muted: true });
    expect(await tjanst().notifier?.notify(APP, { to: [BERTIL.userId, CECILIA.userId], ...VANLIGT })).toEqual({ sent: 0 });
  });

  it('avvisar webbadresser och följer appens gräns', async () => {
    await expect(tjanst().notifier?.notify(APP, { to: 'all', subject: 'Hej', text: 'evil.com' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    skapa({ SVC_NOTIFY_PER_APP_HOUR: '1' });
    await tjanst().notifier?.notify(APP, { to: 'owner', ...VANLIGT });
    await expect(tjanst().notifier?.notify(APP, { to: 'owner', ...VANLIGT })).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
