/**
 * Åtkomst per app (features/delning/appatkomst.feature). Att vara inloggad räcker inte: på appens
 * publicerade värd släpps ägare och användare in, på förhandsvisningens värd bara ägaren. Den som
 * saknar åtkomst får EXAKT samma svar som för en app som inte finns — samma status, kod, kropp och
 * huvuden — så att svaret inte röjer att appen finns. Plattformsroller (även admin) ger ingen
 * genväg, och en borttagen åtkomst gäller från nästa förfrågan, även i en pågående session.
 *
 * Testerna är fientliga: de prövar vägarna in till en app (statiska filer, SPA-fallback, data-API,
 * whoami, skrivande anrop, HEAD) och vad som INTE får avgöra åtkomsten (sökväg, fråga, kropp, huvuden).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { AppAccessRole, Identity } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import type { GatewayLogEntry, GatewayOptions } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { AnropOptions, AnropSvar, Testserver } from './hjalp.ts';
import {
  PREVIEW_DOMAN,
  skapaAppId,
  skapaFejkadAuthRouteProvider,
  skapaFejkadBuilderHandler,
  skapaFejkadIdentityProvider,
  skapaIdentitet,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';
import type { TestUppsattning } from './fejkar.ts';

const APPENS_SIDA = '<h1>Annas app</h1>';
const DOKUMENTVAG = '/_api/collections/poster/docs';

const anna = skapaIdentitet({ userId: 'anv-anna', email: 'anna@exempel.se', roles: ['builder'] });
const bertil = skapaIdentitet({ userId: 'anv-bertil', email: 'bertil@exempel.se', roles: ['viewer'] });
const cecilia = skapaIdentitet({ userId: 'anv-cecilia', email: 'cecilia@exempel.se', roles: ['builder'] });
const erik = skapaIdentitet({ userId: 'anv-erik', email: 'erik@exempel.se', roles: ['admin', 'builder', 'viewer'] });

/** Varje användare loggar in med sin egen token; `Authorization: <userId>`. */
const ANVANDARE: readonly Identity[] = [anna, bertil, cecilia, erik];

function auth(vem: Identity): Record<string, string> {
  return { Authorization: `token-${vem.userId}` };
}

interface Startad {
  readonly port: number;
  readonly uppsattning: TestUppsattning;
  readonly poster: GatewayLogEntry[];
  /** Annas app: publicerad och med ett utkast. */
  readonly appId: string;
  /** En app-id som registret aldrig hört talas om. */
  readonly okandAppId: string;
}

/** Vägar in till en app, med metod och de huvuden som krävs för att passera CSRF-steget. */
const VAGAR: readonly { readonly namn: string; readonly anrop: Partial<AnropOptions> }[] = [
  { namn: 'startsidan', anrop: { path: '/' } },
  { namn: 'en statisk fil', anrop: { path: '/index.html' } },
  { namn: 'SPA-fallback', anrop: { path: '/arenden/42' } },
  { namn: 'HEAD på en fil', anrop: { method: 'HEAD', path: '/index.html' } },
  { namn: 'whoami', anrop: { path: '/_api/whoami' } },
  { namn: 'lista en kollektion', anrop: { path: DOKUMENTVAG } },
  { namn: 'läsa ett dokument', anrop: { path: `${DOKUMENTVAG}/dok-1` } },
  {
    namn: 'spara ett dokument',
    anrop: { method: 'POST', path: DOKUMENTVAG, headers: { [CSRF_HEADER]: '1' }, json: { data: { a: 1 } } },
  },
  {
    namn: 'ersätta ett dokument',
    anrop: { method: 'PUT', path: `${DOKUMENTVAG}/dok-1`, headers: { [CSRF_HEADER]: '1' }, json: { data: { a: 2 } } },
  },
  {
    namn: 'radera ett dokument',
    anrop: { method: 'DELETE', path: `${DOKUMENTVAG}/dok-1`, headers: { [CSRF_HEADER]: '1' } },
  },
  { namn: 'okänd API-rutt', anrop: { path: '/_api/finns-inte' } },
  { namn: 'ogiltig sökväg', anrop: { path: '/%00' } },
];

