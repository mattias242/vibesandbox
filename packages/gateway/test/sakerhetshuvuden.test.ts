/**
 * Säkerhetshuvuden ska sitta på VARJE svar gatewayn ger — lyckat eller inte, API eller
 * statisk fil — och appens egen kod kan aldrig ersätta dem. `X-Frame-Options`/
 * frame-ancestors testas inte här (skalet är inte byggt än, se uppdraget). Se contracts
 * APP_CONTENT_SECURITY_POLICY och features/isolering/ringa-hem.feature.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, enHuvud, startaTestserver } from './hjalp.ts';
import type { AnropSvar, Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaGodkannandeIdentityProvider,
  skapaNekandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
} from './fejkar.ts';

function forvantaSakerhetshuvuden(svar: AnropSvar) {
  expect(enHuvud(svar, 'Content-Security-Policy')).toBe(APP_CONTENT_SECURITY_POLICY);
  expect(enHuvud(svar, 'X-Content-Type-Options')).toBe('nosniff');
  expect(enHuvud(svar, 'Referrer-Policy')).toBe('no-referrer');
}

describe('säkerhetshuvuden på alla svar', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('200 från API:t bär skyddsreglerna och Cache-Control: no-store', async () => {
    const appId = skapaAppId('sakerhet-200-api');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    forvantaSakerhetshuvuden(svar);
    expect(enHuvud(svar, 'Cache-Control')).toBe('no-store');
  });

  it('401 (ej inloggad) bär skyddsreglerna', async () => {
    const appId = skapaAppId('sakerhet-401');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaNekandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(401);
    forvantaSakerhetshuvuden(svar);
  });

  it('404 (okänt app-id) bär skyddsreglerna', async () => {
    const okantId = skapaAppId('sakerhet-404-okand-app');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(okantId) });

    expect(svar.status).toBe(404);
    forvantaSakerhetshuvuden(svar);
  });

  it('400 (ogiltigt värdnamn) bär skyddsreglerna', async () => {
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: '../../etc.appar.test' });

    expect(svar.status).toBe(400);
    forvantaSakerhetshuvuden(svar);
  });

  it('en statisk sida (200) bär skyddsreglerna', async () => {
    const appId = skapaAppId('sakerhet-200-statisk');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>hej</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    forvantaSakerhetshuvuden(svar);
  });

  it('en okänd statisk fil med filändelse (404) bär skyddsreglerna', async () => {
    const appId = skapaAppId('sakerhet-404-statisk');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>hej</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/finns-inte.png', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(404);
    forvantaSakerhetshuvuden(svar);
  });

  it('en app kan inte ersätta skyddsreglerna med en egen meta-tagg', async () => {
    const appId = skapaAppId('sakerhet-meta-tagg');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(
      appId,
      'published',
      '/index.html',
      textfil('<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>'),
    );
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/', host: vardnamnForApp(appId) });

    expect(enHuvud(svar, 'Content-Security-Policy')).toBe(APP_CONTENT_SECURITY_POLICY);
  });
});
