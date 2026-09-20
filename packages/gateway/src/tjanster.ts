/**
 * Plattformstjänster för appar under `/_api/<namn>/…` (contracts `AppService`).
 *
 * Hit kommer en förfrågan först när hyresgäst (ur värdnamnet), inloggning, åtkomst till appen
 * och CSRF är avgjorda i index.ts — samma väg som data-API:t. Tjänsten får `tenant`, `identity`
 * och `access` och kan inte påverka någon av dem. Det tjänsten svarar kontrolleras HELT innan
 * något skrivs: status och huvuden går genom allowlistor, och plattformens skyddshuvuden (satta
 * tidigare i index.ts) skrivs aldrig över.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  APP_SERVICE_NAME_PATTERN,
  MAX_APP_SERVICE_BODY_BYTES,
  RESERVED_APP_SERVICE_NAMES,
} from '@vibesandbox/contracts';
import type { AppAccessRole, AppService, AppServiceRequest, Identity, TenantContext } from '@vibesandbox/contracts';
import { internalError } from './fel.ts';
import { toAuthHeaders } from './huvuden.ts';
import { readBody } from './kropp.ts';
import { describeError } from './logg.ts';
import type { GatewayLogger } from './logg.ts';

/** Samma regel som för byggverktyget: inloggningsuppgifter lämnar aldrig gatewayn. */
const WITHHELD_REQUEST_HEADERS: readonly string[] = ['cookie', 'authorization', 'proxy-authorization'];

const WRITING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE']);

/** Inga omdirigeringar: en tjänst ska aldrig kunna skicka webbläsaren någon annanstans. */
const ALLOWED_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 202, 204, 400, 403, 404, 405, 409, 413, 415, 422, 429, 500, 501, 503, 507,
]);

const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['content-type', 'cache-control', 'content-disposition']);

const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; ?[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/;
const CACHE_CONTROL_PATTERN = /^[a-z0-9=, -]{1,100}$/;
/** Filnamnet utan citattecken, omvänt snedstreck och kontrolltecken — inget att fly ur. */
const CONTENT_DISPOSITION_PATTERN = /^(?:inline|attachment)(?:; filename="[^"\\\u0000-\u001f\u007f]{1,200}")?$/;
const MAX_HEADER_LENGTH = 300;
const DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';

export class AppServiceContractError extends Error {
  constructor(rule: 'shape' | 'status' | 'headers' | 'body') {
    super('Tjänstens svar bröt mot kontraktet.');
    this.name = `AppServiceContractError(${rule})`;
  }
}

/** Tjänsterna efter namn. Kastar vid start om något är fel — aldrig vid första förfrågan. */
export function createServiceTable(services: readonly AppService[] | undefined): ReadonlyMap<string, AppService> {
  const table = new Map<string, AppService>();
  for (const service of services ?? []) {
    if (typeof service !== 'object' || service === null || typeof service.handle !== 'function') {
      throw new Error('Ogiltig tjänst: handle saknas.');
    }
    const { name, maxBodyBytes } = service;
    if (typeof name !== 'string' || !APP_SERVICE_NAME_PATTERN.test(name) || RESERVED_APP_SERVICE_NAMES.has(name)) {
      throw new Error(`Ogiltigt tjänstenamn "${String(name)}".`);
    }
    if (table.has(name)) throw new Error(`Tjänsten "${name}" är angiven två gånger.`);
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0 || maxBodyBytes > MAX_APP_SERVICE_BODY_BYTES) {
      throw new Error(`Tjänsten "${name}": maxBodyBytes ska vara ett heltal mellan 0 och ${MAX_APP_SERVICE_BODY_BYTES}.`);
    }
    table.set(name, service);
  }
  return table;
}

function forwardedHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers = toAuthHeaders(request.headers) as Record<string, string | undefined>;
  for (const name of WITHHELD_REQUEST_HEADERS) delete headers[name];
  return headers;
}

interface CheckedResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer;
}

function checkResponse(candidate: unknown): CheckedResponse {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new AppServiceContractError('shape');
  }
  const { status, headers, body } = candidate as Record<string, unknown>;
  if (typeof status !== 'number' || !ALLOWED_STATUSES.has(status)) throw new AppServiceContractError('status');
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new AppServiceContractError('headers');
  }

  const allowed = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (!ALLOWED_RESPONSE_HEADERS.has(lowered)) continue;
    // Ett tillåtet namn under två skrivsätt ⇒ inget av dem (samma regel som för byggverktyget).
    if (allowed.has(lowered)) throw new AppServiceContractError('headers');
    if (typeof value !== 'string' || value.length > MAX_HEADER_LENGTH) throw new AppServiceContractError('headers');
    const pattern =
      lowered === 'content-type' ? CONTENT_TYPE_PATTERN : lowered === 'cache-control' ? CACHE_CONTROL_PATTERN : CONTENT_DISPOSITION_PATTERN;
    if (!pattern.test(value)) throw new AppServiceContractError('headers');
    allowed.set(lowered, value);
  }

  let payload: Buffer;
  if (body === undefined) payload = Buffer.alloc(0);
  else if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
  else if (body instanceof Uint8Array) payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else throw new AppServiceContractError('body');

  return { status, headers: allowed, body: payload };
}

export interface ServiceRequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly service: AppService;
  /** Segmenten EFTER `/_api/<namn>`. */
  readonly segments: readonly string[];
  readonly query: string;
  readonly tenant: TenantContext;
  readonly identity: Identity;
  readonly access: AppAccessRole;
  readonly log: GatewayLogger;
}

export async function handleServiceRequest(context: ServiceRequestContext): Promise<void> {
  const { request, response, method, service, log } = context;

  // Kroppen läses bara för skrivande metoder, och aldrig mer än tjänstens gräns (413 annars).
  const body = WRITING_METHODS.has(method) ? new Uint8Array(await readBody(request, service.maxBodyBytes)) : undefined;

  const serviceRequest: AppServiceRequest = {
    method,
    segments: context.segments,
    query: context.query,
    headers: forwardedHeaders(request),
    tenant: context.tenant,
    identity: context.identity,
    access: context.access,
    ...(body === undefined ? {} : { body }),
  };

  // Vad tjänsten än kastar blir 500 med fast text; felet loggas utan meddelande.
  let checked: CheckedResponse;
  try {
    checked = checkResponse(await service.handle(serviceRequest));
  } catch (error) {
    log({ level: 'error', event: 'internal_error', method, route: 'service', ...describeError(error) });
    throw internalError();
  }

  response.statusCode = checked.status;
  if (checked.status === 204) {
    response.end();
    return;
  }
  response.setHeader('Content-Type', checked.headers.get('content-type') ?? DEFAULT_CONTENT_TYPE);
  const cacheControl = checked.headers.get('cache-control');
  if (cacheControl !== undefined) response.setHeader('Cache-Control', cacheControl);
  const disposition = checked.headers.get('content-disposition');
  if (disposition !== undefined) response.setHeader('Content-Disposition', disposition);
  response.setHeader('Content-Length', checked.body.length);
  response.end(method === 'HEAD' ? undefined : checked.body);
}
