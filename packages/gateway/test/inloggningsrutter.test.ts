/**
 * Inloggningsrutter: sökvägar under `AUTH_PREFIX` (`/_auth/`) på appens EGEN värd, som lämnas
 * till `IdentityProvider.handleAuthRoute` FÖRE inloggningskontrollen. Det är där en värd byter
 * en biljett mot sin egen host-only-kaka (ADR 0002).
 *
 * Beteendet, i domänens språk:
 *
 *   Givet en oinloggad besökare på en apps adress
 *   När hen öppnar en inloggningsadress under /_auth/
 *   Så får inloggningsleverantören svara — utan att plattformen slår upp om appen finns
 *
 *   Givet en inloggningsleverantör som är slarvig eller fientlig
 *   När den försöker lätta på skyddsreglerna, omdirigera till en annan webbplats eller sätta en
 *     kaka för hela domänen
 *   Så når inget av det webbläsaren: skyddsreglerna står kvar, och svaret blir ett internt fel
 *
 *   Givet en app som har byggt en fil under /_auth/ eller /_api/
 *   Så serveras den aldrig
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_PREFIX, unsafeCreateTenantContext } from '@vibesandbox/contracts';
import { forvantaAppensCsp, INGEN_INRAMNING } from './csp.ts';
import type { ApiErrorBody, AppId, AuthRouteRequest } from '@vibesandbox/contracts';
import type { ServerResponse } from 'node:http';
import { createGateway } from '../src/index.ts';
import type { GatewayLogEntry, GatewayOptions } from '../src/index.ts';
import { SECURITY_HEADERS } from '../src/huvuden.ts';
import { ALLOWED_PROVIDER_HEADERS } from '../src/inloggningsrutt.ts';
import { handleStatic } from '../src/statiskt.ts';
import { allaHuvuden, anropa, anropaRatt, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { AnropSvar, Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaFejkadAuthRouteProvider,
  skapaFejkadeFiler,
  skapaGodkannandeIdentityProvider,
  skapaKrashandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';
import type { TestUppsattning } from './fejkar.ts';

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const OK_SVAR = { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'ok' };

describe('inloggningsrutter under /_auth/', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
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

  /** Startar gatewayn med en leverantör vars inloggningsrutt svarar det testet bestämmer. */
  async function starta(
    rutt: (request: AuthRouteRequest) => unknown,
    overrides: Partial<GatewayOptions> = {},
    registrera = true,
  ): Promise<Startad> {
    const poster: GatewayLogEntry[] = [];
    const appId = skapaAppId(`auth-${Math.random()}`);
    const uppsattning = skapaTestUppsattning({
      identityProvider: skapaFejkadAuthRouteProvider(rutt),
      logger: (post) => poster.push(post),
      ...overrides,
    });
    if (registrera) uppsattning.register.registrera(appId, { published: true, draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));
    return { uppsattning, port: server.port, appId, host: vardnamnForApp(appId), poster };
  }

  function forvantaInterntFel(svar: AnropSvar, poster: readonly GatewayLogEntry[]): void {
    expect(svar.status).toBe(500);
    expect(json<ApiErrorBody>(svar).error.code).toBe('internal');
    // Inget av det leverantören försökte skicka får följa med felsvaret.
    expect(allaHuvuden(svar, 'location')).toEqual([]);
    expect(allaHuvuden(svar, 'set-cookie')).toEqual([]);
    expect(poster.some((p) => p.event === 'internal_error' && p.level === 'error')).toBe(true);
  }

  function forvantaSkyddshuvuden(svar: AnropSvar): void {
    for (const [namn, varde] of SECURITY_HEADERS) expect(enHuvud(svar, namn)).toBe(varde);
  }

  describe('stegordningen: före inloggning, utan registeruppslag', () => {
    it('en oinloggad når rutten; varken authenticate, register, filer eller lagring rörs', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe('ok');
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(1);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
      forvantaSkyddshuvuden(svar);
    });

    it('rutten är inget orakel: en app som INTE finns svarar exakt likadant som en som finns', async () => {
      const finns = await starta(() => OK_SVAR, {}, true);
      const svarFinns = await anropa({ port: finns.port, host: finns.host, path: '/_auth/biljett' });
      await server?.stang();
      const saknas = await starta(() => OK_SVAR, {}, false);
      const svarSaknas = await anropa({ port: saknas.port, host: saknas.host, path: '/_auth/biljett' });

      expect(svarSaknas.status).toBe(svarFinns.status);
      expect(svarSaknas.kropp).toBe(svarFinns.kropp);
      expect(Object.keys(svarSaknas.huvuden).sort()).toEqual(Object.keys(svarFinns.huvuden).sort());
      expect(saknas.uppsattning.register.anrop).toHaveLength(0);
    });

    it('leverantören får metod, normaliserad sökväg, frågeparametrar, validerat värdnamn och huvudena', async () => {
      const { uppsattning, port, appId } = await starta(() => OK_SVAR);

      await anropa({
        port,
        host: `${vardnamnForApp(appId)}:8787`,
        // `%5F` är `_`: det finns bara EN tolkning av sökvägen, och den görs före routningen.
        path: '/%5Fauth/biljett/?kod=abc%20123&retur=%2Fstart',
        headers: { Cookie: 'a=1', 'X-Annat': 'varde' },
      });

      const [fraga] = uppsattning.identityProvider.authRouteAnrop;
      expect(fraga?.method).toBe('GET');
      expect(fraga?.path).toBe('/_auth/biljett');
      expect(fraga?.path.startsWith(AUTH_PREFIX)).toBe(true);
      expect({ ...fraga?.query }).toEqual({ kod: 'abc 123', retur: '/start' });
      expect(fraga?.host).toBe(vardnamnForApp(appId));
      expect(fraga?.headers.cookie).toBe('a=1');
      expect(fraga?.headers['x-annat']).toBe('varde');
    });

    it('frågeparametrar med objektprototypens namn blir vanliga värden, inget annat', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      await anropa({ port, host, path: '/_auth/x?__proto__=a&constructor=b' });

      const fraga = uppsattning.identityProvider.authRouteAnrop[0];
      expect(Object.getPrototypeOf(fraga?.query)).toBeNull();
      expect(fraga?.query['__proto__']).toBe('a');
      expect(fraga?.query['constructor']).toBe('b');
    });

    it('fungerar även på en förhandsvisningsvärd', async () => {
      const { uppsattning, port, appId } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host: vardnamnForForhandsvisning(appId), path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(uppsattning.identityProvider.authRouteAnrop[0]?.host).toBe(vardnamnForForhandsvisning(appId));
    });

    it('bara `/_auth` utan avslutande del går också till leverantören, aldrig till filerna', async () => {
      const { uppsattning, port, host } = await starta(() => null);

      const svar = await anropa({ port, host, path: '/_auth' });

      expect(svar.status).toBe(404);
      expect(uppsattning.identityProvider.authRouteAnrop[0]?.path).toBe('/_auth');
      expect(uppsattning.filer.anrop).toHaveLength(0);
    });

    it.each([
      ['apex', 'appar.test'],
      ['reserverat namn', 'login.appar.test'],
      ['för kort app-id', 'abc.appar.test'],
      ['annan domän', `${skapaAppId('x')}.example.org`],
      ['versaler', `${skapaAppId('x').toUpperCase()}.appar.test`],
    ])('ogiltigt värdnamn (%s) ⇒ 400, leverantören tillfrågas aldrig', async (_b, host) => {
      const { uppsattning, port } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(400);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
      forvantaSkyddshuvuden(svar);
    });

    it('saknat Host ⇒ 400', async () => {
      const { uppsattning, port } = await starta(() => OK_SVAR);

      const svar = await anropaRatt({ port, requestrad: 'GET /_auth/biljett HTTP/1.1', huvuden: ['Connection: close'] });

      expect([0, 400]).toContain(svar.status);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it('dubbelt Host-huvud ⇒ 400, leverantören tillfrågas aldrig', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropaRatt({
        port,
        requestrad: 'GET /_auth/biljett HTTP/1.1',
        huvuden: [`Host: ${host}`, `Host: ${vardnamnForApp(skapaAppId('annan'))}`, 'Connection: close'],
      });

      expect(svar.status).toBe(400);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it('service worker-spärren gäller även här ⇒ 403', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, path: '/_auth/sw.js', headers: { 'Service-Worker': 'script' } });

      expect(svar.status).toBe(403);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it.each(['/_auth/%2e%2e/hemligt', '/_auth//x', '/_auth/a%00b', '/_auth/a%5Cb', '/_auth/%252e'])(
      'ogiltig sökväg under prefixet (%s) når aldrig leverantören — och aldrig filerna',
      async (path) => {
        const { uppsattning, port, host } = await starta(() => OK_SVAR);

        const svar = await anropa({ port, host, path });

        // Oinloggad: 401 som för varje annan adress. Poängen är att ingen "lagad" sökväg routas.
        expect(svar.status).toBe(401);
        expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
        expect(uppsattning.filer.anrop).toHaveLength(0);
      },
    );

    it('annat skiftläge (`/_AUTH/`) är INTE en inloggningsrutt: inloggning krävs som vanligt', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, path: '/_AUTH/biljett' });

      expect(svar.status).toBe(401);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });
  });

  describe('rutten finns inte ⇒ 404', () => {
    it('leverantören saknar kroken', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR, {
        identityProvider: skapaGodkannandeIdentityProvider(),
      });

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(404);
      expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
      // Inte ens en inloggad faller igenom till filer eller SPA-fallback.
      expect(uppsattning.filer.anrop).toHaveLength(0);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
      forvantaSkyddshuvuden(svar);
    });

    it('leverantören svarar null', async () => {
      const { uppsattning, port, host } = await starta(() => null);

      const svar = await anropa({ port, host, path: '/_auth/okand' });

      expect(svar.status).toBe(404);
      expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
      expect(uppsattning.filer.anrop).toHaveLength(0);
    });
  });

  describe('metoder: bara GET och POST', () => {
    it.each(['PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'])('%s ⇒ 405, leverantören tillfrågas aldrig', async (method) => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, method, path: '/_auth/biljett' });

      expect(svar.status).toBe(405);
      if (method !== 'HEAD') expect(json<ApiErrorBody>(svar).error.code).toBe('method_not_allowed');
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it('405 för en inloggningsrutt anger `Allow: GET, POST`', async () => {
      const { port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, method: 'PUT', path: '/_auth/biljett' });

      expect(enHuvud(svar, 'allow')).toBe('GET, POST');
    });

    it('POST når leverantören', async () => {
      const { uppsattning, port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, method: 'POST', path: '/_auth/biljett', body: 'kod=123456' });

      expect(svar.status).toBe(200);
      expect(uppsattning.identityProvider.authRouteAnrop[0]?.method).toBe('POST');
    });
  });

  describe('frågeparametrar', () => {
    it.each(['?token=a&token=b', '?token=a&token=a', '?a=1&b=2&a=3', '?token=&token='])(
      'dubbel parameter (%s) ⇒ 400 innan leverantören anropas',
      async (fraga) => {
        const { uppsattning, port, host } = await starta(() => OK_SVAR);

        const svar = await anropa({ port, host, path: `/_auth/biljett${fraga}` });

        expect(svar.status).toBe(400);
        expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
        expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
      },
    );

    it('felsvaret för en dubbel parameter ekar varken namn eller värde', async () => {
      const { port, host } = await starta(() => OK_SVAR);

      const svar = await anropa({ port, host, path: '/_auth/biljett?hemligparam=HEMLIGT1&hemligparam=HEMLIGT2' });

      expect(svar.kropp).not.toContain('hemligparam');
      expect(svar.kropp).not.toContain('HEMLIGT');
    });
  });

  describe('leverantören kastar ⇒ 401, som i authenticate', () => {
    it('svaret röjer inget, felet loggas utan meddelande', async () => {
      const { port, host, poster } = await starta(() => {
        throw new Error('kunde inte slå upp hemlig.person@example.org');
      });

      const svar = await anropa({ port, host, path: '/_auth/biljett?token=abc' });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(svar.kropp).not.toContain('example.org');
      expect(poster.some((p) => p.event === 'identity_provider_failed' && p.level === 'error')).toBe(true);
      expect(JSON.stringify(poster)).not.toContain('example.org');
      forvantaSkyddshuvuden(svar);
    });

    it('en leverantör vars authenticate kraschar men som saknar kroken ger ändå 404 här', async () => {
      const { port, host } = await starta(() => OK_SVAR, { identityProvider: skapaKrashandeIdentityProvider() });

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(404);
    });
  });

  describe('en fientlig leverantör kan inte röra skyddshuvudena', () => {
    const FIENTLIGA_HUVUDEN = {
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
      'X-Content-Type-Options': 'sniff-garna',
      'Referrer-Policy': 'unsafe-url',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Content-Type': 'text/plain; charset=utf-8',
    };

    it('skyddshuvudena vinner, och förekommer exakt EN gång vardera', async () => {
      const { port, host } = await starta(() => ({ status: 200, headers: FIENTLIGA_HUVUDEN, body: 'hej' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      forvantaAppensCsp(svar, INGEN_INRAMNING);
      expect(enHuvud(svar, 'x-content-type-options')).toBe('nosniff');
      expect(enHuvud(svar, 'referrer-policy')).toBe('no-referrer');
      expect(enHuvud(svar, 'cross-origin-resource-policy')).toBe('same-origin');
      expect(enHuvud(svar, 'cache-control')).toBe('no-store');
      forvantaSkyddshuvuden(svar);
    });

    it('CORS-huvuden filtreras bort helt', async () => {
      const { port, host } = await starta(() => ({ status: 200, headers: FIENTLIGA_HUVUDEN, body: 'hej' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(Object.keys(svar.huvuden).filter((namn) => namn.startsWith('access-control-'))).toEqual([]);
    });

    it.each([
      ['gemener', { 'content-security-policy': 'default-src *', 'cache-control': 'public' }],
      ['versaler', { 'CONTENT-SECURITY-POLICY': 'default-src *', 'CACHE-CONTROL': 'public' }],
      ['blandat', { 'cOnTeNt-SeCuRiTy-PoLiCy': 'default-src *', 'Cache-control': 'public' }],
      ['report-only-varianten', { 'Content-Security-Policy-Report-Only': 'default-src *' }],
    ])('skiftläget spelar ingen roll (%s)', async (_b, headers) => {
      const { port, host } = await starta(() => ({ status: 200, headers }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      forvantaSkyddshuvuden(svar);
      expect(allaHuvuden(svar, 'content-security-policy-report-only')).toEqual([]);
    });

    it.each([
      ['Refresh', '0; url=https://example.org/'],
      ['Link', '<https://example.org/>; rel=preload'],
      ['Clear-Site-Data', '"*"'],
      ['Set-Cookie2', 'a=1'],
      ['Strict-Transport-Security', 'max-age=0'],
      ['Service-Worker-Allowed', '/'],
      ['X-Eget', 'varde'],
      ['Connection', 'keep-alive'],
      ['Transfer-Encoding', 'chunked'],
      ['Content-Length', '9999'],
    ])('huvudet %s finns inte på allowlisten och når aldrig webbläsaren', async (namn, varde) => {
      const { port, host } = await starta(() => ({ status: 200, headers: { [namn]: varde }, body: 'hej' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe('hej');
      expect(enHuvud(svar, 'content-length')).toBe('3');
      if (!['connection', 'content-length'].includes(namn.toLowerCase())) {
        expect(allaHuvuden(svar, namn)).toEqual([]);
      }
    });

    it('ett OKÄNT huvud under två skiftlägen släpps tyst — det fäller inte svaret', async () => {
      const { port, host } = await starta(() => ({
        status: 200,
        headers: { 'X-Eget': 'a', 'x-eget': 'b', 'Cache-Control': 'public', 'cache-control': 'private' },
        body: 'hej',
      }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(allaHuvuden(svar, 'x-eget')).toEqual([]);
      forvantaSkyddshuvuden(svar);
    });

    it('allowlisten är liten och överlappar aldrig skyddshuvudena', () => {
      expect([...ALLOWED_PROVIDER_HEADERS].sort()).toEqual(['allow', 'content-type', 'location', 'set-cookie']);
      for (const [namn] of SECURITY_HEADERS) expect(ALLOWED_PROVIDER_HEADERS.has(namn.toLowerCase())).toBe(false);
    });
  });

  describe('Location: bara en relativ sökväg på samma värd', () => {
    it.each(['/', '/start', '/a/b/c', '/sida?x=1&y=2', '/sida#del', '/a//b', '/%C3%A5'])(
      'godtar %s',
      async (location) => {
        const { port, host } = await starta(() => ({ status: 303, headers: { Location: location } }));

        const svar = await anropa({ port, host, path: '/_auth/biljett' });

        expect(svar.status).toBe(303);
        expect(enHuvud(svar, 'location')).toBe(location);
        expect(enHuvud(svar, 'content-length')).toBe('0');
        forvantaSkyddshuvuden(svar);
      },
    );

    it.each<[string, unknown]>([
      ['protokollrelativ', '//example.org/'],
      ['protokollrelativ med tre snedstreck', '///example.org/'],
      ['snedstreck + bakåtstreck', '/\\example.org'],
      ['bakåtstreck + snedstreck', '\\/example.org'],
      ['bakåtstreck längre in', '/a\\b'],
      ['absolut https', 'https://example.org/'],
      ['absolut http', 'http://example.org/'],
      ['schema utan snedstreck', 'https:example.org'],
      ['javascript-schema', 'javascript:alert(1)'],
      ['data-schema', 'data:text/html,hej'],
      ['bara ett värdnamn', 'example.org'],
      ['relativ utan inledande snedstreck', 'start'],
      ['tom', ''],
      ['inledande blanktecken', ' /start'],
      ['blanktecken i sökvägen', '/a b'],
      // Webbläsare STRYKER tabb och radbrytning ur en URL: `/<tabb>/example.org` blir `//example.org`.
      ['tabb mellan snedstrecken', `/${TAB}/example.org`],
      ['radbrytning (huvudinjektion)', '/start\r\nSet-Cookie: planterad=1'],
      ['ensam LF', '/start\nX: y'],
      ['NUL', `/a${NUL}b`],
      ['DEL', `/a${String.fromCharCode(0x7f)}`],
      ['icke-ASCII', '/å'],
      ['överlång', `/${'a'.repeat(3000)}`],
      ['tal', 42],
      ['lista', ['/']],
      ['null', null],
    ])('nekar %s ⇒ 500 internal + loggat fel', async (_b, location) => {
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: location, 'Set-Cookie': 's=1; Path=/; HttpOnly' },
      }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      forvantaInterntFel(svar, poster);
      expect(allaHuvuden(svar, 'x')).toEqual([]);
      forvantaSkyddshuvuden(svar);
    });

    it('303 utan Location ⇒ 500', async () => {
      const { port, host, poster } = await starta(() => ({ status: 303, headers: {} }));
      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('Location tillsammans med en annan status än 303 ⇒ 500', async () => {
      const { port, host, poster } = await starta(() => ({ status: 200, headers: { Location: '/' } }));
      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('Location under två nycklar som bara skiljer i skiftläge ⇒ 500 (vilken gäller?)', async () => {
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: '/', location: '/annan' },
      }));
      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });
  });

  describe('Set-Cookie: aldrig `Domain`, alltid `HttpOnly`', () => {
    const BRA_KAKA = '__Host-s=abc; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600';

    it('en host-only-kaka släpps igenom ordagrant', async () => {
      const { port, host } = await starta(() => ({ status: 303, headers: { Location: '/', 'Set-Cookie': BRA_KAKA } }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(303);
      expect(allaHuvuden(svar, 'set-cookie')).toEqual([BRA_KAKA]);
    });

    it.each([
      ['vanlig', 's=1; Path=/; HttpOnly; Domain=appar.test'],
      ['gemener', 's=1; Path=/; HttpOnly; domain=appar.test'],
      ['versaler', 's=1; Path=/; HttpOnly; DOMAIN=appar.test'],
      ['blandat skiftläge', 's=1; Path=/; HttpOnly; dOmAiN=appar.test'],
      ['inledande punkt', 's=1; Path=/; HttpOnly; Domain=.appar.test'],
      ['utan blanktecken efter semikolon', 's=1;Domain=appar.test;HttpOnly'],
      ['blanktecken runt likhetstecknet', 's=1; HttpOnly;   Domain   =   appar.test'],
      ['blanktecken före semikolon', 's=1 ;Domain=appar.test ; HttpOnly'],
      ['först bland attributen', 's=1; Domain=appar.test; Path=/; HttpOnly'],
      ['utan värde', 's=1; HttpOnly; Domain'],
      ['tomt värde', 's=1; HttpOnly; Domain='],
      ['tabb före attributet', `s=1; HttpOnly;${TAB}Domain=appar.test`],
      ['efter ett kommatecken, som om två kakor slagits ihop', 'a=1; Path=/; HttpOnly, b=2; Domain=appar.test'],
      ['utan kaka framför', '; Domain=appar.test; HttpOnly'],
    ])('nekar Domain (%s) ⇒ 500 internal + loggat fel, ingen kaka sätts', async (_b, kaka) => {
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: '/', 'Set-Cookie': kaka },
      }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it.each([
      ['kakans NAMN är "domain"', 'domain=1; Path=/; HttpOnly'],
      ['ordet i VÄRDET', 's=domain; Path=/; HttpOnly'],
      ['ett attribut som bara liknar', 's=1; Path=/; HttpOnly; Domainx=1'],
    ])('förväxlar inte: %s godtas', async (_b, kaka) => {
      const { port, host } = await starta(() => ({ status: 200, headers: { 'Set-Cookie': kaka } }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(allaHuvuden(svar, 'set-cookie')).toEqual([kaka]);
    });

    it.each([
      ['saknar HttpOnly', 's=1; Path=/; SameSite=Lax'],
      ['HttpOnly bara som del av ett annat ord', 's=1; Path=/; HttpOnlyish'],
      ['HttpOnly bara i värdet', 's=HttpOnly; Path=/'],
      ['radbrytning', 's=1; HttpOnly\r\nSet-Cookie: planterad=1; Domain=appar.test'],
      ['NUL', `s=${NUL}; HttpOnly`],
      ['icke-ASCII', 's=å; HttpOnly'],
      ['tom', ''],
      ['utan likhetstecken', 'HttpOnly'],
      ['utan namn', '=v; HttpOnly'],
      ['överlång', `s=${'a'.repeat(5000)}; HttpOnly`],
    ])('nekar en kaka som %s ⇒ 500', async (_b, kaka) => {
      const { port, host, poster } = await starta(() => ({ status: 200, headers: { 'Set-Cookie': kaka } }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('flera kakor (lista) blir en Set-Cookie-rad var', async () => {
      const kakor = ['__Host-s=abc; Path=/; Secure; HttpOnly', '__Host-biljett=; Path=/; Secure; HttpOnly; Max-Age=0'];
      const { port, host } = await starta(() => ({ status: 303, headers: { Location: '/', 'Set-Cookie': kakor } }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(303);
      expect(allaHuvuden(svar, 'set-cookie')).toEqual(kakor);
    });

    it('EN kaka med Domain bland flera fäller hela svaret — ingen av dem sätts', async () => {
      const kakor = ['__Host-s=abc; Path=/; Secure; HttpOnly', 'planterad=1; HttpOnly; Domain=appar.test'];
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: '/', 'Set-Cookie': kakor },
      }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it.each<[string, unknown]>([
      ['tom lista', []],
      ['lista med annat än strängar', ['s=1; HttpOnly', 42]],
      ['för många kakor', Array.from({ length: 9 }, (_, i) => `k${i}=1; HttpOnly`)],
      ['tal', 42],
    ])('nekar %s ⇒ 500', async (_b, varde) => {
      const { port, host, poster } = await starta(() => ({ status: 200, headers: { 'Set-Cookie': varde } }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('Set-Cookie under två nycklar som bara skiljer i skiftläge ⇒ 500', async () => {
      const { port, host, poster } = await starta(() => ({
        status: 200,
        headers: { 'Set-Cookie': 'a=1; HttpOnly', 'set-cookie': 'b=2; HttpOnly' },
      }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('listor godtas BARA för Set-Cookie', async () => {
      const { port, host, poster } = await starta(() => ({
        status: 200,
        headers: { 'Content-Type': ['text/plain; charset=utf-8', 'text/html; charset=utf-8'] },
      }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });
  });

  describe('status ur en allowlist', () => {
    it.each([200, 400, 401, 403, 404, 405, 413, 429])('godtar %i', async (status) => {
      const { port, host } = await starta(() => ({ status, headers: {} }));

      expect((await anropa({ port, host, path: '/_auth/biljett' })).status).toBe(status);
    });

    it.each<[unknown]>([
      [100],
      [101],
      [201],
      [204],
      [301],
      [302],
      [304],
      [307],
      [308],
      [402],
      [500],
      [502],
      [0],
      [-200],
      [200.5],
      [Number.NaN],
      ['200'],
      [null],
      [undefined],
    ])('nekar %s ⇒ 500', async (status) => {
      const { port, host, poster } = await starta(() => ({ status, headers: {} }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });
  });

  describe('svarets form', () => {
    it.each<[string, unknown]>([
      ['sträng', 'ok'],
      ['tal', 200],
      ['undefined', undefined],
      ['lista', [200]],
      ['saknar headers', { status: 200 }],
      ['headers är null', { status: 200, headers: null }],
      ['headers är en lista', { status: 200, headers: [['Location', '/']] }],
      ['kroppen är inte en sträng', { status: 200, headers: {}, body: { hemligt: true } }],
      ['kroppen är en Buffer', { status: 200, headers: {}, body: Buffer.from('hej') }],
      ['kroppen är för stor', { status: 200, headers: {}, body: 'x'.repeat(70_000) }],
    ])('%s ⇒ 500', async (_b, svarFranLeverantor) => {
      const { port, host, poster } = await starta(() => svarFranLeverantor);

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it.each([
      'text/plain; charset=utf-8',
      'text/html; charset=utf-8',
      'application/json; charset=utf-8',
    ])('godtar Content-Type %s', async (contentType) => {
      const { port, host } = await starta(() => ({ status: 200, headers: { 'content-type': contentType }, body: 'x' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(200);
      expect(enHuvud(svar, 'content-type')).toBe(contentType);
    });

    it.each([
      'text/html',
      'text/plain; charset=utf-7',
      'application/javascript; charset=utf-8',
      'image/svg+xml',
      'text/html; charset=utf-8\r\nX-Injicerat: 1',
      '',
    ])('nekar Content-Type "%s" ⇒ 500', async (contentType) => {
      const { port, host, poster } = await starta(() => ({
        status: 200,
        headers: { 'Content-Type': contentType },
        body: 'x',
      }));

      forvantaInterntFel(await anropa({ port, host, path: '/_auth/biljett' }), poster);
    });

    it('kropp utan Content-Type serveras som ren text — aldrig något webbläsaren får gissa', async () => {
      const { port, host } = await starta(() => ({ status: 401, headers: {}, body: '<script>alert(1)</script>' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(svar.status).toBe(401);
      expect(enHuvud(svar, 'content-type')).toBe('text/plain; charset=utf-8');
      expect(enHuvud(svar, 'x-content-type-options')).toBe('nosniff');
    });

    it('Content-Length räknas i byte, inte tecken', async () => {
      const { port, host } = await starta(() => ({ status: 200, headers: {}, body: 'åäö' }));

      const svar = await anropa({ port, host, path: '/_auth/biljett' });

      expect(enHuvud(svar, 'content-length')).toBe('6');
      expect(svar.kropp).toBe('åäö');
    });

    it('Allow godtas bara som en delmängd av GET och POST', async () => {
      const bra = await starta(() => ({ status: 405, headers: { Allow: 'GET' } }));
      const svarBra = await anropa({ port: bra.port, host: bra.host, method: 'POST', path: '/_auth/biljett' });
      expect(svarBra.status).toBe(405);
      expect(enHuvud(svarBra, 'allow')).toBe('GET');
      await server?.stang();

      const dalig = await starta(() => ({ status: 405, headers: { Allow: 'GET, TRACE' } }));
      forvantaInterntFel(
        await anropa({ port: dalig.port, host: dalig.host, method: 'POST', path: '/_auth/biljett' }),
        dalig.poster,
      );
    });
  });

  describe('loggen', () => {
    it('anger rutten som "auth" men aldrig sökväg, frågesträng eller kakor', async () => {
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: '/', 'Set-Cookie': 's=KAKVARDE-UT; Path=/; HttpOnly' },
      }));

      await anropa({
        port,
        host,
        path: '/_auth/hemlig-rutt?token=BILJETT-12345',
        headers: { Cookie: 's=KAKVARDE-IN' },
      });

      const dump = JSON.stringify(poster);
      expect(poster.some((p) => p.event === 'request' && p.route === 'auth' && p.status === 303)).toBe(true);
      expect(dump).not.toContain('BILJETT');
      expect(dump).not.toContain('token');
      expect(dump).not.toContain('hemlig-rutt');
      expect(dump).not.toContain('KAKVARDE');
    });

    it('ett kontraktsbrott loggas med VILKEN regel som bröts, aldrig med värdet', async () => {
      const { port, host, poster } = await starta(() => ({
        status: 303,
        headers: { Location: 'https://example.org/stulen?biljett=BILJETT-12345' },
      }));

      await anropa({ port, host, path: '/_auth/biljett' });

      const fel = poster.find((p) => p.event === 'internal_error');
      expect(fel?.errorName).toContain('location');
      expect(JSON.stringify(poster)).not.toContain('example.org');
      expect(JSON.stringify(poster)).not.toContain('BILJETT');
    });
  });
});

describe('appfiler under /_auth/ och /_api/ serveras aldrig', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it.each(['/_auth/stjal.js', '/_auth/index.html', '/_auth', '/_api/stjal.js', '/_api/whoami', '/_api'])(
    'en inloggad får aldrig filen %s, fast AppFiles har den',
    async (path) => {
      const appId = skapaAppId('reserverade-prefix');
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      uppsattning.register.registrera(appId, { published: true });
      uppsattning.filer.satt(appId, 'published', path, textfil('STULEN', 'text/javascript; charset=utf-8'));
      uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<h1>app</h1>'));
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({ port: server.port, host: vardnamnForApp(appId), path });

      expect(svar.kropp).not.toContain('STULEN');
      expect(svar.kropp).not.toContain('<h1>app</h1>');
      expect(uppsattning.filer.anrop).toHaveLength(0);
    },
  );

  /**
   * Skyddet i djupled: även om routningen i index.ts en dag skulle ändras får filservern SJÄLV
   * aldrig läsa under de reserverade prefixen. Därför anropas `handleStatic` här direkt.
   */
  it.each([
    ['_auth', 'stjal.js'],
    ['_api', 'stjal.js'],
    ['_AUTH', 'stjal.js'],
    ['_Api', 'stjal.js'],
    ['_auth', 'djupt', 'ner', 'sida'],
    ['_auth'],
    ['_api'],
  ])('handleStatic vägrar segmenten %j utan att fråga AppFiles', async (...segments) => {
    const filer = skapaFejkadeFiler();
    const appId = skapaAppId('statiskt-direkt');
    filer.satt(appId, 'published', `/${segments.join('/')}`, textfil('STULEN'));
    filer.satt(appId, 'published', '/index.html', textfil('<h1>app</h1>'));
    const tenant = unsafeCreateTenantContext(appId as AppId, 'published');
    const skrivet: unknown[] = [];
    const response = { setHeader: () => {}, end: (data: unknown) => skrivet.push(data) } as unknown as ServerResponse;

    await expect(handleStatic({ response, method: 'GET', segments, tenant, files: filer })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(filer.anrop).toHaveLength(0);
    expect(skrivet).toHaveLength(0);
  });
});
