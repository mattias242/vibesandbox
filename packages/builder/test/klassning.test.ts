/**
 * Informationsklassningen: hur känsliga uppgifter appen ska hantera sätts ÅT den som bygger.
 *
 * Det som prövas här är inte klassningens omdöme (det bor i policy- och agent-paketen) utan tre
 * saker kön och kontrollrummet svarar för. Ordningen: önskemålet prövas mot de röda linjerna
 * FÖRST, klassas SEDAN, och först därefter får agenten se det — ett stoppat önskemål ska aldrig
 * nå en modell, inte ens för att klassas. Riktningen: klassen höjs men sänks aldrig, och en
 * omklassning till samma klass flyttar inte tidpunkten framåt. Och tystnaden: registret svarar
 * på att appen finns och hur känslig den är, aldrig på vad någon skrivit i den.
 *
 * Allt som går fel faller åt det stränga hållet: en klassning som kastar fäller inte bygget, men
 * appen står kvar oklassad — vilket läses som den strängaste klassen.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ADMIN_APP_ID_PREFIX_LENGTH, STRICTEST_CLASSIFICATION } from '@vibesandbox/contracts';
import type { Classification, ClassificationSource, Identity, RedlineCategory } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAM, ANNA, VERA, anropa, api, nyApp, publiceraViaGranskning, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

const REGISTER = api('/admin/register');

/** Ingen roll alls — en inloggad person som ännu inte fått något. */
const INGEN: Identity = { userId: 'u-ingen', email: 'ingen@example.org', roles: [] };

/**
 * Ett unikt ord ur önskemålet. Finns ordet i en loggrad eller i registrets svar har texten läckt
 * dit den inte hör hemma, och då spelar det ingen roll hur klassningen gick.
 */
const HEMLIGT_ORD = 'gurkmeja';
const ONSKEMAL = `En anmälan där varje deltagare fyller i namn, telefonnummer och ${HEMLIGT_ORD}`;
const POANG = 'Poängsätt alla elever efter hur de beter sig på rasten';

type Omdome = { classification: Classification; source: ClassificationSource };

const INTERN: Omdome = { classification: 'intern', source: 'modell' };

/** Appen får ett eget namn, för det första önskemålet blir annars appens namn (och står i registret). */
const NAMN = 'Kursanmälan';

// ── Fejkarna ─────────────────────────────────────────────────────────────────────

/** Önskemålen som klassats, i ordning. Ett stopp ska aldrig lägga något här. */
let klassade: string[];
/** Omdömen som ges i tur och ordning; när listan är tom används `standardOmdome`. */
let kommande: Omdome[];
let standardOmdome: Omdome;
/** Sätts för att klassningen ska kasta i stället för att svara. */
let klassningsFel: Error | null;
/** Vem som anropades när: de röda linjerna, klassningen och agenten skriver var sitt ord här. */
let ordning: string[];

async function fejkadKlassning(request: string): Promise<Omdome> {
  ordning.push('klassning');
  klassade.push(request);
  if (klassningsFel !== null) throw klassningsFel;
  return kommande.shift() ?? standardOmdome;
}

function fejkadProvning(request: string): RedlineCategory | null {
  ordning.push('röda linjer');
  return request.includes('Poängsätt') ? 'social-poangsattning' : null;
}

let m: Miljo;

beforeEach(async () => {
  klassade = [];
  kommande = [];
  standardOmdome = INTERN;
  klassningsFel = null;
  ordning = [];
  m = await skapaMiljo({ checkRedlines: fejkadProvning, classifyRequest: fejkadKlassning });
  const grundtur = m.agent.standard;
  m.agent.standard = async (input) => {
    ordning.push('agent');
    return grundtur(input);
  };
});

afterEach(async () => {
  await m.stada();
});

// ── Hjälp ────────────────────────────────────────────────────────────────────────

/** En app med eget namn och ett genomfört bygge bakom sig. */
async function byggdApp(text = ONSKEMAL, namn = NAMN): Promise<string> {
  const appId = await nyApp(m.builder, ANNA, namn);
  const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, text));
  expect(jobb.json.status).toBe('done');
  return appId;
}

