/**
 * Avvecklingen och exporten: när en app ska sluta finnas.
 *
 * Två rutter, i den ordning de måste komma. `GET /apps/<id>/export` ger allt appen bär som en fil
 * att spara — appdata i en kommun kan vara allmän handling och får inte försvinna bara för att
 * den som byggde appen tröttnat. `POST /apps/<id>/avveckla` raderar uppgifterna och lämnar kvar
 * beviset på att de raderades.
 *
 * Fyra egenskaper är hela poängen och står därför i egna tester. Bekräftelsen är appens NAMN,
 * ordagrant — ett `{ confirm: true }` klickas bort. Ordningen är DATA först, sedan control: går
 * dataraderingen fel har ingenting tagits bort, går control fel är data borta men appen kvar, och
 * det är det medvetet mindre dåliga av de två lägena. Registerposten ARKIVERAS, den raderas inte:
 * att appen har funnits, vem som ägde den och hur känslig den var är själva svaret en tillsyn
 * behöver. Och gallringsbeviset räknas FÖRE raderingen — efteråt finns inget att räkna.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN_APP_ID_PREFIX_LENGTH, DECOMMISSION_LIMITS, STRICTEST_CLASSIFICATION } from '@vibesandbox/contracts';
import type { Classification, ClassificationSource, Identity, JsonObject } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuilderOptions } from '../src/index.ts';
import {
  ADAM,
  ANNA,
  BERTIL,
  anropa,
  api,
  fejkAnvandare,
  lyckadTur,
  nyApp,
  publiceraViaGranskning,
  skapaMiljo,
  skicka,
  slumpatAppId,
  vantaPaJobb,
} from './hjalp.ts';
import type { Miljo, Svar } from './hjalp.ts';

/** Appens namn. Bekräftelsen vid avvecklingen är precis det här ordet, ordagrant. */
const NAMN = 'Kursanmälan';

/**
 * Ett unikt ord ur önskemålet, och ett ur appens KOD. Dyker något av dem upp i en loggrad har
 * text läckt dit den inte hör hemma, och då spelar resten av svaret ingen roll.
 */
const HEMLIGT_ORD = 'gurkmeja';
const ONSKEMAL = `En anmälan där varje deltagare fyller i namn och ${HEMLIGT_ORD}`;
const HEMLIG_KOD = 'vattenmelon';

// ── Fejkad appdata ───────────────────────────────────────────────────────────────
//
// Byggverktyget når aldrig appens data själv — en `TenantContext` skapas bara i gatewayn, och
// plattformen kopplar ihop de två. `skapaMiljo` kopplar inte in den vägen, så den skickas in här
// som en egen option, precis som `checkRedlines` och `classifyRequest`.

type AppData = NonNullable<BuilderOptions['appData']>;

interface FejkAppData extends AppData {
  /** Appens dokument per kollektion. */
  readonly kollektioner: Map<string, Map<string, JsonObject[]>>;
  /** Hur många filer appen har. Filerna själva finns inte i en fejk. */
  readonly filer: Map<string, number>;
  /** `export` och `destroy` i den ordning de anropades. */
  readonly anrop: string[];
  /** Identiteten varje anrop kom med — exporten ska göras SOM den som frågar. */
  readonly identiteter: string[];
  /** Taket API:t bad om, ett tal per exportanrop. */
  readonly tak: number[];
  /** Ett lägre tak att kapa mot, så att kapningen går att prova utan tiotusen dokument. */
  maxPerKollektion: number | null;
  destroyFel: Error | null;
  lagg(appId: string, kollektion: string, dokument: readonly JsonObject[]): void;
}

