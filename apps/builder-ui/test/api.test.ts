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
    // Publiceringen står inte längre med här: den ger ingen adress, utan ett väntande ärende.
    // En adress till den publicerade appen finns först när en granskare sagt ja, och kommer då
    // med `getApp`. Se granskningens egna skivor längre ned.
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/', 'inte en adress', '']) {
      const { api } = client(() => json(200, { url }));
      await expect(api.openUrl(APP_ID, 'preview')).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('skrivande anrop', () => {
  it('skapa app, skicka önskemål, begära publicering och dela: POST med skyddshuvud och JSON-kropp', async () => {
    const { api, calls } = client((call) => {
      if (call.url.endsWith('/apps')) return json(201, { appId: APP_ID });
      if (call.url.endsWith('/messages')) return json(202, { jobId: 'job-1' });
      if (call.url.endsWith('/publish')) {
        return json(202, { review: { state: 'vantar', requestedAt: '2026-09-21T09:00:00Z' } });
      }
      return json(200, { shared: true });
    });

    await expect(api.createApp('Todo')).resolves.toEqual({ appId: APP_ID });
    await expect(api.sendMessage(APP_ID, 'En todo-lista')).resolves.toEqual({ jobId: 'job-1' });
    await expect(api.requestReview(APP_ID)).resolves.toEqual({ state: 'vantar', requestedAt: '2026-09-21T09:00:00Z' });
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
      if (call.url.endsWith('/publish')) {
        return json(202, { review: { state: 'vantar', requestedAt: '2026-09-21T09:00:00Z' } });
      }
      return json(200, { appId: APP_ID, jobId: 'j' });
    });
    await api.me();
    await api.listApps();
    await api.createApp();
    await api.getApp(APP_ID);
    await api.sendMessage(APP_ID, 'x');
    await api.getJob('j', 0);
    await api.requestReview(APP_ID);
    await api.openUrl(APP_ID, 'preview');
    await api.share(APP_ID, 'a@b.se');
    await api.sendFeedback(APP_ID, { helpful: true });
    expect(calls.length).toBe(10);
    for (const call of calls) {
      expect(call.url.startsWith(`${BUILDER_API_PREFIX}/`)).toBe(true);
      expect(call.url).not.toMatch(/^[a-z]+:|^\/\//i);
    }
  });

  it('döpa om appen: POST med namnet, och svaret är serverns namn — inte fältets', async () => {
    const { api, calls } = client(() => json(200, { name: 'Bokning av mötesrum' }));
    // Fältet kan ha blanksteg i kanterna; servern trimmar, och det är dess svar vyn visar.
    await expect(api.renameApp(APP_ID, 'Bokning av mötesrum ')).resolves.toEqual({ name: 'Bokning av mötesrum' });
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', `${BUILDER_API_PREFIX}/apps/${APP_ID}/namn`, JSON.stringify({ name: 'Bokning av mötesrum ' })],
    ]);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
  });

  it('fientliga id:n skickas aldrig — de kunde annars leda anropet till en annan sökväg', async () => {
    const hostile = ['..', '../me', 'a/b', 'a?b=1', 'a#b', '', 'a\u0000b', '%2e%2e', 'å', 'x'.repeat(200)];
    const { api, calls } = client();
    for (const id of hostile) {
      await expect(api.getApp(id)).rejects.toBeInstanceOf(ApiError);
      await expect(api.sendMessage(id, 'x')).rejects.toBeInstanceOf(ApiError);
      await expect(api.renameApp(id, 'Rumsbokning')).rejects.toBeInstanceOf(ApiError);
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

describe('återkoppling på byggverktyget', () => {
  it('tumme upp räknas bara: POST med skyddshuvud och enbart helpful', async () => {
    const { api, calls } = client(() => json(200, { received: true }));
    await expect(api.sendFeedback(APP_ID, { helpful: true })).resolves.toBeUndefined();
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', `${BUILDER_API_PREFIX}/apps/${APP_ID}/feedback`, JSON.stringify({ helpful: true })],
    ]);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('tumme ner skickar texten med — inget annat än kontraktets fält', async () => {
    const { api, calls } = client(() => json(200, { received: true }));
    await api.sendFeedback(APP_ID, { helpful: false, text: 'Den förstod inte vad jag menade.' });
    expect(calls[0]?.body).toBe(JSON.stringify({ helpful: false, text: 'Den förstod inte vad jag menade.' }));
  });

  it('gränsen går igenom som ApiError med status 429, så rutan kan säga det i klarspråk', async () => {
    const { api } = client(() => json(429, { error: { code: 'rate_limited', message: 'För många försök.' } }));
    const error = (await api.sendFeedback(APP_ID, { helpful: true }).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('fientliga id:n skickas aldrig', async () => {
    const { api, calls } = client();
    for (const id of ['..', 'a/b', '', 'a?b=1']) {
      await expect(api.sendFeedback(id, { helpful: true })).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
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

/**
 * Kontrollrummet. Två läsande anrop, och hårdare kontroll än någon annan rutt: en app-rad som
 * Applistan bär hela app-id:t och adressen till appen — det är dem länkarna i kontrollrummet
 * byggs av — och just därför prövas de hårdast: id:t mot app-id:ts form, adressen mot http(s).
 */
describe('kontrollrummet', () => {
  const OVERVIEW = {
    apps: 2,
    published: 1,
    drafts: 1,
    users: { admin: 0, builder: 0, viewer: 0 },
    tokens: { input: 100, output: 50, jobs: 7 },
    failedJobs: 1,
  };

  const APP_ID = '01jabcdefghjkmnpqrstvwxyz0';
  const ROW = {
    appId: APP_ID,
    appIdPrefix: '01jabcde',
    appUrl: `https://${APP_ID}.example.se/`,
    name: 'Bokning',
    ownerEmail: 'anna@example.se',
    updatedAt: '2026-09-19T10:00:00Z',
    hasDraft: true,
    published: false,
    members: 3,
    tokens: { input: 10, output: 5 },
  };

  it('GET till rätt relativa adresser med samma-origin-kakor och utan skyddshuvud', async () => {
    const { api, calls } = client((call) => json(200, call.url.endsWith('/admin/appar') ? { apps: [ROW] } : OVERVIEW));
    await api.adminOverview();
    await api.adminApps();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${BUILDER_API_PREFIX}/admin/oversikt`,
      `GET ${BUILDER_API_PREFIX}/admin/appar`,
    ]);
    for (const call of calls) {
      expect(call.credentials).toBe('same-origin');
      expect(call.headers[CSRF_HEADER]).toBeUndefined();
      expect(call.body).toBeUndefined();
    }
  });

  it('översikten och applistan packas upp när de stämmer', async () => {
    const { api } = client((call) => json(200, call.url.endsWith('/admin/appar') ? { apps: [ROW] } : OVERVIEW));
    await expect(api.adminOverview()).resolves.toEqual(OVERVIEW);
    await expect(api.adminApps()).resolves.toEqual([ROW]);
  });

  it('ägare får saknas — då är det null, aldrig en gissning', async () => {
    const { api } = client(() => json(200, { apps: [{ ...ROW, ownerEmail: null }] }));
    const apps = await api.adminApps();
    expect(apps[0]?.ownerEmail).toBeNull();
  });

  it.each([
    ['saknar ett tal', { ...OVERVIEW, drafts: undefined }],
    ['har ett tal som text', { ...OVERVIEW, apps: '2' }],
    ['har ett negativt tal', { ...OVERVIEW, failedJobs: -1 }],
    ['saknar rollerna', { ...OVERVIEW, users: undefined }],
    ['saknar tokens', { ...OVERVIEW, tokens: { input: 1 } }],
  ])('en översikt som %s blir ett fel i klarspråk', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminOverview().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { apps: 'Bokning' }],
    ['en rad saknar namn', { apps: [{ ...ROW, name: undefined }] }],
    ['en rad har fel sorts ägare', { apps: [{ ...ROW, ownerEmail: 7 }] }],
    ['en rad saknar antal personer', { apps: [{ ...ROW, members: undefined }] }],
    ['en rad saknar tokens', { apps: [{ ...ROW, tokens: { input: 1 } }] }],
  ])('en applista som %s blir ett fel i klarspråk', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminApps().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  /**
   * Vägarna in i appen. De föll bort ur den här funktionen en gång, och då blev länken i
   * kontrollrummet `#/app/undefined` — ett fel som inte syntes förrän någon klickade, eftersom ett
   * fält som saknas bara blir `undefined` och inget går sönder högljutt.
   */
  it('app-id:t och adressen till appen följer med — det är dem länkarna byggs av', async () => {
    const { api } = client(() => json(200, { apps: [ROW] }));
    const rad = (await api.adminApps())[0];
    expect(rad?.appId).toBe(APP_ID);
    expect(rad?.appUrl).toBe(`https://${APP_ID}.example.se/`);
  });

  it('en app som aldrig byggts har ingen adress, och null är ett svar — inte ett fel', async () => {
    const { api } = client(() => json(200, { apps: [{ ...ROW, appUrl: null }] }));
    expect((await api.adminApps())[0]?.appUrl).toBeNull();
  });

  it.each([
    ['ett app-id som inte är ett app-id', { ...ROW, appId: '../../admin' }],
    ['ett app-id med fel längd', { ...ROW, appId: '01jabcde' }],
    ['ett app-id som saknas', { ...ROW, appId: undefined }],
    // Prefixet står bredvid länken. Hör de inte ihop pekar raden ut en annan app än den visar.
    ['ett prefix som inte hör till id:t', { ...ROW, appIdPrefix: 'zzzzzzzz' }],
  ])('%s avvisas — id:t blir en fragmentadress och får aldrig kunna bli en annan sökväg', async (_name, rad) => {
    const { api } = client(() => json(200, { apps: [rad] }));
    await expect(api.adminApps()).rejects.toBeInstanceOf(ApiError);
  });

  /** Adressen hamnar i ett `href`. En `javascript:`-adress därifrån vore körbar kod från servern. */
  it.each([
    ['javascript:', { ...ROW, appUrl: 'javascript:alert(1)' }],
    ['data:', { ...ROW, appUrl: 'data:text/html,<script>alert(1)</script>' }],
    ['ingen adress alls', { ...ROW, appUrl: 'inte-en-adress' }],
    ['ett tal', { ...ROW, appUrl: 7 }],
  ])('en adress som är %s avvisas', async (_name, rad) => {
    const { api } = client(() => json(200, { apps: [rad] }));
    await expect(api.adminApps()).rejects.toBeInstanceOf(ApiError);
  });

  it('403 går igenom som ApiError med status, så vyn kan säga varför', async () => {
    const { api } = client(() => json(403, { error: { code: 'forbidden', message: 'Åtkomst nekad.' } }));
    const error = (await api.adminOverview().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  });
});

/**
 * Kontrollrummets adresser och roller. Här finns adminvyns första SKRIVANDE anrop, så
 * skyddshuvudet är det som måste sitta: utan det avvisar gatewayn anropet som CSRF.
 *
 * Svaret kontrolleras lika hårt som applistan. Ett `userId` hamnar i en sökväg, och en `role`
 * som inte är kontraktets styr vilken knapp vyn visar — bägge avvisas innan de nått vyn.
 */
describe('kontrollrummets adresser', () => {
  const USER = {
    userId: 'u-01jabcde',
    email: 'anna@example.se',
    role: 'admin',
    createdAt: '2026-09-01T08:00:00Z',
    self: true,
  };

  it('GET hämtar listan utan skyddshuvud', async () => {
    const { api, calls } = client(() => json(200, { users: [USER] }));
    await expect(api.adminUsers()).resolves.toEqual([USER]);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`GET ${BUILDER_API_PREFIX}/admin/anvandare`);
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.credentials).toBe('same-origin');
  });

  it('inbjudan skickar adress och roll med skyddshuvudet', async () => {
    const invited = { ...USER, userId: 'u-ny', email: 'ny@example.se', role: 'builder', self: false };
    const { api, calls } = client(() => json(201, { user: invited }));
    await expect(api.adminInvite('ny@example.se', 'builder')).resolves.toEqual(invited);

    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`POST ${BUILDER_API_PREFIX}/admin/anvandare`);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ email: 'ny@example.se', role: 'builder' });
  });

  it('en ny roll sätts på personens egen sökväg, också med skyddshuvudet', async () => {
    const changed = { ...USER, userId: 'u-annan', email: 'b@example.se', role: 'viewer', self: false };
    const { api, calls } = client(() => json(200, { user: changed }));
    await expect(api.adminSetRole('u-annan', 'viewer')).resolves.toEqual(changed);

    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`POST ${BUILDER_API_PREFIX}/admin/anvandare/u-annan`);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ role: 'viewer' });
  });

  it('ett id som skulle leda anropet någon annanstans skickas aldrig iväg', async () => {
    const { api, calls } = client(() => json(200, { user: USER }));
    await expect(api.adminSetRole('../andra', 'viewer')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { users: 'anna@example.se' }],
    ['en rad saknar adress', { users: [{ ...USER, email: undefined }] }],
    ['en rad har en roll som inte finns i kontraktet', { users: [{ ...USER, role: 'superadmin' }] }],
    ['en rad saknar vem som frågar', { users: [{ ...USER, self: undefined }] }],
    ['en rad har ett id som inte går att använda i en sökväg', { users: [{ ...USER, userId: '../x' }] }],
  ])('en lista som %s blir ett fel i klarspråk, inte en trasig vy', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminUsers().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it.each([
    ['saknar användaren', {}],
    ['har en roll som inte finns', { user: { ...USER, role: 'owner' } }],
    ['säger inte vem som frågar', { user: { ...USER, self: 'ja' } }],
  ])('ett svar på en ändring som %s avvisas — vyn ändras aldrig på ett trasigt svar', async (_name, body) => {
    const { api } = client(() => json(200, body));
    await expect(api.adminInvite('ny@example.se', 'builder')).rejects.toBeInstanceOf(ApiError);
    await expect(api.adminSetRole('u-annan', 'viewer')).rejects.toBeInstanceOf(ApiError);
  });

  it.each([400, 403, 409, 429])('serverns %i går igenom med sin status, så vyn kan säga varför', async (status) => {
    const { api } = client(() => json(status, { error: { code: 'invalid_request', message: 'Nej.' } }));
    const error = (await api.adminSetRole('u-annan', 'viewer').catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(status);
  });
});

/**
 * Kontrollrummets stoppade önskemål. Svaret bär bara kategori, app-förkortning och tidpunkt —
 * aldrig önskemålets text. Kategorin styr vilken rubrik vyn ritar, så en kategori utanför
 * kontraktet avvisas här: den skulle annars visas som maskintext för en förvaltare, eller
 * alls inte, och listan hade sett kortare ut än den är.
 */
describe('kontrollrummets stoppade önskemål', () => {
  const STOP = { appIdPrefix: '01jabcde', category: 'biometri', at: '2026-09-20T12:00:00Z' };

  it('GET till rätt relativa adress, med kakor och utan skyddshuvud', async () => {
    const { api, calls } = client(() => json(200, { stops: [STOP] }));
    await expect(api.adminStops()).resolves.toEqual([STOP]);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`GET ${BUILDER_API_PREFIX}/admin/stopp`);
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it('en tom lista är ett giltigt svar — ingen har försökt bygga något förbjudet', async () => {
    const { api } = client(() => json(200, { stops: [] }));
    await expect(api.adminStops()).resolves.toEqual([]);
  });

  it('en okänd kategori avvisas i stället för att ritas', async () => {
    const { api } = client(() => json(200, { stops: [{ ...STOP, category: 'nagot-nytt' }] }));
    await expect(api.adminStops()).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { stops: 'biometri' }],
    ['en rad saknar kategori', { stops: [{ ...STOP, category: undefined }] }],
    ['en rad saknar tidpunkt', { stops: [{ ...STOP, at: undefined }] }],
    ['en rad har tom tidpunkt', { stops: [{ ...STOP, at: '' }] }],
    ['en rad saknar app', { stops: [{ ...STOP, appIdPrefix: undefined }] }],
  ])('ett svar som %s blir ett fel i klarspråk', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminStops().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('en rad med mer än förkortningen av app-id:t avvisas, precis som i applistan', async () => {
    const { api } = client(() => json(200, { stops: [{ ...STOP, appIdPrefix: APP_ID }] }));
    await expect(api.adminStops()).rejects.toBeInstanceOf(ApiError);
  });

  it('svaret bär aldrig önskemålets text — ett fält för mycket plockas bort', async () => {
    const { api } = client(() => json(200, { stops: [{ ...STOP, text: 'känn igen ansikten i entrén' }] }));
    const stops = await api.adminStops();
    expect(JSON.stringify(stops)).not.toContain('entrén');
  });
});


/**
 * Kontrollrummets AI-register. Formen kontrolleras lika hårt som applistans, men nivån och källan
 * behandlas annorlunda än stopplistans kategori: ett okänt värde AVVISAS INTE, det läses som det
 * strängaste. Skälet är vad de två listorna svarar på. En okänd kategori i stopplistan går att
 * avvisa utan att något blir osant; ett register som fälls på en enda rad visar en tillsyn
 * ingenting alls, och en rad som ritas som den står vore en gissning åt det ofarliga hållet.
 */
describe('kontrollrummets AI-register', () => {
  const ENTRY = {
    appIdPrefix: '01jabcde',
    name: 'Bokning',
    ownerEmail: 'anna@example.se',
    classification: 'personuppgift',
    source: 'signalord',
    classifiedAt: '2026-09-19T10:00:00Z',
    published: true,
    decommissionedAt: null,
  };

  it('GET till rätt relativa adress, med kakor och utan skyddshuvud', async () => {
    const { api, calls } = client(() => json(200, { entries: [ENTRY] }));
    await expect(api.adminRegister()).resolves.toEqual([ENTRY]);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`GET ${BUILDER_API_PREFIX}/admin/register`);
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it('ett tomt register är ett giltigt svar — ingen har byggt något än', async () => {
    const { api } = client(() => json(200, { entries: [] }));
    await expect(api.adminRegister()).resolves.toEqual([]);
  });

  it('ägare får saknas — då är det null, aldrig en gissning', async () => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, ownerEmail: null }] }));
    const entries = await api.adminRegister();
    expect(entries[0]?.ownerEmail).toBeNull();
  });

  it('en app som aldrig klassats har ingen tidpunkt, och den hittas inte på', async () => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, classifiedAt: null }] }));
    const entries = await api.adminRegister();
    expect(entries[0]?.classifiedAt).toBeNull();
  });

  it.each([
    ['en nivå utanför kontraktet', 'ganska-hemlig'],
    ['en nivå som saknas', undefined],
    ['en nivå som inte är text', 7],
  ])('%s läses som den strängaste, inte som ett fel — fail-closed', async (_name, classification) => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, classification }] }));
    const entries = await api.adminRegister();
    expect(entries[0]?.classification).toBe('kanslig');
  });

  it.each([
    ['en källa utanför kontraktet', 'gissning'],
    ['en källa som saknas', undefined],
  ])('%s betyder att vi inte vet hur nivån sattes', async (_name, source) => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, source }] }));
    const entries = await api.adminRegister();
    expect(entries[0]?.source).toBe('fail-closed');
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { entries: 'Bokning' }],
    ['en rad saknar namn', { entries: [{ ...ENTRY, name: undefined }] }],
    ['en rad har fel sorts ägare', { entries: [{ ...ENTRY, ownerEmail: 7 }] }],
    ['en rad har tom tidpunkt', { entries: [{ ...ENTRY, classifiedAt: '' }] }],
    ['en rad saknar läge', { entries: [{ ...ENTRY, published: undefined }] }],
    ['en rad saknar app', { entries: [{ ...ENTRY, appIdPrefix: undefined }] }],
  ])('ett svar som %s blir ett fel i klarspråk', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminRegister().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('en rad med mer än förkortningen av app-id:t avvisas, precis som i applistan', async () => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, appIdPrefix: APP_ID }] }));
    await expect(api.adminRegister()).rejects.toBeInstanceOf(ApiError);
  });

  it('svaret bär aldrig önskemålets text — ett fält för mycket plockas bort', async () => {
    const { api } = client(() => json(200, { entries: [{ ...ENTRY, text: 'namn och personnummer på alla elever' }] }));
    const entries = await api.adminRegister();
    expect(JSON.stringify(entries)).not.toContain('personnummer');
  });
});


