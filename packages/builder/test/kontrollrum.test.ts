/**
 * Kontrollrummet (adminvyn): `GET /_api/builder/admin/oversikt` och `GET /_api/builder/admin/appar`.
 *
 * Den här skivan är ren läsning. Det som prövas här är inte främst siffrorna utan grinden och
 * tystnaden: bara plattformsrollen `admin` kommer in, svaret röjer aldrig ett helt app-id eller en
 * väg in i någon app, och ägarnas adresser finns i svaret men aldrig i en loggrad.
 */
import { ADMIN_APP_ID_PREFIX_LENGTH, ADMIN_TOKEN_WINDOW_DAYS } from '@vibesandbox/contracts';
import type { Identity } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAM, ANNA, BERTIL, VERA, anropa, api, misslyckadTur, nyApp, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

const OVERSIKT = api('/admin/oversikt');
const APPAR = api('/admin/appar');

/** Ingen roll alls — en inloggad person som ännu inte fått något. */
const INGEN: Identity = { userId: 'u-ingen', email: 'ingen@example.org', roles: [] };

/** En app med ett grönt bygge bakom sig, så att den har ett utkast och ett avslutat jobb. */
async function byggdApp(agare: Identity = ANNA): Promise<string> {
  const appId = await nyApp(m.builder, agare);
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista', agare), agare);
  return appId;
}

async function publicera(appId: string, agare: Identity = ANNA): Promise<void> {
  const svar = await anropa(m.builder, agare, 'POST', api(`/apps/${appId}/publish`));
  expect(svar.status).toBe(200);
}

describe('grinden: bara plattformsrollen admin', () => {
  it('byggaren nekas båda rutterna, i klarspråk och utan att något räknas upp', async () => {
    for (const vag of [OVERSIKT, APPAR]) {
      const svar = await anropa(m.builder, ANNA, 'GET', vag);
      expect(svar.status).toBe(403);
      expect(svar.json.error.code).toBe('forbidden');
      expect(typeof svar.json.error.message).toBe('string');
      expect(svar.json.apps).toBeUndefined();
    }
  });

  it('den som bara får titta nekas', async () => {
    for (const vag of [OVERSIKT, APPAR]) {
      expect((await anropa(m.builder, VERA, 'GET', vag)).status).toBe(403);
    }
  });

  it('den utan roller nekas', async () => {
    for (const vag of [OVERSIKT, APPAR]) {
      expect((await anropa(m.builder, INGEN, 'GET', vag)).status).toBe(403);
    }
  });

  it('administratören släpps in', async () => {
    expect((await anropa(m.builder, ADAM, 'GET', OVERSIKT)).status).toBe(200);
    expect((await anropa(m.builder, ADAM, 'GET', APPAR)).status).toBe(200);
  });
});

describe('rutterna är exakta', () => {
  const fientliga = [
    '/admin',
    '/admin/',
    '/admin/oversikt/extra',
    '/admin/Oversikt',
    '/admin/APPAR',
    '/admin/../apps',
    '/admin/oversikt/',
    '/admin//oversikt',
    '/admin/appar/x/y/z',
  ];

  for (const vag of fientliga) {
    it(`${vag} är ingen rutt, inte ens för en administratör`, async () => {
      const svar = await anropa(m.builder, ADAM, 'GET', api(vag));
      expect([400, 404]).toContain(svar.status);
      expect(svar.json.apps).toBeUndefined();
    });
  }

  it('POST mot en läsande rutt ger 405', async () => {
    for (const vag of [OVERSIKT, APPAR]) {
      const svar = await anropa(m.builder, ADAM, 'POST', vag, { body: {} });
      expect(svar.status).toBe(405);
      expect(svar.json.error.code).toBe('method_not_allowed');
    }
  });

  it('en metod som inte finns ändrar ingenting', async () => {
    for (const metod of ['PUT', 'DELETE', 'PATCH']) {
      expect((await anropa(m.builder, ADAM, metod, APPAR)).status).toBe(405);
    }
  });
});

