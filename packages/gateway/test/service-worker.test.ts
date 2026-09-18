/**
 * Bakgrundsskript (service workers) som överlever sidan tillåts inte — de skulle kunna
 * fortsätta köra och läcka data även efter att fliken stängts. Se
 * features/isolering/ringa-hem.feature, scenariot "Bakgrundsskript som överlever sidan
 * tillåts inte". Webbläsare sätter huvudet `Service-Worker: script` när de hämtar filen
 * som ska registreras som service worker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import { skapaAppId, skapaGodkannandeIdentityProvider, skapaTestUppsattning, textfil, vardnamnForApp } from './fejkar.ts';

describe('registrering av bakgrundsskript (service worker) blockeras', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('en begäran med huvudet Service-Worker: script ⇒ 403 forbidden', async () => {
    const appId = skapaAppId('sw-blockering');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/sw.js', textfil('self.addEventListener("fetch",()=>{});', 'text/javascript'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/sw.js',
      host: vardnamnForApp(appId),
      headers: { 'Service-Worker': 'script' },
    });

    expect(svar.status).toBe(403);
    expect(json<ApiErrorBody>(svar).error.code).toBe('forbidden');
  });

  it('samma fil UTAN Service-Worker-huvudet är en helt vanlig statisk fil', async () => {
    const appId = skapaAppId('sw-vanlig-fil');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/sw.js', textfil('console.log("bara en vanlig fil");', 'text/javascript'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/sw.js', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
  });
});
