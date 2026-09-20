/**
 * Tjänsten `search`: semantisk sökning i en apps dokument.
 *
 *   POST /_api/search { collection, query, limit?, personal?, fields? } → { results: [{ id, score }] }
 *
 * Säkerhetsbesluten, i korthet:
 * - Vilka dokument som söks avgör data-API:t (`store.listDocuments`) med gatewayns `tenant` och
 *   `identity` — samma regler som när appen själv listar. Kroppen säger bara VILKEN kollektion;
 *   aldrig vilken app eller vilken användare.
 * - Personliga kollektioner har ett index PER ANVÄNDARE (ägaren ingår i nyckeln). En sökning läser,
 *   bäddar in och jämför bara den sökandes egna dokument. Att i stället filtrera ett gemensamt
 *   index efteråt vore också korrekt i svaret, men då skulle arbetet (och därmed svarstiden) bero
 *   på andras dokument, och ett fel i filtret skulle läcka. Med ett eget index finns det inget
 *   annat att läcka: varken träffar, poäng eller tidsskillnader kan påverkas av någon annans text.
 * - Bara dokument som finns i listningen NU kan bli träffar; vektorer för raderade dokument tas bort.
 * - Text maskas (personnummer, telefon, e-post, kort, IBAN) innan den lämnar servern — både
 *   dokument och fråga, så att båda sidor ser likadana ut för modellen.
 * - Loggar innehåller aldrig frågan, dokumentens text, kollektionens namn eller användar-id.
 */
import { createHash } from 'node:crypto';
import { API_ERROR_STATUS, COLLECTION_NAME_PATTERN, DataApiError } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  JsonObject,
  StoredDocument,
  TenantStore,
} from '@vibesandbox/contracts';
import { maskPersonalData } from '@vibesandbox/llm';
import { openSearchDatabase } from './databas.ts';
import type { IndexKey, SearchDatabase } from './databas.ts';
import { EmbeddingError, estimateTokens } from './inbaddning.ts';
import type { Embedder } from './inbaddning.ts';
import { documentText, withPrefix } from './text.ts';

export interface SearchLimits {
  /** Tokens som får bäddas in (dokument och frågor) per app och dygn (UTC). */
  readonly tokensPerAppDay: number;
  /** Fler dokument än så i en kollektion (för den som söker) ⇒ `too_large`. */
  readonly maxDocuments: number;
  readonly queriesPerUserMinute: number;
  /** Tak för sparade vektorer per app (utkast och publicerad tillsammans) — skyddar disken. */
  readonly maxVectorsPerApp: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  tokensPerAppDay: 1_000_000,
  maxDocuments: 5000,
  queriesPerUserMinute: 30,
  maxVectorsPerApp: 25_000,
};

export interface SearchServiceOptions {
  readonly store: TenantStore;
  readonly dataDir: string;
  readonly embedder: Embedder;
  readonly now: () => Date;
  readonly log: AppServiceDependencies['log'];
  readonly limits?: Partial<SearchLimits>;
}

export const MAX_QUERY_CHARS = 1000;
export const DEFAULT_RESULT_LIMIT = 10;
export const MAX_RESULT_LIMIT = 50;
const MAX_FIELDS = 20;
const FIELD_PATTERN = /^[\p{L}\p{N}_-]{1,64}$/u;
/** Kroppen är liten: en fråga på högst 1000 tecken och några fältnamn. */
const MAX_BODY_BYTES = 16 * 1024;
/** Så många texter per anrop till Berget (API:t tar upp till 2048; mindre satser ger jämnare svarstid). */
const BATCH_SIZE = 32;
const PAGE_SIZE = 100;
const BODY_KEYS: ReadonlySet<string> = new Set(['collection', 'query', 'limit', 'personal', 'fields']);

const MESSAGES = {
  invalidBody: 'Sökningen kunde inte läsas. Skicka JSON med minst "collection" och "query".',
  invalidCollection: 'Ogiltigt namn på samlingen. Använd små bokstäver, siffror, bindestreck och understreck.',
  invalidQuery: `Skriv en sökfråga på högst ${MAX_QUERY_CHARS} tecken.`,
  invalidLimit: `"limit" ska vara ett heltal mellan 1 och ${MAX_RESULT_LIMIT}.`,
  invalidPersonal: '"personal" ska vara true eller false.',
  invalidFields: `"fields" ska vara en lista med 1–${MAX_FIELDS} fältnamn.`,
  unknownKey: 'Sökningen innehåller något som inte känns igen. Tillåtna fält: collection, query, limit, personal, fields.',
  queryString: 'Sökningen tar inga parametrar i adressen.',
  contentType: 'Sökningen ska skickas som JSON.',
  method: 'Sökningen görs med POST.',
  notFound: 'Det finns ingen sådan sökväg.',
  rateLimited: 'Du har sökt många gånger på kort tid. Vänta en minut och försök igen.',
  quotaTokens: 'Appen har sökt och indexerat så mycket i dag att dagens kvot är slut. Försök igen i morgon.',
  quotaVectors: 'Appen har redan så många sökbara dokument som plattformen tillåter. Ta bort gamla dokument och försök igen.',
  tooMany: (max: number) => `Samlingen har fler än ${max} dokument, och så stora samlingar går inte att söka i. Dela upp den i flera mindre.`,
  unavailable: 'Sökningen går inte att använda just nu. Försök igen om en stund.',
  internal: 'Något gick fel med sökningen. Försök igen om en stund.',
} as const;

