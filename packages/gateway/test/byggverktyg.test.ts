/**
 * Byggverktygets värd `bygg.<BASE_DOMAIN>` i gatewayn.
 *
 *   Givet en inloggad byggare på byggverktygets egen origin
 *   När hen öppnar byggverktyget eller skickar ett anrop med skyddshuvud och rätt Origin
 *   Så når förfrågan byggverktyget — med vem hen är, men utan hens kakor
 *
 *   Givet en förhandsvisning eller en publicerad app (opålitlig kod, SAMMA site)
 *   När den försöker skicka ett skrivande anrop till byggverktyget
 *   Så nekas anropet: bara byggverktygets exakta Origin godtas (SameSite skyddar inte, spik S1)
 *
 *   Givet ett svar från byggverktyget
 *   När det skickas vidare
 *   Så går bara Content-Type igenom; skyddshuvudena vinner, och kakor och CORS stoppas
 *
 * Varje prov kontrollerar att den fejkade handlern INTE nåddes där den inte får nås.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  builderContentSecurityPolicy,
  CSRF_HEADER,
  DataApiError,
  MAX_REQUEST_BODY_BYTES,
} from '@vibesandbox/contracts';
import type { ApiErrorBody, PlatformRequest } from '@vibesandbox/contracts';
import { createGateway, createTestIdentityProvider, testLoginPath } from '../src/index.ts';
import type { GatewayLogEntry, GatewayOptions } from '../src/index.ts';
import { createHostParser } from '../src/vardnamn.ts';
import { allaHuvuden, anropa, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { AnropOptions, AnropSvar, Testserver } from './hjalp.ts';
import {
  BYGGVERKTYGETS_SIDA,
  skapaAppId,
  skapaFejkadBuilderHandler,
  skapaGodkannandeIdentityProvider,
  skapaIdentitet,
  skapaKrashandeIdentityProvider,
  skapaNekandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
} from './fejkar.ts';
import type { FejkadBuilderHandler, FejkadIdentityProvider, TestUppsattning } from './fejkar.ts';

const DOMAN = 'example.org';
const BYGG = `bygg.${DOMAN}`;
const BYGG_ORIGIN = `https://${BYGG}`;
const FORVANTAD_CSP = builderContentSecurityPolicy(`https://*.${DOMAN}`);
const HEMLIGHET = 'testhemlighet-for-byggverktygets-inloggning-32-byte';

const SKRIVANDE = ['POST', 'PUT', 'DELETE'] as const;

interface Startad {
  readonly port: number;
  readonly handler: FejkadBuilderHandler;
  readonly uppsattning: TestUppsattning;
  readonly poster: GatewayLogEntry[];
}

describe('byggverktygets värd', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function starta(
    options: {
      leverantor?: FejkadIdentityProvider | GatewayOptions['identityProvider'];
      svar?: (request: PlatformRequest) => unknown;
      origin?: string;
      utanByggverktyg?: boolean;
    } = {},
  ): Promise<Startad> {
    const poster: GatewayLogEntry[] = [];
    const handler = skapaFejkadBuilderHandler(options.svar);
    const uppsattning = skapaTestUppsattning({
      appDomain: DOMAN,
      previewDomain: DOMAN,
      identityProvider: options.leverantor ?? skapaGodkannandeIdentityProvider(),
      logger: (post) => poster.push(post),
      ...(options.utanByggverktyg ? {} : { builder: { handler, origin: options.origin ?? BYGG_ORIGIN } }),
    });
    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, handler, uppsattning, poster };
  }

  /** Ett skrivande anrop som det legitima byggverktyget skickar det. */
  function skriv(port: number, method: string, extra: Partial<AnropOptions> = {}): Promise<AnropSvar> {
    return anropa({
      port,
      method,
      host: BYGG,
      path: '/_api/builder/apps',
      headers: { [CSRF_HEADER]: '1', Origin: BYGG_ORIGIN },
      json: { name: 'Todo' },
      ...extra,
    });
  }

  function forvantaNeka(svar: AnropSvar, status: number, handler: FejkadBuilderHandler): void {
    expect(svar.status).toBe(status);
    expect(handler.anrop).toHaveLength(0);
    expect(enHuvud(svar, 'Content-Security-Policy')).toBe(FORVANTAD_CSP);
  }

  // ── Värdnamnet ────────────────────────────────────────────────────────────────

  describe('värdnamnet', () => {
    const parse = createHostParser({ appDomain: DOMAN, previewDomain: DOMAN, builder: true });

    it('bygg.<domän> är byggverktyget — en egen sort utan app-id', () => {
      expect(parse(BYGG)).toEqual({ kind: 'builder', hostname: BYGG });
    });

    it('porten strippas och påverkar ingenting', () => {
      expect(parse(`${BYGG}:8787`)).toEqual({ kind: 'builder', hostname: BYGG });
    });

    it('förhandsvisningsdomänen avgör, inte appdomänen', () => {
      const separat = createHostParser({ appDomain: 'appar.test', previewDomain: DOMAN, builder: true });
      expect(separat(BYGG)).toEqual({ kind: 'builder', hostname: BYGG });
      expect(separat('bygg.appar.test')).toBe('ogiltigt');
    });

    it('utan byggverktyg är bygg.<domän> ett okänt värdnamn', () => {
      expect(createHostParser({ appDomain: DOMAN, previewDomain: DOMAN })(BYGG)).toBe('ogiltigt');
    });

    const fientliga = [
      'Bygg.example.org',
      'BYGG.example.org',
      'bygg.EXAMPLE.org',
      'xbygg.example.org',
      'byggx.example.org',
      'bygg.bygg.example.org',
      'p-bygg.example.org',
      'bygg-.example.org',
      'bygg.example.com',
      'bygg.example.org.',
      'bygg.example.org.evil.test',
      'evil.test.bygg.example.org',
      'bygg.example.org:',
      'bygg.example.org:123456',
      'bygg.example.org:80:80',
      ' bygg.example.org',
      'bygg.example.org ',
      'bygg..example.org',
      'bygg.example.org/',
      'bygg.example.org@evil.test',
      'bygg%2eexample.org',
      'bygg',
      DOMAN,
      '',
    ];

    it.each(fientliga)('"%s" ⇒ ogiltigt', (host) => {
      expect(parse(host)).toBe('ogiltigt');
    });

    it.each(fientliga.filter((h) => h.length > 0 && !/\s/.test(h)))(
      '"%s" över HTTP ⇒ 400, utan inloggningsfråga och utan att handlern nås',
      async (host) => {
        const { port, handler, uppsattning } = await starta();

        const svar = await anropa({ port, host, path: '/' });

        expect(svar.status).toBe(400);
        expect(handler.anrop).toHaveLength(0);
        expect(uppsattning.identityProvider.anrop).toHaveLength(0);
      },
    );

    it('utan builder-option ⇒ 400 på bygg.<domän>', async () => {
      const { port, handler, uppsattning } = await starta({ utanByggverktyg: true });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(400);
      expect(handler.anrop).toHaveLength(0);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    });
  });

  // ── Inställningen ─────────────────────────────────────────────────────────────

  describe('builder.origin valideras vid start', () => {
    const felaktiga = [
      'bygg.example.org',
      'https://bygg.example.org/',
      'https://bygg.example.org/x',
      'https://bygg.example.org:443',
      'http://bygg.example.org:80',
      'https://bygg.example.org:0',
      'https://bygg.example.org:08787',
      'https://bygg.example.org:65536',
      'https://bygg.example.org:',
      'ftp://bygg.example.org',
      'HTTPS://bygg.example.org',
      'https://BYGG.example.org',
      'https://example.org',
      'https://bygg.annan.test',
      'https://p-bygg.example.org',
      'https://*.example.org',
      ' https://bygg.example.org',
      'https://bygg.example.org?x',
      'https://user@bygg.example.org',
      'null',
      '',
    ];

    it.each(felaktiga)('"%s" ⇒ createGateway kastar', (origin) => {
      const uppsattning = skapaTestUppsattning({
        appDomain: DOMAN,
        previewDomain: DOMAN,
        builder: { handler: skapaFejkadBuilderHandler(), origin },
      });
      expect(() => createGateway(uppsattning.options)).toThrow(/builder/);
    });

    it.each(['https://bygg.example.org', 'http://bygg.example.org:8787', 'https://bygg.example.org:8443'])(
      '"%s" godtas',
      (origin) => {
        const uppsattning = skapaTestUppsattning({
          appDomain: DOMAN,
          previewDomain: DOMAN,
          builder: { handler: skapaFejkadBuilderHandler(), origin },
        });
        expect(() => createGateway(uppsattning.options)).not.toThrow();
      },
    );

    it('en handler utan handle() ⇒ createGateway kastar', () => {
      const uppsattning = skapaTestUppsattning({
        appDomain: DOMAN,
        previewDomain: DOMAN,
        builder: { handler: {} as never, origin: BYGG_ORIGIN },
      });
      expect(() => createGateway(uppsattning.options)).toThrow(/builder/);
    });
  });

  // ── Skyddsregler ──────────────────────────────────────────────────────────────

  describe('skyddsregler', () => {
    it('byggverktygets CSP på 200, med förhandsvisningarnas mönster i frame-src', async () => {
      const { port } = await starta();

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe(BYGGVERKTYGETS_SIDA);
      expect(enHuvud(svar, 'Content-Security-Policy')).toBe(FORVANTAD_CSP);
      expect(FORVANTAD_CSP).toContain(`frame-src https://*.${DOMAN}`);
      expect(enHuvud(svar, 'X-Content-Type-Options')).toBe('nosniff');
      expect(enHuvud(svar, 'Referrer-Policy')).toBe('same-origin');
      expect(enHuvud(svar, 'Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(enHuvud(svar, 'Cache-Control')).toBe('no-store');
    });

    it('frame-src bär originens schema och port', async () => {
      const { port } = await starta({ origin: 'http://bygg.example.org:8787' });

      const svar = await anropa({ port, host: `${BYGG}:8787`, path: '/' });

      expect(enHuvud(svar, 'Content-Security-Policy')).toBe(builderContentSecurityPolicy('http://*.example.org:8787'));
    });

    it('även 401, 403 och 400 bär byggverktygets CSP', async () => {
      const nekad = await starta({ leverantor: skapaNekandeIdentityProvider() });
      forvantaNeka(await anropa({ port: nekad.port, host: BYGG, path: '/' }), 401, nekad.handler);
      await server?.stang();

      const { port, handler } = await starta();
      forvantaNeka(await skriv(port, 'POST', { headers: { [CSRF_HEADER]: '1' } }), 403, handler);
      forvantaNeka(await anropa({ port, host: BYGG, path: '/?a=1&a=2' }), 400, handler);
    });
  });

  // ── Inloggning ────────────────────────────────────────────────────────────────

  describe('inloggning', () => {
    it('oinloggad ⇒ 401, och handlern nås aldrig — inte ens för en statisk fil', async () => {
      const { port, handler, uppsattning } = await starta({ leverantor: skapaNekandeIdentityProvider() });

      for (const path of ['/', '/assets/app.js', '/_api/builder/me', '/favicon.ico']) {
        const svar = await anropa({ port, host: BYGG, path });
        expect(svar.status).toBe(401);
      }
      forvantaNeka(await skriv(port, 'POST'), 401, handler);
      expect(uppsattning.identityProvider.anrop.every((a) => a.host === BYGG)).toBe(true);
    });

    it('identitetsleverantören kraschar ⇒ 401, och handlern nås aldrig', async () => {
      const { port, handler } = await starta({ leverantor: skapaKrashandeIdentityProvider() });

      forvantaNeka(await anropa({ port, host: BYGG, path: '/' }), 401, handler);
    });

    it('/_auth/test-login på byggverktygets värd sätter en host-only-kaka, och den loggar sedan in', async () => {
      const identitet = skapaIdentitet({ userId: 'bygg-anna' });
      const { port, handler } = await starta({ leverantor: createTestIdentityProvider({ secret: HEMLIGHET }) });

      const inloggning = await anropa({ port, host: BYGG, path: testLoginPath(identitet, HEMLIGHET) });

      expect(inloggning.status).toBe(303);
      expect(enHuvud(inloggning, 'Location')).toBe('/');
      const [kaka] = allaHuvuden(inloggning, 'Set-Cookie');
      expect(kaka).toBeDefined();
      expect(kaka?.toLowerCase()).not.toContain('domain');
      expect(enHuvud(inloggning, 'Content-Security-Policy')).toBe(FORVANTAD_CSP);
      expect(handler.anrop).toHaveLength(0);

      const svar = await anropa({ port, host: BYGG, path: '/', headers: { Cookie: (kaka ?? '').split(';')[0] ?? '' } });

      expect(svar.status).toBe(200);
      expect(handler.anrop).toHaveLength(1);
      expect(handler.anrop[0]?.identity.userId).toBe('bygg-anna');
    });
  });

  // ── CSRF ──────────────────────────────────────────────────────────────────────

  describe('strikt CSRF för skrivande metoder', () => {
    it.each(SKRIVANDE)('%s med skyddshuvud och exakt Origin ⇒ handlern nås', async (method) => {
      const { port, handler } = await starta();

      const svar = await skriv(port, method);

      expect(svar.status).toBe(200);
      expect(handler.anrop).toHaveLength(1);
      expect(handler.anrop[0]?.method).toBe(method);
    });

    it.each(SKRIVANDE)('%s utan skyddshuvud ⇒ 403', async (method) => {
      const { port, handler } = await starta();

      forvantaNeka(await skriv(port, method, { headers: { Origin: BYGG_ORIGIN } }), 403, handler);
    });

    it.each(SKRIVANDE)('%s med tomt skyddshuvud ⇒ 403', async (method) => {
      const { port, handler } = await starta();

      forvantaNeka(await skriv(port, method, { headers: { [CSRF_HEADER]: '', Origin: BYGG_ORIGIN } }), 403, handler);
    });

    it.each(SKRIVANDE)('%s utan Origin ⇒ 403 (i appar godtas det; här inte)', async (method) => {
      const { port, handler } = await starta();

      forvantaNeka(await skriv(port, method, { headers: { [CSRF_HEADER]: '1' } }), 403, handler);
    });

    const felaktigaOrigins: ReadonlyArray<[string, string]> = [
      ['en publicerad app', `https://${skapaAppId('csrf-app')}.${DOMAN}`],
      ['en förhandsvisning', `https://p-${skapaAppId('csrf-utkast')}.${DOMAN}`],
      ['Origin: null (sandlådad ram, data:-adress)', 'null'],
      ['rätt värd, fel schema', `http://${BYGG}`],
      ['rätt värd, med port', `${BYGG_ORIGIN}:443`],
      ['rätt värd, annan port', `${BYGG_ORIGIN}:8443`],
      ['versaler', `https://BYGG.${DOMAN}`],
      ['avslutande snedstreck', `${BYGG_ORIGIN}/`],
      ['apex', `https://${DOMAN}`],
      ['byggverktyget som underdomän till en annan', `https://${BYGG}.evil.test`],
      ['tomt', ''],
    ];

    it.each(felaktigaOrigins)('Origin från %s ⇒ 403', async (_beskrivning, origin) => {
      const { port, handler } = await starta();

      for (const method of SKRIVANDE) {
        forvantaNeka(await skriv(port, method, { headers: { [CSRF_HEADER]: '1', Origin: origin } }), 403, handler);
      }
    });

    it('rätt värd men fel port när originen har port ⇒ 403', async () => {
      const { port, handler } = await starta({ origin: 'http://bygg.example.org:8787' });

      for (const origin of ['http://bygg.example.org:8788', 'http://bygg.example.org', 'https://bygg.example.org:8787']) {
        const svar = await skriv(port, 'POST', { host: `${BYGG}:8787`, headers: { [CSRF_HEADER]: '1', Origin: origin } });
        expect(svar.status).toBe(403);
      }
      expect(handler.anrop).toHaveLength(0);
      const ratt = await skriv(port, 'POST', {
        host: `${BYGG}:8787`,
        headers: { [CSRF_HEADER]: '1', Origin: 'http://bygg.example.org:8787' },
      });
      expect(ratt.status).toBe(200);
    });

    it('dubbla Origin-huvuden ⇒ 400, även om ett av dem är rätt', async () => {
      const { port, handler } = await starta();

      forvantaNeka(
        await skriv(port, 'POST', { headers: { [CSRF_HEADER]: '1', Origin: [BYGG_ORIGIN, BYGG_ORIGIN] } }),
        400,
        handler,
      );
    });

    it('GET och HEAD kräver varken skyddshuvud eller Origin', async () => {
      const { port, handler } = await starta();

      expect((await anropa({ port, host: BYGG, path: '/_api/builder/me' })).status).toBe(200);
      expect((await anropa({ port, host: BYGG, method: 'HEAD', path: '/' })).status).toBe(200);
      expect(handler.anrop.map((a) => a.method)).toEqual(['GET', 'HEAD']);
    });

    it('HEAD får ingen kropp', async () => {
      const { port } = await starta();

      const svar = await anropa({ port, host: BYGG, method: 'HEAD', path: '/' });

      expect(svar.kropp).toBe('');
    });
  });

  // ── Förfrågan till handlern ───────────────────────────────────────────────────

  describe('det handlern får', () => {
    it('normaliserad sökväg, tolkad fråga, identitet och kropp', async () => {
      const identitet = skapaIdentitet({ userId: 'byggaren' });
      const { port, handler } = await starta({ leverantor: skapaGodkannandeIdentityProvider(identitet) });

      await skriv(port, 'POST', { path: '/_api/builder/apps/%61bc/messages?after=3&x=%C3%A5' });

      const anrop = handler.anrop[0];
      expect(anrop?.path).toBe('/_api/builder/apps/abc/messages');
      expect({ ...anrop?.query }).toEqual({ after: '3', x: 'å' });
      expect(anrop?.identity).toEqual(identitet);
      expect(new TextDecoder().decode(anrop?.body)).toBe(JSON.stringify({ name: 'Todo' }));
      expect(anrop?.headers['content-type']).toBe('application/json');
    });

    it('frågan saknar prototyp: __proto__ är bara ett namn', async () => {
      const { port, handler } = await starta();

      await anropa({ port, host: BYGG, path: '/?__proto__=x&constructor=y' });

      const query = handler.anrop[0]?.query;
      expect(Object.getPrototypeOf(query)).toBeNull();
      expect(query?.['__proto__']).toBe('x');
    });

    it('kakor och Authorization lämnas aldrig vidare till handlern', async () => {
      const { port, handler } = await starta();

      await anropa({
        port,
        host: BYGG,
        path: '/',
        headers: { Cookie: 'sessionen=hemlig', Authorization: 'Test hemlig', 'Proxy-Authorization': 'x' },
      });

      const huvuden = handler.anrop[0]?.headers ?? {};
      expect(huvuden.cookie).toBeUndefined();
      expect(huvuden.authorization).toBeUndefined();
      expect(huvuden['proxy-authorization']).toBeUndefined();
      expect(JSON.stringify(handler.anrop)).not.toContain('hemlig');
    });

    it('GET får ingen kropp', async () => {
      const { port, handler } = await starta();

      await anropa({ port, host: BYGG, path: '/', body: 'smuggel' });

      expect(handler.anrop[0]?.body).toBeUndefined();
    });

    it('dubbla frågeparametrar ⇒ 400 före handlern', async () => {
      const { port, handler } = await starta();

      forvantaNeka(await anropa({ port, host: BYGG, path: '/_api/builder/jobs/j1?after=1&after=2' }), 400, handler);
      forvantaNeka(await skriv(port, 'POST', { path: '/_api/builder/apps?a=1&a=1' }), 400, handler);
    });

    it.each(['/../etc/passwd', '/a//b', '/%2e%2e/x', '/a%2Fb', '/a%5Cb', '/.env', '/%00'])(
      'ogiltig sökväg %s ⇒ 400 före handlern',
      async (path) => {
        const { port, handler } = await starta();

        forvantaNeka(await anropa({ port, host: BYGG, path }), 400, handler);
      },
    );

    it('en kropp över gränsen ⇒ 413 och handlern nås aldrig', async () => {
      const { port, handler } = await starta();

      const svar = await skriv(port, 'POST', { json: undefined, body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) });

      forvantaNeka(svar, 413, handler);
    });

    it('en kropp exakt på gränsen går fram', async () => {
      const { port, handler } = await starta();

      const svar = await skriv(port, 'POST', { json: undefined, body: 'x'.repeat(MAX_REQUEST_BODY_BYTES) });

      expect(svar.status).toBe(200);
      expect(handler.anrop[0]?.body?.byteLength).toBe(MAX_REQUEST_BODY_BYTES);
    });

    // CONNECT fångas av Node själv (händelsen `connect`) och når aldrig en förfrågningshanterare.
    it('OPTIONS och andra metoder ⇒ 405 före handlern', async () => {
      const { port, handler } = await starta();

      for (const method of ['OPTIONS', 'TRACE', 'PATCH', 'PROPFIND']) {
        const svar = await anropa({ port, host: BYGG, method, path: '/' });
        expect(svar.status).toBe(405);
      }
      expect(handler.anrop).toHaveLength(0);
    });

    it('Service-Worker-huvudet ⇒ 403 före handlern', async () => {
      const { port, handler } = await starta();

      forvantaNeka(await anropa({ port, host: BYGG, path: '/sw.js', headers: { 'Service-Worker': 'script' } }), 403, handler);
    });
  });

  // ── Svaret från handlern ──────────────────────────────────────────────────────

  describe('handlerns svar', () => {
    it('Content-Type släpps igenom', async () => {
      const { port } = await starta({
        svar: () => ({ status: 201, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"appId":"a"}' }),
      });

      const svar = await skriv(port, 'POST');

      expect(svar.status).toBe(201);
      expect(enHuvud(svar, 'Content-Type')).toBe('application/json; charset=utf-8');
      expect(json(svar)).toEqual({ appId: 'a' });
    });

    it('en binär kropp skickas byte för byte med rätt längd', async () => {
      const bytes = new Uint8Array([0x3c, 0x62, 0x3e, 0xc3, 0xa5]);
      const { port } = await starta({ svar: () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: bytes }) });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.kropp).toBe('<b>å');
      expect(enHuvud(svar, 'Content-Length')).toBe('5');
    });

    it('en kropp utan Content-Type blir ren text — webbläsaren får aldrig gissa', async () => {
      const { port } = await starta({ svar: () => ({ status: 200, headers: {}, body: '<script>1</script>' }) });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(enHuvud(svar, 'Content-Type')).toBe('text/plain; charset=utf-8');
    });

    it('204 skickas utan kropp', async () => {
      const { port } = await starta({ svar: () => ({ status: 204, headers: {}, body: 'ska inte synas' }) });

      const svar = await skriv(port, 'DELETE');

      expect(svar.status).toBe(204);
      expect(svar.kropp).toBe('');
    });

    const FARLIGA: Readonly<Record<string, string>> = {
      'Set-Cookie': 'kapad=1; Domain=example.org; Path=/',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': CSRF_HEADER,
      'Content-Security-Policy': "default-src *; frame-ancestors *",
      'Content-Security-Policy-Report-Only': "default-src 'none'",
      'X-Content-Type-Options': 'sniff',
      'Referrer-Policy': 'unsafe-url',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=31536000',
      'X-Frame-Options': 'ALLOWALL',
      Location: 'https://evil.test/',
      Refresh: '0; url=https://evil.test/',
      Link: '<https://evil.test/>; rel=preload',
      'Clear-Site-Data': '"*"',
      'Content-Type': 'text/html; charset=utf-8',
    };

    it('bara Content-Type släpps igenom; skyddshuvudena vinner och förekommer en gång', async () => {
      const { port } = await starta({ svar: () => ({ status: 200, headers: FARLIGA, body: 'hej' }) });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(200);
      expect(enHuvud(svar, 'Content-Type')).toBe('text/html; charset=utf-8');
      expect(enHuvud(svar, 'Content-Security-Policy')).toBe(FORVANTAD_CSP);
      expect(enHuvud(svar, 'X-Content-Type-Options')).toBe('nosniff');
      expect(enHuvud(svar, 'Referrer-Policy')).toBe('same-origin');
      expect(enHuvud(svar, 'Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(enHuvud(svar, 'Cache-Control')).toBe('no-store');
      for (const namn of [
        'Set-Cookie',
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Credentials',
        'Access-Control-Allow-Headers',
        'Content-Security-Policy-Report-Only',
        'X-Frame-Options',
        'Location',
        'Refresh',
        'Link',
        'Clear-Site-Data',
      ]) {
        expect(allaHuvuden(svar, namn), namn).toEqual([]);
      }
    });

    it('samma huvud under två skrivsätt ⇒ 500, hellre än att välja ett', async () => {
      const { port } = await starta({
        svar: () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'content-type': 'text/plain' }, body: 'x' }),
      });

      expect((await anropa({ port, host: BYGG, path: '/' })).status).toBe(500);
    });

    it.each([
      ['radbrytning', 'text/html\r\nSet-Cookie: kapad=1'],
      ['bara radmatning', 'text/html\nX: 1'],
      ['NUL', `text/html${String.fromCharCode(0)}`],
      ['tom', ''],
      ['inte en typ', 'html'],
      ['icke-ASCII', 'text/html; charset=utf-8å'],
    ])('Content-Type med %s ⇒ 500 utan att något av det syns', async (_beskrivning, contentType) => {
      const { port } = await starta({ svar: () => ({ status: 200, headers: { 'Content-Type': contentType }, body: 'x' }) });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(500);
      expect(allaHuvuden(svar, 'Set-Cookie')).toEqual([]);
      expect(enHuvud(svar, 'Content-Type')).toBe('application/json; charset=utf-8');
    });

    const TILLATNA = [200, 201, 202, 204, 400, 401, 403, 404, 405, 409, 413, 429, 500, 501, 503];

    it.each(TILLATNA)('status %i släpps igenom', async (status) => {
      const { port } = await starta({ svar: () => ({ status, headers: {} }) });

      expect((await anropa({ port, host: BYGG, path: '/' })).status).toBe(status);
    });

    it.each([100, 101, 199, 203, 206, 301, 302, 303, 304, 307, 308, 402, 418, 451, 502, 504, 599, 0, -1, 200.5, 1000])(
      'status %s ⇒ 500',
      async (status) => {
        const { port } = await starta({ svar: () => ({ status, headers: { Location: '/x' } }) });

        const svar = await anropa({ port, host: BYGG, path: '/' });

        expect(svar.status).toBe(500);
        expect(allaHuvuden(svar, 'Location')).toEqual([]);
      },
    );

    it.each([
      ['null', null],
      ['en sträng', '200'],
      ['status som sträng', { status: '200', headers: {} }],
      ['utan huvuden', { status: 200 }],
      ['huvuden som lista', { status: 200, headers: [['Content-Type', 'text/html']] }],
      ['huvudvärde som lista', { status: 200, headers: { 'Content-Type': ['text/html'] } }],
      ['kropp som objekt', { status: 200, headers: {}, body: { hemligt: 1 } }],
      ['kropp som tal', { status: 200, headers: {}, body: 42 }],
    ])('ett svar som inte följer kontraktet (%s) ⇒ 500', async (_beskrivning, felaktigt) => {
      const { port, poster } = await starta({ svar: () => felaktigt });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(500);
      expect(json<ApiErrorBody>(svar).error.code).toBe('internal');
      expect(svar.kropp).not.toContain('hemligt');
      expect(poster.some((p) => p.level === 'error')).toBe(true);
    });

    it('en kastande handler ⇒ 500 med fast klarspråk; felets text når varken svar eller logg', async () => {
      const { port, poster } = await starta({
        svar: () => {
          throw new Error('SQLITE_ERROR hemlig-rad anna@example.org');
        },
      });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(500);
      const kropp = json<ApiErrorBody>(svar);
      expect(kropp.error.code).toBe('internal');
      expect(kropp.error.message.length).toBeGreaterThan(0);
      expect(JSON.stringify(svar)).not.toContain('hemlig');
      expect(JSON.stringify(poster)).not.toContain('hemlig');
      expect(JSON.stringify(poster)).not.toContain('anna@');
      const fel = poster.find((p) => p.level === 'error' && p.event === 'internal_error');
      expect(fel?.errorName).toBe('Error');
      expect(enHuvud(svar, 'Content-Security-Policy')).toBe(FORVANTAD_CSP);
    });

    it('ett kastat DataApiError med "användarvänlig" text blir också 500 — handlern äger inte felsvaren', async () => {
      const { port } = await starta({
        svar: () => {
          throw new DataApiError('not_found', 'hemlig-text');
        },
      });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(API_ERROR_STATUS.internal);
      expect(svar.kropp).not.toContain('hemlig');
    });

    it('ett avvisat löfte från handlern ⇒ 500', async () => {
      const { port } = await starta({ svar: () => Promise.reject(new Error('hemligt')) });

      const svar = await anropa({ port, host: BYGG, path: '/' });

      expect(svar.status).toBe(500);
      expect(svar.kropp).not.toContain('hemligt');
    });
  });

  // ── Isolering mellan värdsorter ───────────────────────────────────────────────

  describe('app och byggverktyg når aldrig varandras hanterare', () => {
    it('en app- eller förhandsvisningsvärd når aldrig byggverktygets handler, inte ens under /_api/builder', async () => {
      const { port, handler, uppsattning } = await starta();
      const appId = skapaAppId('isolering-bygg');
      uppsattning.register.registrera(appId, { published: true, draft: true });
      uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<h1>app</h1>'));
      uppsattning.filer.satt(appId, 'draft', '/index.html', textfil('<h1>utkast</h1>'));

      for (const host of [`${appId}.${DOMAN}`, `p-${appId}.${DOMAN}`]) {
        for (const path of ['/', '/_api/builder/me', '/_api/builder/apps']) {
          await anropa({ port, host, path });
        }
        await anropa({
          port,
          host,
          method: 'POST',
          path: '/_api/builder/apps',
          headers: { [CSRF_HEADER]: '1', Origin: BYGG_ORIGIN },
          json: {},
        });
      }

      expect(handler.anrop).toHaveLength(0);
    });

    it('byggverktygets värd når aldrig register, filer eller lagring', async () => {
      const { port, uppsattning } = await starta();

      await anropa({ port, host: BYGG, path: '/' });
      await anropa({ port, host: BYGG, path: '/_api/whoami' });
      await anropa({ port, host: BYGG, path: '/_api/collections/poster/docs' });
      await skriv(port, 'POST', { path: '/_api/collections/poster/docs' });

      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });
  });

  // ── Loggen ────────────────────────────────────────────────────────────────────

  describe('loggen', () => {
    it('ruttsort builder; aldrig sökväg, fråga eller kropp', async () => {
      const { port, poster } = await starta();

      await skriv(port, 'POST', {
        path: '/_api/builder/apps/hemligsokvag?q=hemligfraga',
        json: { name: 'hemligkropp' },
      });

      const post = poster.find((p) => p.event === 'request');
      expect(post?.route).toBe('builder');
      expect(post?.status).toBe(200);
      expect(post?.method).toBe('POST');
      expect(post?.appIdPrefix).toBeUndefined();
      const allt = JSON.stringify(poster);
      expect(allt).not.toContain('hemligsokvag');
      expect(allt).not.toContain('hemligfraga');
      expect(allt).not.toContain('hemligkropp');
    });
  });
});
