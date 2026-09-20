/**
 * Plattformstjänsten `history` (`/_api/history`): ändringshistorik för appars dokument — vem
 * ändrade vad och när.
 *
 *   GET  /_api/history/collections/:name/docs/:id?limit=&cursor=      → { entries, nextCursor? }
 *   GET  /_api/history/collections/:name?since=&limit=&cursor=        → { entries, nextCursor? }
 *   POST /_api/history/collections/:name/docs/:id/restore   { at }    → dokumentet (ny version)
 *
 * Tjänsten SKRIVER ingen historik själv. Historiken skrivs av data-API:t i samma transaktion som
 * varje ändring (se packages/data-api/src/historik.ts) — annars kunde en ändring ske utan rad,
 * eller en rad finnas för en ändring som aldrig blev av. Tjänsten läser genom `store` och
 * lägger bara till visningsnamn. All behörighet (vems dokument, vilken app) avgörs av lagringen
 * utifrån `tenant` och `identity` som gatewayn satt; inget i sökväg, fråga eller kropp påverkar den.
 *
 * Visningsnamnet härleds som i `whoami`: e-postadressens lokala del, aldrig hela adressen. Den
 * som inte längre är medlem i appen visas neutralt.
 */
import { API_ERROR_STATUS, DataApiError } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppService,
  AppServiceDependencies,
  AppServiceFactory,
  AppServiceRequest,
  AppServiceResponse,
  HistoryEntry,
  HistoryPage,
  Identity,
  TenantStore,
} from '@vibesandbox/contracts';

const NAME = 'history';
/** Den enda kroppen tjänsten tar emot är `{ "at": "<ISO-tid>" }`. */
const MAX_BODY_BYTES = 1024;
const FORMER_MEMBER = 'Tidigare användare';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

type HistoryStore = Required<Pick<TenantStore, 'readDocumentHistory' | 'readCollectionHistory' | 'restoreDocument'>>;

class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_request', message);
}

function json(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function errorResponse(status: number, code: ApiErrorCode, message: string): AppServiceResponse {
  return json(status, { error: { code, message } });
}

/** Status för ett fel från lagringen: samma som data-API:t ger. */
function statusFor(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}

/** Frågesträngen: bara tillåtna namn, var och en högst en gång. */
function parseQuery(query: string, allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (query.length === 0) return result;
  for (const [name, value] of new URLSearchParams(query)) {
    if (!allowed.includes(name)) throw invalid('Okänd parameter i frågan.');
    if (result.has(name)) throw invalid('En parameter får bara anges en gång.');
    result.set(name, value);
  }
  return result;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) throw invalid('Ogiltig sidstorlek. Ange ett heltal som är minst 1.');
  return Number(value);
}

function parseRestoreBody(request: AppServiceRequest): string {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) throw invalid('Skicka tidpunkten som JSON.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? new Uint8Array()));
  } catch {
    throw invalid('Skicka tidpunkten som JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid('Skicka { "at": "<tidpunkt>" }.');
  const keys = Object.keys(parsed);
  const at: unknown = (parsed as Record<string, unknown>)['at'];
  if (keys.length !== 1 || keys[0] !== 'at' || typeof at !== 'string') throw invalid('Skicka { "at": "<tidpunkt>" }.');
  return at;
}

function localPart(email: string | null | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : undefined;
}

export const factory: AppServiceFactory = (dependencies: AppServiceDependencies) => {
  const { store } = dependencies;
  if (
    typeof store.readDocumentHistory !== 'function' ||
    typeof store.readCollectionHistory !== 'function' ||
    typeof store.restoreDocument !== 'function'
  ) {
    throw new Error(
      'Tjänsten history kräver att appdatalagringen skapats med historiken påslagen (createTenantStore med valet history).',
    );
  }
  const history = store as unknown as HistoryStore;

  /** Visningsnamn per användar-id: den frågande ur sin identitet, övriga ur appens medlemslista. */
  async function withDisplayNames(
    request: AppServiceRequest,
    page: HistoryPage,
    includeDocumentId: boolean,
  ): Promise<Record<string, unknown>> {
    const names = new Map<string, string>();
    names.set(request.identity.userId, displayNameOf(request.identity));
    if (page.entries.some((entry) => !names.has(entry.userId))) {
      try {
        for (const member of await dependencies.members.members(request.tenant.appId)) {
          if (!names.has(member.userId)) names.set(member.userId, localPart(member.email) ?? FORMER_MEMBER);
        }
      } catch {
        // Medlemslistan är bara till för namnen; historiken ska visas även om den inte gick att läsa.
      }
    }
    const entries = page.entries.map((entry: HistoryEntry) => ({
      ...(includeDocumentId ? { documentId: entry.documentId } : {}),
      event: entry.event,
      at: entry.at,
      userId: entry.userId,
      displayName: names.get(entry.userId) ?? FORMER_MEMBER,
      data: entry.data,
    }));
    return page.nextCursor === undefined ? { entries } : { entries, nextCursor: page.nextCursor };
  }

  async function route(request: AppServiceRequest): Promise<AppServiceResponse> {
    const { method, segments, tenant, identity } = request;
    const [first, collection, docs, id, action, ...rest] = segments;
    if (first !== 'collections' || collection === undefined || rest.length > 0) {
      throw new HttpError(404, 'not_found', 'Det finns inget här.');
    }

    // GET /collections/:name
    if (docs === undefined) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Metoden stöds inte här.');
      const query = parseQuery(request.query, ['since', 'limit', 'cursor']);
      const limit = parseLimit(query.get('limit'));
      const since = query.get('since');
      const cursor = query.get('cursor');
      const page = await history.readCollectionHistory(tenant, identity, collection, {
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return json(200, await withDisplayNames(request, page, true));
    }

    if (docs !== 'docs' || id === undefined) throw new HttpError(404, 'not_found', 'Det finns inget här.');

    // GET /collections/:name/docs/:id
    if (action === undefined) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Metoden stöds inte här.');
      const query = parseQuery(request.query, ['limit', 'cursor']);
      const limit = parseLimit(query.get('limit'));
      const cursor = query.get('cursor');
      const page = await history.readDocumentHistory(tenant, identity, collection, id, {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return json(200, await withDisplayNames(request, page, false));
    }

    // POST /collections/:name/docs/:id/restore
    if (action !== 'restore') throw new HttpError(404, 'not_found', 'Det finns inget här.');
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Metoden stöds inte här.');
    parseQuery(request.query, []);
    const document = await history.restoreDocument(tenant, identity, collection, id, parseRestoreBody(request));
    // Att något återställdes — aldrig vad, i vilket dokument eller av vem.
    dependencies.log({ level: 'info', event: 'history_restore', app: tenant.appId.slice(0, 8) });
    return json(200, document);
  }

  const service: AppService = {
    name: NAME,
    maxBodyBytes: MAX_BODY_BYTES,
    async handle(request) {
      try {
        return await route(request);
      } catch (fel) {
        if (fel instanceof HttpError) return errorResponse(fel.status, fel.code, fel.message);
        // Lagringens fel är redan översatta till klarspråk utan interna detaljer.
        if (fel instanceof DataApiError && fel.code !== 'internal') {
          return errorResponse(statusFor(fel.code), fel.code, fel.message);
        }
        throw fel;
      }
    },
  };
  return { service };
};

function displayNameOf(identity: Identity): string {
  return localPart(identity.email) ?? 'Användare';
}
