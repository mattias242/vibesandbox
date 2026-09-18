/**
 * Kärnan i gatewayens säkerhet: vilken app ett anrop hör till avgörs ENDAST av ett strikt
 * validerat Host-huvud. Inget i sökväg, frågesträng, kropp eller andra huvuden får påverka
 * det — och ett ogiltigt eller förfalskat värdnamn ska nekas innan registry/store/filer
 * ens tillfrågas. Se docs/konventioner.md och features/isolering/hyresgastisolering.feature.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, WhoAmIResponse } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, anropaRatt, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  APP_DOMAN,
  skapaAppId,
  skapaGodkannandeIdentityProvider,
  skapaTestUppsattning,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';

describe('värdnamn → hyresgäst', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('en publicerad app routas till TenantContext med kind "published"', async () => {
    const appId = skapaAppId('bokningar');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(appId);
    expect(uppsattning.store.anrop[0]?.tenant?.kind).toBe('published');
  });

  it('en förhandsvisning routas till TenantContext med kind "draft"', async () => {
    const appId = skapaAppId('bokningar-utkast');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForForhandsvisning(appId),
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(appId);
    expect(uppsattning.store.anrop[0]?.tenant?.kind).toBe('draft');
  });

  it('app-id i frågesträngen ändrar inte vilken hyresgäst som används', async () => {
    const målApp = skapaAppId('mal-app');
    const lockApp = skapaAppId('lock-app');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(målApp, { published: true });
    uppsattning.register.registrera(lockApp, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: `/_api/collections/poster/docs?appId=${lockApp}&tenant=${lockApp}`,
      host: vardnamnForApp(målApp),
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(målApp);
  });

  it('app-id i kroppen ändrar inte vilken hyresgäst som används', async () => {
    const målApp = skapaAppId('mal-app-kropp');
    const lockApp = skapaAppId('lock-app-kropp');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(målApp, { published: true });
    uppsattning.register.registrera(lockApp, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(målApp),
      headers: { 'x-vibesandbox-request': '1' },
      json: { data: { appId: lockApp, kommentar: 'jag vill skriva i lockApp' } },
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(målApp);
  });

  it('ett kollektionsnamn som råkar likna ett annat app-id ändrar inte hyresgästen', async () => {
    const målApp = skapaAppId('mal-app-kollektion');
    const lockApp = skapaAppId('lock-app-kollektion');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(målApp, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: `/_api/collections/${lockApp}/docs`,
      host: vardnamnForApp(målApp),
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(målApp);
  });

  describe('förfalskade vidarebefordringshuvuden ignoreras helt', () => {
    const rätta = skapaAppId('ratta-appen');
    const forfalskade = skapaAppId('forfalskade-appen');

    it.each([
      ['X-Forwarded-Host', vardnamnForApp(forfalskade)],
      ['Forwarded', `host=${vardnamnForApp(forfalskade)}`],
      ['X-Original-Host', vardnamnForApp(forfalskade)],
      ['X-Host', vardnamnForApp(forfalskade)],
    ])('huvudet %s styr inte routningen', async (huvudnamn, varde) => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      uppsattning.register.registrera(rätta, { published: true });
      uppsattning.register.registrera(forfalskade, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs',
        host: vardnamnForApp(rätta),
        headers: { [huvudnamn]: varde },
      });

      expect(svar.status).toBeLessThan(500);
      expect(uppsattning.store.anrop).toHaveLength(1);
      expect(uppsattning.store.anrop[0]?.tenant?.appId).toBe(rätta);
    });
  });

  describe('ogiltiga värdnamn avvisas innan registry, store eller filer nås', () => {
    const giltigtId = skapaAppId('ett-giltigt-id');

    const fall: ReadonlyArray<[string, string]> = [
      ['sökvägstraversering i värdnamnet', '../../etc.appar.test'],
      ['fel domän', `${giltigtId}.ond.test`],
      ['domänsvans-attack', `${giltigtId}.${APP_DOMAN}.ond.test`],
      ['extra subdomännivå', `x.${giltigtId}.${APP_DOMAN}`],
      ['för kort app-id', `${giltigtId.slice(0, 25)}.${APP_DOMAN}`],
      ['för långt app-id', `${giltigtId}z.${APP_DOMAN}`],
      ['versaler i app-id (normaliseras inte)', `${giltigtId.toUpperCase()}.${APP_DOMAN}`],
      ['tecken utanför alfabetet (i, l, o, u förbjudna)', `i${giltigtId.slice(1)}.${APP_DOMAN}`],
      ['avslutande punkt', `${giltigtId}.${APP_DOMAN}.`],
      ['icke-ASCII-tecken i värdnamnet', `${giltigtId.slice(0, 25)}ä.${APP_DOMAN}`],
    ];

    it.each(fall)('%s ⇒ 400 invalid_request', async (_beskrivning, vardnamn) => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamn });

      expect(svar.status).toBe(400);
      expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
    });

    it('tomt Host-huvud ⇒ 400 invalid_request', async () => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({ port: server.port, path: '/_api/whoami', host: '' });

      expect(svar.status).toBe(400);
      expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('saknat Host-huvud ⇒ 400 invalid_request (HTTP/1.1 kräver Host)', async () => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropaRatt({
        port: server.port,
        requestrad: 'GET /_api/whoami HTTP/1.1',
        huvuden: ['Connection: close'],
      });

      // Antingen svarar gatewayn själv 400, eller så vägrar Node:s HTTP-parser förfrågan
      // (saknat Host-huvud i HTTP/1.1 är ogiltigt redan på protokollnivå).
      expect([0, 400]).toContain(svar.status);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('NUL-byte i värdnamnet ⇒ avvisas (400, eller att anslutningen stängs)', async () => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));

      const nulTecken = String.fromCharCode(0);
      const svar = await anropaRatt({
        port: server.port,
        requestrad: 'GET /_api/whoami HTTP/1.1',
        huvuden: [`Host: ${giltigtId}${nulTecken}.${APP_DOMAN}`, 'Connection: close'],
      });

      expect([0, 400]).toContain(svar.status);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('dubbla Host-huvuden ⇒ avvisas', async () => {
      const annanApp = skapaAppId('annan-app-dubbel');
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      uppsattning.register.registrera(giltigtId, { published: true });
      uppsattning.register.registrera(annanApp, { published: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropaRatt({
        port: server.port,
        requestrad: 'GET /_api/whoami HTTP/1.1',
        huvuden: [`Host: ${vardnamnForApp(giltigtId)}`, `Host: ${vardnamnForApp(annanApp)}`, 'Connection: close'],
      });

      // Antingen svarar gatewayn 400, eller Node:s HTTP-parser vägrar dubbla Host-huvuden.
      expect([0, 400]).toContain(svar.status);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });
  });

  it('port i Host-huvudet accepteras och strippas', async () => {
    const appId = skapaAppId('app-med-port');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/whoami',
      host: `${vardnamnForApp(appId)}:8443`,
    });

    expect(svar.status).toBe(200);
    const kropp = json<WhoAmIResponse>(svar);
    expect(kropp.userId).toBeTruthy();
  });

  it('okänt men välformat app-id ⇒ 404 not_found, och store anropas aldrig', async () => {
    const okantId = skapaAppId('finns-inte-alls');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(okantId) });

    expect(svar.status).toBe(404);
    expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it('en adress som inte hör till någon app avvisas även för statiskt innehåll, utan att en databas skapas', async () => {
    const okantId = skapaAppId('statisk-finns-inte');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/', host: vardnamnForApp(okantId) });

    expect(svar.status).toBe(404);
    expect(uppsattning.store.anrop).toHaveLength(0);
    expect(uppsattning.filer.anrop).toHaveLength(0);
  });

  it('app utan publicerad version ⇒ 404 på appdomänen', async () => {
    const appId = skapaAppId('bara-utkast');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: false, draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(404);
    expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
  });

  it('app utan utkast ⇒ 404 på förhandsvisningsdomänen', async () => {
    const appId = skapaAppId('bara-publicerad');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true, draft: false });
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/whoami',
      host: vardnamnForForhandsvisning(appId),
    });

    expect(svar.status).toBe(404);
    expect(json<ApiErrorBody>(svar).error.code).toBe('not_found');
  });
});