function fejkAppData(): FejkAppData {
  const data: FejkAppData = {
    kollektioner: new Map(),
    filer: new Map(),
    anrop: [],
    identiteter: [],
    tak: [],
    maxPerKollektion: null,
    destroyFel: null,
    lagg(appId, kollektion, dokument) {
      const app = data.kollektioner.get(appId) ?? new Map<string, JsonObject[]>();
      app.set(kollektion, [...(app.get(kollektion) ?? []), ...dokument]);
      data.kollektioner.set(appId, app);
    },
    async export(appId, identity, options) {
      data.anrop.push('export');
      data.identiteter.push(identity.userId);
      data.tak.push(options.maxDocumentsPerCollection);
      const tak = data.maxPerKollektion ?? options.maxDocumentsPerCollection;
      const collections: Record<string, { documents: readonly JsonObject[]; truncated: boolean }> = {};
      let documentCount = 0;
      for (const [namn, dokument] of data.kollektioner.get(appId) ?? new Map<string, JsonObject[]>()) {
        const med = dokument.slice(0, tak);
        collections[namn] = { documents: med, truncated: med.length < dokument.length };
        documentCount += med.length;
      }
      return { collections, documentCount };
    },
    async destroy(appId, identity) {
      data.anrop.push('destroy');
      data.identiteter.push(identity.userId);
      if (data.destroyFel !== null) throw data.destroyFel;
      let documentsDeleted = 0;
      for (const dokument of (data.kollektioner.get(appId) ?? new Map<string, JsonObject[]>()).values()) {
        documentsDeleted += dokument.length;
      }
      const filesDeleted = data.filer.get(appId) ?? 0;
      data.kollektioner.delete(appId);
      data.filer.delete(appId);
      return { documentsDeleted, filesDeleted };
    },
  };
  return data;
}

// ── Miljön ───────────────────────────────────────────────────────────────────────

/** Sätts för att klassningen ska kasta: appen står då kvar oklassad, vilket läses fail-closed. */
let klassningsFel: Error | null;
let data: FejkAppData;
let m: Miljo;

const OMDOME: { classification: Classification; source: ClassificationSource } = {
  classification: 'personuppgift',
  source: 'modell',
};

/**
 * En plattform som den riktiga: identiteten inkopplad och en klassning som svarar. Identiteten
 * behövs för att registret ska kunna svara med ÄGAREN efter en avveckling — control:s
 * åtkomstlista revs med appen, och adressen finns då bara kvar i identiteten.
 */
async function nyMiljo(extra: Partial<BuilderOptions> = {}): Promise<Miljo> {
  return skapaMiljo({
    users: fejkAnvandare(),
    classifyRequest: async () => {
      if (klassningsFel !== null) throw klassningsFel;
      return OMDOME;
    },
    ...extra,
  });
}

beforeEach(async () => {
  klassningsFel = null;
  data = fejkAppData();
  m = await nyMiljo({ appData: data });
});
afterEach(async () => {
  await m.stada();
});

/** En app med ett eget namn och ett grönt bygge bakom sig — den har alltså kod och ett samtal. */
async function byggdApp(agare: Identity = ANNA, namn = NAMN): Promise<string> {
  const appId = await nyApp(m.builder, agare, namn);
  m.agent.turer.push(lyckadTur({ 'src/App.tsx': `export function App() { return <h1>${HEMLIG_KOD}</h1>; }` }));
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, ONSKEMAL, agare), agare);
  return appId;
}

async function exportera(appId: string, vem: Identity = ANNA): Promise<Svar> {
  return anropa(m.builder, vem, 'GET', api(`/apps/${appId}/export`));
}

async function avveckla(appId: string, body: unknown = { confirm: NAMN }, vem: Identity = ANNA): Promise<Svar> {
  return anropa(m.builder, vem, 'POST', api(`/apps/${appId}/avveckla`), { body });
}

async function registret(): Promise<Svar> {
  return anropa(m.builder, ADAM, 'GET', api('/admin/register'));
}

