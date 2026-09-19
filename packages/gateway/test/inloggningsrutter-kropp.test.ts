/**
 * Inloggningsrutternas kropp, klientadress och statusar (kontraktet: `AuthRouteRequest.body`,
 * `AuthRequest.clientAddress`, `MAX_AUTH_BODY_BYTES`, `AUTH_ROUTE_STATUSES`).
 *
 *   Givet ett inloggningsformulär som skickas med POST
 *   När gatewayn tar emot det
 *   Så får leverantören kroppen rå — men aldrig mer än taket; en större kropp ger 413 och
 *   leverantören tillfrågas inte
 *
 *   Givet en klient som påstår sig ha en annan adress i X-Forwarded-For eller Forwarded
 *   När leverantören får klientens adress (för hastighetsbegränsning)
 *   Så är det TCP-anslutningens adress, aldrig huvudets
 *
 *   Givet en leverantör som själv nekar en POST utan rätt Origin
 *   När den svarar 403
 *   Så når 403 fram — det är ett medvetet nekande, inte ett kontraktsbrott
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_ROUTE_STATUSES, MAX_AUTH_BODY_BYTES } from '@vibesandbox/contracts';
import type { ApiErrorBody, AuthRouteRequest } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, anropaRatt, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaFejkadAuthRouteProvider,
  skapaFejkadIdentityProvider,
  skapaTestUppsattning,
  vardnamnForApp,
} from './fejkar.ts';
import type { FejkadIdentityProvider } from './fejkar.ts';

const OK = { status: 200, headers: {}, body: 'ok' };
const FORFALSKADE = {
  'X-Forwarded-For': '203.0.113.7',
  Forwarded: 'for=203.0.113.8',
  'X-Real-IP': '203.0.113.9',
  'CF-Connecting-IP': '203.0.113.10',
};

describe('inloggningsrutternas kropp, klientadress och statusar', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function starta(leverantor: FejkadIdentityProvider) {
    const uppsattning = skapaTestUppsattning({ identityProvider: leverantor });
    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, host: vardnamnForApp(skapaAppId('kropp')), uppsattning };
  }

  function sistaRutt(uppsattning: { identityProvider: FejkadIdentityProvider }): AuthRouteRequest | undefined {
    return uppsattning.identityProvider.authRouteAnrop.at(-1);
  }

  describe('kroppen', () => {
    it('POST ⇒ leverantören får kroppen rå, byte för byte', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));
      const formular = 'email=anna%40example.org&kod=123456';

      const svar = await anropa({
        port,
        host,
        method: 'POST',
        path: '/_auth/login',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formular,
      });

      expect(svar.status).toBe(200);
      const body = sistaRutt(uppsattning)?.body;
      expect(body).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(body)).toBe(formular);
    });

    it('UTF-8 och godtyckliga bytes tolkas inte om', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      await anropa({ port, host, method: 'POST', path: '/_auth/login', body: 'namn=Åsa' });

      expect(Buffer.from(sistaRutt(uppsattning)?.body ?? new Uint8Array()).toString('utf8')).toBe('namn=Åsa');
    });

    it('POST utan kropp ⇒ en tom kropp, inte ingen', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      await anropa({ port, host, method: 'POST', path: '/_auth/login', headers: { 'Content-Length': '0' } });

      expect(sistaRutt(uppsattning)?.body?.byteLength).toBe(0);
    });

    it('en kropp exakt på taket går fram', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      const svar = await anropa({ port, host, method: 'POST', path: '/_auth/login', body: 'x'.repeat(MAX_AUTH_BODY_BYTES) });

      expect(svar.status).toBe(200);
      expect(sistaRutt(uppsattning)?.body?.byteLength).toBe(MAX_AUTH_BODY_BYTES);
    });

    it('en kropp över taket ⇒ 413, och leverantören tillfrågas aldrig', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      const svar = await anropa({
        port,
        host,
        method: 'POST',
        path: '/_auth/login',
        body: 'x'.repeat(MAX_AUTH_BODY_BYTES + 1),
      });

      expect(svar.status).toBe(413);
      expect(json<ApiErrorBody>(svar).error.code).toBe('too_large');
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    });

    // Kroppen sparas aldrig; readBody läser och kastar i högst några sekunder så att klienten hinner
    // få 413 i stället för ett nätverksfel (kropp.ts). Därför den längre tidsgränsen.
    it('ett utlovat Content-Length över taket ⇒ 413 utan att något sparas eller når leverantören', { timeout: 15_000 }, async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      const svar = await anropaRatt({
        port,
        requestrad: 'POST /_auth/login HTTP/1.1',
        huvuden: [`Host: ${host}`, `Content-Length: ${MAX_AUTH_BODY_BYTES * 100}`, 'Connection: close'],
        kropp: 'x'.repeat(100),
        tidsgrans: 12_000,
      });

      expect(svar.status).toBe(413);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it('en chunkad kropp över taket ⇒ 413 (längden räknas, inte huvudet)', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));
      const bit = 'x'.repeat(MAX_AUTH_BODY_BYTES);
      const chunkad = `${bit.length.toString(16)}\r\n${bit}\r\n${bit.length.toString(16)}\r\n${bit}\r\n0\r\n\r\n`;

      const svar = await anropaRatt({
        port,
        requestrad: 'POST /_auth/login HTTP/1.1',
        huvuden: [`Host: ${host}`, 'Transfer-Encoding: chunked', 'Connection: close'],
        kropp: chunkad,
      });

      expect(svar.status).toBe(413);
      expect(uppsattning.identityProvider.authRouteAnrop).toHaveLength(0);
    });

    it('GET får ingen kropp, även om klienten skickar en', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      await anropa({ port, host, path: '/_auth/login', body: 'smuggel' });

      expect(sistaRutt(uppsattning)?.body).toBeUndefined();
    });

    it('en leverantör utan rutter ⇒ 404 utan att kroppen ens läses in till leverantören', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadIdentityProvider(() => null));

      const svar = await anropa({ port, host, method: 'POST', path: '/_auth/login', body: 'x' });

      expect(svar.status).toBe(404);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    });
  });

  describe('klientadressen', () => {
    it('inloggningsrutten får TCP-anslutningens adress — aldrig X-Forwarded-For eller Forwarded', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadAuthRouteProvider(() => OK));

      await anropa({ port, host, path: '/_auth/login', headers: FORFALSKADE });

      const rutt = sistaRutt(uppsattning);
      expect(rutt?.clientAddress).toMatch(/^(?:::ffff:)?127\.0\.0\.1$/);
      expect(JSON.stringify(rutt?.clientAddress)).not.toContain('203.0.113');
    });

    it('authenticate får samma adress, och ett förfalskat huvud ändrar den inte', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadIdentityProvider(() => null));

      await anropa({ port, host, path: '/_api/whoami' });
      await anropa({ port, host, path: '/_api/whoami', headers: FORFALSKADE });

      const [utan, med] = uppsattning.identityProvider.anrop;
      expect(utan?.clientAddress).toMatch(/^(?:::ffff:)?127\.0\.0\.1$/);
      expect(med?.clientAddress).toBe(utan?.clientAddress);
    });

    it('huvudena finns kvar i headers — det är bara clientAddress som aldrig läses ur dem', async () => {
      const { port, host, uppsattning } = await starta(skapaFejkadIdentityProvider(() => null));

      await anropa({ port, host, path: '/', headers: FORFALSKADE });

      const anrop = uppsattning.identityProvider.anrop[0];
      expect(anrop?.headers['x-forwarded-for']).toBe('203.0.113.7');
      expect(anrop?.clientAddress).not.toBe('203.0.113.7');
    });
  });

  describe('statusar ur kontraktet', () => {
    it('allowlisten är exakt kontraktets AUTH_ROUTE_STATUSES', () => {
      expect([...AUTH_ROUTE_STATUSES].sort((a, b) => a - b)).toEqual([200, 303, 400, 401, 403, 404, 405, 413, 429]);
    });

    it('en leverantör som nekar en POST utan rätt Origin med 403 ⇒ 403 når fram', async () => {
      const { port, host } = await starta(
        skapaFejkadAuthRouteProvider((request) =>
          request.headers.origin === `http://${host}`
            ? OK
            : { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Nekad.' },
        ),
      );

      const svar = await anropa({ port, host, method: 'POST', path: '/_auth/login', headers: { Origin: 'http://evil.test' }, body: 'a=1' });

      expect(svar.status).toBe(403);
      expect(svar.kropp).toBe('Nekad.');
    });

    it('413 från leverantören når fram', async () => {
      const { port, host } = await starta(skapaFejkadAuthRouteProvider(() => ({ status: 413, headers: {} })));

      expect((await anropa({ port, host, path: '/_auth/login' })).status).toBe(413);
    });
  });
});
