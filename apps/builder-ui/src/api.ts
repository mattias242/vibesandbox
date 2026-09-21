/**
 * En liten klient för byggverktygets HTTP-gränssnitt (se kontraktet, "Byggverktygets
 * HTTP-gränssnitt"). Allt går till RELATIVA adresser under `/_api/builder` på den egna origin,
 * med samma-origin-kakor. Skrivande anrop bär skyddshuvudet, som gatewayn kräver mot CSRF.
 *
 * Fel blir alltid `ApiError` med ett meddelande som går att visa rakt av för användaren.
 */
import {
  ADMIN_APP_ID_PREFIX_LENGTH,
  BUILDER_API_PREFIX,
  CSRF_HEADER,
  type AdminApp,
  type AdminOverview,
  type AdminUser,
  type ApiErrorCode,
  type BuilderAppDetail,
  type BuilderAppMember,
  type BuilderAppSummary,
  type BuilderFeedback,
  type BuilderJob,
  type BuilderMe,
  type Role,
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
  /**
   * Återkoppling på byggverktyget självt, till den som driver plattformen. `helpful: false`
   * kräver text och mejlas med hela konversationen om appen; `helpful: true` räknas bara.
   */
  sendFeedback(appId: string, feedback: BuilderFeedback): Promise<void>;
  /** Vilka som har åtkomst till appen, ägaren först. */
  listMembers(appId: string): Promise<readonly BuilderAppMember[]>;
  /** Tar bort en persons åtkomst. Gäller direkt. */
  removeMember(appId: string, memberId: string): Promise<void>;
  /** Kontrollrummet: plattformens siffror. Kräver rollen `admin`; annars 403 från servern. */
  adminOverview(): Promise<AdminOverview>;
  /** Kontrollrummet: alla appar, senast ändrad först. Aldrig hela app-id:t. */
  adminApps(): Promise<readonly AdminApp[]>;
  /** Kontrollrummet: alla adresser som får logga in, och med vilken roll. */
  adminUsers(): Promise<readonly AdminUser[]>;
  /**
   * Bjuder in adressen, eller höjer rollen om den redan finns. Servern svarar likadant i båda
   * fallen, så vyn avgör själv vilket det var genom att se efter i listan den redan har.
   */
  adminInvite(email: string, role: Role): Promise<AdminUser>;
  /** Sätter rollen rakt av — den enda vägen att sänka. Den egna raden avvisas av servern. */
  adminSetRole(userId: string, role: Role): Promise<AdminUser>;
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

function checkId(id: string, message = 'Den här appen finns inte.'): string {
  if (!ID_PATTERN.test(id)) throw new ApiError(400, message);
  return id;
}

/**
 * Åtkomstlistan styr vilka knappar som visas och vilket id som hamnar i en sökväg vid borttagning,
 * så varje rad kontrolleras. En rad som inte stämmer gör hela svaret ogiltigt.
 */
function checkMembers(value: unknown): readonly BuilderAppMember[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    const { memberId, email, role } = item as Record<string, unknown>;
    if (
      typeof memberId !== 'string' ||
      !ID_PATTERN.test(memberId) ||
      typeof email !== 'string' ||
      email === '' ||
      email.length > 254 ||
      (role !== 'owner' && role !== 'user')
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return { memberId, email, role };
  });
}

/** Ett antal från servern: ett helt tal som inte kan vara negativt. Allt annat är ett trasigt svar. */
function checkCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value as Record<string, unknown>;
}

/** Kontrollrummets siffror. Ett fält som saknas blir ett fel, aldrig en nolla som ser ut som ett svar. */
function checkOverview(value: unknown): AdminOverview {
  const body = fields(value);
  const users = fields(body['users']);
  const tokens = fields(body['tokens']);
  return {
    apps: checkCount(body['apps']),
    published: checkCount(body['published']),
    drafts: checkCount(body['drafts']),
    users: {
      admin: checkCount(users['admin']),
      builder: checkCount(users['builder']),
      viewer: checkCount(users['viewer']),
    },
    tokens: {
      input: checkCount(tokens['input']),
      output: checkCount(tokens['output']),
      jobs: checkCount(tokens['jobs']),
    },
    failedJobs: checkCount(body['failedJobs']),
  };
}

