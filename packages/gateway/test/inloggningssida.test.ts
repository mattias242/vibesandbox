/**
 * Oinloggad webbläsare → inloggningssidan.
 *
 *   Givet att en vän öppnar en delad länk utan att vara inloggad
 *   När webbläsaren navigerar till appen
 *   Så skickas hen till inloggningssidan på SAMMA värd, och kommer tillbaka dit hen skulle efteråt
 *
 *   Givet ett API-anrop (fetch) utan inloggning
 *   När det når gatewayn
 *   Så blir svaret 401 som förut — ett skript ska inte få en HTML-sida som svar
 *
 *   Givet en angripare som hittar på en adress
 *   När omdirigeringen byggs
 *   Så kan `next` aldrig peka på en annan värd, och inloggningssidan kan aldrig skicka till sig själv
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, Identity, IdentityProvider } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, anropaRatt, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { AnropSvar, Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaFejkadAuthRouteProvider,
  skapaFejkadBuilderHandler,
  skapaFejkadIdentityProvider,
  skapaTestUppsattning,
  textfil,
} from './fejkar.ts';
import type { FejkadBuilderHandler, FejkadIdentityProvider, TestUppsattning } from './fejkar.ts';

const DOMAN = 'example.org';
const INLOGGNING = '/_auth/login';
const NAVIGERING = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } as const;

function medInloggningssida(
  leverantor: FejkadIdentityProvider,
  loginPath: string = INLOGGNING,
): FejkadIdentityProvider & { readonly loginPath: string } {
  return { ...leverantor, loginPath };
}

function nekande(): FejkadIdentityProvider {
  return skapaFejkadIdentityProvider(() => null);
}

/** `next` ur en `Location`, avkodad — det webbläsaren sedan skickas vidare till. */
function nextUr(svar: AnropSvar): string {
  const location = enHuvud(svar, 'Location') ?? '';
  expect(location.startsWith(`${INLOGGNING}?next=`)).toBe(true);
  const next = new URL(location, 'https://offer.example.org').searchParams.get('next');
  expect(next).not.toBeNull();
  return next ?? '';
}

/** Hur en webbläsare tolkar `next` på värden: måste bli samma origin. */
function forvantaSammaVard(next: string): void {
  expect(next.startsWith('/')).toBe(true);
  expect(next.startsWith('//')).toBe(false);
  expect(next).not.toContain('\\');
  for (let i = 0; i < next.length; i += 1) expect(next.charCodeAt(i)).toBeGreaterThan(0x20);
  expect(new URL(next, 'https://offer.example.org').origin).toBe('https://offer.example.org');
}

