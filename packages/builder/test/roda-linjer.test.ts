/**
 * De röda linjerna: ett önskemål om förbjuden användning stoppas INNAN språkmodellen får se det.
 *
 * Det som prövas här är inte prövningens omdöme (den bor i policy-paketet) utan vad kön gör med ett
 * stopp: ingen tur startas, inget utkast ändras, den som bad om appen får ett besked i klarspråk om
 * att det var ett beslut — och kontrollrummet ser stoppet utan att vare sig önskemålets text eller
 * hela app-id:t följer med. Ett stopp är inte ett byggfel och ska inte räknas som ett.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ADMIN_APP_ID_PREFIX_LENGTH } from '@vibesandbox/contracts';
import type { Identity, RedlineCategory } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../src/databas.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/sql.ts';
import {
  ADAM,
  ANNA,
  VERA,
  anropa,
  api,
  misslyckadTur,
  nyApp,
  skapaMiljo,
  skicka,
  tempKatalog,
  vantaPaJobb,
} from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

const STOPP = api('/admin/stopp');

/** Ingen roll alls — en inloggad person som ännu inte fått något. */
const INGEN: Identity = { userId: 'u-ingen', email: 'ingen@example.org', roles: [] };

const POANG = 'Poängsätt alla elever efter hur de beter sig på rasten';
const KANSLOR = 'Läs av känslorna hos personalen under mötet';
const OFARLIGT = 'En todo-lista';

/**
 * Vår egen fejk av prövningen i packages/policy: samma signatur, men ett fast omdöme. Kön ska bete
 * sig likadant oavsett vem som säger nej.
 */
function fejkadProvning(request: string): RedlineCategory | null {
  if (request.includes('Poängsätt')) return 'social-poangsattning';
  if (request.includes('känslorna')) return 'kansloigenkanning';
  return null;
}

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo({ checkRedlines: fejkadProvning });
});
afterEach(async () => {
  await m.stada();
});

describe('ett stoppat önskemål når aldrig språkmodellen', () => {
  it('agenten anropas inte alls, och ingenting byggs', async () => {
    const appId = await nyApp(m.builder);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));

    expect(jobb.json.status).toBe('failed');
    expect(m.agent.inputs).toHaveLength(0);
    expect(m.control.anrop).toEqual(['createApp']);
    expect(m.control.importerade).toEqual([]);
  });

  it('appens utkast står kvar oförändrat', async () => {
    const appId = await nyApp(m.builder);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, OFARLIGT));
    expect(m.control.utkast.get(appId)).toBe('version-1');

    await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));

    expect(m.control.utkast.get(appId)).toBe('version-1');
    expect(m.control.importerade).toHaveLength(1);
    expect(m.agent.inputs).toHaveLength(1);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.hasDraft).toBe(true);
  });

  it('beskedet är klarspråk och låter som ett beslut, inte som ett tekniskt fel', async () => {
    const appId = await nyApp(m.builder);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));

    const besked = jobb.json.events.at(-1);
    expect(besked).toMatchObject({ type: 'done', ok: false });
    expect(besked.message).toMatch(/inte tillåt/i);
    expect(besked.message).not.toMatch(/fel hos plattformen|försök igen om en stund/i);

    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    const sista = detalj.json.messages.at(-1);
    expect(sista.role).toBe('assistant');
    expect(sista.text).toBe(besked.message);
    expect(sista.text.length).toBeGreaterThan(40);
    // Kategorin är vårt eget ordval och hör hemma i kontrollrummet, inte i ett besked till den
    // som bad om appen.
    expect(sista.text).not.toContain('social-poangsattning');
  });

  it('nästa önskemål går vidare till agenten precis som förut', async () => {
    const appId = await nyApp(m.builder);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, OFARLIGT));

    expect(jobb.json.status).toBe('done');
    expect(m.agent.inputs).toHaveLength(1);
    expect(m.agent.inputs[0]!.request).toBe(OFARLIGT);
  });

  it('ingen loggrad i hela körningen bär önskemålets text', async () => {
    const appId = await nyApp(m.builder);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, POANG));

    const logg = JSON.stringify(m.logg);
    expect(logg).not.toContain('Poängsätt');
    expect(logg).not.toContain(POANG);
    expect(logg).not.toContain(appId);
    // Kategorin bär loggraden — den är fast text ur vår egen kod.
    expect(m.logg.some((rad) => rad.category === 'social-poangsattning')).toBe(true);
  });
});