/**
 * Granskningen, sedd från klienten.
 *
 * Två saker skiljer den från kontrollrummets övriga anrop. Svaret på en begäran om publicering är
 * ett VÄNTANDE ärende, aldrig en adress: ägaren publicerar inte, hon ber om att få göra det, och
 * en klient som tog emot "publicerad" i samma andetag skulle visa henne något som inte hänt.
 *
 * Och ett öppnat ärende bär appens KOD. Det är det enda svaret i hela kontrollrummet som gör det,
 * och därför det enda som fälls helt när en fil inte går att lita på: en halv kodbas är värre än
 * ingen, eftersom granskaren då tror att hon läst appen.
 */
describe('begäran om publicering', () => {
  it('går till publiceringsrutten och ger ett väntande ärende, inte en adress', async () => {
    const { api, calls } = client(() => json(202, { review: { state: 'vantar', requestedAt: '2026-09-21T09:00:00Z' } }));
    const review = await api.requestReview(APP_ID);
    expect(review).toEqual({ state: 'vantar', requestedAt: '2026-09-21T09:00:00Z' });
    expect(JSON.stringify(review), 'ingen adress till appen följer med en begäran').not.toMatch(/https?:/);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`POST ${BUILDER_API_PREFIX}/apps/${APP_ID}/publish`);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
  });

  it.each([
    ['ett läge som säger att appen redan publicerats', { review: { state: 'godkand', requestedAt: '2026-09-21T09:00:00Z' } }],
    ['ett läge utanför kontraktet', { review: { state: 'utskickad', requestedAt: '2026-09-21T09:00:00Z' } }],
    ['ingen tidpunkt', { review: { state: 'vantar' } }],
    ['en tom tidpunkt', { review: { state: 'vantar', requestedAt: '' } }],
    ['inget ärende alls', {}],
    ['en gammal publicering med adress', { publishedUrl: 'https://abc.example.se/' }],
  ])('%s blir ett fel i klarspråk — vyn ska aldrig påstå att appen gått ut', async (_name, body) => {
    const { api } = client(() => json(202, body));
    const error = (await api.requestReview(APP_ID).catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });
});

