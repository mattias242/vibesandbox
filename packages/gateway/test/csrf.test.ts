/**
 * Enkelt CSRF-skydd: skrivande anrop (POST/PUT/DELETE) måste bära CSRF_HEADER, annars 403
 * forbidden. GET kräver det inte. Se contracts CSRF_HEADER och
 * features/isolering/atkomst.feature, scenariot "Skrivande anrop utan plattformens
 * skyddshuvud mot förfalskade anrop nekas".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import { skapaAppId, skapaGodkannandeIdentityProvider, skapaTestUppsattning, vardnamnForApp } from './fejkar.ts';

describe('CSRF-skydd på skrivande anrop', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it.each(['POST', 'PUT', 'DELETE'])('%s utan CSRF-huvudet ⇒ 403 forbidden, store anropas inte', async (metod) => {
    const appId = skapaAppId(`csrf-${metod.toLowerCase()}`);
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const vag = metod === 'POST' ? '/_api/collections/poster/docs' : '/_api/collections/poster/docs/dok-1';
    const svar = await anropa({
      port: server.port,
      method: metod,
      path: vag,
      host: vardnamnForApp(appId),
      json: metod === 'DELETE' ? undefined : { data: { rum: 'Stora salen' } },
    });

    expect(svar.status).toBe(403);
    expect(json<ApiErrorBody>(svar).error.code).toBe('forbidden');
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it('POST MED CSRF-huvudet accepteras (kommer förbi CSRF-kontrollen)', async () => {
    const appId = skapaAppId('csrf-post-giltig');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
      json: { data: { rum: 'Stora salen' } },
    });

    expect(svar.status).not.toBe(403);
    expect(uppsattning.store.anrop.some((a) => a.metod === 'createDocument')).toBe(true);
  });

  it('GET kräver inte CSRF-huvudet', async () => {
    const appId = skapaAppId('csrf-get');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      method: 'GET',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
    });

    expect(svar.status).not.toBe(403);
  });
});