async function registerrad(appId: string): Promise<Record<string, unknown> | undefined> {
  const svar = await registret();
  return (svar.json.entries as Record<string, unknown>[]).find((rad) => rad['appIdPrefix'] === appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
}

/**
 * Läser byggverktygets egen databas. Det finns ingen väg UTIFRÅN till ett samtal som är borta —
 * appen svarar 404 för sin ägare — så gallringen går bara att se här inne.
 */
async function iDatabasen<T>(las: (db: DatabaseSync) => T): Promise<T> {
  await m.builder.close();
  const db = new DatabaseSync(join(m.dataDir, 'builder.sqlite'));
  try {
    return las(db);
  } finally {
    db.close();
    m.builder = m.starta();
  }
}

function antal(db: DatabaseSync, tabell: 'apps' | 'revisions' | 'messages', appId: string): number {
  // Tabellnamnet är ett av tre fasta ord ur den här filen, aldrig något som kommit utifrån.
  const rad = db.prepare(`SELECT count(*) AS n FROM ${tabell} WHERE app_id = ?`).get(appId);
  return Number(rad?.['n'] ?? -1);
}

// ── Exporten ─────────────────────────────────────────────────────────────────────

describe('exporten: allt appen bär, som en fil att spara', () => {
  it('bär appens namn, klass och källa, samtalet och dokumenten per kollektion', async () => {
    const appId = await byggdApp();
    await publiceraViaGranskning(m.builder, appId);
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera', plats: 3 }, { namn: 'Ville', plats: 4 }]);
    data.lagg(appId, 'kurser', [{ titel: 'Simskola' }]);

    m.tid.ms += 60_000;
    const svar = await exportera(appId);

    expect(svar.status).toBe(200);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(svar.json.format).toBe(1);
    expect(svar.json.exportedAt).toBe('2026-09-19T08:01:00.000Z');
    expect(svar.json.app).toEqual({
      name: NAMN,
      classification: 'personuppgift',
      classificationSource: 'modell',
      published: true,
    });
    expect(svar.json.collections).toEqual({
      anmalningar: { documents: [{ namn: 'Vera', plats: 3 }, { namn: 'Ville', plats: 4 }], truncated: false },
      kurser: { documents: [{ titel: 'Simskola' }], truncated: false },
    });
    // Samtalet hör till handlingen: det visar VARFÖR appen ser ut som den gör.
    expect(svar.json.conversation[0]).toMatchObject({ role: 'user', text: ONSKEMAL });
    expect(svar.json.conversation.length).toBeGreaterThan(1);
    // Filernas innehåll hämtas var för sig — en export som bakade in dem hade sprängt taket.
    expect(svar.json.files).toEqual([]);
    // Exporten görs SOM den som frågar, inte som plattformen.
    expect(data.identiteter).toEqual([ANNA.userId]);
  });

  it('en app utan data ger tomma kollektioner, inte ett fel', async () => {
    const appId = await byggdApp();
    const svar = await exportera(appId);

    expect(svar.status).toBe(200);
    expect(svar.json.collections).toEqual({});
    expect(svar.json.app.published).toBe(false);
  });

  it('en app ingen kunnat klassa exporteras som den strängaste klassen och fail-closed', async () => {
    klassningsFel = new Error('modellen svarade inte');
    const appId = await byggdApp();
    const svar = await exportera(appId);

    expect(svar.json.app.classification).toBe(STRICTEST_CLASSIFICATION);
    expect(svar.json.app.classificationSource).toBe('fail-closed');
  });

  it('taket kommer ur kontraktet, och en kapad kollektion säger det rakt ut', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ nummer: 1 }, { nummer: 2 }, { nummer: 3 }]);
    data.lagg(appId, 'kurser', [{ titel: 'Simskola' }]);

    const helt = await exportera(appId);
    expect(data.tak).toEqual([DECOMMISSION_LIMITS.maxDocumentsPerCollection]);
    expect(helt.json.collections.anmalningar.truncated).toBe(false);

    data.maxPerKollektion = 2;
    const kapat = await exportera(appId);
    expect(kapat.json.collections.anmalningar).toEqual({ documents: [{ nummer: 1 }, { nummer: 2 }], truncated: true });
    // Kapningen gäller kollektionen som sprängde taket, inte hela exporten.
    expect(kapat.json.collections.kurser.truncated).toBe(false);
  });

  it('bara ägaren — en annan byggare och en administratör får samma svar som för en app som inte finns', async () => {
    const appId = await byggdApp(ANNA);
    const ingenApp = await exportera(slumpatAppId(), BERTIL);

    for (const vem of [BERTIL, ADAM]) {
      const svar = await exportera(appId, vem);
      expect(svar.status, vem.userId).toBe(404);
      expect(svar.text, vem.userId).toBe(ingenApp.text);
      expect(svar.headers, vem.userId).toEqual(ingenApp.headers);
    }
    // Ingen läste appens data för att få reda på att den inte var deras.
    expect(data.anrop).toEqual([]);
  });

  it('loggen: app_exported med antalet, aldrig innehållet', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }, { namn: 'Ville' }]);
    m.logg.length = 0;
    await exportera(appId);

    expect(m.logg).toEqual([
      { level: 'info', event: 'app_exported', appIdPrefix: appId.slice(0, 8), userId: ANNA.userId, count: 2 },
    ]);
    const rader = JSON.stringify(m.logg);
    expect(rader).not.toContain(appId);
    expect(rader).not.toContain(ANNA.email);
    expect(rader).not.toContain(NAMN);
    expect(rader).not.toContain('Vera');
  });
});

// ── Bekräftelsen ─────────────────────────────────────────────────────────────────