describe('kontrollrummets granskningskö', () => {
  const REVIEW = {
    reviewId: 'a'.repeat(32),
    appIdPrefix: '01jabcde',
    name: 'Bokning',
    ownerEmail: 'anna@example.se',
    classification: 'personuppgift',
    classificationSource: 'signalord',
    state: 'vantar',
    requestedAt: '2026-09-21T09:00:00Z',
    decidedAt: null,
    reason: null,
  };

  it('GET till rätt relativa adress, med kakor och utan skyddshuvud', async () => {
    const { api, calls } = client(() => json(200, { reviews: [REVIEW] }));
    await expect(api.adminReviews()).resolves.toEqual([REVIEW]);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`GET ${BUILDER_API_PREFIX}/admin/granskning`);
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
  });

  it('en tom kö är ett giltigt svar — ingen väntar på besked', async () => {
    const { api } = client(() => json(200, { reviews: [] }));
    await expect(api.adminReviews()).resolves.toEqual([]);
  });

  it('kön bär aldrig koden — den hämtas för ett ärende i taget', async () => {
    const { api } = client(() => json(200, { reviews: [{ ...REVIEW, files: { 'index.html': '<h1>hej</h1>' } }] }));
    const reviews = await api.adminReviews();
    expect(JSON.stringify(reviews)).not.toContain('hej');
  });

  it.each([
    ['en nivå utanför kontraktet', 'ganska-hemlig'],
    ['en nivå som saknas', undefined],
  ])('%s läses som den strängaste — granskaren ska inte se appen som ofarligare än den är', async (_name, value) => {
    const { api } = client(() => json(200, { reviews: [{ ...REVIEW, classification: value }] }));
    const reviews = await api.adminReviews();
    expect(reviews[0]?.classification).toBe('kanslig');
  });

  it('en källa vi inte känner igen betyder att vi inte vet hur nivån sattes', async () => {
    const { api } = client(() => json(200, { reviews: [{ ...REVIEW, classificationSource: 'gissning' }] }));
    const reviews = await api.adminReviews();
    expect(reviews[0]?.classificationSource).toBe('fail-closed');
  });

  it('ett läge vi inte känner igen läses som väntande, alltså som något som behöver en läsare', async () => {
    const { api } = client(() => json(200, { reviews: [{ ...REVIEW, state: 'kanske' }] }));
    const reviews = await api.adminReviews();
    expect(reviews[0]?.state).toBe('vantar');
  });

  it.each([
    ['saknar listan', {}],
    ['listan är inget fält', { reviews: 'Bokning' }],
    ['ett ärende saknar id', { reviews: [{ ...REVIEW, reviewId: undefined }] }],
    ['ett ärende har ett id som inte kan stå i en sökväg', { reviews: [{ ...REVIEW, reviewId: '../me' }] }],
    ['ett ärende saknar namn', { reviews: [{ ...REVIEW, name: undefined }] }],
    ['ett ärende saknar tidpunkt', { reviews: [{ ...REVIEW, requestedAt: '' }] }],
    ['ett ärende bär mer än förkortningen av app-id:t', { reviews: [{ ...REVIEW, appIdPrefix: APP_ID }] }],
  ])('ett svar som %s blir ett fel i klarspråk', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.adminReviews().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('ett öppnat ärende hämtas med sitt id och bär koden', async () => {
    const files = { 'index.html': '<h1>Bokning</h1>', 'app.js': 'console.log(1)' };
    const { api, calls } = client(() => json(200, { review: REVIEW, files }));
    const opened = await api.adminReview(REVIEW.reviewId);
    expect(opened.review).toEqual(REVIEW);
    expect(opened.files).toEqual(files);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(
      `GET ${BUILDER_API_PREFIX}/admin/granskning/${REVIEW.reviewId}`,
    );
  });

  it('ett ärende-id som inte kan stå i en sökväg skickas aldrig', async () => {
    const { api, calls } = client();
    for (const id of ['..', 'a/b', '', 'a?b=1', 'x'.repeat(200)]) {
      await expect(api.adminReview(id)).rejects.toBeInstanceOf(ApiError);
      await expect(api.adminDecide(id, 'godkand')).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['ett filnamn som klättrar i sökvägen', { '../../etc/passwd': 'x' }],
    ['ett filnamn med styrtecken', { 'a\u0000b.js': 'x' }],
    ['ett innehåll som inte är text', { 'index.html': 42 }],
    ['inga filer alls som fält', 'index.html'],
  ])('%s fäller hela svaret — en halv kodbas är värre än ingen', async (_name, files) => {
    const { api } = client(() => json(200, { review: REVIEW, files }));
    await expect(api.adminReview(REVIEW.reviewId)).rejects.toBeInstanceOf(ApiError);
  });

  it('ett godkännande skickar beslutet, och ingen text som råkat stå kvar', async () => {
    const decided = { ...REVIEW, state: 'godkand', decidedAt: '2026-09-21T10:00:00Z' };
    const { api, calls } = client(() => json(200, { review: decided }));
    await expect(api.adminDecide(REVIEW.reviewId, 'godkand')).resolves.toEqual(decided);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe(JSON.stringify({ decision: 'godkand' }));
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
  });

  it('ett nej skickar skälet ordagrant, eftersom ägaren får det ordagrant', async () => {
    const reason = 'Appen sparar personnummer i klartext. Ta bort fältet först.';
    const decided = { ...REVIEW, state: 'avvisad', decidedAt: '2026-09-21T10:00:00Z', reason };
    const { api, calls } = client(() => json(200, { review: decided }));
    await expect(api.adminDecide(REVIEW.reviewId, 'avvisad', reason)).resolves.toEqual(decided);
    expect(calls[0]?.body).toBe(JSON.stringify({ decision: 'avvisad', reason }));
  });

  it('serverns nej till ett nej utan skäl når fram i klarspråk', async () => {
    const { api } = client(() =>
      json(400, { error: { code: 'invalid_request', message: 'Skriv varför appen inte kan publiceras. Ägaren får skälet ordagrant.' } }),
    );
    const error = (await api.adminDecide('b'.repeat(32), 'avvisad').catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/Skriv varför/);
  });
});


/**
 * Avveckling och export, sedda från klienten.
 *
 * Två saker skiljer de här anropen från alla andra i filen. Exporten plockas INTE isär fält för
 * fält — den ritas aldrig, den skrivs till en fil, och att kasta ett fält vi inte känner igen
 * vore att tyst ta bort något ur en export vars hela poäng är att vara fullständig. Det låses
 * nedan med en rad som kontraktet inte känner: den ska komma hela vägen fram.
 *
 * Gallringsbeviset är tvärtom. Siffrorna är hela svaret på vad som försvann, de går inte att
 * räkna om i efterhand, och en siffra som inte är en siffra ska fälla svaret — aldrig bli en
 * nolla som ägaren läser som ett besked om att appen var tom.
 */
describe('export och avveckling', () => {
  const EXPORT = {
    format: 1,
    exportedAt: '2026-09-22T08:00:00Z',
    app: { name: 'Bokning av mötesrum', classification: 'personuppgift', classificationSource: 'signalord', published: true },
    collections: { bokningar: { documents: [{ id: 'r1', rum: 'Stora salen' }], truncated: false } },
    files: [{ id: 'f1', name: 'dagordning.pdf', size: 1024 }],
    conversation: [{ role: 'user', text: 'En lista där vi bokar mötesrum', createdAt: '2026-09-18T08:00:00Z' }],
  };

  const EVIDENCE = {
    appIdPrefix: '01jabcde',
    decommissionedAt: '2026-09-22T08:30:00Z',
    documentsDeleted: 148,
    filesDeleted: 3,
  };

  it('exporten hämtas med GET till appens egen adress, utan skyddshuvud', async () => {
    const { api, calls } = client(() => json(200, EXPORT));
    await expect(api.exportApp(APP_ID)).resolves.toEqual(EXPORT);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`GET ${BUILDER_API_PREFIX}/apps/${APP_ID}/export`);
    expect(calls[0]?.credentials).toBe('same-origin');
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it('inget kastas bort ur exporten — den ska vara fullständig, inte välkänd', async () => {
    const withExtra = { ...EXPORT, gallringsbeslut: 'KS 2026/144' };
    const { api } = client(() => json(200, withExtra));
    const data = (await api.exportApp(APP_ID)) as unknown as Record<string, unknown>;
    expect(data['gallringsbeslut'], 'ett fält vi inte känner igen är inte ett fält att slänga').toBe('KS 2026/144');
  });

  it('ett svar som inte ens är ett objekt blir ett fel, aldrig en tom fil', async () => {
    const { api } = client(() => json(200, 'inget'));
    await expect(api.exportApp(APP_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('avvecklingen skickar appens namn, och ingenting annat', async () => {
    const { api, calls } = client(() => json(200, { evidence: EVIDENCE }));
    await expect(api.decommissionApp(APP_ID, 'Bokning av mötesrum')).resolves.toEqual(EVIDENCE);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(`POST ${BUILDER_API_PREFIX}/apps/${APP_ID}/avveckla`);
    expect(calls[0]?.body).toBe(JSON.stringify({ confirm: 'Bokning av mötesrum' }));
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('1');
  });

  it('serverns nej till fel namn når fram ordagrant — den kontrollen sitter inte bara i vyn', async () => {
    const message = 'Skriv appens namn för att bekräfta att den ska avvecklas: Bokning av mötesrum';
    const { api } = client(() => json(400, { error: { code: 'invalid_request', message } }));
    const error = (await api.decommissionApp(APP_ID, 'bokning av mötesrum').catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(400);
    expect(error.message).toBe(message);
  });

  it('en installation utan appdata säger att funktionen inte är inkopplad, inte att något gått fel', async () => {
    const message = 'Export och avveckling är inte inkopplade i den här installationen.';
    const respond = () => json(503, { error: { code: 'unavailable', message } });
    const { api } = client(respond);
    for (const call of [api.exportApp(APP_ID), api.decommissionApp(APP_ID, 'Bokning av mötesrum')]) {
      const error = (await call.catch((caught: unknown) => caught)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(503);
      expect(error.code).toBe('unavailable');
      expect(error.message, 'serverns egen text är tydligare än vår').toBe(message);
    }
  });

  it('ett 503 utan läsbar text blir ändå ett besked om läget, inte "något gick fel"', async () => {
    const { api } = client(() => json(503, {}));
    const error = (await api.exportApp(APP_ID).catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/går inte att använda just nu/);
  });

  it.each([
    ['saknar bevis', {}],
    ['beviset saknar tidpunkt', { evidence: { ...EVIDENCE, decommissionedAt: '' } }],
    ['beviset saknar räknade uppgifter', { evidence: { ...EVIDENCE, documentsDeleted: undefined } }],
    ['beviset räknar bakåt', { evidence: { ...EVIDENCE, filesDeleted: -1 } }],
    ['beviset räknar i decimaler', { evidence: { ...EVIDENCE, documentsDeleted: 2.5 } }],
    ['beviset bär hela app-id:t', { evidence: { ...EVIDENCE, appIdPrefix: APP_ID } }],
  ])('ett svar som %s blir ett fel — en nolla här läses som att appen var tom', async (_name, body) => {
    const { api } = client(() => json(200, body));
    const error = (await api.decommissionApp(APP_ID, 'Bokning').catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/Något gick fel/);
  });

  it('ett app-id som inte kan stå i en sökväg skickas aldrig', async () => {
    const { api, calls } = client();
    for (const id of ['..', 'a/b', '', 'a?b=1', 'x'.repeat(200)]) {
      await expect(api.exportApp(id)).rejects.toBeInstanceOf(ApiError);
      await expect(api.decommissionApp(id, 'Bokning')).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls).toEqual([]);
  });

  it('registret bär när en app avvecklades, och läser tomt som ett trasigt svar', async () => {
    const entry = {
      appIdPrefix: '01jabcde',
      name: 'Enkät om fikat',
      ownerEmail: 'anna@example.se',
      classification: 'intern',
      source: 'modell',
      classifiedAt: '2026-09-11T09:00:00Z',
      published: false,
      decommissionedAt: '2026-09-14T10:12:00Z',
    };
    const { api } = client(() => json(200, { entries: [entry] }));
    const entries = await api.adminRegister();
    expect(entries[0]?.decommissionedAt).toBe('2026-09-14T10:12:00Z');

    const { api: broken } = client(() => json(200, { entries: [{ ...entry, decommissionedAt: '' }] }));
    await expect(broken.adminRegister()).rejects.toBeInstanceOf(ApiError);
  });
});
