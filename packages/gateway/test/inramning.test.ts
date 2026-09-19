/**
 * Inramning: vem får visa en värd i en `<iframe>`?
 *
 *   Givet att byggverktyget visar ett utkast i en ram
 *   När förhandsvisningen svarar
 *   Så får den ramas in av byggverktyget — och av ingen annan
 *
 *   Givet en publicerad app
 *   När den svarar
 *   Så får den inte ramas in alls (tills plattformens skal finns)
 *
 *   Givet byggverktyget självt
 *   När det svarar
 *   Så får det inte ramas in alls — annars kan en app lägga det i en osynlig ram och lura
 *   användaren att klicka ("clickjacking")
 *
 * `frame-ancestors` gäller oavsett status, så varje prov görs även på felsvar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { builderContentSecurityPolicy } from '@vibesandbox/contracts';
import { createGateway, handleClientError, RECOMMENDED_SERVER_OPTIONS } from '../src/index.ts';
import { SECURITY_HEADERS } from '../src/huvuden.ts';
import { anropa, anropaRatt, enHuvud, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import { cspDirektiv, forvantaAppensCsp, INGEN_INRAMNING } from './csp.ts';
import {
  skapaAppId,
  skapaFejkadBuilderHandler,
  skapaGodkannandeIdentityProvider,
  skapaNekandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
} from './fejkar.ts';
import type { FejkadIdentityProvider } from './fejkar.ts';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

const DOMAN = 'example.org';
const BYGG_ORIGIN = 'https://bygg.example.org';

describe('inramning per värdsort', () => {
  let server: Testserver | undefined;
  let nodeServer: Server | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
    const stangs = nodeServer;
    nodeServer = undefined;
    if (stangs) {
      stangs.closeAllConnections();
      await new Promise<void>((resolve) => stangs.close(() => resolve()));
    }
  });

  async function starta(options: { medByggverktyg: boolean; leverantor?: FejkadIdentityProvider }) {
    const appId = skapaAppId(`inramning-${Math.random()}`);
    const uppsattning = skapaTestUppsattning({
      appDomain: DOMAN,
      previewDomain: DOMAN,
      identityProvider: options.leverantor ?? skapaGodkannandeIdentityProvider(),
      ...(options.medByggverktyg ? { builder: { handler: skapaFejkadBuilderHandler(), origin: BYGG_ORIGIN } } : {}),
    });
    uppsattning.register.registrera(appId, { published: true, draft: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<h1>publicerad</h1>'));
    uppsattning.filer.satt(appId, 'draft', '/index.html', textfil('<h1>utkast</h1>'));
    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, appId };
  }

  describe('förhandsvisning (p-<id>)', () => {
    it('får ramas in av byggverktygets exakta origin — på 200', async () => {
      const { port, appId } = await starta({ medByggverktyg: true });

      const svar = await anropa({ port, host: `p-${appId}.${DOMAN}`, path: '/' });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toContain('utkast');
      forvantaAppensCsp(svar, BYGG_ORIGIN);
    });

    it('får ramas in av byggverktyget även på 401 och 404', async () => {
      const nekad = await starta({ medByggverktyg: true, leverantor: skapaNekandeIdentityProvider() });
      const svar401 = await anropa({ port: nekad.port, host: `p-${nekad.appId}.${DOMAN}`, path: '/' });
      expect(svar401.status).toBe(401);
      forvantaAppensCsp(svar401, BYGG_ORIGIN);
      await server?.stang();
      server = undefined;

      const { port } = await starta({ medByggverktyg: true });
      const svar404 = await anropa({ port, host: `p-${skapaAppId('inramning-finns-inte')}.${DOMAN}`, path: '/' });
      expect(svar404.status).toBe(404);
      forvantaAppensCsp(svar404, BYGG_ORIGIN);
    });

    it('utan byggverktyg får den inte ramas in av någon', async () => {
      const { port, appId } = await starta({ medByggverktyg: false });

      const svar = await anropa({ port, host: `p-${appId}.${DOMAN}`, path: '/' });

      expect(svar.status).toBe(200);
      forvantaAppensCsp(svar, INGEN_INRAMNING);
    });

    it('en port i Host ändrar inte vem som får rama in', async () => {
      const { port, appId } = await starta({ medByggverktyg: true });

      const svar = await anropa({ port, host: `p-${appId}.${DOMAN}:4443`, path: '/' });

      forvantaAppensCsp(svar, BYGG_ORIGIN);
    });
  });

  describe('publicerad app', () => {
    it("får inte ramas in av någon, inte ens av byggverktyget", async () => {
      const { port, appId } = await starta({ medByggverktyg: true });

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/' });

      expect(svar.status).toBe(200);
      expect(svar.kropp).toContain('publicerad');
      forvantaAppensCsp(svar, INGEN_INRAMNING);
    });

    it('inte heller på 401', async () => {
      const { port, appId } = await starta({ medByggverktyg: true, leverantor: skapaNekandeIdentityProvider() });

      const svar = await anropa({ port, host: `${appId}.${DOMAN}`, path: '/' });

      expect(svar.status).toBe(401);
      forvantaAppensCsp(svar, INGEN_INRAMNING);
    });
  });

  describe('okänd eller ogiltig värd', () => {
    it.each([
      ['ogiltigt värdnamn', 'x.annan.test'],
      ['byggverktygets värd med versaler', 'BYGG.example.org'],
      ['förhandsvisning av något som inte är ett app-id', 'p-bygg.example.org'],
    ])('%s ⇒ inte inramningsbar', async (_beskrivning, host) => {
      const { port } = await starta({ medByggverktyg: true });

      const svar = await anropa({ port, host, path: '/' });

      expect(svar.status).toBe(400);
      forvantaAppensCsp(svar, INGEN_INRAMNING);
    });

    it('svaret på en förfrågan som Node själv vägrade (clientError) är inte inramningsbart', async () => {
      const uppsattning = skapaTestUppsattning({ appDomain: DOMAN, previewDomain: DOMAN });
      const s = createServer(RECOMMENDED_SERVER_OPTIONS, createGateway(uppsattning.options));
      s.on('clientError', handleClientError);
      nodeServer = s;
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
      const adress = s.address();
      if (adress === null || typeof adress === 'string') throw new Error('ingen port');

      const svar = await anropaRatt({
        port: adress.port,
        requestrad: 'DETTA ÄR INTE HTTP',
        huvuden: ['Host: x.example.org', 'Connection: close'],
      });

      expect(svar.status).toBe(400);
      forvantaAppensCsp(svar, INGEN_INRAMNING);
    });

    it('standardlistan med skyddsregler förbjuder inramning', () => {
      const csp = SECURITY_HEADERS.find(([namn]) => namn === 'Content-Security-Policy')?.[1] ?? '';
      expect(cspDirektiv(csp)).toContain("frame-ancestors 'none'");
    });
  });

  describe('byggverktyget', () => {
    it("bär sin egen CSP med frame-ancestors 'none' — aldrig appens", async () => {
      const { port } = await starta({ medByggverktyg: true });

      const svar = await anropa({ port, host: `bygg.${DOMAN}`, path: '/' });

      expect(svar.status).toBe(200);
      const csp = enHuvud(svar, 'Content-Security-Policy');
      expect(csp).toBe(builderContentSecurityPolicy(`https://*.${DOMAN}`));
      expect(cspDirektiv(csp ?? '')).toContain("frame-ancestors 'none'");
    });
  });
});
