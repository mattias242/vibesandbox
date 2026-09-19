import { API_ERROR_STATUS, API_PREFIX, CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorCode, DocumentPage, StoredDocument, WhoAmIResponse } from '@vibesandbox/contracts';
import type { StorageAdapter } from './adapter.ts';
import { SdkError } from './errors.ts';

/**
 * Den del av `fetch` som adaptern använder. Egen typ, så att SDK:t varken behöver DOM- eller
 * Node-typer och så att tester kan injicera en fejk. Webbläsarens `fetch` passar in som den är.
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: 'same-origin';
  },
) => Promise<{ readonly status: number; readonly ok: boolean; json(): Promise<unknown> }>;

/**
 * Talar med plattformens data-API på appens EGEN origin. Alla adresser är relativa och
 * börjar med `/_api` — adaptern kan inte fås att anropa en annan app eller en extern adress,
 * och vilken app det gäller avgörs av värdnamnet, aldrig av något appen skickar.
 */
export function createPlatformAdapter(options: { readonly fetch?: FetchLike } = {}): StorageAdapter {
  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<unknown> {
    // Slås upp vid anropet, så att modulen går att importera där `fetch` saknas.
    const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const headers: Record<string, string> = { accept: 'application/json' };
    // Skrivande anrop bär CSRF-huvudet: ett formulär på en annan sajt kan inte sätta det.
    if (method !== 'GET') headers[CSRF_HEADER] = '1';
    if (data !== undefined) headers['content-type'] = 'application/json';

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${API_PREFIX}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
      });
    } catch {
      // Orsaken (t.ex. "Failed to fetch") säger inget för en användare och kastas därför inte vidare.
      throw new SdkError('network');
    }

    if (!response.ok) throw await toSdkError(response);
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new SdkError('internal');
    }
  }

  const docsPath = (collection: string, id?: string) =>
    `/collections/${encodeURIComponent(collection)}/docs${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;

  return {
    async whoami() {
      return expectShape(await call('GET', '/whoami'), isWhoAmI);
    },

    async list(collection, scope, options = {}) {
      // Byggs för hand i stället för med URLSearchParams: ordningen blir förutsägbar och inga DOM-typer behövs.
      let query = `?scope=${scope}`;
      if (options.limit !== undefined) query += `&limit=${encodeURIComponent(String(options.limit))}`;
      if (options.cursor !== undefined) query += `&cursor=${encodeURIComponent(options.cursor)}`;
      return expectShape(await call('GET', docsPath(collection) + query), isDocumentPage);
    },

    async create(collection, scope, data) {
      return expectShape(await call('POST', `${docsPath(collection)}?scope=${scope}`, data), isStoredDocument);
    },

    async get(collection, id) {
      return expectShape(await call('GET', docsPath(collection, id)), isStoredDocument);
    },

    async replace(collection, id, data) {
      return expectShape(await call('PUT', docsPath(collection, id), data), isStoredDocument);
    },

    async remove(collection, id) {
      await call('DELETE', docsPath(collection, id));
    },
  };
}

export async function toSdkError(response: Awaited<ReturnType<FetchLike>>): Promise<SdkError> {
  try {
    const body = await response.json();
    if (isRecord(body) && isRecord(body['error'])) {
      const { code, message } = body['error'];
      if (isApiErrorCode(code) && typeof message === 'string' && message.length > 0) {
        return new SdkError(code, message);
      }
    }
  } catch {
    // Ingen JSON-kropp (t.ex. en felsida från en proxy) — statuskoden får avgöra.
  }
  return new SdkError(codeFromStatus(response.status));
}

function codeFromStatus(status: number): ApiErrorCode {
  for (const code of Object.keys(API_ERROR_STATUS) as ApiErrorCode[]) {
    if (API_ERROR_STATUS[code] === status) return code;
  }
  return 'internal';
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERROR_STATUS, value);
}

/** Ett svar med fel form ska bli ett begripligt fel här, inte ett `undefined` långt in i appens kod. */
function expectShape<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new SdkError('internal');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWhoAmI(value: unknown): value is WhoAmIResponse {
  return isRecord(value) && typeof value['userId'] === 'string' && typeof value['displayName'] === 'string';
}

function isStoredDocument(value: unknown): value is StoredDocument {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    isRecord(value['data']) &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function isDocumentPage(value: unknown): value is DocumentPage {
  return (
    isRecord(value) &&
    Array.isArray(value['documents']) &&
    value['documents'].every(isStoredDocument) &&
    (value['nextCursor'] === undefined || typeof value['nextCursor'] === 'string')
  );
}
