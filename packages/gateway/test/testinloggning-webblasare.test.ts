/**
 * Testinloggningen i en webbläsare: en klickbar adress byter en signerad token mot kakan
 * `vs-test-session` på appens egen värd. Bara för tester och lokal utveckling.
 *
 * Beteendet, i domänens språk:
 *
 *   Givet att utvecklaren har startat plattformen lokalt
 *   När hen öppnar inloggningsadressen för en app i webbläsaren
 *   Så blir webbläsaren inloggad på just den appens värd, och skickas vidare till appen
 *
 *   Givet att en syskonapp har planterat en kaka med samma namn för hela domänen
 *   När webbläsaren skickar båda
 *   Så nekas inloggningen — vi gissar aldrig vilken kaka som är vår
 *
 *   Givet en inloggad webbläsare (kakan följer med ALLA anrop, även förfalskade)
 *   När en annan app försöker skriva i den här appens data
 *   Så nekas anropet: skyddshuvudet och `Origin` är det som skyddar, inte kakan
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, AuthRouteRequest, Identity, WhoAmIResponse } from '@vibesandbox/contracts';
import { createGateway, createTestIdentityProvider, signTestIdentity, testLoginPath } from '../src/index.ts';
import type { GatewayLogEntry } from '../src/index.ts';
import { MAX_COOKIE_HEADER_LENGTH } from '../src/kakor.ts';
import { allaHuvuden, anropa, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { AnropSvar, Testserver } from './hjalp.ts';
import { skapaAppId, skapaIdentitet, skapaTestUppsattning, textfil, vardnamnForApp } from './fejkar.ts';
import type { TestUppsattning } from './fejkar.ts';

const HEMLIGHET = 'testhemlighet-for-webblasarinloggning-minst-32-byte';
const ANNAN_HEMLIGHET = 'en-helt-annan-hemlighet-ocksa-minst-32-byte-lang';
const KAKNAMN = 'vs-test-session';
const DOKUMENTVAG = '/_api/collections/poster/docs';

/** Token utan prefixet `Test ` — det som står i kakan och i inloggningsadressen. */
function tokenFor(identitet: Identity, hemlighet = HEMLIGHET, expiresInSeconds?: number): string {
  const huvudvarde = signTestIdentity(identitet, hemlighet, expiresInSeconds === undefined ? {} : { expiresInSeconds });
  return huvudvarde.slice('Test '.length);
}

function kaka(token: string): string {
  return `${KAKNAMN}=${token}`;
}

/**
 * En ANNAN apps värd, garanterat skild från `appId`: första tecknet byts. (`skapaAppId` med ett
 * annat frö räcker inte — hjälparen har bara 32 möjliga utfall, så två frön ger ibland samma id,
 * och då vore "syskonappen" appen själv.)
 */
function syskonvardTill(appId: string): string {
  return vardnamnForApp(`${appId.startsWith('0') ? '1' : '0'}${appId.slice(1)}`);
}