describe('åtkomst per app', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function starta(extra: Partial<GatewayOptions> = {}): Promise<Startad> {
    const poster: GatewayLogEntry[] = [];
    const leverantor = skapaFejkadIdentityProvider(
      (request) => ANVANDARE.find((vem) => request.headers.authorization === `token-${vem.userId}`) ?? null,
    );
    const uppsattning = skapaTestUppsattning({
      identityProvider: leverantor,
      logger: (post) => poster.push(post),
      ...extra,
    });
    const appId = skapaAppId('annas-app-atkomst');
    uppsattning.register.registrera(appId, { published: true, draft: true });
    uppsattning.register.bevilja(appId, anna.userId, 'owner');
    for (const kind of ['published', 'draft'] as const) {
      uppsattning.filer.satt(appId, kind, '/index.html', textfil(APPENS_SIDA));
    }
    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, uppsattning, poster, appId, okandAppId: skapaAppId('ingen-sadan-app') };
  }

  function oppna(port: number, host: string, vem: Identity, anrop: Partial<AnropOptions> = {}): Promise<AnropSvar> {
    return anropa({ port, host, path: '/', ...anrop, headers: { ...auth(vem), ...anrop.headers } });
  }

  /** Allt i svaret utom `Date`, som bara säger när svaret skickades. */
  function jamforbart(svar: AnropSvar): unknown {
    const { date: _date, ...huvuden } = svar.huvuden;
    return { status: svar.status, huvuden, kropp: svar.kropp };
  }

  /** Nekandet ska vara oskiljbart från svaret för en app som inte finns — på varje väg in. */
  async function forvantaSomOkandApp(
    s: Startad,
    vem: Identity,
    vardnamn: (appId: string) => string,
    anrop: Partial<AnropOptions> = {},
  ): Promise<void> {
    const nekad = await oppna(s.port, vardnamn(s.appId), vem, anrop);
    const okand = await oppna(s.port, vardnamn(s.okandAppId), vem, anrop);
    expect(nekad.status).toBe(404);
    // Värdnamnet skiljer sig i förfrågan men får inte synas i svaret; allt annat ska vara byte-lika.
    expect(jamforbart(nekad)).toEqual(jamforbart(okand));
    expect(nekad.kropp).not.toContain(APPENS_SIDA);
  }

  describe('den som har åtkomst släpps in', () => {
    it('ägaren når den publicerade appen', async () => {
      const s = await starta();
      const svar = await oppna(s.port, vardnamnForApp(s.appId), anna);
      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe(APPENS_SIDA);
    });

    it('ägaren når förhandsvisningen', async () => {
      const s = await starta();
      const svar = await oppna(s.port, vardnamnForForhandsvisning(s.appId), anna);
      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe(APPENS_SIDA);
    });

    it('den som fått appen delad med sig når den publicerade appen', async () => {
      const s = await starta();
      s.uppsattning.register.bevilja(s.appId, bertil.userId, 'user');
      const svar = await oppna(s.port, vardnamnForApp(s.appId), bertil);
      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe(APPENS_SIDA);
    });

    it('den som fått appen delad med sig kan spara data i den', async () => {
      const s = await starta();
      s.uppsattning.register.bevilja(s.appId, bertil.userId, 'user');
      const svar = await oppna(s.port, vardnamnForApp(s.appId), bertil, {
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { [CSRF_HEADER]: '1' },
        json: { data: { anteckning: 'hej' } },
      });
      expect(svar.status).toBe(201);
      expect(s.uppsattning.store.anrop.map((a) => a.identity?.userId)).toEqual([bertil.userId]);
    });
  });

  describe('den som saknar åtkomst får samma svar som för en app som inte finns', () => {
    for (const { namn, anrop } of VAGAR) {
      it(`inloggad utan rad — ${namn}`, async () => {
        const s = await starta();
        await forvantaSomOkandApp(s, cecilia, vardnamnForApp, anrop);
      });

      it(`admin utan rad — ${namn}`, async () => {
        const s = await starta();
        await forvantaSomOkandApp(s, erik, vardnamnForApp, anrop);
      });

      it(`användare på förhandsvisningen — ${namn}`, async () => {
        const s = await starta();
        s.uppsattning.register.bevilja(s.appId, bertil.userId, 'user');
        await forvantaSomOkandApp(s, bertil, vardnamnForForhandsvisning, anrop);
      });
    }

    it('varken filer eller lagring nås när åtkomst saknas', async () => {
      const s = await starta();
      for (const { anrop } of VAGAR) {
        await oppna(s.port, vardnamnForApp(s.appId), cecilia, anrop);
        await oppna(s.port, vardnamnForForhandsvisning(s.appId), erik, anrop);
      }
      expect(s.uppsattning.filer.anrop).toEqual([]);
      expect(s.uppsattning.store.anrop).toEqual([]);
    });

    it('ett skrivande anrop utan skyddshuvud ger 404, inte 403 — åtkomsten avgörs före CSRF', async () => {
      // 403 skulle röja att appen finns: för en okänd app kommer anropet aldrig till CSRF-steget.
      const s = await starta();
      const anrop = { method: 'POST', path: DOKUMENTVAG, json: { data: {} } };
      await forvantaSomOkandApp(s, cecilia, vardnamnForApp, anrop);
    });

    it('en rad i app A ger ingen åtkomst till app B', async () => {
      const s = await starta();
      const appB = skapaAppId('bertils-egen-app');
      s.uppsattning.register.registrera(appB, { published: true, draft: true });
      s.uppsattning.filer.satt(appB, 'published', '/index.html', textfil('<h1>B</h1>'));
      s.uppsattning.register.bevilja(appB, bertil.userId, 'owner');

      await forvantaSomOkandApp(s, bertil, vardnamnForApp);
      await forvantaSomOkandApp(s, bertil, vardnamnForForhandsvisning);
      // Och åt andra hållet: Annas ägarskap i A ger henne ingenting i B.
      const svar = await oppna(s.port, vardnamnForApp(appB), anna);
      expect(svar.status).toBe(404);
    });

    it('en okänd roll från registret behandlas som ingen åtkomst', async () => {
      const s = await starta();
      for (const varde of ['admin', 'OWNER', 'owner ', '', 1, true, {}, ['owner'], undefined]) {
        s.uppsattning.register.styrAtkomst(() => varde);
        const svar = await oppna(s.port, vardnamnForApp(s.appId), anna);
        expect(svar.status, JSON.stringify(varde)).toBe(404);
      }
      expect(s.uppsattning.filer.anrop).toEqual([]);
    });

    it('rollen "user" räcker aldrig för förhandsvisningen — rollen avgör, inte vem man är', async () => {
      const s = await starta();
      s.uppsattning.register.bevilja(s.appId, anna.userId, 'user');
      const svar = await oppna(s.port, vardnamnForForhandsvisning(s.appId), anna);
      expect(svar.status).toBe(404);
      const publicerad = await oppna(s.port, vardnamnForApp(s.appId), anna);
      expect(publicerad.status).toBe(200);
    });
  });

  describe('borttagen åtkomst', () => {
    it('upphör direkt, även för en pågående session', async () => {
      const s = await starta();
      s.uppsattning.register.bevilja(s.appId, bertil.userId, 'user');

      const forst = await oppna(s.port, vardnamnForApp(s.appId), bertil);
      expect(forst.status).toBe(200);

      s.uppsattning.register.aterkalla(s.appId, bertil.userId);
      await forvantaSomOkandApp(s, bertil, vardnamnForApp);
      await forvantaSomOkandApp(s, bertil, vardnamnForApp, { path: DOKUMENTVAG });
    });

    it('registret tillfrågas vid varje förfrågan — inget cachas', async () => {
      const s = await starta();
      for (let i = 0; i < 3; i += 1) await oppna(s.port, vardnamnForApp(s.appId), anna);
      expect(s.uppsattning.register.atkomstAnrop).toHaveLength(3);
    });
  });

  describe('vad som avgör åtkomsten', () => {
    it('frågar med inloggat userId och värdnamnets app-id — inte sökvägens, frågans, kroppens', async () => {
      const s = await starta();
      const annanApp = skapaAppId('en-helt-annan-app');
      await oppna(s.port, vardnamnForApp(s.appId), cecilia, {
        method: 'POST',
        path: `/_api/collections/${annanApp}/docs?appId=${annanApp}&userId=${anna.userId}`,
        headers: {
          [CSRF_HEADER]: '1',
          'X-User-Id': anna.userId,
          'X-App-Id': annanApp,
          'X-Forwarded-Host': vardnamnForApp(annanApp),
        },
        json: { appId: annanApp, userId: anna.userId, data: { userId: anna.userId } },
      });
      expect(s.uppsattning.register.atkomstAnrop).toEqual([{ appId: s.appId, userId: cecilia.userId }]);
      expect(s.uppsattning.store.anrop).toEqual([]);
    });

    it('frågar med samma app-id på förhandsvisningens värd', async () => {
      const s = await starta();
      await oppna(s.port, vardnamnForForhandsvisning(s.appId), anna);
      expect(s.uppsattning.register.atkomstAnrop).toEqual([{ appId: s.appId, userId: anna.userId }]);
    });

    it('en oinloggad kostar inget åtkomstuppslag och får 401', async () => {
      const s = await starta();
      const svar = await anropa({ port: s.port, host: vardnamnForApp(s.appId), path: '/_api/whoami' });
      expect(svar.status).toBe(401);
      expect(s.uppsattning.register.atkomstAnrop).toEqual([]);
    });
  });

  describe('när registret inte kan svara', () => {
    it('nekar med samma svar som för en app som inte finns — aldrig 500 med detaljer', async () => {
      const s = await starta();
      const hemligt = 'SQLITE_BUSY i /var/lib/vibesandbox/control.db';
      s.uppsattning.register.styrAtkomst(() => {
        throw new Error(hemligt);
      });
      await forvantaSomOkandApp(s, anna, vardnamnForApp);
      await forvantaSomOkandApp(s, anna, vardnamnForForhandsvisning, { path: DOKUMENTVAG });
      const dump = JSON.stringify(s.poster);
      expect(dump).not.toContain(hemligt);
      expect(s.poster.some((p) => p.event === 'app_registry_failed' && p.level === 'error')).toBe(true);
      expect(s.uppsattning.filer.anrop).toEqual([]);
      expect(s.uppsattning.store.anrop).toEqual([]);
    });

    it('ett löfte som avvisas utan Error nekas också', async () => {
      const s = await starta();
      s.uppsattning.register.styrAtkomst(() => Promise.reject('inget fel-objekt'));
      const svar = await oppna(s.port, vardnamnForApp(s.appId), anna);
      expect(svar.status).toBe(404);
    });
  });

  describe('loggning', () => {
    it('nekad åtkomst loggas som en egen händelse, med userId men utan e-post', async () => {
      const s = await starta();
      await oppna(s.port, vardnamnForApp(s.appId), cecilia);
      const post = s.poster.find((p) => p.event === 'app_access_denied');
      expect(post).toMatchObject({
        level: 'warn',
        userId: cecilia.userId,
        appIdPrefix: s.appId.slice(0, 8),
        kind: 'published',
      });
      const dump = JSON.stringify(s.poster);
      expect(dump).not.toContain(cecilia.email);
      expect(dump).not.toContain('exempel.se');
      expect(dump).not.toContain(s.appId);
    });

    it('en app som inte finns loggas inte som nekad åtkomst', async () => {
      const s = await starta();
      await oppna(s.port, vardnamnForApp(s.okandAppId), cecilia);
      expect(s.poster.some((p) => p.event === 'app_access_denied')).toBe(false);
    });

    it('beviljad åtkomst ger ingen nekandehändelse', async () => {
      const s = await starta();
      await oppna(s.port, vardnamnForApp(s.appId), anna);
      expect(s.poster.some((p) => p.event === 'app_access_denied')).toBe(false);
    });
  });

  describe('det som inte påverkas', () => {
    it('inloggningsrutterna fungerar utan åtkomst och utan uppslag', async () => {
      const leverantor = skapaFejkadAuthRouteProvider(() => ({
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<form>logga in</form>',
      }));
      const s = await starta({ identityProvider: leverantor });
      const svar = await anropa({ port: s.port, host: vardnamnForApp(s.appId), path: '/_auth/login' });
      expect(svar.status).toBe(200);
      expect(svar.kropp).toContain('logga in');
      expect(s.uppsattning.register.atkomstAnrop).toEqual([]);
      expect(s.uppsattning.register.anrop).toEqual([]);
    });

    it('byggverktygets värd frågar aldrig om åtkomst till en app', async () => {
      const handler = skapaFejkadBuilderHandler();
      const s = await starta({ builder: { handler, origin: `https://bygg.${PREVIEW_DOMAN}` } });
      const svar = await oppna(s.port, `bygg.${PREVIEW_DOMAN}`, cecilia);
      expect(svar.status).toBe(200);
      expect(handler.anrop).toHaveLength(1);
      expect(s.uppsattning.register.atkomstAnrop).toEqual([]);
    });
  });

  it('whoami svarar för den som har åtkomst', async () => {
    const s = await starta();
    s.uppsattning.register.bevilja(s.appId, bertil.userId, 'user' satisfies AppAccessRole);
    const svar = await oppna(s.port, vardnamnForApp(s.appId), bertil, { path: '/_api/whoami' });
    expect(svar.status).toBe(200);
    expect(json<{ userId: string }>(svar).userId).toBe(bertil.userId);
  });
});