describe('omdirigering till inloggningssidan', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  interface Startad {
    readonly port: number;
    readonly appId: string;
    readonly uppsattning: TestUppsattning;
    readonly handler: FejkadBuilderHandler;
  }

  async function starta(leverantor: IdentityProvider = medInloggningssida(nekande())): Promise<Startad> {
    const appId = skapaAppId(`inloggningssida-${Math.random()}`);
    const handler = skapaFejkadBuilderHandler();
    const uppsattning = skapaTestUppsattning({
      appDomain: DOMAN,
      previewDomain: DOMAN,
      identityProvider: leverantor,
      builder: { handler, origin: `https://bygg.${DOMAN}` },
    });
    uppsattning.register.registrera(appId, { published: true, draft: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<h1>hemlig app</h1>'));
    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, appId, uppsattning, handler };
  }

  describe('sidnavigering ⇒ 303', () => {
    it('till startsidan: next=/', async () => {
      const { port, appId, uppsattning } = await starta();

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(303);
      expect(enHuvud(svar, 'Location')).toBe(`${INLOGGNING}?next=%2F`);
      expect(svar.kropp).not.toContain('hemlig app');
      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
      expect(enHuvud(svar, 'Cache-Control')).toBe('no-store');
    });

    it('djup sökväg och fråga följer med, URL-kodade', async () => {
      const { port, appId } = await starta();

      const svar = await anropa({
        port,
        host: `${appId}.${DOMAN}`,
        path: '/listor/handla?flik=2&sok=mj%C3%B6lk',
        headers: NAVIGERING,
      });

      expect(svar.status).toBe(303);
      expect(enHuvud(svar, 'Location')).toBe(
        `${INLOGGNING}?next=${encodeURIComponent('/listor/handla?flik=2&sok=mj%C3%B6lk')}`,
      );
      expect(nextUr(svar)).toBe('/listor/handla?flik=2&sok=mj%C3%B6lk');
    });

    it('å, ä, ö i sökvägen kodas', async () => {
      const { port, appId } = await starta();

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/f%C3%B6rr%C3%A5d', headers: NAVIGERING });

      expect(nextUr(svar)).toBe('/f%C3%B6rr%C3%A5d');
      expect(/^[\x21-\x7e]+$/.test(enHuvud(svar, 'Location') ?? '')).toBe(true);
    });

    it('utan Sec-Fetch räcker Accept med text/html', async () => {
      const { port, appId } = await starta();

      const svar = await anropa({
        port,
        host: `${appId}.${DOMAN}`,
        path: '/',
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      });

      expect(svar.status).toBe(303);
    });

    it('HEAD som navigering ⇒ 303', async () => {
      const { port, appId } = await starta();

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, method: 'HEAD', path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(303);
    });

    it('på en förhandsvisning', async () => {
      const { port, appId } = await starta();

      const svar = await anropa({ port, host: `p-${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(303);
      expect(enHuvud(svar, 'Location')).toBe(`${INLOGGNING}?next=%2F`);
    });

    it('på byggverktyget — handlern nås aldrig', async () => {
      const { port, handler } = await starta();

      const svar = await anropa({ port, host: `bygg.${DOMAN}`, path: '/appar/1', headers: NAVIGERING });

      expect(svar.status).toBe(303);
      expect(nextUr(svar)).toBe('/appar/1');
      expect(handler.anrop).toHaveLength(0);
    });

    it('röjer inte om appen finns: okänt app-id ger exakt samma svar', async () => {
      const { port, appId, uppsattning } = await starta();

      const finns = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });
      const finnsInte = await anropa({ port, host: `${skapaAppId('finns-inte')}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(finnsInte.status).toBe(finns.status);
      expect(enHuvud(finnsInte, 'Location')).toBe(enHuvud(finns, 'Location'));
      expect(finnsInte.kropp).toBe(finns.kropp);
      expect(uppsattning.register.anrop).toHaveLength(0);
    });
  });

  describe('allt annat ⇒ 401 som förut', () => {
    const fall: ReadonlyArray<[string, string, string, Readonly<Record<string, string>>]> = [
      ['fetch (Sec-Fetch-Mode: cors) även med Accept text/html', 'GET', '/', { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' }],
      ['no-cors', 'GET', '/', { 'Sec-Fetch-Mode': 'no-cors', Accept: 'text/html' }],
      ['same-origin', 'GET', '/', { 'Sec-Fetch-Mode': 'same-origin', Accept: 'text/html' }],
      ['utan Sec-Fetch och utan Accept', 'GET', '/', {}],
      ['utan Sec-Fetch, Accept JSON', 'GET', '/', { Accept: 'application/json' }],
      ['utan Sec-Fetch, Accept */*', 'GET', '/', { Accept: '*/*' }],
      ['API-anrop som ser ut som navigering', 'GET', '/_api/whoami', NAVIGERING],
      ['API-anrop med Accept text/html', 'GET', '/_api/collections/x/docs', { Accept: 'text/html' }],
      ['API med kodat prefix', 'GET', '/%5Fapi/whoami', NAVIGERING],
      ['POST som navigering (formulär)', 'POST', '/', NAVIGERING],
      ['PUT', 'PUT', '/', NAVIGERING],
      ['DELETE', 'DELETE', '/', NAVIGERING],
      ['Sec-Fetch-Mode med versaler', 'GET', '/', { 'Sec-Fetch-Mode': 'Navigate' }],
    ];

    it.each(fall)('%s', async (_beskrivning, method, path, headers) => {
      const { port, appId } = await starta();

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, method, path, headers });

      expect(svar.status).toBe(401);
      expect(enHuvud(svar, 'Location')).toBeUndefined();
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
    });

    it('byggverktygets API ⇒ 401 även som navigering', async () => {
      const { port, handler } = await starta();

      const svar = await anropa({ port, host: `bygg.${DOMAN}`, path: '/_api/builder/me', headers: NAVIGERING });

      expect(svar.status).toBe(401);
      expect(handler.anrop).toHaveLength(0);
    });

    it('en skrivande navigering på byggverktyget ⇒ 401 (inloggning före CSRF), aldrig 303', async () => {
      const { port, handler } = await starta();

      const svar = await anropa({
        port,
        host: `bygg.${DOMAN}`,
        method: 'POST',
        path: '/',
        headers: { ...NAVIGERING, [CSRF_HEADER]: '1', Origin: `https://bygg.${DOMAN}` },
      });

      expect(svar.status).toBe(401);
      expect(handler.anrop).toHaveLength(0);
    });

    it('leverantör utan loginPath ⇒ 401 som i dag', async () => {
      const { port, appId } = await starta(nekande());

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(401);
      expect(enHuvud(svar, 'Location')).toBeUndefined();
    });

    it('leverantören kraschar ⇒ 401, ingen omdirigering', async () => {
      const kraschar = medInloggningssida(
        skapaFejkadIdentityProvider(() => {
          throw new Error('trasig');
        }),
      );
      const { port, appId } = await starta(kraschar);

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(401);
    });

    it('en inloggad navigering omdirigeras inte', async () => {
      const identitet: Identity = { userId: 'u1', email: 'u1@example.org', roles: ['viewer'] };
      const leverantor = medInloggningssida(skapaFejkadIdentityProvider(() => identitet));
      const { port, appId, uppsattning } = await starta(leverantor);
      uppsattning.register.bevilja(appId, identitet.userId, 'owner');

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/', headers: NAVIGERING });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toContain('hemlig app');
    });
  });

  describe('next pekar aldrig på en annan värd', () => {
    const fientliga = [
      '//evil.test',
      '//evil.test/',
      '/\\evil.test',
      '/%2Fevil.test',
      '/%2F%2Fevil.test',
      '/%5Cevil.test',
      '/%5C%5Cevil.test',
      '/%252F%252Fevil.test',
      '/%09/evil.test',
      '/%0A/evil.test',
      '/%0D%0ALocation:%20https://evil.test',
      '/.%2F/evil.test',
      '/a/..//evil.test',
      '///evil.test',
      '/?next=//evil.test',
      '/?//evil.test',
      '/x?a=%0D%0ASet-Cookie:%20x=1',
      '/x?a=\\\\evil.test',
      '/@evil.test',
      '/https:%2F%2Fevil.test',
    ];

    it.each(fientliga)('%s ⇒ antingen 401 eller en relativ sökväg på samma värd', async (path) => {
      const { port, appId } = await starta();

      const svar = await anropaRatt({
        port,
        requestrad: `GET ${path} HTTP/1.1`,
        huvuden: [`Host: ${appId}.${DOMAN}`, 'Sec-Fetch-Mode: navigate', 'Connection: close'],
      });

      expect([303, 400, 401]).toContain(svar.status);
      if (svar.status === 303) {
        const location = enHuvud(svar, 'Location') ?? '';
        expect(location.startsWith(`${INLOGGNING}?next=`)).toBe(true);
        expect(/^[\x21-\x7e]+$/.test(location)).toBe(true);
        forvantaSammaVard(nextUr(svar));
      }
      expect(svar.huvuden['set-cookie']).toBeUndefined();
    });
  });

  describe('ingen slinga', () => {
    it('inloggningssidan själv omdirigeras aldrig, inte ens när leverantören saknar rutten', async () => {
      const { port, appId } = await starta();

      for (const path of [INLOGGNING, `${INLOGGNING}?next=%2F`, '/_auth/annat', '/%5Fauth/login']) {
        const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path, headers: NAVIGERING });
        expect(svar.status, path).not.toBe(303);
      }
    });

    it('leverantör med rutten som svarar null ⇒ 404, inte 303', async () => {
      const leverantor = medInloggningssida(skapaFejkadAuthRouteProvider(() => null));
      const { port, appId } = await starta(leverantor);

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: INLOGGNING, headers: NAVIGERING });

      expect(svar.status).toBe(404);
    });

    it('leverantörens egen sida visas när den finns', async () => {
      const leverantor = medInloggningssida(
        skapaFejkadAuthRouteProvider(() => ({
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: '<form>kod</form>',
        })),
      );
      const { port, appId } = await starta(leverantor);

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: `${INLOGGNING}?next=%2F`, headers: NAVIGERING });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toBe('<form>kod</form>');
    });
  });

  describe('loginPath valideras vid start', () => {
    it.each([
      '/login',
      '_auth/login',
      '//evil.test/_auth/login',
      'https://evil.test/_auth/login',
      '/_auth',
      '/_auth/',
      '/_auth/login?x=1',
      '/_auth/login#x',
      '/_auth/../login',
      '/_auth//login',
      '/_auth/lo gin',
      '/_auth/\\login',
      '/_AUTH/login',
      '',
    ])('"%s" ⇒ createGateway kastar', (loginPath) => {
      const uppsattning = skapaTestUppsattning({
        appDomain: DOMAN,
        previewDomain: DOMAN,
        identityProvider: medInloggningssida(nekande(), loginPath),
      });
      expect(() => createGateway(uppsattning.options)).toThrow(/loginPath/);
    });

    it.each(['/_auth/login', '/_auth/inloggning/kod'])('"%s" godtas', (loginPath) => {
      const uppsattning = skapaTestUppsattning({
        appDomain: DOMAN,
        previewDomain: DOMAN,
        identityProvider: medInloggningssida(nekande(), loginPath),
      });
      expect(() => createGateway(uppsattning.options)).not.toThrow();
    });
  });
});