describe('stoppet i kontrollrummet', () => {
  async function stoppa(text = POANG, agare: Identity = ANNA): Promise<string> {
    const appId = await nyApp(m.builder, agare);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, text, agare), agare);
    expect(jobb.json.status).toBe('failed');
    return appId;
  }

  it('listar stoppen senast först, med kategori och tidpunkt', async () => {
    const forsta = await stoppa(POANG);
    m.tid.ms += 60_000;
    const andra = await stoppa(KANSLOR, VERA.userId === '' ? ANNA : ANNA);

    const svar = await anropa(m.builder, ADAM, 'GET', STOPP);
    expect(svar.status).toBe(200);
    expect(svar.json.stops).toEqual([
      {
        appIdPrefix: andra.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        category: 'kansloigenkanning',
        at: '2026-09-19T08:01:00.000Z',
      },
      {
        appIdPrefix: forsta.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        category: 'social-poangsattning',
        at: '2026-09-19T08:00:00.000Z',
      },
    ]);
  });

  it('svaret bär aldrig önskemålets text och aldrig ett helt app-id', async () => {
    const appId = await stoppa(POANG);
    const svar = await anropa(m.builder, ADAM, 'GET', STOPP);

    expect(svar.text).not.toContain(POANG);
    expect(svar.text).not.toContain('Poängsätt');
    expect(svar.text).not.toContain(appId);
    expect(svar.text).not.toContain('https://');
    expect(svar.headers['Cache-Control']).toBe('no-store');
  });

  it('ett stopp räknas inte som ett byggfel i översikten', async () => {
    await stoppa(POANG);
    const appId = await nyApp(m.builder);
    m.agent.turer.push(misslyckadTur());
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, OFARLIGT));

    const oversikt = await anropa(m.builder, ADAM, 'GET', api('/admin/oversikt'));
    expect(oversikt.json.failedJobs).toBe(1);
    expect((await anropa(m.builder, ADAM, 'GET', STOPP)).json.stops).toHaveLength(1);
  });

  it('en plattform utan stopp svarar med en tom lista', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', STOPP);
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ stops: [] });
  });

  it('bara plattformens administratörer kommer in', async () => {
    for (const vem of [ANNA, VERA, INGEN]) {
      const svar = await anropa(m.builder, vem, 'GET', STOPP);
      expect(svar.status, vem.userId).toBe(403);
      expect(svar.json.error.code).toBe('forbidden');
      expect(svar.json.stops).toBeUndefined();
    }
  });

  it('fel metod ger 405', async () => {
    for (const metod of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const svar = await anropa(m.builder, ADAM, metod, STOPP, { body: {} });
      expect(svar.status, metod).toBe(405);
      expect(svar.json.error.code).toBe('method_not_allowed');
    }
  });

  it('ett segment till är ingen rutt', async () => {
    for (const vag of ['/admin/stopp/extra', '/admin/stopp/', '/admin/Stopp', '/admin//stopp']) {
      const svar = await anropa(m.builder, ADAM, 'GET', api(vag));
      expect([400, 404], vag).toContain(svar.status);
      expect(svar.json.stops).toBeUndefined();
    }
  });
});

describe('migreringen', () => {
  it('en databas på schema 2 går att öppna och får kolumnen stop_reason', async () => {
    const katalog = await tempKatalog('vibesandbox-builder-schema2-');
    const fil = join(katalog, 'builder.sqlite');

    // En databas som den såg ut före den här skivan: bara de två första stegen.
    const gammal = new DatabaseSync(fil);
    gammal.exec('PRAGMA foreign_keys = ON');
    for (const [index, steg] of MIGRATIONS.slice(0, 2).entries()) {
      gammal.exec(steg);
      gammal.exec(`PRAGMA user_version = ${index + 1}`);
    }
    gammal.exec(`
      INSERT INTO apps (app_id, owner_user_id, name, name_is_default, created_at, updated_at)
      VALUES ('gammalapp', 'u-anna', 'Gammal', 0, '2026-09-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z');
      INSERT INTO jobs (job_id, app_id, message_seq, status, created_at)
      VALUES ('gammaltjobb', 'gammalapp', 1, 'done', '2026-09-01T08:00:00.000Z');
    `);
    gammal.close();

    const db = openBuilderDatabase(katalog);
    try {
      expect(db.get('PRAGMA user_version')?.['user_version']).toBe(SCHEMA_VERSION);
      const kolumner = db.all('PRAGMA table_info(jobs)').map((rad) => rad['name']);
      expect(kolumner).toContain('stop_reason');
      // Raderna som redan fanns är kvar, och är inga stopp.
      const rad = db.get(`SELECT job_id, stop_reason FROM jobs WHERE job_id = 'gammaltjobb'`);
      expect(rad?.['job_id']).toBe('gammaltjobb');
      expect(rad?.['stop_reason']).toBe(null);
    } finally {
      db.close();
    }
  });
});