describe('bekräftelsen är appens namn, ordagrant', () => {
  const fel: readonly { readonly vad: string; readonly body: unknown }[] = [
    { vad: 'ingen bekräftelse alls', body: {} },
    { vad: 'ett kryss i stället för ett namn', body: { confirm: true } },
    { vad: 'en tom sträng', body: { confirm: '' } },
    { vad: 'fel namn', body: { confirm: 'Kursanmälning' } },
    { vad: 'rätt namn med ett blanksteg efter', body: { confirm: `${NAMN} ` } },
    { vad: 'namnet i fel skiftläge', body: { confirm: NAMN.toLowerCase() } },
    { vad: 'ett tal', body: { confirm: 1 } },
  ];

  for (const { vad, body } of fel) {
    it(`${vad} ⇒ 400, och ingenting har rörts`, async () => {
      const appId = await byggdApp();
      data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }]);

      const svar = await avveckla(appId, body);
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      // Beskedet säger vad som ska skrivas — annars blir nästa försök en gissning.
      expect(svar.json.error.message).toContain(NAMN);

      expect(data.anrop).toEqual([]);
      expect(m.control.anrop).not.toContain('deleteApp');
      expect((await exportera(appId)).status).toBe(200);
      expect((await registerrad(appId))?.['decommissionedAt']).toBeNull();
    });
  }

  it('rätt namn ⇒ gallringsbeviset, räknat FÖRE raderingen', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }, { namn: 'Ville' }, { namn: 'Vilma' }]);
    data.filer.set(appId, 2);

    m.tid.ms += 60_000;
    const svar = await avveckla(appId);

    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({
      evidence: {
        appIdPrefix: appId.slice(0, 8),
        decommissionedAt: '2026-09-19T08:01:00.000Z',
        documentsDeleted: 3,
        filesDeleted: 2,
      },
    });
    // Beviset bär ett prefix, aldrig hela id:t — det är den hemliga länken in i appen.
    expect(svar.text).not.toContain(appId);
    expect(data.kollektioner.has(appId)).toBe(false);
  });

  it('bara ägaren avvecklar — en annan byggare och en administratör får 404 och rör ingenting', async () => {
    const appId = await byggdApp(ANNA);
    const ingenApp = await avveckla(slumpatAppId(), { confirm: NAMN }, BERTIL);

    for (const vem of [BERTIL, ADAM]) {
      const svar = await avveckla(appId, { confirm: NAMN }, vem);
      expect(svar.status, vem.userId).toBe(404);
      expect(svar.text, vem.userId).toBe(ingenApp.text);
      expect(svar.headers, vem.userId).toEqual(ingenApp.headers);
    }
    expect(data.anrop).toEqual([]);
    expect(m.control.anrop).not.toContain('deleteApp');
    expect((await exportera(appId)).status).toBe(200);
  });
});

// ── Ordningen ────────────────────────────────────────────────────────────────────