/**
 * Kontrollrummets applista. Hela app-id:t är appens hemliga adress, så en rad som bär mer än de
 * första `ADMIN_APP_ID_PREFIX_LENGTH` tecknen avvisas här — innan den nått en vy som kunde visa
 * den. Radens fält plockas ett och ett: bara kontraktets fält går vidare.
 */
function checkAdminApps(value: unknown): readonly AdminApp[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    const row = fields(item);
    const { appIdPrefix, name, ownerEmail, updatedAt, hasDraft, published } = row;
    const tokens = fields(row['tokens']);
    if (
      typeof appIdPrefix !== 'string' ||
      appIdPrefix.length === 0 ||
      appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
      !ID_PATTERN.test(appIdPrefix) ||
      typeof name !== 'string' ||
      name === '' ||
      name.length > 200 ||
      (ownerEmail !== null && (typeof ownerEmail !== 'string' || ownerEmail === '' || ownerEmail.length > 254)) ||
      typeof updatedAt !== 'string' ||
      typeof hasDraft !== 'boolean' ||
      typeof published !== 'boolean'
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return {
      appIdPrefix,
      name,
      ownerEmail,
      updatedAt,
      hasDraft,
      published,
      members: checkCount(row['members']),
      tokens: { input: checkCount(tokens['input']), output: checkCount(tokens['output']) },
    };
  });
}

/**
 * En rad ur kontrollrummets adresslista. Hårdare än den ser ut: `userId` hamnar i sökvägen när en
 * roll sätts, och `role` styr vilken knapp vyn visar — en roll utanför kontraktet skulle lämna
 * vyn i ett läge den inte kan rita. `self` avgör om raden får en knapp alls, så en rad utan det
 * fältet är inte ett tomt värde utan ett trasigt svar.
 */
function checkAdminUser(value: unknown): AdminUser {
  const row = fields(value);
  const { userId, email, role, createdAt, self } = row;
  if (
    typeof userId !== 'string' ||
    !ID_PATTERN.test(userId) ||
    typeof email !== 'string' ||
    email === '' ||
    email.length > 254 ||
    (role !== 'admin' && role !== 'builder' && role !== 'viewer') ||
    typeof createdAt !== 'string' ||
    createdAt === '' ||
    typeof self !== 'boolean'
  ) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  return { userId, email, role, createdAt, self };
}

function checkAdminUsers(value: unknown): readonly AdminUser[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => checkAdminUser(item));
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
  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    // Alla skrivande anrop behandlas lika: skyddshuvud och en JSON-kropp (tom när inget skickas).
    if (method !== 'GET') {
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

    sendFeedback: async (appId, feedback) => {
      // Kroppen byggs fält för fält: bara kontraktets två fält går iväg, aldrig något som
      // råkat följa med objektet. Texten utelämnas helt när den saknas (tumme upp).
      const body: { helpful: boolean; text?: string } = { helpful: feedback.helpful };
      if (feedback.text !== undefined) body.text = feedback.text;
      await request('POST', `/apps/${checkId(appId)}/feedback`, body);
    },

    listMembers: async (appId) => {
      const result = await request<{ members?: unknown }>('GET', `/apps/${checkId(appId)}/members`);
      return checkMembers(result.members);
    },

    removeMember: async (appId, memberId) => {
      const path = `/apps/${checkId(appId)}/members/${checkId(memberId, 'Den personen finns inte i listan.')}`;
      await request('DELETE', path);
    },

    adminOverview: async () => checkOverview(await request<unknown>('GET', '/admin/oversikt')),

    adminApps: async () => checkAdminApps((await request<{ apps?: unknown }>('GET', '/admin/appar')).apps),

    adminUsers: async () => checkAdminUsers((await request<{ users?: unknown }>('GET', '/admin/anvandare')).users),

    adminInvite: async (email, role) => {
      // Kroppen byggs fält för fält: bara adressen och rollen går iväg.
      const result = await request<{ user?: unknown }>('POST', '/admin/anvandare', { email, role });
      return checkAdminUser(result.user);
    },

    adminSetRole: async (userId, role) => {
      const path = `/admin/anvandare/${checkId(userId, 'Den personen finns inte i listan.')}`;
      return checkAdminUser((await request<{ user?: unknown }>('POST', path, { role })).user);
    },
  };
}
