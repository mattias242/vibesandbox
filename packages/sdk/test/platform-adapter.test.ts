import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { createPlatformAdapter } from '../src/index.ts';
import type { FetchLike } from '../src/index.ts';
import { ANNA, describeAdapterContract, expectSdkError } from './adapter-contract.ts';
import { createFakeServer, errorResponse, jsonResponse } from './fake-server.ts';

describeAdapterContract('plattformsadaptern mot en fejkad plattform', () => {
  const server = createFakeServer();
  return { as: (user) => createPlatformAdapter({ fetch: server.fetchAs(user) }) };
});

const ID = '0123456789abcdefghjkmnpqrs';

function setup() {
  const server = createFakeServer();
  const adapter = createPlatformAdapter({ fetch: server.fetchAs(ANNA) });
  const last = () => {
    const request = server.requests.at(-1);
    if (request === undefined) throw new Error('inget anrop gjordes');
    return request;
  };
  return { server, adapter, last };
}

describe('plattformsadaptern: det som går på tråden', () => {
  it('whoami är ett GET mot /_api/whoami', async () => {
    const { adapter, last } = setup();
    await adapter.whoami();
    expect(last()).toMatchObject({ url: '/_api/whoami', method: 'GET', body: undefined });
  });

  it('listning skickar scope, och limit/cursor bara när de är satta', async () => {
    const { adapter, last } = setup();
    await adapter.list('bokningar', 'app');
    expect(last()).toMatchObject({ url: '/_api/collections/bokningar/docs?scope=app', method: 'GET' });

    await adapter.list('svar', 'user', { limit: 50 });
    expect(last().url).toBe('/_api/collections/svar/docs?scope=user&limit=50');
  });

  it('en markör URL-kodas, vad den än innehåller', async () => {
    const recorded: string[] = [];
    const fetch: FetchLike = async (url) => {
      recorded.push(url);
      return jsonResponse(200, { documents: [] });
    };
    await createPlatformAdapter({ fetch }).list('poster', 'app', { cursor: 'a&scope=user#/../x' });
    expect(recorded).toEqual(['/_api/collections/poster/docs?scope=app&cursor=a%26scope%3Duser%23%2F..%2Fx']);
  });

  it('skapande är ett POST med { data } som JSON', async () => {
    const { adapter, last } = setup();
    await adapter.create('bokningar', 'app', { rum: 'Stora salen' });
    expect(last()).toMatchObject({ url: '/_api/collections/bokningar/docs?scope=app', method: 'POST' });
    expect(last().headers['content-type']).toBe('application/json');
    expect(JSON.parse(last().body ?? '')).toEqual({ data: { rum: 'Stora salen' } });
  });

  it('hämtning, ersättning och borttagning går mot dokumentets sökväg utan scope', async () => {
    const { adapter, server } = setup();
    const doc = await adapter.create('bokningar', 'app', { rum: 'Stora salen' });
    await adapter.get('bokningar', doc.id);
    await adapter.replace('bokningar', doc.id, { rum: 'Lilla salen' });
    await adapter.remove('bokningar', doc.id);

    const [, get, put, del] = server.requests;
    const path = `/_api/collections/bokningar/docs/${doc.id}`;
    expect(get).toMatchObject({ url: path, method: 'GET', body: undefined });
    expect(put).toMatchObject({ url: path, method: 'PUT' });
    expect(JSON.parse(put?.body ?? '')).toEqual({ data: { rum: 'Lilla salen' } });
    expect(del).toMatchObject({ url: path, method: 'DELETE', body: undefined });
  });

  it('skrivande anrop bär CSRF-huvudet; läsande gör det inte i onödan', async () => {
    const { adapter, server } = setup();
    const doc = await adapter.create('bokningar', 'app', { rum: 'x' });
    await adapter.replace('bokningar', doc.id, { rum: 'y' });
    await adapter.list('bokningar', 'app');
    await adapter.remove('bokningar', doc.id);

    const byMethod = Object.fromEntries(server.requests.map((request) => [request.method, request.headers]));
    expect(byMethod['POST']?.[CSRF_HEADER]).toBe('1');
    expect(byMethod['PUT']?.[CSRF_HEADER]).toBe('1');
    expect(byMethod['DELETE']?.[CSRF_HEADER]).toBe('1');
    expect(byMethod['GET']?.[CSRF_HEADER]).toBeUndefined();
  });

  it('alla anrop är relativa, med credentials same-origin — aldrig en absolut URL', async () => {
    const { adapter, server } = setup();
    const doc = await adapter.create('bokningar', 'app', { rum: 'x' });
    await adapter.whoami();
    await adapter.list('bokningar', 'app');
    await adapter.get('bokningar', doc.id);
    await adapter.replace('bokningar', doc.id, { rum: 'y' });
    await adapter.remove('bokningar', doc.id);

    expect(server.requests).toHaveLength(6);
    for (const request of server.requests) {
      expect(request.url.startsWith('/_api/')).toBe(true);
      expect(request.url).not.toMatch(/^\/\/|:\/\//);
      expect(request.credentials).toBe('same-origin');
    }
  });

  it('fientliga namn och id:n kan inte ändra sökvägen', async () => {
    const recorded: string[] = [];
    const fetch: FetchLike = async (url) => {
      recorded.push(url);
      return errorResponse('invalid_request', 'Begäran är ogiltig.');
    };
    const adapter = createPlatformAdapter({ fetch });
    await expectSdkError(adapter.get('../whoami', '../../x?scope=user'), 'invalid_request');
    await expectSdkError(adapter.list('a/b?x=1#y', 'app'), 'invalid_request');
    expect(recorded).toEqual([
      '/_api/collections/..%2Fwhoami/docs/..%2F..%2Fx%3Fscope%3Duser',
      '/_api/collections/a%2Fb%3Fx%3D1%23y/docs?scope=app',
    ]);
  });
});

describe('plattformsadaptern: fel', () => {
  const failing = (fetch: FetchLike) => createPlatformAdapter({ fetch });

  it('en felkropp från plattformen blir SdkError med samma kod och meddelande', async () => {
    const adapter = failing(async () => errorResponse('quota_exceeded', 'Appens lagringsutrymme är slut.'));
    const error = await expectSdkError(adapter.create('bokningar', 'app', { rum: 'x' }), 'quota_exceeded');
    expect(error.message).toBe('Appens lagringsutrymme är slut.');
    expect(error.name).toBe('SdkError');
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [413, 'too_large'],
    [429, 'rate_limited'],
    [500, 'internal'],
    [502, 'internal'],
  ] as const)('status %i utan begriplig kropp blir koden %s med ett svenskt meddelande', async (status, code) => {
    const adapter = failing(async () => ({
      status,
      ok: false,
      json: async () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }));
    const error = await expectSdkError(adapter.get('bokningar', ID), code);
    expect(error.message).not.toMatch(/JSON|token|fetch|\d{3}/i);
  });

  it('en felkropp med okänd kod litar vi inte på — statusen avgör', async () => {
    const adapter = failing(async () => jsonResponse(404, { error: { code: 'hittepå', message: 12 } }));
    await expectSdkError(adapter.get('bokningar', ID), 'not_found');
  });

  it('ett nätverksfel blir ett begripligt fel med koden network, utan tekniska detaljer', async () => {
    const adapter = failing(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await expectSdkError(adapter.list('bokningar', 'app'), 'network');
    expect(error.message).not.toMatch(/fetch|TypeError/i);
    expect(error.message).toMatch(/anslutning|uppkoppling|nätverk/i);
  });

  it('ett lyckat svar som inte går att tolka blir internal, inte ett rått JSON-fel', async () => {
    const adapter = failing(async () => ({
      status: 200,
      ok: true,
      json: async () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    }));
    await expectSdkError(adapter.whoami(), 'internal');
  });

  it('ett lyckat svar med fel form blir internal', async () => {
    const adapter = failing(async () => jsonResponse(200, { något: 'annat' }));
    await expectSdkError(adapter.get('bokningar', ID), 'internal');
    await expectSdkError(adapter.list('bokningar', 'app'), 'internal');
    await expectSdkError(adapter.whoami(), 'internal');
  });

  it('utan injicerad fetch används webbläsarens, uppslagen först vid anrop', async () => {
    const original = globalThis.fetch;
    const urls: unknown[] = [];
    try {
      const adapter = createPlatformAdapter();
      globalThis.fetch = (async (url: unknown) => {
        urls.push(url);
        return new Response(JSON.stringify(ANNA), { status: 200 });
      }) as typeof fetch;
      expect(await adapter.whoami()).toEqual(ANNA);
      expect(urls).toEqual(['/_api/whoami']);
    } finally {
      globalThis.fetch = original;
    }
  });
});
