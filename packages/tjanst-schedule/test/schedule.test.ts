/**
 * Tjänsten `schedule`: schemaläggning, vem som ser och tar bort vad, och utskicken — med en klocka
 * som testerna styr och en fejkad notifier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataApiError } from '@vibesandbox/contracts';
import type { AppServiceResponse } from '@vibesandbox/contracts';
import { createSchedule, factory } from '../src/index.ts';
import type { ScheduleInstance } from '../src/index.ts';
import {
  ANNA,
  APP_A,
  APP_B,
  BERTIL,
  CECILIA,
  beroenden,
  fejkMedlemmar,
  fejkNotifier,
  felkod,
  forfragan,
  json,
  klocka,
  logg,
  tempKatalog,
} from './hjalp.ts';
import type { Anropare, FejkMedlemmar, FejkNotifier, Klocka, Logg } from './hjalp.ts';

const NU = '2026-10-01T10:00:00Z'; // torsdag 12:00 i Stockholm
const OM_EN_TIMME = '2026-10-01T11:00:00Z';
const I_MORGON = '2026-10-02T10:00:00Z';

let katalog: string;
let stada: () => Promise<void>;
let k: Klocka;
let notifier: FejkNotifier;
let medlemmar: FejkMedlemmar;
let loggen: Logg;
const oppna: ScheduleInstance[] = [];

function starta(env: Record<string, string> = {}): ScheduleInstance {
  const instans = createSchedule(beroenden({ dataDir: katalog, klocka: k, notifier, medlemmar, logg: loggen, env }));
  oppna.push(instans);
  return instans;
}

beforeEach(async () => {
  ({ katalog, stada } = await tempKatalog());
  k = klocka(NU);
  notifier = fejkNotifier();
  medlemmar = fejkMedlemmar();
  loggen = logg();
});

afterEach(async () => {
  for (const instans of oppna.splice(0)) await instans.service.close?.();
  await stada();
});

function paminnelse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: OM_EN_TIMME, to: 'all', subject: 'Städdag', text: 'Ta med arbetshandskar.', ...over };
}

async function skapa(s: ScheduleInstance, vem: Anropare, over: Record<string, unknown> = {}): Promise<AppServiceResponse> {
  return s.service.handle(forfragan(vem, 'POST', [], paminnelse(over)));
}

async function skapaId(s: ScheduleInstance, vem: Anropare, over: Record<string, unknown> = {}): Promise<string> {
  const svar = await skapa(s, vem, over);
  expect(svar.status, String(svar.body)).toBe(201);
  return json(svar)['id'] as string;
}

async function lista(s: ScheduleInstance, vem: Anropare): Promise<Record<string, unknown>[]> {
  const svar = await s.service.handle(forfragan(vem, 'GET'));
  expect(svar.status).toBe(200);
  return json(svar)['reminders'] as Record<string, unknown>[];
}

describe('fabriken', () => {
  it('kastar med klarspråk när notify inte är påslagen', () => {
    expect(() => factory(beroenden({ dataDir: katalog, klocka: k }))).toThrow(/schedule kräver tjänsten notify — slå på båda/);
  });

  it.each([
    ['SVC_SCHEDULE_MAX_PER_APP', 'många'],
    ['SVC_SCHEDULE_MAX_PER_USER', '0'],
    ['SVC_SCHEDULE_TICK_MS', '-5'],
    ['SVC_SCHEDULE_MAX_DAYS_AHEAD', '1.5'],
  ])('kastar vid ogiltig %s', (namn, varde) => {
    expect(() => factory(beroenden({ dataDir: katalog, klocka: k, notifier, env: { [namn]: varde } }))).toThrow(namn);
  });

  it('ger tjänsten schedule', async () => {
    const { service } = factory(beroenden({ dataDir: katalog, klocka: k, notifier }));
    expect(service.name).toBe('schedule');
    expect(service.maxBodyBytes).toBeGreaterThan(0);
    await service.close?.();
  });
});

describe('schemalägga', () => {
  it('ger id och nästa tid', async () => {
    const s = starta();
    const svar = await skapa(s, BERTIL, { at: '2026-10-02T09:00:00+02:00' });
    expect(svar.status).toBe(201);
    expect(svar.headers['Content-Type']).toMatch(/^application\/json/);
    const kropp = json(svar);
    expect(kropp['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(kropp['nextAt']).toBe('2026-10-02T07:00:00.000Z');
  });

  it.each([
    ['en tid som har passerat', { at: '2026-10-01T09:59:59Z' }],
    ['just nu', { at: NU }],
    ['en tid utan tidszon', { at: '2026-10-02T09:00:00' }],
    ['en påhittad tidszon', { at: '2026-10-02T09:00:00+25:00' }],
    ['en namngiven tidszon', { at: '2026-10-02T09:00:00[Europe/Mars]' }],
    ['mer än ett år fram', { at: '2027-10-03T10:00:00Z' }],
    ['en tid som tal', { at: 1_790_000_000_000 }],
    ['okänd upprepning', { repeat: 'hourly' }],
    ['upprepning med fel skiftläge', { repeat: 'Daily' }],
    ['okänd mottagare', { to: 'everyone' }],
    ['tom mottagarlista', { to: [] }],
    ['mottagare som inte är text', { to: [42] }],
    ['mottagare med NUL', { to: ['anna\u0000'] }],
    ['för många mottagare', { to: Array.from({ length: 101 }, (_, i) => `anv-${i}`) }],
    ['tomt ämne', { subject: '' }],
    ['för långt ämne', { subject: 'x'.repeat(201) }],
    ['ämne med radbrytning', { subject: 'Städdag\r\nBcc: alla@example.org' }],
    ['text med NUL', { text: 'hej\u0000' }],
    ['för lång text', { text: 'x'.repeat(4001) }],
    ['ett fält för app-id', { appId: APP_B }],
  ])('nekar %s', async (_namn, over) => {
    const s = starta();
    const svar = await skapa(s, ANNA, over);
    expect(svar.status).toBe(400);
    expect(felkod(svar)).toBe('invalid_request');
    expect(await lista(s, ANNA)).toEqual([]);
  });

  it.each([
    ['ogiltig JSON', '{"at":'],
    ['en lista', '[]'],
    ['null', 'null'],
    ['tom kropp', ''],
  ])('nekar kroppen %s', async (_namn, kropp) => {
    const s = starta();
    const svar = await s.service.handle(forfragan(ANNA, 'POST', [], kropp));
    expect(svar.status).toBe(400);
  });

  it('nekar ogiltig UTF-8', async () => {
    const s = starta();
    const svar = await s.service.handle(forfragan(ANNA, 'POST', [], new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
    expect(svar.status).toBe(400);
  });

  it('har en gräns per användare', async () => {
    const s = starta({ SVC_SCHEDULE_MAX_PER_USER: '2' });
    await skapaId(s, BERTIL);
    await skapaId(s, BERTIL);
    const svar = await skapa(s, BERTIL);
    expect(svar.status).toBe(429);
    expect(felkod(svar)).toBe('rate_limited');
    // Andra i samma app påverkas inte.
    await skapaId(s, CECILIA);
  });

  it('har en gräns per app, och en annan app påverkas inte', async () => {
    const s = starta({ SVC_SCHEDULE_MAX_PER_APP: '3' });
    await skapaId(s, ANNA);
    await skapaId(s, BERTIL);
    await skapaId(s, CECILIA);
    expect((await skapa(s, ANNA)).status).toBe(429);
    await skapaId(s, { ...BERTIL, appId: APP_B, access: 'owner' });
  });

  it('en borttagen påminnelse räknas inte mot gränsen', async () => {
    const s = starta({ SVC_SCHEDULE_MAX_PER_USER: '1' });
    const id = await skapaId(s, BERTIL);
    expect((await s.service.handle(forfragan(BERTIL, 'DELETE', [id]))).status).toBe(200);
    await skapaId(s, BERTIL);
  });

  it('svarar 405 på andra metoder och 404 på okända vägar', async () => {
    const s = starta();
    expect((await s.service.handle(forfragan(ANNA, 'PUT', [], paminnelse()))).status).toBe(405);
    expect((await s.service.handle(forfragan(ANNA, 'POST', ['x'], paminnelse()))).status).toBe(404);
    expect((await s.service.handle(forfragan(ANNA, 'GET', ['a', 'b']))).status).toBe(404);
    expect((await s.service.handle(forfragan(ANNA, 'DELETE', []))).status).toBe(405);
  });
});

describe('lista', () => {
  it('en medlem ser sina egna, ägaren ser alla i appen', async () => {
    const s = starta();
    await skapaId(s, ANNA, { subject: 'Styrelsemöte' });
    await skapaId(s, BERTIL, { subject: 'Tvättid', repeat: 'weekly', to: ['bertil'] });
    const bertils = await lista(s, BERTIL);
    expect(bertils).toEqual([
      {
        id: expect.any(String),
        nextAt: '2026-10-01T11:00:00.000Z',
        repeat: 'weekly',
        to: ['bertil'],
        subject: 'Tvättid',
        text: 'Ta med arbetshandskar.',
        createdBy: 'bertil',
      },
    ]);
    expect((await lista(s, ANNA)).map((r) => r['subject']).sort()).toEqual(['Styrelsemöte', 'Tvättid']);
    expect(await lista(s, CECILIA)).toEqual([]);
  });

  it('en annan app och förhandsvisningen ser inte appens påminnelser', async () => {
    const s = starta();
    await skapaId(s, ANNA);
    expect(await lista(s, { ...BERTIL, appId: APP_B, access: 'owner' })).toEqual([]);
    expect(await lista(s, { ...ANNA, kind: 'draft' })).toEqual([]);
  });
});

describe('ta bort', () => {
  it('skaparen kan ta bort sin egen', async () => {
    const s = starta();
    const id = await skapaId(s, BERTIL);
    const svar = await s.service.handle(forfragan(BERTIL, 'DELETE', [id]));
    expect(svar.status).toBe(200);
    expect(json(svar)).toEqual({ cancelled: true });
    expect(await lista(s, BERTIL)).toEqual([]);
  });

  it('ägaren kan ta bort en medlems', async () => {
    const s = starta();
    const id = await skapaId(s, BERTIL);
    expect((await s.service.handle(forfragan(ANNA, 'DELETE', [id]))).status).toBe(200);
    expect(await lista(s, BERTIL)).toEqual([]);
  });

  it('en annan medlem får "finns inte" och påminnelsen finns kvar', async () => {
    const s = starta();
    const id = await skapaId(s, ANNA);
    const svar = await s.service.handle(forfragan(BERTIL, 'DELETE', [id]));
    expect(svar.status).toBe(404);
    expect(felkod(svar)).toBe('not_found');
    expect(await lista(s, ANNA)).toHaveLength(1);
  });

  it('en annan app — även med ägarens roll — får "finns inte"', async () => {
    const s = starta();
    const id = await skapaId(s, ANNA);
    expect((await s.service.handle(forfragan({ ...BERTIL, appId: APP_B, access: 'owner' }, 'DELETE', [id]))).status).toBe(404);
    expect((await s.service.handle(forfragan({ ...ANNA, kind: 'draft' }, 'DELETE', [id]))).status).toBe(404);
    expect(await lista(s, ANNA)).toHaveLength(1);
  });

  it.each(['okänt', '../../etc', 'x'.repeat(500), '00000000-0000-0000-0000-000000000000'])('okänt id %s ger "finns inte"', async (id) => {
    const s = starta();
    expect((await s.service.handle(forfragan(ANNA, 'DELETE', [id]))).status).toBe(404);
  });
});

describe('utskick', () => {
  it('skickar när det är dags, en gång, genom notify', async () => {
    const s = starta();
    await skapaId(s, BERTIL, { to: ['anna', 'cecilia'] });
    await s.tick();
    expect(notifier.skickat).toEqual([]);
    k.satt(OM_EN_TIMME);
    await s.tick();
    await s.tick();
    expect(notifier.skickat).toEqual([{ appId: APP_A, to: ['anna', 'cecilia'], subject: 'Städdag', text: 'Ta med arbetshandskar.' }]);
    expect(await lista(s, BERTIL)).toEqual([]);
  });

  it('en upprepad påminnelse får en ny tid efter utskicket', async () => {
    const s = starta();
    await skapaId(s, ANNA, { repeat: 'daily' });
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat).toHaveLength(1);
    expect((await lista(s, ANNA))[0]?.['nextAt']).toBe('2026-10-02T11:00:00.000Z');
  });

  it('varje vecka över höstens sommartidsövergång: samma klockslag i Stockholm', async () => {
    const s = starta();
    await skapaId(s, ANNA, { at: '2026-10-23T09:00:00+02:00', repeat: 'weekly' });
    k.satt('2026-10-23T07:00:00Z');
    await s.tick();
    expect((await lista(s, ANNA))[0]?.['nextAt']).toBe('2026-10-30T08:00:00.000Z');
  });

  it('efter en omstart med missade tillfällen skickas påminnelsen EN gång, och nästa tid ligger efter nu', async () => {
    const forsta = starta();
    await skapaId(forsta, ANNA, { repeat: 'daily' });
    await forsta.service.close?.();

    k.satt('2026-10-06T15:00:00Z'); // fem missade tillfällen
    const andra = starta();
    await andra.tick();
    expect(notifier.skickat).toHaveLength(1);
    expect((await lista(andra, ANNA))[0]?.['nextAt']).toBe('2026-10-07T11:00:00.000Z');
  });

  it('en engångspåminnelse som missats under ett avbrott skickas en gång efteråt', async () => {
    const forsta = starta();
    await skapaId(forsta, ANNA);
    await forsta.service.close?.();
    k.satt('2026-10-03T10:00:00Z');
    const andra = starta();
    await andra.tick();
    await andra.tick();
    expect(notifier.skickat).toHaveLength(1);
  });

  it('en klocka som hoppar bakåt skickar inget i förtid och tappar inget', async () => {
    const s = starta();
    await skapaId(s, ANNA, { repeat: 'daily' });
    k.satt('2026-09-01T10:00:00Z');
    await s.tick();
    expect(notifier.skickat).toEqual([]);
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat).toHaveLength(1);
  });

  it('två samtidiga väckningar skickar inte dubbelt', async () => {
    const s = starta();
    await skapaId(s, ANNA);
    k.satt(OM_EN_TIMME);
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    expect(notifier.skickat).toHaveLength(1);
  });

  it('en krasch mitt i ett utskick ger hellre en missad än en dubblett', async () => {
    const forsta = starta();
    await skapaId(forsta, ANNA, { repeat: 'daily' });
    k.satt(OM_EN_TIMME);
    // Första processen fastnar mitt i utskicket och "dör" — den stängs aldrig.
    let fastnade!: () => void;
    const fast = new Promise<void>((resolve) => {
      fastnade = resolve;
    });
    notifier.beteende = () => new Promise<void>(() => fastnade());
    void forsta.tick();
    await fast;
    oppna.splice(oppna.indexOf(forsta), 1);

    notifier.beteende = async () => {};
    const andra = starta();
    await andra.tick();
    expect(notifier.skickat).toEqual([]);
    expect((await lista(andra, ANNA))[0]?.['nextAt']).toBe('2026-10-02T11:00:00.000Z');
  });

  it('ett misslyckat utskick görs inte om, och loggas utan ämne och text', async () => {
    const s = starta();
    await skapaId(s, ANNA);
    k.satt(OM_EN_TIMME);
    notifier.beteende = async () => {
      throw new Error('Mailgun svarade 500 om Städdag');
    };
    await s.tick();
    notifier.beteende = async () => {};
    await s.tick();
    expect(notifier.skickat).toEqual([]);
    expect(loggen.rader.some((r) => r['event'] === 'reminder_failed' && r['level'] === 'warn')).toBe(true);
  });

  it.each(['invalid_request', 'rate_limited'] as const)(
    'notify nekar en påminnelse (%s): den loggas med felkoden och de andra skickas ändå',
    async (kod) => {
      const s = starta();
      await skapaId(s, ANNA, { subject: 'Nekad', text: 'Se https://example.org' });
      await skapaId(s, BERTIL, { subject: 'Vanlig', at: '2026-10-01T11:00:01Z' });
      k.satt('2026-10-01T11:00:01Z');
      notifier.beteende = async (u) => {
        if (u.subject === 'Nekad') throw new DataApiError(kod, 'Texten innehåller en webbadress: https://example.org');
      };
      await s.tick();
      expect(notifier.skickat.map((u) => u.subject)).toEqual(['Vanlig']);
      const rad = loggen.rader.find((r) => r['event'] === 'reminder_failed');
      expect(rad).toMatchObject({ level: 'warn', error: 'DataApiError', code: kod });
      expect(JSON.stringify(loggen.rader)).not.toContain('example.org');
    },
  );

  it('i förhandsvisningen går påminnelsen bara till ägaren, vad appen än angav', async () => {
    const s = starta();
    const utkast = { ...ANNA, kind: 'draft' as const };
    const svar = await skapa(s, utkast, { to: ['bertil', 'cecilia'] });
    expect(svar.status).toBe(201);
    expect((await lista(s, utkast))[0]?.['to']).toBe('owner');
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat).toEqual([{ appId: APP_A, to: 'owner', subject: 'Städdag', text: 'Ta med arbetshandskar.' }]);
  });

  it('en påminnelse vars skapare inte längre är medlem skickas inte och tas bort', async () => {
    const s = starta();
    await skapaId(s, BERTIL, { repeat: 'daily' });
    medlemmar.taBort(APP_A, 'bertil');
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat).toEqual([]);
    expect(await lista(s, ANNA)).toEqual([]);
    expect(loggen.rader.some((r) => r['event'] === 'reminder_dropped')).toBe(true);
  });

  it('skickar många förfallna påminnelser i en och samma väckning', async () => {
    const s = starta({ SVC_SCHEDULE_MAX_PER_APP: '1000', SVC_SCHEDULE_MAX_PER_USER: '1000' });
    for (let i = 0; i < 250; i += 1) await skapaId(s, ANNA, { subject: `Nr ${i}` });
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat).toHaveLength(250);
    expect(new Set(notifier.skickat.map((u) => u.subject)).size).toBe(250);
  });

  it('en annan apps påminnelser skickas med den appens id', async () => {
    const s = starta();
    await skapaId(s, { ...BERTIL, appId: APP_B, access: 'owner' });
    k.satt(OM_EN_TIMME);
    await s.tick();
    expect(notifier.skickat.map((u) => u.appId)).toEqual([APP_B]);
  });

  it('timern skickar av sig själv', async () => {
    const s = starta({ SVC_SCHEDULE_TICK_MS: '10' });
    await skapaId(s, ANNA);
    k.satt(OM_EN_TIMME);
    for (let i = 0; i < 100 && notifier.skickat.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(notifier.skickat).toHaveLength(1);
  });
});

describe('stänga', () => {
  it('väntar in pågående utskick och skickar sedan inget mer', async () => {
    const s = starta();
    await skapaId(s, ANNA);
    await skapaId(s, BERTIL, { at: I_MORGON });
    k.satt(OM_EN_TIMME);
    let slapp!: () => void;
    notifier.beteende = () =>
      new Promise<void>((resolve) => {
        slapp = resolve;
      });
    const tick = s.tick();
    await new Promise((r) => setTimeout(r, 5));
    let stangd = false;
    const stangning = s.service.close?.().then(() => {
      stangd = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(stangd).toBe(false);
    slapp();
    await tick;
    await stangning;
    expect(stangd).toBe(true);
    expect(notifier.skickat).toHaveLength(1);
    oppna.splice(oppna.indexOf(s), 1);

    k.satt('2026-10-03T10:00:00Z');
    await s.tick();
    expect(notifier.skickat).toHaveLength(1);
  });
});

describe('loggar', () => {
  it('innehåller aldrig ämne, text eller e-postadresser', async () => {
    const s = starta();
    await skapaId(s, ANNA, { subject: 'HEMLIGT-ÄMNE', text: 'HEMLIG-TEXT', repeat: 'daily' });
    await skapaId(s, BERTIL, { subject: 'HEMLIGT-ÄMNE', text: 'HEMLIG-TEXT' });
    medlemmar.taBort(APP_A, 'bertil');
    await skapa(s, ANNA, { subject: 'HEMLIGT-ÄMNE', text: 'HEMLIG-TEXT', at: 'fel' });
    k.satt(OM_EN_TIMME);
    await s.tick();
    const allt = JSON.stringify(loggen.rader);
    expect(loggen.rader.length).toBeGreaterThan(0);
    expect(allt).not.toContain('HEMLIG');
    expect(allt).not.toContain('@example.org');
    expect(allt).not.toContain(APP_A);
  });
});
