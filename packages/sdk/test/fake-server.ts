/**
 * En fejkad plattform att injicera som `fetch`. Den tolkar HTTP-gränssnittet i
 * @vibesandbox/contracts STRIKT — fel metod, sökväg, fråga eller huvud ger ett fel i stället
 * för ett snällt svar — och lagrar i en minnesadapter. Inget nätverk används.
 */
import { API_ERROR_STATUS, API_PREFIX, CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, ApiErrorCode, CollectionScope, JsonObject, WhoAmIResponse } from '@vibesandbox/contracts';
import { createMemoryAdapter, SdkError } from '../src/index.ts';
import type { FetchLike, MemoryAdapter } from '../src/index.ts';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly credentials: string;
}

export interface FakeServer {
  readonly requests: RecordedRequest[];
  /** En `fetch` som bär den användarens session (på riktigt: en kaka webbläsaren sköter). */
  fetchAs(user: WhoAmIResponse): FetchLike;
}

type FakeResponse = Awaited<ReturnType<FetchLike>>;

export function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => structuredClone(body),
  };
}

export function errorResponse(code: ApiErrorCode, message: string): FakeResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(API_ERROR_STATUS[code], body);
}

const DOCS_PATH = new RegExp(`^${API_PREFIX}/collections/([^/]+)/docs(?:/([^/]+))?$`);

export function createFakeServer(): FakeServer {
  const store = createMemoryAdapter();
  const requests: RecordedRequest[] = [];

  return {
    requests,
    fetchAs(user) {
      const session = store.asUser(user);
      return async (url, init) => {
        requests.push({
          url,
          method: init.method,
          headers: { ...init.headers },
          body: init.body,
          credentials: init.credentials,
        });
        try {
          return await route(session, url, init);
        } catch (error) {
          if (error instanceof SdkError && error.code !== 'network') {
            return errorResponse(error.code, error.message);
          }
          throw error;
        }
      };
    },
  };
}

async function route(
  session: MemoryAdapter,
  url: string,
  init: Parameters<FetchLike>[1],
): Promise<FakeResponse> {
  // En absolut URL skulle kunna peka på en annan app eller ut på internet.
  if (!url.startsWith(`${API_PREFIX}/`)) {
    return errorResponse('invalid_request', `Fejkservern tar bara emot relativa sökvägar under ${API_PREFIX}: ${url}`);
  }
  if (init.credentials !== 'same-origin') {
    return errorResponse('unauthenticated', 'Fejkservern kräver credentials: same-origin.');
  }
  const writing = init.method !== 'GET';
  if (writing && init.headers[CSRF_HEADER] === undefined) {
    return errorResponse('forbidden', `Fejkservern kräver huvudet ${CSRF_HEADER} på skrivande anrop.`);
  }

  const parsed = new URL(url, 'https://app.invalid');
  if (parsed.pathname === `${API_PREFIX}/whoami` && init.method === 'GET') {
    return jsonResponse(200, await session.whoami());
  }

  const match = DOCS_PATH.exec(parsed.pathname);
  if (match === null) return errorResponse('not_found', 'Fejkservern känner inte till sökvägen.');
  const collection = decodeURIComponent(match[1] ?? '');
  const id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);

  if (id === undefined) {
    const scope = parsed.searchParams.get('scope');
    if (scope !== 'app' && scope !== 'user') {
      return errorResponse('invalid_request', 'Fejkservern kräver ?scope=app|user.');
    }
    if (init.method === 'GET') {
      const limit = parsed.searchParams.get('limit');
      const cursor = parsed.searchParams.get('cursor');
      return jsonResponse(
        200,
        await session.list(collection, scope satisfies CollectionScope, {
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(cursor === null ? {} : { cursor }),
        }),
      );
    }
    if (init.method === 'POST') {
      return jsonResponse(201, await session.create(collection, scope, readData(init)));
    }
  } else {
    if (init.method === 'GET') return jsonResponse(200, await session.get(collection, id));
    if (init.method === 'PUT') return jsonResponse(200, await session.replace(collection, id, readData(init)));
    if (init.method === 'DELETE') {
      await session.remove(collection, id);
      // 204 har ingen kropp; att läsa den som JSON ska inte krävas av klienten.
      return { status: 204, ok: true, json: async () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) };
    }
  }
  return errorResponse('invalid_request', 'Fejkservern stöder inte metoden på den sökvägen.');
}

function readData(init: Parameters<FetchLike>[1]): JsonObject {
  if (init.headers['content-type'] !== 'application/json' || init.body === undefined) {
    throw new SdkError('invalid_request', 'Fejkservern kräver en JSON-kropp med content-type application/json.');
  }
  const body = JSON.parse(init.body) as { data?: JsonObject };
  if (body.data === undefined) {
    throw new SdkError('invalid_request', 'Fejkservern kräver kroppen { data }.');
  }
  return body.data;
}
