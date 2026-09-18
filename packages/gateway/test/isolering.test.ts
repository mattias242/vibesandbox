/**
 * Ände-till-ände-speglingar av features/isolering/hyresgastisolering.feature: en app ser
 * ALDRIG en annan apps data, oavsett vad som står i sökväg, fråga, kropp eller förfalskade
 * huvuden — och en förhandsvisning delar aldrig data med den publicerade appen. Till
 * skillnad från vardnamn.test.ts (som bara kollar VILKET TenantContext store fick) skriver
 * och läser de här testerna riktiga dokument via samma delade fejkade store, precis som i
 * produktion där en store-instans betjänar alla hyresgäster.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, DocumentPage } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaGodkannandeIdentityProvider,
  skapaTestUppsattning,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';

describe('hyresgästisolering (ände till ände)', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function sparaDokument(port: number, host: string, data: Record<string, unknown>) {
    const svar = await anropa({
      port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host,
      headers: { [CSRF_HEADER]: '1' },
      json: { data },
    });
    return json<{ id: string }>(svar);
  }

  it('en app ser bara sina egna dokument', async () => {
    const bokningar = skapaAppId('iso-bokningar-1');
    const enkat = skapaAppId('iso-enkat-1');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(bokningar, { published: true });
    uppsattning.register.registrera(enkat, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await sparaDokument(server.port, vardnamnForApp(bokningar), { rum: 'Stora salen' });

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(enkat),
    });

    expect(json<DocumentPage>(svar).documents).toHaveLength(0);
  });

  it('app-id för en annan app i frågesträngen ändrar inte vad som listas', async () => {
    const bokningar = skapaAppId('iso-bokningar-2');
    const enkat = skapaAppId('iso-enkat-2');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(bokningar, { published: true });
    uppsattning.register.registrera(enkat, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await sparaDokument(server.port, vardnamnForApp(bokningar), { rum: 'Stora salen' });

    const svar = await anropa({
      port: server.port,
      path: `/_api/collections/poster/docs?appId=${bokningar}`,
      host: vardnamnForApp(enkat),
    });

    expect(json<DocumentPage>(svar).documents).toHaveLength(0);
  });

  it('ett förfalskat X-Forwarded-Host ändrar inte vad som listas', async () => {
    const bokningar = skapaAppId('iso-bokningar-3');
    const enkat = skapaAppId('iso-enkat-3');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(bokningar, { published: true });
    uppsattning.register.registrera(enkat, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await sparaDokument(server.port, vardnamnForApp(bokningar), { rum: 'Stora salen' });

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(enkat),
      headers: { 'X-Forwarded-Host': vardnamnForApp(bokningar) },
    });

    expect(json<DocumentPage>(svar).documents).toHaveLength(0);
  });

  it('ett dokument-id från en annan app ger "finns inte"', async () => {
    const bokningar = skapaAppId('iso-bokningar-4');
    const enkat = skapaAppId('iso-enkat-4');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(bokningar, { published: true });
    uppsattning.register.registrera(enkat, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const skapat = await sparaDokument(server.port, vardnamnForApp(bokningar), { rum: 'Stora salen' });

    const svar = await anropa({
      port: server.port,
      path: `/_api/collections/poster/docs/${skapat.id}`,
      host: vardnamnForApp(enkat),
    });

    expect(svar.status).toBe(404);
    expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
  });

  it('utkast och publicerad version delar aldrig data', async () => {
    const appId = skapaAppId('iso-bade-och-5');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true, draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await sparaDokument(server.port, vardnamnForApp(appId), { rum: 'Stora salen' });

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForForhandsvisning(appId),
    });

    expect(json<DocumentPage>(svar).documents).toHaveLength(0);
  });
});