describe('testinloggning via kaka', () => {
  let server: Testserver | undefined;
  const ursprungligNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    process.env.NODE_ENV = ursprungligNodeEnv;
    await server?.stang();
    server = undefined;
  });

  interface Startad {
    readonly uppsattning: TestUppsattning;
    readonly port: number;
    readonly appId: string;
    readonly host: string;
    readonly poster: GatewayLogEntry[];
  }

  async function starta(): Promise<Startad> {
    const poster: GatewayLogEntry[] = [];
    const appId = skapaAppId(`webblasare-${Math.random()}`);
    const uppsattning = skapaTestUppsattning({
      identityProvider: createTestIdentityProvider({ secret: HEMLIGHET }),
      logger: (post) => poster.push(post),
    });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<h1>Bokningar</h1>'));
    server = await startaTestserver(createGateway(uppsattning.options));
    return { uppsattning, port: server.port, appId, host: vardnamnForApp(appId), poster };
  }

  function forvantaNekadUtanEko(svar: AnropSvar, token: string): void {
    expect(svar.status).toBe(401);
    expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
    expect(allaHuvuden(svar, 'location')).toEqual([]);
    const allt = JSON.stringify(svar);
    if (token.length > 0) {
      expect(allt).not.toContain(token);
      expect(allt).not.toContain(token.slice(0, 16));
    }
  }

  describe('GET /_auth/test-login', () => {
    it('giltig token ⇒ 303 till / med en host-only-kaka som lever lika länge som token', async () => {
      const { port, host, uppsattning } = await starta();
      const token = tokenFor(skapaIdentitet(), HEMLIGHET, 600);

      const svar = await anropa({ port, host, path: `/_auth/test-login?token=${token}` });

      expect(svar.status).toBe(303);
      expect(enHuvud(svar, 'location')).toBe('/');
      const satt = enHuvud(svar, 'set-cookie') ?? '';
      const match = /^vs-test-session=([A-Za-z0-9_.-]+); Path=\/; HttpOnly; SameSite=Lax; Max-Age=([0-9]+)$/.exec(satt);
      expect(match?.[1]).toBe(token);
      const maxAge = Number(match?.[2]);
      expect(maxAge).toBeGreaterThan(590);
      expect(maxAge).toBeLessThanOrEqual(600);
      // Inloggningen i sig kräver varken register eller filer.
      expect(uppsattning.register.anrop).toHaveLength(0);
    });

    it('kakan har varken Domain eller Secure', async () => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: `/_auth/test-login?token=${tokenFor(skapaIdentitet())}` });

      const satt = (enHuvud(svar, 'set-cookie') ?? '').toLowerCase();
      expect(satt).not.toBe('');
      expect(satt).not.toContain('domain');
      expect(satt).not.toContain('secure');
    });

    it('hela flödet: logga in, öppna appen och fråga vem man är — utan Authorization', async () => {
      const { port, host, appId, uppsattning } = await starta();
      const identitet = skapaIdentitet({ userId: 'anv-webblasare', email: 'vera@example.org' });
      uppsattning.register.bevilja(appId, identitet.userId, 'owner');

      const inloggning = await anropa({ port, host, path: testLoginPath(identitet, HEMLIGHET) });
      const kakan = (enHuvud(inloggning, 'set-cookie') ?? '').split(';')[0] ?? '';

      const sida = await anropa({ port, host, path: '/', headers: { Cookie: kakan } });
      const vem = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: kakan } });

      expect(inloggning.status).toBe(303);
      expect(sida.status).toBe(200);
      expect(sida.kropp).toContain('Bokningar');
      expect(vem.status).toBe(200);
      expect(json<WhoAmIResponse>(vem)).toEqual({ userId: 'anv-webblasare', displayName: 'vera' });
    });

    it.each([
      ['saknad token', () => ''],
      ['tom token', () => '?token='],
      ['skräp', () => '?token=inte-en-token'],
      ['fel hemlighet', () => `?token=${tokenFor(skapaIdentitet(), ANNAN_HEMLIGHET)}`],
      ['utgången', () => `?token=${tokenFor(skapaIdentitet(), HEMLIGHET, -1)}`],
      ['manipulerad nyttolast', () => `?token=A${tokenFor(skapaIdentitet())}`],
      ['manipulerad signatur', () => `?token=${tokenFor(skapaIdentitet())}A`],
      ['med prefixet "Test "', () => `?token=Test%20${tokenFor(skapaIdentitet())}`],
      ['överlång', () => `?token=${'a'.repeat(900)}.${'b'.repeat(900)}`],
      ['i fel parameter', () => `?biljett=${tokenFor(skapaIdentitet())}`],
    ])('%s ⇒ 401, ingen kaka, och token ekas ingenstans', async (_b, fraga) => {
      const { port, host } = await starta();
      const f = fraga();

      const svar = await anropa({ port, host, path: `/_auth/test-login${f}` });

      forvantaNekadUtanEko(svar, f.replace(/^\?[a-z]+=/, '').replace('Test%20', ''));
    });

    it('dubbel token-parameter ⇒ 400 (avgörs av gatewayn, inte av leverantören)', async () => {
      const { port, host } = await starta();
      const token = tokenFor(skapaIdentitet());

      const svar = await anropa({ port, host, path: `/_auth/test-login?token=${token}&token=${token}` });

      expect(svar.status).toBe(400);
      expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
    });

    it('okända extra parametrar ignoreras', async () => {
      const { port, host } = await starta();

      const svar = await anropa({
        port,
        host,
        path: `/_auth/test-login?utm=x&token=${tokenFor(skapaIdentitet())}&retur=https%3A%2F%2Fexample.org`,
      });

      expect(svar.status).toBe(303);
      // Ingen parameter får styra vart omdirigeringen går.
      expect(enHuvud(svar, 'location')).toBe('/');
    });
  });

  describe('GET /_auth/test-logout', () => {
    it('rensar kakan och skickar vidare till /', async () => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: '/_auth/test-logout', headers: { Cookie: kaka('vad-som-helst') } });

      expect(svar.status).toBe(303);
      expect(enHuvud(svar, 'location')).toBe('/');
      expect(enHuvud(svar, 'set-cookie')).toBe('vs-test-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    });

    it('fungerar även för den som inte är inloggad', async () => {
      const { port, host } = await starta();

      expect((await anropa({ port, host, path: '/_auth/test-logout' })).status).toBe(303);
    });
  });

  describe('övriga metoder och rutter', () => {
    it.each(['/_auth/test-login', '/_auth/test-logout'])('POST %s ⇒ 405 med Allow: GET', async (path) => {
      const { port, host } = await starta();
      const token = tokenFor(skapaIdentitet());

      const svar = await anropa({ port, host, method: 'POST', path: `${path}?token=${token}` });

      expect(svar.status).toBe(405);
      expect(enHuvud(svar, 'allow')).toBe('GET');
      expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
    });

    it.each(['/_auth', '/_auth/', '/_auth/okand', '/_auth/test-login/extra', '/_auth/TEST-LOGIN', '/_auth/test-loginx'])(
      '%s ⇒ 404',
      async (path) => {
        const { port, host } = await starta();

        const svar = await anropa({ port, host, path: `${path}?token=${tokenFor(skapaIdentitet())}` });

        expect(svar.status).toBe(404);
        expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
      },
    );
  });

  describe('kakan som inloggning', () => {
    it('giltig kaka bland okända kakor ⇒ inloggad', async () => {
      const { port, host, appId, uppsattning } = await starta();
      const identitet = skapaIdentitet({ userId: 'anv-kaka' });
      uppsattning.register.bevilja(appId, identitet.userId, 'owner');

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Cookie: `tema=mork; ${kaka(tokenFor(identitet))}; _ga=GA1.2.3; session=annan-apps-kaka` },
      });

      expect(svar.status).toBe(200);
      expect(json<WhoAmIResponse>(svar).userId).toBe('anv-kaka');
    });

    it('kaknamnet två gånger i samma huvud ⇒ 401, även om BÅDA är giltiga', async () => {
      const { port, host } = await starta();
      const token = tokenFor(skapaIdentitet());

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: `${kaka(token)}; ${kaka(token)}` } });

      expect(svar.status).toBe(401);
    });

    it.each([
      ['planterad först', (egen: string, planterad: string) => `${kaka(planterad)}; ${kaka(egen)}`],
      ['planterad sist', (egen: string, planterad: string) => `${kaka(egen)}; ${kaka(planterad)}`],
    ])('en syskonapps planterade kaka (%s) ger 401 — aldrig angriparens identitet', async (_b, bygg) => {
      const { port, host } = await starta();
      const egen = tokenFor(skapaIdentitet({ userId: 'offret' }));
      const planterad = tokenFor(skapaIdentitet({ userId: 'angriparen' }));

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: bygg(egen, planterad) } });

      expect(svar.status).toBe(401);
      expect(svar.kropp).not.toContain('angriparen');
      expect(svar.kropp).not.toContain('offret');
    });

    it('kaknamnet i två SKILDA Cookie-huvuden ⇒ 401', async () => {
      const { port, host } = await starta();
      const token = tokenFor(skapaIdentitet());

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Cookie: [kaka(token), kaka('planterad')] },
      });

      expect(svar.status).toBe(401);
    });

    it('två Cookie-huvuden där bara det ena bär vår kaka ⇒ inloggad', async () => {
      const { port, host, appId, uppsattning } = await starta();
      const token = tokenFor(skapaIdentitet({ userId: 'anv-tva-huvuden' }));
      uppsattning.register.bevilja(appId, 'anv-tva-huvuden', 'owner');

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: ['tema=mork', kaka(token)] } });

      expect(svar.status).toBe(200);
    });

    it.each([
      ['utgången', () => tokenFor(skapaIdentitet(), HEMLIGHET, -1)],
      ['fel hemlighet', () => tokenFor(skapaIdentitet(), ANNAN_HEMLIGHET)],
      ['med prefixet "Test "', () => `Test ${tokenFor(skapaIdentitet())}`],
      ['inom citattecken', () => `"${tokenFor(skapaIdentitet())}"`],
      ['procentkodad punkt', () => tokenFor(skapaIdentitet()).replaceAll('.', '%2E')],
      ['tom', () => ''],
      ['manipulerad', () => `${tokenFor(skapaIdentitet())}A`],
    ])('kaka som är %s ⇒ 401', async (_b, varde) => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: kaka(varde()) } });

      expect(svar.status).toBe(401);
    });

    it('överlångt Cookie-huvud ⇒ 401 utan krasch, fast en giltig kaka finns med', async () => {
      const { port, host } = await starta();
      const fyllnad = `fyllnad=${'x'.repeat(MAX_COOKIE_HEADER_LENGTH)}`;

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Cookie: `${kaka(tokenFor(skapaIdentitet()))}; ${fyllnad}` },
      });

      expect(svar.status).toBe(401);
    });

    it.each([';;;', '=', '===;;==', `${KAKNAMN}`, `=${KAKNAMN}`, 'a=b; c'])('skräp i Cookie (%s) ⇒ 401, aldrig 500', async (skrap) => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: skrap } });

      expect(svar.status).toBe(401);
    });

    it('Authorization vinner över kakan', async () => {
      const { port, host, appId, uppsattning } = await starta();
      const viaHuvud = skapaIdentitet({ userId: 'via-authorization' });
      const viaKaka = skapaIdentitet({ userId: 'via-kaka' });
      // Båda har åtkomst, så att det är inloggningskällan och inte åtkomsten som avgör svaret.
      uppsattning.register.bevilja(appId, viaHuvud.userId, 'owner');
      uppsattning.register.bevilja(appId, viaKaka.userId, 'owner');

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Authorization: signTestIdentity(viaHuvud, HEMLIGHET), Cookie: kaka(tokenFor(viaKaka)) },
      });

      expect(json<WhoAmIResponse>(svar).userId).toBe('via-authorization');
    });

    it('ett OGILTIGT Authorization räddas inte av en giltig kaka — en källa per förfrågan', async () => {
      const { port, host } = await starta();

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Authorization: 'Test trasig.token', Cookie: kaka(tokenFor(skapaIdentitet())) },
      });

      expect(svar.status).toBe(401);
    });

    it('Authorization gäller även när kakan är tvetydig', async () => {
      const { port, host, appId, uppsattning } = await starta();
      const identitet = skapaIdentitet({ userId: 'via-authorization' });
      uppsattning.register.bevilja(appId, identitet.userId, 'owner');

      const svar = await anropa({
        port,
        host,
        path: '/_api/whoami',
        headers: { Authorization: signTestIdentity(identitet, HEMLIGHET), Cookie: `${kaka('a')}; ${kaka('b')}` },
      });

      expect(svar.status).toBe(200);
    });
  });

  describe('CSRF blir skarpt med kakor', () => {
    async function inloggad(): Promise<Startad & { readonly kakan: string }> {
      const startad = await starta();
      // Åtkomst till appen, så att det är CSRF-skyddet — inte åtkomsten — som prövas här.
      startad.uppsattning.register.bevilja(startad.appId, 'anv-csrf', 'owner');
      return { ...startad, kakan: kaka(tokenFor(skapaIdentitet({ userId: 'anv-csrf' }))) };
    }

    it('skrivning med giltig kaka men UTAN skyddshuvudet ⇒ 403, lagringen rörs inte', async () => {
      const { port, host, kakan, uppsattning } = await inloggad();

      const svar = await anropa({
        port,
        host,
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { Cookie: kakan, Origin: `http://${host}` },
        json: { data: { rum: 'Stora salen' } },
      });

      expect(svar.status).toBe(403);
      expect(json<ApiErrorBody>(svar).error.code).toBe('forbidden');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('giltig kaka + skyddshuvud + Origin från en SYSKONAPP ⇒ 403', async () => {
      const { port, host, appId, kakan, uppsattning } = await inloggad();
      const syskon = syskonvardTill(appId);
      expect(syskon).not.toBe(host);

      const svar = await anropa({
        port,
        host,
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { Cookie: kakan, [CSRF_HEADER]: '1', Origin: `http://${syskon}` },
        json: { data: { rum: 'Stora salen' } },
      });

      expect(svar.status).toBe(403);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it.each(['PUT', 'DELETE'])('%s med giltig kaka från en syskonapp ⇒ 403', async (method) => {
      const { port, host, appId, kakan, uppsattning } = await inloggad();
      const syskon = syskonvardTill(appId);
      expect(syskon).not.toBe(host);

      const svar = await anropa({
        port,
        host,
        method,
        path: `${DOKUMENTVAG}/dok-1`,
        headers: { Cookie: kakan, [CSRF_HEADER]: '1', Origin: `https://${syskon}` },
        ...(method === 'PUT' ? { json: { data: {} } } : {}),
      });

      expect(svar.status).toBe(403);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('giltig kaka + skyddshuvud + EGET Origin ⇒ går igenom', async () => {
      const { port, host, kakan, uppsattning } = await inloggad();

      const svar = await anropa({
        port,
        host,
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { Cookie: kakan, [CSRF_HEADER]: '1', Origin: `http://${host}:${port}` },
        json: { data: { rum: 'Stora salen' } },
      });

      expect(svar.status).toBe(201);
      expect(uppsattning.store.anrop.map((a) => a.metod)).toEqual(['createDocument']);
      expect(uppsattning.store.anrop[0]?.identity?.userId).toBe('anv-csrf');
    });

    it('GET med kaka ⇒ 200, utan skyddshuvud', async () => {
      const { port, host, kakan } = await inloggad();

      const svar = await anropa({ port, host, path: DOKUMENTVAG, headers: { Cookie: kakan } });

      expect(svar.status).toBe(200);
    });
  });

  describe('loggen', () => {
    it('innehåller aldrig token, kakvärde eller frågesträng', async () => {
      const { port, host, poster, appId, uppsattning } = await starta();
      const identitet = skapaIdentitet({ userId: 'anv-logg', email: 'loggad.person@example.org' });
      uppsattning.register.bevilja(appId, identitet.userId, 'owner');
      const token = tokenFor(identitet);
      const utgangen = tokenFor(identitet, HEMLIGHET, -1);

      await anropa({ port, host, path: `/_auth/test-login?token=${token}&markor=FRAGEMARKOR` });
      await anropa({ port, host, path: `/_auth/test-login?token=${utgangen}` });
      await anropa({ port, host, path: `/_auth/test-login?token=${token}&token=${token}` });
      await anropa({ port, host, method: 'POST', path: `/_auth/test-login?token=${token}` });
      await anropa({ port, host, path: '/_auth/test-logout', headers: { Cookie: kaka(token) } });
      await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: kaka(token) } });
      await anropa({ port, host, path: '/_api/whoami', headers: { Cookie: `${kaka(token)}; ${kaka(token)}` } });

      const dump = JSON.stringify(poster);
      expect(poster.filter((p) => p.event === 'request').map((p) => p.status)).toEqual([303, 401, 400, 405, 303, 200, 401]);
      expect(dump).toContain('anv-logg'); // userId ÄR det som ska användas — men bara för den inloggade förfrågan
      for (const hemligt of [token, utgangen]) {
        expect(dump).not.toContain(hemligt);
        for (const del of hemligt.split('.')) {
          expect(dump).not.toContain(del);
          expect(dump).not.toContain(del.slice(0, 20));
        }
      }
      expect(dump).not.toContain('FRAGEMARKOR');
      expect(dump).not.toContain('token');
      expect(dump).not.toContain('test-login');
      expect(dump).not.toContain(KAKNAMN);
      expect(dump).not.toContain('example.org');
    });
  });

  describe('produktionsspärren gäller även kroken', () => {
    const fraga = (path: string, query: Record<string, string>): AuthRouteRequest => ({
      host: 'exempel.appar.test',
      headers: {},
      method: 'GET',
      path,
      query,
    });

    it('NODE_ENV=production efter att leverantören skapats ⇒ rutterna finns inte (null)', async () => {
      process.env.NODE_ENV = 'test';
      const leverantor = createTestIdentityProvider({ secret: HEMLIGHET });
      const token = tokenFor(skapaIdentitet());
      expect((await leverantor.handleAuthRoute?.(fraga('/_auth/test-login', { token })))?.status).toBe(303);

      process.env.NODE_ENV = 'production';

      expect(await leverantor.handleAuthRoute?.(fraga('/_auth/test-login', { token }))).toBeNull();
      expect(await leverantor.handleAuthRoute?.(fraga('/_auth/test-logout', {}))).toBeNull();
    });

    it('NODE_ENV=production ⇒ en giltig kaka loggar inte in', async () => {
      process.env.NODE_ENV = 'test';
      const leverantor = createTestIdentityProvider({ secret: HEMLIGHET });
      const headers = { cookie: kaka(tokenFor(skapaIdentitet())) };
      expect(await leverantor.authenticate({ host: 'exempel.appar.test', headers })).not.toBeNull();

      process.env.NODE_ENV = 'production';

      expect(await leverantor.authenticate({ host: 'exempel.appar.test', headers })).toBeNull();
    });

    it('via gatewayn: inloggningsadressen ger 404 i produktion', async () => {
      const { port, host } = await starta();
      process.env.NODE_ENV = 'production';

      const svar = await anropa({ port, host, path: `/_auth/test-login?token=${tokenFor(skapaIdentitet())}` });

      expect(svar.status).toBe(404);
      expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
    });
  });

  describe('testLoginPath', () => {
    it('ger en sökväg under /_auth/ med token URL-kodad', () => {
      const path = testLoginPath(skapaIdentitet(), HEMLIGHET);

      expect(path).toMatch(/^\/_auth\/test-login\?token=[A-Za-z0-9_.~%-]+$/);
      const token = new URL(path, 'http://x.localtest.me').searchParams.get('token') ?? '';
      expect(`Test ${token}`).toMatch(/^Test [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it('respekterar livslängden', async () => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: testLoginPath(skapaIdentitet(), HEMLIGHET, { expiresInSeconds: 120 }) });

      const maxAge = Number(/Max-Age=([0-9]+)/.exec(enHuvud(svar, 'set-cookie') ?? '')?.[1]);
      expect(maxAge).toBeGreaterThan(110);
      expect(maxAge).toBeLessThanOrEqual(120);
    });

    it('en redan utgången inloggning ger en adress som nekas', async () => {
      const { port, host } = await starta();

      const svar = await anropa({ port, host, path: testLoginPath(skapaIdentitet(), HEMLIGHET, { expiresInSeconds: -5 }) });

      expect(svar.status).toBe(401);
    });

    it('kastar för en för kort hemlighet', () => {
      expect(() => testLoginPath(skapaIdentitet(), 'kort')).toThrow();
    });
  });
});