describe('GET /admin/appar', () => {
  it('administratören ser appar hen inte äger — och aldrig hela app-id:t eller en väg in', async () => {
    const annas = await byggdApp(ANNA);
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);

    expect(svar.status).toBe(200);
    expect(svar.json.apps).toHaveLength(1);
    expect(svar.json.apps[0].appIdPrefix).toBe(annas.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
    expect(svar.text).not.toContain(annas);
    // Ingen länk: kontrollrummet ger insyn i att appar finns, aldrig en väg in i dem.
    expect(svar.text).not.toContain('https://');
    expect(svar.headers['Cache-Control']).toBe('no-store');
  });

  it('byggaren ser ingenting alls — inte ens sina egna appar den här vägen', async () => {
    await byggdApp(ANNA);
    const svar = await anropa(m.builder, ANNA, 'GET', APPAR);
    expect(svar.status).toBe(403);
    expect(svar.text).not.toContain('appIdPrefix');
  });

  it('ger ägarens adress, antal medlemmar, tillstånd och tokens', async () => {
    const appId = await byggdApp(ANNA);
    await publicera(appId);
    const delning = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: BERTIL.email } });
    expect(delning.status).toBe(200);

    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0]).toEqual({
      appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      // Önskemålets text, inte ägarens namnval — kontrollrummet visar den inte. Se `visatNamn`.
      name: 'Namnlös app',
      ownerEmail: ANNA.email,
      updatedAt: expect.any(String),
      hasDraft: true,
      published: true,
      members: 2,
      tokens: { input: 1200, output: 800 },
    });
  });

  it('visar ägarens eget namnval, men aldrig plattformens avskrift av önskemålet', async () => {
    // Två appar: en som ägaren döpt själv, en som fick sitt namn ur det första önskemålet. Bara
    // den första har ett namn kontrollrummet får visa — den andra bär texten någon skrev.
    const dopt = await nyApp(m.builder, ANNA, 'Lokalbokningen');
    await vantaPaJobb(m.builder, await skicka(m.builder, dopt, 'En lista med rum', ANNA), ANNA);
    m.tid.ms += 60_000;
    const odopt = await byggdApp(ANNA);

    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    const rad = (id: string): { name: string } =>
      svar.json.apps.find((app: { appIdPrefix: string }) => id.startsWith(app.appIdPrefix));
    expect(rad(dopt).name).toBe('Lokalbokningen');
    expect(rad(odopt).name).toBe('Namnlös app');
    expect(svar.text).not.toContain('En todo-lista');
  });

  it('senast ändrad först, oavsett vem som äger appen', async () => {
    const forsta = await byggdApp(ANNA);
    m.tid.ms += 60_000;
    const andra = await byggdApp(BERTIL);

    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps.map((app: { appIdPrefix: string }) => app.appIdPrefix)).toEqual([
      andra.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      forsta.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    ]);
    expect(svar.json.apps[0].ownerEmail).toBe(BERTIL.email);
  });

  it('en app utan bygge syns med noll tokens och utan utkast', async () => {
    await nyApp(m.builder, ANNA, 'Tom app');
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0]).toMatchObject({
      name: 'Tom app',
      hasDraft: false,
      published: false,
      members: 1,
      tokens: { input: 0, output: 0 },
    });
  });

  it('adresserna finns i svaret men aldrig i en loggrad', async () => {
    await byggdApp(ANNA);
    const innanLoggrader = m.logg.length;
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.text).toContain(ANNA.email);
    for (const rad of m.logg.slice(innanLoggrader)) {
      expect(JSON.stringify(rad)).not.toContain('@');
    }
    expect(JSON.stringify(m.logg)).not.toContain('@');
  });
});

describe('GET /admin/oversikt', () => {
  it('räknar alla appar oavsett ägare, publicerade, utkast och tokens', async () => {
    const annas = await byggdApp(ANNA);
    await publicera(annas);
    await byggdApp(BERTIL);

    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({
      apps: 2,
      published: 1,
      // Bertils app har ett bygge men har aldrig publicerats.
      drafts: 1,
      users: { admin: 0, builder: 0, viewer: 0 },
      tokens: { input: 2400, output: 1600, jobs: 2 },
      failedJobs: 0,
    });
  });

  it('räknar misslyckade jobb och deras tokens', async () => {
    const appId = await nyApp(m.builder, ANNA);
    m.agent.turer.push(misslyckadTur());
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En app som inte går att bygga'));

    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.json.failedJobs).toBe(1);
    expect(svar.json.tokens).toEqual({ input: 3000, output: 2000, jobs: 1 });
    expect(svar.json.drafts).toBe(0);
  });

  it('en tom plattform ger nollor, inte fel', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.json).toEqual({
      apps: 0,
      published: 0,
      drafts: 0,
      users: { admin: 0, builder: 0, viewer: 0 },
      tokens: { input: 0, output: 0, jobs: 0 },
      failedJobs: 0,
    });
  });

  it(`tokenfönstret är ${ADMIN_TOKEN_WINDOW_DAYS} dygn — äldre jobb räknas inte`, async () => {
    await byggdApp(ANNA);
    m.tid.ms += (ADMIN_TOKEN_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;

    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.json.tokens).toEqual({ input: 0, output: 0, jobs: 0 });
    // Apparna räknas ändå: fönstret gäller bara tokens och jobb.
    expect(svar.json.apps).toBe(1);
  });

  it('svaret innehåller inget app-id och ingen adress', async () => {
    const appId = await byggdApp(ANNA);
    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.text).not.toContain(appId);
    expect(svar.text).not.toContain('@');
  });
});

describe('GET /me', () => {
  it('berättar att administratören är administratör', async () => {
    expect((await anropa(m.builder, ADAM, 'GET', api('/me'))).json.isAdmin).toBe(true);
  });

  it('byggaren och den som bara tittar är det inte', async () => {
    expect((await anropa(m.builder, ANNA, 'GET', api('/me'))).json.isAdmin).toBe(false);
    expect((await anropa(m.builder, VERA, 'GET', api('/me'))).json.isAdmin).toBe(false);
  });
});
