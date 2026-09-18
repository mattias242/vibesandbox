/**
 * GET /_api/whoami: appen ska få veta vem användaren är, men aldrig mer än nödvändigt.
 * Se features/isolering/atkomst.feature, scenariot "Appen får veta vem användaren är,
 * men inte mer än nödvändigt", och contracts WhoAmIResponse.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WhoAmIResponse } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import { skapaAppId, skapaGodkannandeIdentityProvider, skapaIdentitet, skapaTestUppsattning, vardnamnForApp } from './fejkar.ts';

describe('whoami', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('ger userId och ett visningsnamn härlett ur e-postens lokala del', async () => {
    const appId = skapaAppId('bokningar-whoami-1');
    const epost = 'anna.andersson@exempel.se';
    const identitet = skapaIdentitet({ userId: 'anv-anna', email: epost });
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider(identitet) });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    const kropp = json<WhoAmIResponse>(svar);
    expect(kropp.userId).toBe('anv-anna');
    expect(kropp.displayName).toBe('anna.andersson');
  });

  it('svaret innehåller aldrig e-postadressen, varken i kropp eller huvuden', async () => {
    const appId = skapaAppId('bokningar-whoami-2');
    const epost = 'hemlig.epostadress@exempel.se';
    const identitet = skapaIdentitet({ email: epost });
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider(identitet) });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.kropp).not.toContain(epost);
    expect(svar.kropp).not.toContain('exempel.se');
    expect(JSON.stringify(svar.huvuden)).not.toContain(epost);
  });

  it('kräver inloggning som alla andra API-anrop', async () => {
    const appId = skapaAppId('bokningar-whoami-3');
    const uppsattning = skapaTestUppsattning();
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(401);
  });
});