describe('data först, sedan control, sedan arkiveringen', () => {
  it('går dataraderingen fel ⇒ 503, och INGENTING har tagits bort', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }]);
    data.destroyFel = new Error('/srv/data/anmalningar.sqlite: disk full');

    const svar = await avveckla(appId);
    expect(svar.status).toBe(503);
    expect(svar.json.error.code).toBe('unavailable');
    expect(svar.json.error.message).toContain('ingenting har tagits bort');
    expect(svar.text).not.toContain('/srv');

    // Appen finns kvar hela vägen: i control, i registret och för sin ägare.
    expect(m.control.anrop).not.toContain('deleteApp');
    expect(m.control.appar.has(appId)).toBe(true);
    expect((await registerrad(appId))?.['decommissionedAt']).toBeNull();
    expect((await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`))).status).toBe(200);

    // Och när disken är tillbaka går avvecklingen att göra om.
    data.destroyFel = null;
    expect((await avveckla(appId)).status).toBe(200);
  });

  it('går borttagningen ur control fel ⇒ 503 med ett annat besked: data ÄR borta, appen finns kvar', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }]);
    m.control.deleteFel = new Error('control: /srv/control.sqlite is locked');

    const svar = await avveckla(appId);
    expect(svar.status).toBe(503);
    expect(svar.json.error.code).toBe('unavailable');
    expect(svar.json.error.message).toContain('raderade');
    expect(svar.json.error.message).not.toContain('ingenting har tagits bort');
    expect(svar.text).not.toContain('/srv');

    // Det medvetet mindre dåliga av två lägen: uppgifterna är borta, men adressen svarar tills
    // någon kör om avvecklingen. Registerposten är INTE arkiverad — appen är inte avvecklad.
    expect(data.kollektioner.has(appId)).toBe(false);
    expect(m.control.appar.has(appId)).toBe(true);
    expect((await registerrad(appId))?.['decommissionedAt']).toBeNull();

    // Och avvecklingen går att köra om, hela vägen.
    m.control.deleteFel = null;
    const igen = await avveckla(appId);
    expect(igen.status).toBe(200);
    // Uppgifterna var redan borta: beviset ljuger inte om att de försvann en andra gång.
    expect(igen.json.evidence.documentsDeleted).toBe(0);
    expect(m.control.appar.has(appId)).toBe(false);
  });

  it('loggen: decommission_failed bär skälet som ett fast ord, aldrig felets text', async () => {
    const appId = await byggdApp();
    data.destroyFel = new Error(`disken tog slut när ${HEMLIGT_ORD} skulle raderas`);
    m.logg.length = 0;
    await avveckla(appId);

    expect(m.logg).toHaveLength(1);
    expect(m.logg[0]).toMatchObject({
      level: 'error',
      event: 'decommission_failed',
      appIdPrefix: appId.slice(0, 8),
      userId: ANNA.userId,
      reason: 'data',
    });
    expect(JSON.stringify(m.logg)).not.toContain(HEMLIGT_ORD);

    data.destroyFel = null;
    m.control.deleteFel = new Error(`control svarade inte om ${HEMLIGT_ORD}`);
    m.logg.length = 0;
    await avveckla(appId);
    expect(m.logg[0]).toMatchObject({ event: 'decommission_failed', reason: 'control' });
    expect(JSON.stringify(m.logg)).not.toContain(HEMLIGT_ORD);
  });

  it('loggen: app_decommissioned bär antalet dokument och filer, aldrig något ur appen', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }, { namn: 'Ville' }]);
    data.filer.set(appId, 1);
    m.logg.length = 0;
    await avveckla(appId);

    expect(m.logg).toEqual([
      {
        level: 'info',
        event: 'app_decommissioned',
        appIdPrefix: appId.slice(0, 8),
        userId: ANNA.userId,
        count: 2,
        files: 1,
      },
    ]);
    const rader = JSON.stringify(m.logg);
    expect(rader).not.toContain(appId);
    expect(rader).not.toContain(ANNA.email);
    expect(rader).not.toContain(NAMN);
  });
});

// ── Efteråt ──────────────────────────────────────────────────────────────────────

describe('efter avvecklingen', () => {
  it('registerposten arkiveras, den raderas inte', async () => {
    const appId = await byggdApp();
    await publiceraViaGranskning(m.builder, appId);
    expect(await registerrad(appId)).toMatchObject({ published: true, decommissionedAt: null });

    m.tid.ms += 60_000;
    expect((await avveckla(appId)).status).toBe(200);

    // Att appen har funnits, vem som ägde den och hur känslig den var är själva svaret en
    // tillsyn behöver. Det som raderas är uppgifterna i appen, inte spåret av att den fanns.
    // Ägarens adress kommer nu ur identiteten: control:s åtkomstlista revs med appen.
    expect(await registerrad(appId)).toEqual({
      appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      name: NAMN,
      ownerEmail: ANNA.email,
      classification: 'personuppgift',
      source: 'modell',
      classifiedAt: '2026-09-19T08:00:00.000Z',
      decommissionedAt: '2026-09-19T08:01:00.000Z',
      published: false,
    });
  });

  it('arkiveringen överlever en omstart', async () => {
    const appId = await byggdApp();
    await avveckla(appId);
    await m.builder.close();
    m.builder = m.starta();

    expect((await registerrad(appId))?.['decommissionedAt']).toBe('2026-09-19T08:00:00.000Z');
    expect((await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`))).status).toBe(404);
  });

  it('ägarens egen lista tappar appen: den finns inte längre för henne', async () => {
    const appId = await byggdApp();
    const annan = await byggdApp(ANNA, 'En anmälningslista');
    await avveckla(appId);

    const lista = await anropa(m.builder, ANNA, 'GET', api('/apps'));
    expect(lista.status).toBe(200);
    expect((lista.json.apps as { appId: string }[]).map((app) => app.appId)).toEqual([annan]);

    // Det finns ingenting kvar att göra med den — inte ens läsa.
    expect((await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`))).status).toBe(404);
    expect((await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'Byt rubrik' } })).status).toBe(404);
    expect((await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`))).status).toBe(404);
  });

  it('en avvecklad app går inte att exportera — den finns inte för sin ägare', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }]);
    await avveckla(appId);
    data.anrop.length = 0;

    const ingenApp = await exportera(slumpatAppId());
    const svar = await exportera(appId);
    expect(svar.status).toBe(404);
    expect(svar.text).toBe(ingenApp.text);
    // Ingen frågade datalagret efter en app som inte finns.
    expect(data.anrop).toEqual([]);
  });

  it('en redan avvecklad app går inte att avveckla igen, och inget nytt gallringsbevis skrivs', async () => {
    const appId = await byggdApp();
    data.lagg(appId, 'anmalningar', [{ namn: 'Vera' }]);
    const forsta = await avveckla(appId);
    expect(forsta.status).toBe(200);

    data.anrop.length = 0;
    m.logg.length = 0;
    m.tid.ms += 60_000;

    const andra = await avveckla(appId);
    expect(andra.status).toBe(404);
    expect(andra.json.evidence).toBeUndefined();
    expect(data.anrop).toEqual([]);
    expect(m.logg.map((rad) => rad.event)).not.toContain('app_decommissioned');
    // Arkiveringens tidpunkt står kvar på den första avvecklingen.
    expect((await registerrad(appId))?.['decommissionedAt']).toBe('2026-09-19T08:00:00.000Z');
  });

  it('appen är borta ur control, så adressen slutar svara', async () => {
    const appId = await byggdApp();
    await publiceraViaGranskning(m.builder, appId);
    expect(m.control.publicerade.has(appId)).toBe(true);

    await avveckla(appId);
    expect(m.control.anrop).toContain('deleteApp');
    expect(m.control.appar.has(appId)).toBe(false);
    expect(m.control.publicerade.has(appId)).toBe(false);
    expect(m.control.utkast.has(appId)).toBe(false);
  });

  it('källkoden och samtalet gallras ur byggverktygets databas, men appraden står kvar', async () => {
    const appId = await byggdApp();
    const innan = await iDatabasen((db) => ({
      appar: antal(db, 'apps', appId),
      revisioner: antal(db, 'revisions', appId),
      meddelanden: antal(db, 'messages', appId),
    }));
    expect(innan.appar).toBe(1);
    expect(innan.revisioner).toBeGreaterThan(0);
    expect(innan.meddelanden).toBeGreaterThan(0);

    await avveckla(appId);

    const efter = await iDatabasen((db) => ({
      appar: antal(db, 'apps', appId),
      revisioner: antal(db, 'revisions', appId),
      meddelanden: antal(db, 'messages', appId),
    }));
    // Raden om att appen fanns är kvar. Det appen BAR — koden och samtalet — är borta.
    expect(efter).toEqual({ appar: 1, revisioner: 0, meddelanden: 0 });
  });

  it('granskarens kopia av koden är också borta: ärendet går inte längre att läsa', async () => {
    const appId = await byggdApp();
    const begaran = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    expect(begaran.status).toBe(202);
    const kon = await anropa(m.builder, ADAM, 'GET', api('/admin/granskning'));
    const reviewId = (kon.json.reviews as { reviewId: string }[])[0]?.reviewId ?? '';
    expect((await anropa(m.builder, ADAM, 'GET', api(`/admin/granskning/${reviewId}`))).status).toBe(200);

    await avveckla(appId);

    const arende = await anropa(m.builder, ADAM, 'GET', api(`/admin/granskning/${reviewId}`));
    expect(arende.status).toBe(503);
    expect(arende.text).not.toContain(HEMLIG_KOD);
  });
});

// ── Utan datalagret inkopplat ────────────────────────────────────────────────────

describe('utan appdata inkopplat', () => {
  beforeEach(async () => {
    // Ingen väg till appens data alls: en plattform startad utan `appData`.
    await m.stada();
    m = await nyMiljo();
  });

  it('exporten svarar att funktionen inte är inkopplad — aldrig en tom export som ser ut som ett svar', async () => {
    const appId = await byggdApp();
    const svar = await exportera(appId);
    expect(svar.status).toBe(503);
    expect(svar.json.error.code).toBe('unavailable');
    expect(svar.json.error.message).toContain('inte inkopplade');
  });

  it('avvecklingen vägrar i stället för att göra en tyst halvavveckling', async () => {
    const appId = await byggdApp();
    const svar = await avveckla(appId);
    expect(svar.status).toBe(503);
    expect(svar.json.error.code).toBe('unavailable');

    expect(m.control.anrop).not.toContain('deleteApp');
    expect(m.control.appar.has(appId)).toBe(true);
    expect((await registerrad(appId))?.['decommissionedAt']).toBeNull();
  });
});
