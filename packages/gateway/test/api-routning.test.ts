/**
 * Routning och felmappning för det dataAPI:t gatewayn exponerar (se API_PREFIX-kommentaren
 * i contracts). Varje rutt ska anropa rätt store-metod med rätt argument, mappa
 * `DataApiError` till rätt status/kropp enligt API_ERROR_STATUS/ApiErrorBody, och aldrig
 * läcka interna felmeddelanden. Fientliga och trasiga kroppar testas explicit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { API_ERROR_STATUS, CSRF_HEADER, DataApiError } from '@vibesandbox/contracts';
import type { ApiErrorBody, ApiErrorCode } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, anropaRatt, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  STANDARDANVANDARE,
  skapaAppId,
  skapaGodkannandeIdentityProvider,
  skapaTestUppsattning,
  vardnamnForApp,
} from './fejkar.ts';
import type { TestUppsattning } from './fejkar.ts';

let raknare = 0;
function nastaAppId(): string {
  raknare += 1;
  return skapaAppId(`api-routning-${raknare}`);
}

function nyUppsattning(): { appId: string; uppsattning: TestUppsattning } {
  const appId = nastaAppId();
  const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
  uppsattning.register.registrera(appId, { published: true });
  uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
  return { appId, uppsattning };
}

describe('API-routning och felmappning', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('GET .../docs anropar listDocuments med kollektion, scope och paginering', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs?scope=user&limit=10&cursor=abc',
      host: vardnamnForApp(appId),
    });

    expect(uppsattning.store.anrop).toHaveLength(1);
    const anrop = uppsattning.store.anrop[0];
    expect(anrop?.metod).toBe('listDocuments');
    expect(anrop?.collection).toBe('poster');
    expect(anrop?.extra).toEqual({ scope: 'user', options: { limit: 10, cursor: 'abc' } });
  });

  it('scope utelämnad ⇒ default "app"', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({ port: server.port, path: '/_api/collections/poster/docs', host: vardnamnForApp(appId) });

    const anrop = uppsattning.store.anrop[0];
    expect((anrop?.extra as { scope: string }).scope).toBe('app');
  });

  it('ogiltigt scope-värde ⇒ 400 invalid_request, store anropas inte', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs?scope=admin',
      host: vardnamnForApp(appId),
    });

    expect(svar.status).toBe(400);
    expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it('POST .../docs anropar createDocument med kollektion, scope och data', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs?scope=user',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
      json: { data: { rum: 'Stora salen' } },
    });

    const anrop = uppsattning.store.anrop[0];
    expect(anrop?.metod).toBe('createDocument');
    expect(anrop?.collection).toBe('poster');
    expect(anrop?.extra).toEqual({ scope: 'user', data: { rum: 'Stora salen' } });
  });

  it('GET .../docs/:id anropar getDocument med kollektion och id', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs/dok-42',
      host: vardnamnForApp(appId),
    });

    const anrop = uppsattning.store.anrop[0];
    expect(anrop?.metod).toBe('getDocument');
    expect(anrop?.collection).toBe('poster');
    expect(anrop?.extra).toEqual({ id: 'dok-42' });
  });

  it('PUT .../docs/:id anropar replaceDocument med kollektion, id och data', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      method: 'PUT',
      path: '/_api/collections/poster/docs/dok-42',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
      json: { data: { rum: 'Nya salen' } },
    });

    const anrop = uppsattning.store.anrop[0];
    expect(anrop?.metod).toBe('replaceDocument');
    expect(anrop?.collection).toBe('poster');
    expect(anrop?.extra).toEqual({ id: 'dok-42', data: { rum: 'Nya salen' } });
  });

  it('DELETE .../docs/:id anropar deleteDocument med kollektion och id', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      method: 'DELETE',
      path: '/_api/collections/poster/docs/dok-42',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
    });

    const anrop = uppsattning.store.anrop[0];
    expect(anrop?.metod).toBe('deleteDocument');
    expect(anrop?.collection).toBe('poster');
    expect(anrop?.extra).toEqual({ id: 'dok-42' });
  });

  describe('DataApiError mappas till rätt status och felkod', () => {
    const koder = Object.entries(API_ERROR_STATUS) as ReadonlyArray<[ApiErrorCode, number]>;

    it.each(koder)('%s ⇒ status %i', async (kod, forvantadStatus) => {
      const { appId, uppsattning } = nyUppsattning();
      uppsattning.store.kastaVidNastaAnrop(new DataApiError(kod, 'testfel för mappning'));
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({
        port: server.port,
        path: '/_api/collections/poster/docs/dok-1',
        host: vardnamnForApp(appId),
      });

      expect(svar.status).toBe(forvantadStatus);
      expect(json<ApiErrorBody>(svar).error.code).toBe(kod);
    });
  });

  it('ett oväntat fel (inte DataApiError) ⇒ 500 internal utan att läcka detaljer', async () => {
    const { appId, uppsattning } = nyUppsattning();
    const hemligDetalj = 'stacktrace-eller-sql-som-aldrig-far-lacka';
    uppsattning.store.kastaVidNastaAnrop(new Error(hemligDetalj));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
    });

    expect(svar.status).toBe(500);
    expect(json<ApiErrorBody>(svar).error.code).toBe('internal');
    expect(svar.kropp).not.toContain(hemligDetalj);
  });

  it('okänd API-rutt ⇒ 404', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/_api/nagot-som-inte-finns', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(404);
  });

  it('fel HTTP-metod på en känd rutt ⇒ 405', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, method: 'PATCH', path: '/_api/whoami', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(405);
  });

  it('ogiltig JSON i kroppen ⇒ 400', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const trasigKropp = '{ det här är inte giltig JSON';
    const svar = await anropaRatt({
      port: server.port,
      requestrad: 'POST /_api/collections/poster/docs HTTP/1.1',
      huvuden: [
        `Host: ${vardnamnForApp(appId)}`,
        `${CSRF_HEADER}: 1`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(trasigKropp, 'utf8')}`,
        'Connection: close',
      ],
      kropp: trasigKropp,
    });

    expect(svar.status).toBe(400);
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it.each([
    ['tomt objekt utan data-nyckel', {}],
    ['data är inte ett objekt', { data: 'en sträng' }],
  ])('kropp utan giltigt data-objekt (%s) ⇒ 400', async (_beskrivning, kropp) => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
      json: kropp,
    });

    expect(svar.status).toBe(400);
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  it('kropp över en rimlig gräns (1 MB) ⇒ 413', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const storText = 'x'.repeat(2 * 1024 * 1024);
    const svar = await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1' },
      json: { data: { fyllnad: storText } },
    });

    expect(svar.status).toBe(413);
    expect(uppsattning.store.anrop).toHaveLength(0);
  }, 10000);

  it('fel Content-Type på ett skrivande anrop ⇒ 400 eller 415', async () => {
    const { appId, uppsattning } = nyUppsattning();
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: vardnamnForApp(appId),
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ data: { rum: 'Stora salen' } }),
    });

    expect([400, 415]).toContain(svar.status);
    expect(uppsattning.store.anrop).toHaveLength(0);
  });
});