/** Registrets rad för en app, läst som administratör. */
async function registerrad(appId: string): Promise<Record<string, unknown>> {
  const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);
  expect(svar.status).toBe(200);
  const prefix = appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH);
  const rad = svar.json.entries.find((post: { appIdPrefix: string }) => post.appIdPrefix === prefix);
  expect(rad, 'appen saknas i registret').toBeDefined();
  return rad as Record<string, unknown>;
}

/**
 * Skriver direkt i databasen och startar om byggverktyget mot samma katalog. Enda vägen att pröva
 * hur en rad skriven av en ÄLDRE version av vår egen kod läses: kön kan bara skriva ord som finns
 * i kontraktet, och det är just de okända orden som ska falla åt det stränga hållet.
 */
async function skrivIDatabasen(sats: string): Promise<void> {
  await m.builder.close();
  const db = new DatabaseSync(join(m.dataDir, 'builder.sqlite'));
  try {
    db.exec(sats);
  } finally {
    db.close();
  }
  m.builder = m.starta();
}

// ── Ordningen i kön ──────────────────────────────────────────────────────────────

describe('varje önskemål klassas innan det byggs', () => {
  it('appen bär klassen efter att bygget är klart', async () => {
    const appId = await byggdApp();

    expect(klassade).toEqual([ONSKEMAL]);
    expect(await registerrad(appId)).toMatchObject({
      classification: 'intern',
      source: 'modell',
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
  });

  it('ett stoppat önskemål klassas inte alls — det når aldrig en modell', async () => {
    const appId = await nyApp(m.builder, ANNA, NAMN);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));

    expect(jobb.json.status).toBe('failed');
    expect(klassade).toEqual([]);
    expect(ordning).toEqual(['röda linjer']);
    expect(m.agent.inputs).toHaveLength(0);
    // Appen står kvar oklassad, och läses därför som den strängaste klassen.
    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      source: 'fail-closed',
      classifiedAt: null,
    });
  });

  it('klassningen ligger mellan de röda linjerna och agenten', async () => {
    await byggdApp();
    expect(ordning).toEqual(['röda linjer', 'klassning', 'agent']);
  });

  it('en klassning som kastar fäller inte bygget, men appen står kvar oklassad', async () => {
    klassningsFel = new Error('modellen svarade inte');
    const appId = await byggdApp();

    expect(klassade).toEqual([ONSKEMAL]);
    expect(ordning).toEqual(['röda linjer', 'klassning', 'agent']);
    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      source: 'fail-closed',
      classifiedAt: null,
    });
    expect(m.logg.some((rad) => rad.event === 'internal_error' && rad.reason === 'classification_failed')).toBe(true);
    expect(m.logg.some((rad) => rad.event === 'request_classified')).toBe(false);
  });

  it('utan klassning alls byggs appen precis som förut, och ingenting klassas', async () => {
    await m.stada();
    m = await skapaMiljo();

    const appId = await nyApp(m.builder, ANNA, NAMN);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, ONSKEMAL));

    expect(jobb.json.status).toBe('done');
    expect(m.agent.inputs).toHaveLength(1);
    expect(m.logg.some((rad) => rad.event === 'request_classified')).toBe(false);
    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      source: 'fail-closed',
      classifiedAt: null,
    });
  });

  it('loggen bär klass och källa — men aldrig önskemålets text', async () => {
    const appId = await byggdApp();

    const rad = m.logg.find((post) => post.event === 'request_classified');
    expect(rad).toMatchObject({
      level: 'info',
      event: 'request_classified',
      appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      classification: 'intern',
      classificationSource: 'modell',
    });

    const logg = JSON.stringify(m.logg);
    expect(logg).not.toContain(HEMLIGT_ORD);
    expect(logg).not.toContain(ONSKEMAL);
    expect(logg).not.toContain('telefonnummer');
    expect(logg).not.toContain(appId);
  });
});