class SearchFailure extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message: string) => new SearchFailure(400, 'invalid_request', message);

function respond(status: number, body: unknown): AppServiceResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function failure(error: SearchFailure): AppServiceResponse {
  return respond(error.status, { error: { code: error.code, message: error.message } });
}

interface SearchInput {
  readonly collection: string;
  readonly query: string;
  readonly limit: number;
  readonly personal: boolean;
  readonly fields: readonly string[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInput(request: AppServiceRequest): SearchInput {
  if (request.query !== '') throw invalid(MESSAGES.queryString);
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new SearchFailure(415, 'invalid_request', MESSAGES.contentType);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? new Uint8Array()));
  } catch {
    throw invalid(MESSAGES.invalidBody);
  }
  if (!isRecord(body)) throw invalid(MESSAGES.invalidBody);
  for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) throw invalid(MESSAGES.unknownKey);

  const { collection, query, limit, personal, fields } = body;
  if (typeof collection !== 'string' || !COLLECTION_NAME_PATTERN.test(collection)) throw invalid(MESSAGES.invalidCollection);
  if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_CHARS || query.includes('\u0000') || !query.isWellFormed()) {
    throw invalid(MESSAGES.invalidQuery);
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT)) {
    throw invalid(MESSAGES.invalidLimit);
  }
  if (personal !== undefined && typeof personal !== 'boolean') throw invalid(MESSAGES.invalidPersonal);
  if (
    fields !== undefined &&
    (!Array.isArray(fields) ||
      fields.length === 0 ||
      fields.length > MAX_FIELDS ||
      !fields.every((field): field is string => typeof field === 'string' && FIELD_PATTERN.test(field)))
  ) {
    throw invalid(MESSAGES.invalidFields);
  }
  return {
    collection,
    query: query.trim(),
    limit: limit ?? DEFAULT_RESULT_LIMIT,
    personal: personal === true,
    fields: fields === undefined ? undefined : [...new Set(fields as string[])],
  };
}

/** Enhetslängd, så att cosinuslikhet blir en skalärprodukt. En nollvektor lämnas som den är. */
function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** Maskar fail-closed: kastar maskningen skickas ingenting. */
function mask(text: string): string {
  try {
    return maskPersonalData(text).text;
  } catch {
    throw new SearchFailure(503, 'unavailable', MESSAGES.unavailable);
  }
}

function fingerprint(model: string, text: string): string {
  return createHash('sha256').update(model).update('\u0000').update(text).digest('hex');
}

/** Frågor per användare, i ett glidande fönster på en minut. Bara i minnet: en omstart nollställer. */
function createRateLimiter(perMinute: number) {
  const windows = new Map<string, number[]>();
  return {
    allow(key: string, nowMs: number): boolean {
      if (windows.size > 10_000) {
        for (const [k, times] of windows) if ((times.at(-1) ?? 0) <= nowMs - 60_000) windows.delete(k);
      }
      const times = (windows.get(key) ?? []).filter((t) => t > nowMs - 60_000);
      if (times.length >= perMinute) {
        windows.set(key, times);
        return false;
      }
      times.push(nowMs);
      windows.set(key, times);
      return true;
    },
  };
}

