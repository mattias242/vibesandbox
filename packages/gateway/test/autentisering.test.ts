/**
 * Autentisering ska vara fail-closed: saknad, ogiltig eller manipulerad inloggning ger
 * alltid ett avslag — aldrig ett gissat standardvärde och aldrig genomsläpp. Se
 * docs/konventioner.md ("Osäkerhet ⇒ neka") och features/isolering/atkomst.feature.
 *
 * OBS: `signTestIdentity` antas returnera hela värdet till Authorization-huvudet (dvs.
 * strängen "Test <payload>.<signatur>"), enligt jsdoc-kommentaren i stubben. Om det visar
 * sig vara fel (t.ex. att "Test "-prefixet ska läggas till av den som anropar) är det en
 * lucka i kontraktet — se min rapport till koordinatorn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { createGateway, createTestIdentityProvider, signTestIdentity } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaIdentitet,
  skapaKrashandeIdentityProvider,
  skapaNekandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
} from './fejkar.ts';

describe('autentisering är fail-closed', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('anrop utan inloggning ⇒ 401 unauthenticated, och store anropas aldrig', async () => {
    const appId = skapaAppId('bokningar-auth-1');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaNekandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
    });

    expect(svar.status).toBe(401);
    expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  describe('manipulerad testinloggning nekas', () => {
    const hemlighet = 'test-hemlighet-1234567890-minst-32-tecken';
    const annanHemlighet = 'en-helt-annan-hemlighet-minst-32-tecken';
    const identitet = skapaIdentitet({ email: 'anna.andersson@exempel.se' });

    it('förfalskad signatur ⇒ 401', async () => {
      const appId = skapaAppId('bokningar-auth-2');
      const identityProvider = createTestIdentityProvider({ secret: hemlighet });
      const uppsattning = skapaTestUppsattning({ identityProvider });
      uppsattning.register.registrera(appId, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const giltigt = signTestIdentity(identitet, hemlighet);
      const forfalskat = giltigt.slice(0, -1) + (giltigt.endsWith('a') ? 'b' : 'a');

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs',
        host: vardnamnForApp(appId),
        headers: { Authorization: forfalskat },
      });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('trunkerad token ⇒ 401', async () => {
      const appId = skapaAppId('bokningar-auth-3');
      const identityProvider = createTestIdentityProvider({ secret: hemlighet });
      const uppsattning = skapaTestUppsattning({ identityProvider });
      uppsattning.register.registrera(appId, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const giltigt = signTestIdentity(identitet, hemlighet);
      const trunkerat = giltigt.slice(0, Math.floor(giltigt.length / 2));

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs',
        host: vardnamnForApp(appId),
        headers: { Authorization: trunkerat },
      });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('signerad med fel hemlighet ⇒ 401', async () => {
      const appId = skapaAppId('bokningar-auth-4');
      const identityProvider = createTestIdentityProvider({ secret: hemlighet });
      const uppsattning = skapaTestUppsattning({ identityProvider });
      uppsattning.register.registrera(appId, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const felSignerat = signTestIdentity(identitet, annanHemlighet);

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs',
        host: vardnamnForApp(appId),
        headers: { Authorization: felSignerat },
      });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('rent skräp i Authorization-huvudet ⇒ 401', async () => {
      const appId = skapaAppId('bokningar-auth-5');
      const identityProvider = createTestIdentityProvider({ secret: hemlighet });
      const uppsattning = skapaTestUppsattning({ identityProvider });
      uppsattning.register.registrera(appId, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs',
        host: vardnamnForApp(appId),
        headers: { Authorization: 'Bearer inte-alls-ett-testtoken' },
      });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });
  });

  it('en IdentityProvider som kastar är ändå fail-closed (401 eller 500, aldrig genomsläpp)', async () => {
    const appId = skapaAppId('bokningar-auth-6');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaKrashandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
    });

    expect([401, 500]).toContain(svar.status);
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it('statisk fil levereras inte till den som inte är inloggad', async () => {
    const appId = skapaAppId('bokningar-auth-7');
    const hemligMarkor = 'HEMLIGT-APPINNEHÅLL-SOM-INTE-FÅR-LÄCKA';
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaNekandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil(`<html>${hemligMarkor}</html>`));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/', host: vardnamnForApp(appId) });

    const ärNekadEllerOmdirigerad = svar.status === 401 || (svar.status >= 300 && svar.status < 400);
    expect(ärNekadEllerOmdirigerad).toBe(true);
    expect(svar.kropp).not.toContain(hemligMarkor);
  });
});