// ── Höjningsregeln ───────────────────────────────────────────────────────────────

describe('appens klass höjs men sänks aldrig', () => {
  /** Ett önskemål till mot samma app, en minut senare, med ett bestämt omdöme. */
  async function omklassa(appId: string, omdome: Omdome, text = 'Lägg till en knapp'): Promise<void> {
    kommande.push(omdome);
    m.tid.ms += 60_000;
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, text));
    expect(jobb.json.status).toBe('done');
  }

  it('en oklassad app får sin första klass', async () => {
    const appId = await nyApp(m.builder, ANNA, NAMN);
    expect(await registerrad(appId)).toMatchObject({ classification: STRICTEST_CLASSIFICATION, classifiedAt: null });

    kommande.push({ classification: 'oppen', source: 'modell' });
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, ONSKEMAL));

    expect(await registerrad(appId)).toMatchObject({
      classification: 'oppen',
      source: 'modell',
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
  });

  it('ett strängare önskemål höjer klassen', async () => {
    kommande.push({ classification: 'intern', source: 'modell' });
    const appId = await byggdApp();

    await omklassa(appId, { classification: 'personuppgift', source: 'signalord' });

    expect(await registerrad(appId)).toMatchObject({
      classification: 'personuppgift',
      source: 'signalord',
      classifiedAt: '2026-09-19T08:01:00.000Z',
    });
  });

  it('ett mildare önskemål sänker ingenting — inte klassen, inte källan, inte tidpunkten', async () => {
    kommande.push({ classification: 'personuppgift', source: 'signalord' });
    const appId = await byggdApp();

    await omklassa(appId, { classification: 'oppen', source: 'modell' });

    expect(await registerrad(appId)).toMatchObject({
      classification: 'personuppgift',
      source: 'signalord',
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
    // Loggen säger vad klassen BLEV, inte vad modellen föreslog.
    const rader = m.logg.filter((post) => post.event === 'request_classified');
    expect(rader.at(-1)).toMatchObject({ classification: 'personuppgift' });
  });

  it('samma klass igen ändrar ingenting och flyttar inte tidpunkten framåt', async () => {
    kommande.push({ classification: 'intern', source: 'modell' });
    const appId = await byggdApp();

    await omklassa(appId, { classification: 'intern', source: 'signalord' });

    expect(await registerrad(appId)).toMatchObject({
      classification: 'intern',
      // Källan står kvar: ingen höjning skedde, alltså skrevs ingenting om.
      source: 'modell',
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
  });

  it('en klassning som gick fel åt det stränga hållet höjer från en mildare klass', async () => {
    kommande.push({ classification: 'intern', source: 'modell' });
    const appId = await byggdApp();

    await omklassa(appId, { classification: STRICTEST_CLASSIFICATION, source: 'fail-closed' });

    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      source: 'fail-closed',
      classifiedAt: '2026-09-19T08:01:00.000Z',
    });
  });

  it('en app som redan står på den strängaste klassen rörs inte av nästa önskemål', async () => {
    kommande.push({ classification: STRICTEST_CLASSIFICATION, source: 'fail-closed' });
    const appId = await byggdApp();

    await omklassa(appId, { classification: 'oppen', source: 'modell' });

    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      source: 'fail-closed',
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
  });
});

// ── Registret ────────────────────────────────────────────────────────────────────