export function createSearchService(options: SearchServiceOptions): AppService {
  const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, ...options.limits };
  const { store, embedder, now, log } = options;
  const db: SearchDatabase = openSearchDatabase(options.dataDir);
  const rateLimiter = createRateLimiter(limits.queriesPerUserMinute);
  /** En indexering åt gången per index: två samtidiga sökningar ska inte bädda in samma sak två gånger. */
  const locks = new Map<string, Promise<unknown>>();

  const day = () => now().toISOString().slice(0, 10);

  function assertTokensLeft(appId: string): void {
    if (db.tokensUsed(appId, day()) >= limits.tokensPerAppDay) throw new SearchFailure(429, 'quota_exceeded', MESSAGES.quotaTokens);
  }

  async function embed(appId: string, texts: readonly string[]): Promise<Float32Array[]> {
    assertTokensLeft(appId);
    let result;
    try {
      result = await embedder.embed(texts);
    } catch (error) {
      log({ level: 'warn', event: 'search_provider_error', app: appId.slice(0, 8), reason: error instanceof EmbeddingError ? error.code : 'unexpected' });
      throw new SearchFailure(503, 'unavailable', MESSAGES.unavailable);
    }
    db.addTokens(appId, day(), Number.isFinite(result.tokens) && result.tokens >= 0 ? result.tokens : estimateTokens(texts));
    if (result.vectors.length !== texts.length) throw new SearchFailure(503, 'unavailable', MESSAGES.unavailable);
    return result.vectors.map(normalize);
  }

  async function listAll(request: AppServiceRequest, input: SearchInput): Promise<StoredDocument[]> {
    const documents: StoredDocument[] = [];
    let cursor: string | undefined;
    const scope = input.personal ? 'user' : 'app';
    for (;;) {
      let page;
      try {
        page = await store.listDocuments(request.tenant, request.identity, input.collection, scope, {
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        if (error instanceof DataApiError) {
          // `quota_exceeded` har 507, som gatewayn inte släpper igenom; listning ger den aldrig ändå.
          const status = error.code === 'quota_exceeded' ? 429 : API_ERROR_STATUS[error.code];
          throw new SearchFailure(status, error.code, error.message);
        }
        throw error;
      }
      documents.push(...page.documents);
      if (documents.length > limits.maxDocuments) throw new SearchFailure(413, 'too_large', MESSAGES.tooMany(limits.maxDocuments));
      cursor = page.nextCursor;
      if (cursor === undefined || page.documents.length === 0) return documents;
    }
  }

  /** Bäddar in det som saknas eller ändrats och tar bort det som försvunnit. Ger doc-id → avtryck. */
  async function refreshIndex(key: IndexKey, documents: readonly StoredDocument[], fields: SearchInput['fields']): Promise<{ current: Map<string, string>; embedded: number }> {
    const current = new Map<string, string>();
    const pending: { docId: string; text: string; fingerprint: string }[] = [];
    const known = db.fingerprints(key);
    for (const document of documents) {
      const raw = documentText(document.data as JsonObject, fields);
      if (raw === '') continue;
      const text = withPrefix(embedder.model, 'passage', mask(raw));
      const print = fingerprint(embedder.model, text);
      current.set(document.id, print);
      if (known.get(document.id) !== print) pending.push({ docId: document.id, text, fingerprint: print });
    }
    db.removeExcept(key, new Set(current.keys()));

    const newRows = pending.filter((p) => !known.has(p.docId)).length;
    if (newRows > 0 && db.vectorCount(key.appId) + newRows > limits.maxVectorsPerApp) {
      throw new SearchFailure(429, 'quota_exceeded', MESSAGES.quotaVectors);
    }

    // Satsvis, och varje sats sparas direkt: blir det fel halvvägs är det som hunnit bäddas in kvar.
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const vectors = await embed(key.appId, batch.map((p) => p.text));
      db.upsert(key, batch.map((p, i) => ({ docId: p.docId, fingerprint: p.fingerprint, vector: vectors[i]! })));
    }
    return { current, embedded: pending.length };
  }

  async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(name) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    locks.set(name, tail);
    try {
      return await run;
    } finally {
      if (locks.get(name) === tail) locks.delete(name);
    }
  }

  async function search(request: AppServiceRequest): Promise<AppServiceResponse> {
    if (request.segments.length > 0) throw new SearchFailure(404, 'not_found', MESSAGES.notFound);
    if (request.method !== 'POST') throw new SearchFailure(405, 'method_not_allowed', MESSAGES.method);
    const input = parseInput(request);
    const { appId, kind } = request.tenant;
    const app = appId.slice(0, 8);

    if (!rateLimiter.allow(`${appId}\u0000${request.identity.userId}`, now().getTime())) {
      log({ level: 'info', event: 'search_rate_limited', app });
      throw new SearchFailure(429, 'rate_limited', MESSAGES.rateLimited);
    }
    assertTokensLeft(appId);

    const started = Date.now();
    const documents = await listAll(request, input);
    const key: IndexKey = { appId, kind, collection: input.collection, owner: input.personal ? `user:${request.identity.userId}` : 'app' };
    const lockName = [key.appId, key.kind, key.collection, key.owner].join('\u0000');
    const { current, embedded } = await withLock(lockName, () => refreshIndex(key, documents, input.fields));

    let results: { id: string; score: number }[] = [];
    if (current.size > 0) {
      const [queryVector] = await embed(appId, [withPrefix(embedder.model, 'query', mask(input.query))]);
      const scored: { id: string; score: number }[] = [];
      for (const row of db.vectors(key)) {
        if (current.get(row.docId) !== row.fingerprint || row.vector.length !== queryVector!.length) continue;
        scored.push({ id: row.docId, score: dot(queryVector!, row.vector) });
      }
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      results = scored.slice(0, input.limit).map((r) => ({ id: r.id, score: Math.round(r.score * 10_000) / 10_000 }));
    }
    log({ level: 'info', event: 'search_done', app, kind, documents: current.size, embedded, results: results.length, ms: Date.now() - started });
    return respond(200, { results });
  }

  return {
    name: 'search',
    maxBodyBytes: MAX_BODY_BYTES,
    async handle(request) {
      try {
        return await search(request);
      } catch (error) {
        if (error instanceof SearchFailure) return failure(error);
        log({ level: 'error', event: 'search_failed', app: request.tenant.appId.slice(0, 8), reason: error instanceof Error ? error.name : 'unknown' });
        return failure(new SearchFailure(500, 'internal', MESSAGES.internal));
      }
    },
    async close() {
      db.close();
    },
  };
}
