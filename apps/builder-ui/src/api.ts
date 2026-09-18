/**
 * En liten klient för byggverktygets HTTP-gränssnitt (se kontraktet, "Byggverktygets
 * HTTP-gränssnitt"). Allt går till RELATIVA adresser under `/_api/builder` på den egna origin,
 * med samma-origin-kakor. Skrivande anrop bär skyddshuvudet, som gatewayn kräver mot CSRF.
 *
 * Fel blir alltid `ApiError` med ett meddelande som går att visa rakt av för användaren.
 */
import {
  BUILDER_API_PREFIX,
  CSRF_HEADER,
  type ApiErrorCode,
  type BuilderAppDetail,
  type BuilderAppSummary,
  type BuilderJob,
  type BuilderMe,
} from '@vibesandbox/contracts';

export class ApiError extends Error {
  /** HTTP-status, eller 0 när servern inte gick att nå. */
  readonly status: number;
  readonly code: ApiErrorCode | undefined;

  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  readonly fetch: typeof fetch;
  /** Anropas vid 401. I webbläsaren: ladda om, så skickar gatewayn till inloggningssidan. */
  readonly onUnauthenticated: () => void;
}

export type OpenTarget = 'preview' | 'published';

export interface ApiClient {
  me(): Promise<BuilderMe>;
  listApps(): Promise<readonly BuilderAppSummary[]>;
  createApp(name?: string): Promise<{ appId: string }>;
  getApp(appId: string): Promise<BuilderAppDetail>;
  sendMessage(appId: string, text: string): Promise<{ jobId: string }>;
  getJob(jobId: string, after: number): Promise<BuilderJob>;
  publish(appId: string): Promise<{ publishedUrl: string }>;
  openUrl(appId: string, target: OpenTarget): Promise<string>;
  share(appId: string, email: string): Promise<void>;
}

export const NETWORK_ERROR_MESSAGE = 'Kunde inte nå servern. Kontrollera uppkopplingen och försök igen.';
const GENERIC_ERROR_MESSAGE = 'Något gick fel hos oss. Försök igen om en stund.';

/** Standardmeddelanden när servern inte skickade ett läsbart fel. */
export function fallbackMessage(status: number): string {
  if (status === 0) return NETWORK_ERROR_MESSAGE;
  if (status === 400) return 'Något i det du skickade stämmer inte. Kontrollera och försök igen.';
  if (status === 401) return 'Du behöver logga in igen.';
  if (status === 403) return 'Du har inte behörighet att göra det här.';
  if (status === 404) return 'Det du letar efter finns inte, eller så har du inte tillgång till det.';
  if (status === 409) return 'Det går inte att göra det just nu. Vänta en stund och försök igen.';
  if (status === 413) return 'Texten är för lång. Försök att korta den.';
  if (status === 429) return 'Du har gjort många försök på kort tid. Vänta en stund och försök igen.';
  return GENERIC_ERROR_MESSAGE;
}

/**
 * Id:n sätts in i sökvägen. Ett id som `..` eller `a/b` skulle leda anropet till en annan
 * sökväg (fetch normaliserar punktsegment), så bara ett snävt teckenförråd godtas.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new ApiError(400, 'Den här appen finns inte.');
  return id;
}

/** Adresser från servern hamnar i en iframe eller en länk — bara http(s) godtas, aldrig `javascript:`. */
function checkHttpUrl(value: unknown): string {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // faller igenom till felet nedan
    }
  }
  throw new ApiError(500, GENERIC_ERROR_MESSAGE);
}

function readErrorBody(body: unknown): { code: ApiErrorCode; message: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string' || message.trim() === '' || message.length > 500) {
    return undefined;
  }
  return { code: code as ApiErrorCode, message };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    if (method === 'POST') {
      headers[CSRF_HEADER] = '1';
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await options.fetch(`${BUILDER_API_PREFIX}${path}`, init);
    } catch {
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      if (response.status === 401) options.onUnauthenticated();
      const error = readErrorBody(parsed);
      throw new ApiError(response.status, error?.message ?? fallbackMessage(response.status), error?.code);
    }
    if (parsed === undefined) throw new ApiError(response.status, GENERIC_ERROR_MESSAGE);
    return parsed as T;
  }

  return {
    me: () => request<BuilderMe>('GET', '/me'),

    listApps: async () => (await request<{ apps: readonly BuilderAppSummary[] }>('GET', '/apps')).apps,

    createApp: (name) => request('POST', '/apps', name === undefined ? {} : { name }),

    getApp: async (appId) => request<BuilderAppDetail>('GET', `/apps/${checkId(appId)}`),

    sendMessage: async (appId, text) => request('POST', `/apps/${checkId(appId)}/messages`, { text }),

    getJob: async (jobId, after) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, fallbackMessage(400));
      return request<BuilderJob>('GET', `/jobs/${checkId(jobId)}?after=${after}`);
    },

    publish: async (appId) => {
      const result = await request<{ publishedUrl?: unknown }>('POST', `/apps/${checkId(appId)}/publish`);
      return { publishedUrl: checkHttpUrl(result.publishedUrl) };
    },

    openUrl: async (appId, target) => {
      const result = await request<{ url?: unknown }>('GET', `/apps/${checkId(appId)}/open?target=${target}`);
      return checkHttpUrl(result.url);
    },

    share: async (appId, email) => {
      await request('POST', `/apps/${checkId(appId)}/share`, { email });
    },
  };
}