describe('AI-registret i kontrollrummet', () => {
  async function publicera(appId: string): Promise<void> {
    await publiceraViaGranskning(m.builder, appId);
  }

  it('administratören får varje app med klass, källa, ägarens adress och om den är publicerad', async () => {
    const appId = await byggdApp();
    await publicera(appId);

    const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);
    expect(svar.status).toBe(200);
    expect(svar.json.entries).toEqual([
      {
        appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        name: NAMN,
        ownerEmail: ANNA.email,
        classification: 'intern',
        source: 'modell',
        classifiedAt: '2026-09-19T08:00:00.000Z',
        published: true,
      decommissionedAt: null,
      },
    ]);
    expect(svar.headers['Cache-Control']).toBe('no-store');
  });

  it('en app som aldrig klassats läses som den strängaste klassen, utan påhittad tidpunkt', async () => {
    await nyApp(m.builder, ANNA, 'Tom app');

    const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);
    expect(svar.json.entries).toEqual([
      {
        appIdPrefix: expect.any(String),
        name: 'Tom app',
        ownerEmail: ANNA.email,
        classification: STRICTEST_CLASSIFICATION,
        source: 'fail-closed',
        classifiedAt: null,
        published: false,
      decommissionedAt: null,
      },
    ]);
  });

  it('ett okänt ord i klasskolumnen läses som den strängaste klassen', async () => {
    const appId = await byggdApp();
    await skrivIDatabasen(`UPDATE apps SET classification = 'topphemlig'`);

    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      // Klassen ÄR satt, om än till ett ord vi inte känner igen — tidpunkten är alltså sann.
      classifiedAt: '2026-09-19T08:00:00.000Z',
    });
  });

  it('en tidpunkt utan klass räknas inte — registret hittar inte på när klassen sattes', async () => {
    const appId = await byggdApp();
    // En rad där klassen är borta men tidpunkten står kvar. Registret ska läsa den som oklassad
    // och svara `null`, inte visa en tidpunkt för en klass som inte finns.
    await skrivIDatabasen(`UPDATE apps SET classification = NULL`);

    expect(await registerrad(appId)).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      classifiedAt: null,
    });
  });

  it('en okänd källa läses som fail-closed, utan att klassen ändras', async () => {
    const appId = await byggdApp();
    await skrivIDatabasen(`UPDATE apps SET classification_source = 'magkansla'`);

    expect(await registerrad(appId)).toMatchObject({ classification: 'intern', source: 'fail-closed' });
  });

  it('bara app-id:ts första tecken finns i svaret — hela id:t läcker aldrig', async () => {
    const appId = await byggdApp();
    const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);

    expect(svar.json.entries[0].appIdPrefix).toBe(appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
    expect(svar.json.entries[0].appIdPrefix).toHaveLength(ADMIN_APP_ID_PREFIX_LENGTH);
    expect(appId.length).toBeGreaterThan(ADMIN_APP_ID_PREFIX_LENGTH);
    expect(svar.text).not.toContain(appId);
    expect(svar.text).not.toContain(appId.slice(ADMIN_APP_ID_PREFIX_LENGTH));
    // Ingen länk: registret ger insyn i att appen finns, aldrig en väg in i den.
    expect(svar.text).not.toContain('https://');
  });

  it('önskemålets text finns inte någonstans i svaret', async () => {
    await byggdApp();
    const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);

    expect(svar.text).not.toContain(HEMLIGT_ORD);
    expect(svar.text).not.toContain(ONSKEMAL);
    expect(svar.text).not.toContain('telefonnummer');
  });

  it('en byggare kommer inte in, och får veta att det är adminrollen som saknas', async () => {
    await byggdApp();

    for (const vem of [ANNA, VERA, INGEN]) {
      const svar = await anropa(m.builder, vem, 'GET', REGISTER);
      expect(svar.status, vem.userId).toBe(403);
      expect(svar.json.error.code).toBe('forbidden');
      expect(svar.json.entries).toBeUndefined();
      expect(svar.text).not.toContain('classification');
    }
  });

  it('fel metod ger 405, och ett segment till är ingen rutt', async () => {
    for (const metod of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const svar = await anropa(m.builder, ADAM, metod, REGISTER, { body: {} });
      expect(svar.status, metod).toBe(405);
      expect(svar.json.error.code).toBe('method_not_allowed');
    }
    for (const vag of ['/admin/register/extra', '/admin/register/', '/admin/Register', '/admin//register']) {
      const svar = await anropa(m.builder, ADAM, 'GET', api(vag));
      expect([400, 404], vag).toContain(svar.status);
      expect(svar.json.entries).toBeUndefined();
    }
  });

  it('en plattform utan appar svarar med en tom lista', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', REGISTER);
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ entries: [] });
  });
});
