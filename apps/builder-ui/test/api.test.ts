/**
 * API-klienten mot en fejkad fetch: rätt metod, sökväg, huvuden och kropp; fel blir klarspråk;
 * adresser är alltid relativa till byggverktygets egen origin.
 */
import { describe, expect, it, vi } from 'vitest';
import { BUILDER_API_PREFIX, CSRF_HEADER } from '@vibesandbox/contracts';
import { ApiError, createApiClient } from '../src/api.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly credentials: RequestCredentials | undefined;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => json(200, {})) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials,
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, fetchFn };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(respond?: (call: Call) => Response | Promise<Response>) {
  const { calls, fetchFn } = fakeFetch(respond);
  const onUnauthenticated = vi.fn();
  const api = createApiClient({ fetch: fetchFn, onUnauthenticated });
  return { api, calls, onUnauthenticated };
}

const APP_ID = '01jabcdefghjkmnpqrstvwxyz0';

describe('läsande anrop', () => {
  it('GET me, apps, app och jobb går till rätt relativa sökväg med samma-origin-kakor', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/apps')) return json(200, { apps: [] });
      return json(200, {});
    });
    await api.me();
    await api.listApps();
    await api.getApp(APP_ID);
    await api.getJob('job-1', 7);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BUILDER_API_PREFIX}/me`,
      `GET ${BUILDER_API_PREFIX}/apps`,
      `GET ${BUILDER_API_PREFIX}/apps/${APP_ID}`,
      `GET ${BUILDER_API_PREFIX}/jobs/job-1?after=7`,
    ]);
    for (const call of calls) {
      expect(call.credentials).toBe('same-origin');
      expect(call.headers[CSRF_HEADER], 'läsande anrop behöver inget skyddshuvud').toBeUndefined();
      expect(call.body).toBeUndefined();
    }
  });

  it('listApps packar upp listan', async () => {
    const apps = [{ appId: APP_ID, name: 'Todo', updatedAt: '2026-09-19T10:00:00Z', hasDraft: true, published: false }];
    const { api } = client(() => json(200, { apps }));
    await expect(api.listApps()).resolves.toEqual(apps);
  });

  it('open frågar efter förhandsvisning eller publicerad app och returnerar adressen', async () => {
    const { api, calls } = client(() => json(200, { url: 'https://p-abc.example.se/' }));
    await expect(api.openUrl(APP_ID, 'preview')).resolves.toBe('https://p-abc.example.se/');
    await api.openUrl(APP_ID, 'published');
    expect(calls.map((call) => call.url)).toEqual([
      `${BUILDER_API_PREFIX}/apps/${APP_ID}/open?target=preview`,
      `${BUILDER_API_PREFIX}/apps/${APP_ID}/open?target=published`,
    ]);
  });

  it('en adress som inte är http(s) från servern används aldrig (t.ex. javascript:)', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/', 'inte en adress', '']) {
      const { api } = client(() => json(200, { url, publishedUrl: url }));
      await expect(api.openUrl(APP_ID, 'preview')).rejects.toBeInstanceOf(ApiError);
      await expect(api.publish(APP_ID)).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('skrivande anrop', () => {
  it('skapa app, skicka önskemål, publicera och dela: POST med skyddshuvud och JSON-kropp', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/apps')) return json(201, { appId: APP_ID });
      if (call.url.endsWith('/messages')) return json(202, { jobId: 'job-1' });
      if (call.url.endsWith('/publish')) return json(200, { publishedUrl: 'https://abc.example.se/' });
      return json(200, { shared: true });
    });

    await expect(api.createApp('Todo')).resolves.toEqual({ appId: APP_ID });
    await expect(api.sendMessage(APP_ID, 'En todo-lista')).resolves.toEqual({ jobId: 'job-1' });
    await expect(api.publish(APP_ID)).resolves.toEqual({ publishedUrl: 'https://abc.example.se/' });
    await expect(api.share(APP_ID, 'kollega@example.se')).resolves.toBeUndefined();

    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', `${BUILDER_API_PREFIX}/apps`, JSON.stringify({ name: 'Todo' })],
      ['POST', `${BUILDER_API_PREFIX}/apps/${APP_ID}/messages`, JSON.stringify({ text: 'En todo-lista' })],
      ['POST', `${BUILDER_API_PREFIX}/apps/${APP_ID}/publish`, JSON.stringify({})],
      ['POST', `${BUILDER_API_PREFIX}/apps/${APP_ID}/share`, JSON.stringify({ email: 'kollega@example.se' })],
    ]);
    for (const call of calls) {
      expect(call.headers[CSRF_HEADER]).toBe('1');
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.credentials).toBe('same-origin');
    }
  });

  it('createApp utan namn skickar en tom kropp', async () => {
    const { api, calls } = client(() => json(201, { appId: APP_ID }));
    await api.createApp();
    expect(calls[0]?.body).toBe('{}');
  });
});

describe('adresser', () => {
  it('är alltid relativa till den egna origin — aldrig absoluta eller protokollrelativa', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/apps')) return json(200, { apps: [] });
      if (call.url.includes('/open')) return json(200, { url: 'https://p.example.se/' });
      if (call.url.endsWith('/publish')) return json(200, { publishedUrl: 'https://a.example.se/' });
      return json(200, { appId: APP_ID, jobId: 'j' });
    });
    await api.me();
    await api.listApps();
    await api.createApp();
    await api.getApp(APP_ID);
    await api.sendMessage(APP_ID, 'x');
    await api.getJob('j', 0);
    await api.publish(APP_ID);
    await api.openUrl(APP_ID, 'preview');
    await api.share(APP_ID, 'a@b.se');
    expect(calls.length).toBe(9);
    for (const call of calls) {
      expect(call.url.startsWith(`${BUILDER_API_PREFIX}/`)).toBe(true);
      expect(call.url).not.toMatch(/^[a-z]+:|^\/\//i);
    }
  });

  it('fientliga id:n skickas aldrig — de kunde annars leda anropet till en annan sökväg', async () => {
    const hostile = ['..', '../me', 'a/b', 'a?b=1', 'a#b', '', 'a\u0000b', '%2e%2e', 'å', 'x'.repeat(200)];
    const { api, calls } = client();
    for (const id of hostile) {
      await expect(api.getApp(id)).rejects.toBeInstanceOf(ApiError);
      await expect(api.sendMessage(id, 'x')).rejects.toBeInstanceOf(ApiError);
      await expect(api.getJob(id, 0)).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
  });

  it('after måste vara ett icke-negativt heltal', async () => {
    const { api, calls } = client();
    for (const after of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(api.getJob('j', after)).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
  });
});

describe('fel blir klarspråk', () => {
  it('använder serverns klarspråk när svaret är en ApiErrorBody', async () => {
    const { api } = client(() => json(400, { error: { code: 'invalid_request', message: 'Texten är för lång.' } }));
    const error = await api.sendMessage(APP_ID, 'x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_request', message: 'Texten är för lång.' });
  });

  it.each([
    [403, /behörighet/],
    [404, /finns inte/],
    [429, /Vänta en stund/],
    [500, /Något gick fel/],
    [502, /Något gick fel/],
  ])('status %i utan läsbar kropp ger ett vänligt standardmeddelande', async (status, message) => {
    const { api } = client(() => new Response('<html>Bad gateway</html>', { status }));
    const error = await api.listApps().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).message).toMatch(message);
    expect((error as ApiError).message).not.toMatch(/html|gateway/i);
  });

  it('en förfalskad felkropp med konstig form ignoreras', async () => {
    const { api } = client(() => json(500, { error: { code: 'internal', message: { html: '<b>' } } }));
    const error = (await api.listApps().catch((caught: unknown) => caught)) as ApiError;
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('nätverksfel ger ApiError med status 0 och ett meddelande om uppkopplingen', async () => {
    const { api } = client(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = (await api.me().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/uppkopplingen/);
  });

  it('ett svar som inte är JSON trots 200 blir ett fel, inte ett krasch', async () => {
    const { api } = client(() => new Response('inte json', { status: 200 }));
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });

  it('401 laddar om sidan (gatewayn skickar då till inloggningen) och avbryter anropet', async () => {
    const { api, onUnauthenticated } = client(() =>
      json(401, { error: { code: 'unauthenticated', message: 'Du behöver logga in.' } }),
    );
    const error = (await api.listApps().catch((caught: unknown) => caught)) as ApiError;
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(error.status).toBe(401);
  });
});

describe('åtkomstlistan', () => {
  const MEMBER_ID = 'Qm9ydGlsLXVzZXItaWQwMQ';
  const members = [
    { memberId: 'b3duZXItdXNlci1pZC0wMQ', email: 'anna@example.se', role: 'owner' },
    { memberId: MEMBER_ID, email: 'bertil@example.se', role: 'user' },
  ];

  it('listMembers: GET utan skyddshuvud och packar upp listan i serverns ordning', async () => {
    const { api, calls } = client(() => json(200, { members }));
    await expect(api.listMembers(APP_ID)).resolves.toEqual(members);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BUILDER_API_PREFIX}/apps/${APP_ID}/members`]);
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('removeMember: DELETE med skyddshuvud, samma hantering som övriga skrivande anrop', async () => {
    const { api, calls } = client(() => json(200, { removed: true }));
    await expect(api.removeMember(APP_ID, MEMBER_ID)).resolves.toBeUndefined();
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['DELETE', `${BUILDER_API_PREFIX}/apps/${APP_ID}/members/${MEMBER_ID}`],
    ]);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('fientliga id:n skickas aldrig, varken för appen eller medlemmen', async () => {
    const hostile = ['..', '../me', 'a/b', 'a?b=1', 'a#b', '', 'a\u0000b', '%2e%2e', 'x'.repeat(200)];
    const { api, calls } = client();
    for (const id of hostile) {
      await expect(api.listMembers(id)).rejects.toBeInstanceOf(ApiError);
      await expect(api.removeMember(id, MEMBER_ID)).rejects.toBeInstanceOf(ApiError);
      await expect(api.removeMember(APP_ID, id)).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { members: 'anna@example.se' }],
    ['en rad saknar adress', { members: [{ memberId: MEMBER_ID, role: 'user' }] }],
    ['en rad har okänd roll', { members: [{ memberId: MEMBER_ID, email: 'a@b.se', role: 'admin' }] }],
    ['ett id som inte går att använda i en sökväg', { members: [{ memberId: '../x', email: 'a@b.se', role: 'user' }] }],
  ])('ett svar som %s blir ett fel i klarspråk, inte en trasig vy', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.listMembers(APP_ID).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('serverns fel går igenom som ApiError med status', async () => {
    const { api } = client(() => json(400, { error: { code: 'invalid_request', message: 'Ogiltig begäran.' } }));
    const error = (await api.removeMember(APP_ID, MEMBER_ID).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
  });
});
