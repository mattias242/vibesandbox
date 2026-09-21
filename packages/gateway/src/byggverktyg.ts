/**
 * Byggverktygets värd `bygg.<previewDomain>` (ADR 0002). Hit kommer en förfrågan först när
 * skyddshuvuden, form, värdnamn, service worker-spärr och inloggning är avgjorda (index.ts).
 * Här återstår, i den ordningen:
 *
 *   1. STRIKT CSRF — skrivande metoder kräver skyddshuvudet OCH att `Origin` FINNS och är EXAKT
 *      byggverktygets origin. Striktare än i apparna, där `Origin` får saknas: alla värdar är
 *      same-site, så `SameSite` skyddar inte (mätt i spik S1), och på andra sidan står opålitlig
 *      kod i förhandsvisningar. Saknat `Origin` betyder att vi inte VET varifrån anropet kommer.
 *   2. sökväg och fråga — samma rena tolkning som för appar; dubbla parametrar ⇒ 400
 *   3. kropp — samma gräns som för appar (`MAX_REQUEST_BODY_BYTES`), och bara för skrivande metoder
 *   4. `handler.handle(PlatformRequest)`
 *
 * Handlern är plattformskod, men dess svar behandlas som opålitlig UTDATA av samma skäl som
 * identitetsleverantörens (inloggningsrutt.ts): ett enda slarvfel där — ett `Set-Cookie` med
 * `Domain=`, ett `Access-Control-Allow-Origin` — vore ett hål för alla syskonvärdar. Därför går
 * status och huvuden genom allowlistor, och ett svar som bryter mot kontraktet blir 500.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BUILDER_HOST_LABEL, CSRF_HEADER, MAX_REQUEST_BODY_BYTES, builderContentSecurityPolicy } from '@vibesandbox/contracts';
import type { BuilderHandler, Identity, PlatformRequest } from '@vibesandbox/contracts';
import { forbidden, internalError, invalidRequest } from './fel.ts';
import { toAuthHeaders } from './huvuden.ts';
import { parseQuery } from './inloggningsrutt.ts';
import { describeError } from './logg.ts';
import type { GatewayLogger } from './logg.ts';
import type { NormalizedTarget } from './sokvag.ts';
import { readBody } from './kropp.ts';

export interface BuilderOptions {
  readonly handler: BuilderHandler;
  /**
   * Byggverktygets EXAKTA origin, som webbläsaren skriver den i `Origin`: `http://bygg.localtest.me:8787`
   * lokalt, `https://bygg.example.org` i drift. Används för CSRF-kontrollen, för förhandsvisningarnas
   * `frame-ancestors` och för byggverktygets `frame-src`.
   */
  readonly origin: string;
}

/** Det som räknas fram EN gång vid start. */
export interface BuilderConfig {
  readonly handler: BuilderHandler;
  readonly origin: string;
  readonly contentSecurityPolicy: string;
}

/** Inklusive PATCH, som formkontrollen redan nekar: skyddet ska inte hänga på den listan. */
const WRITING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Huvuden som aldrig lämnas till handlern. Den får veta VEM som frågar genom `identity`; själva
 * sessionen (kakor, `Authorization`) har den inget att göra med, och det som inte skickas kan
 * inte läcka ut i en logg eller ett svar.
 */
const WITHHELD_REQUEST_HEADERS: readonly string[] = ['cookie', 'authorization', 'proxy-authorization'];

/**
 * Samma tillåtna statusar som kontraktet beskriver. Inga omdirigeringar (en 3xx med ett mål
 * handlern hittat på vore en öppen omdirigering), inga 1xx, inget 502/504 som ser ut att komma
 * från en proxy.
 */
export const ALLOWED_BUILDER_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 202, 204, 400, 401, 403, 404, 405, 409, 413, 429, 500, 501, 503,
]);

/**
 * Svarshuvuden handlern får ange (gemener). `cache-control` står här för att kontraktet nämner
 * det, men skyddshuvudet `Cache-Control: no-store` vinner ALLTID: handlerns värde tas emot,
 * kontrolleras för dubbletter och kastas sedan. Allt bakom inloggning ska vara ocachat.
 */
const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['content-type', 'cache-control']);

/** `typ/undertyp` följt av parametrar, bara HTTP-tokentecken: inga blanktecken utöver ett efter `;`. */
const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; ?[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/;
const MAX_CONTENT_TYPE_LENGTH = 200;
const DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * Handlerns svar bröt mot kontraktet. Oväntat ⇒ 500 `internal` och en felrad i loggen. Namnet
 * bär vilken regel som bröts, aldrig värdet.
 */
export class BuilderContractError extends Error {
  constructor(rule: 'shape' | 'status' | 'headers' | 'content-type' | 'body') {
    super('Byggverktygets svar bröt mot kontraktet.');
    this.name = `BuilderContractError(${rule})`;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Kontrollerar `builder` vid start och räknar fram byggverktygets CSP. Kastar vid fel: en origin
 * som aldrig kan matcha webbläsarens `Origin` (avslutande snedstreck, standardport, versaler)
 * skulle annars ge ett byggverktyg där varje skrivande anrop nekas, och en origin på fel domän
 * skulle ge förhandsvisningar som ramas in av fel värd.
 */
export function createBuilderConfig(options: BuilderOptions, previewDomain: string): BuilderConfig {
  if (typeof options !== 'object' || options === null || typeof options.handler?.handle !== 'function') {
    throw new Error('Ogiltig inställning builder: handler.handle saknas.');
  }
  const pattern = new RegExp(
    `^(https?)://${escapeRegExp(`${BUILDER_HOST_LABEL}.${previewDomain}`)}(?::([1-9][0-9]{0,4}))?$`,
  );
  const match = typeof options.origin === 'string' ? pattern.exec(options.origin) : null;
  const scheme = match?.[1];
  const port = match?.[2];
  const defaultPort = scheme === 'https' ? '443' : '80';
  if (match === null || scheme === undefined || (port !== undefined && (Number(port) > 65535 || port === defaultPort))) {
    throw new Error(
      `Ogiltig inställning builder.origin: ska vara exakt <http|https>://${BUILDER_HOST_LABEL}.${previewDomain}[:port], ` +
        'som webbläsaren skriver den i Origin (gemener, ingen standardport, inget snedstreck).',
    );
  }
  // Förhandsvisningarna ligger på samma domän, med samma schema och port som byggverktyget.
  const previewFrameSource = `${scheme}://*.${previewDomain}${port === undefined ? '' : `:${port}`}`;
  return {
    handler: options.handler,
    origin: options.origin,
    contentSecurityPolicy: builderContentSecurityPolicy(previewFrameSource),
  };
}

function assertStrictCsrfProtection(request: IncomingMessage, origin: string): void {
  const marker = request.headers[CSRF_HEADER];
  if (typeof marker !== 'string' || marker.length === 0) {
    throw forbidden('Anropet saknar plattformens skyddshuvud och nekades.');
  }
  // Exakt strängjämförelse — ingen tolkning. `null`, en annan port eller en förhandsvisning ⇒ nej.
  if (request.headers.origin !== origin) {
    throw forbidden('Anropet kom inte från byggverktyget och nekades.');
  }
}

function forwardedHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers = toAuthHeaders(request.headers) as Record<string, string | undefined>;
  for (const name of WITHHELD_REQUEST_HEADERS) delete headers[name];
  return headers;
}

interface CheckedBuilderResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

/** Hela kontrollen görs FÖRE första skrivningen, så att ett underkänt svar inte lämnar spår. */
function checkBuilderResponse(candidate: unknown): CheckedBuilderResponse {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new BuilderContractError('shape');
  }
  const { status, headers, body } = candidate as Record<string, unknown>;
  if (typeof status !== 'number' || !ALLOWED_BUILDER_STATUSES.has(status)) throw new BuilderContractError('status');
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new BuilderContractError('headers');
  }

  // Samma regel som för inloggningsrutterna: ett tillåtet namn under två skrivsätt ⇒ inget av dem.
  const allowed = new Map<string, unknown>();
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (!ALLOWED_RESPONSE_HEADERS.has(lowered)) continue;
    if (allowed.has(lowered)) throw new BuilderContractError('headers');
    if (typeof value !== 'string') throw new BuilderContractError('headers');
    allowed.set(lowered, value);
  }

  let contentType: string | undefined;
  if (allowed.has('content-type')) {
    const value = allowed.get('content-type') as string;
    if (value.length > MAX_CONTENT_TYPE_LENGTH || !CONTENT_TYPE_PATTERN.test(value)) {
      throw new BuilderContractError('content-type');
    }
    contentType = value;
  }

  let payload: Buffer;
  if (body === undefined) payload = Buffer.alloc(0);
  else if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
  else if (body instanceof Uint8Array) payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else throw new BuilderContractError('body');

  return { status, contentType, body: payload };
}

export interface BuilderRequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly target: NormalizedTarget | 'ogiltig';
  readonly identity: Identity;
  readonly builder: BuilderConfig;
  readonly log: GatewayLogger;
}

export async function handleBuilderRequest(context: BuilderRequestContext): Promise<void> {
  const { request, response, method, target, identity, builder, log } = context;

  // 1. Strikt CSRF — före allt som läser förfrågans innehåll.
  const writing = WRITING_METHODS.has(method);
  if (writing) assertStrictCsrfProtection(request, builder.origin);

  // 2. Sökväg och fråga.
  if (target === 'ogiltig') throw invalidRequest('Adressen är ogiltig.');
  const query = parseQuery(target.query);

  // 3. Kropp — bara där den betyder något. En kropp på GET lämnas oläst och når aldrig handlern.
  const body = writing ? new Uint8Array(await readBody(request, MAX_REQUEST_BODY_BYTES)) : undefined;

  const platformRequest: PlatformRequest = {
    method,
    path: `/${target.segments.join('/')}`,
    query,
    headers: forwardedHeaders(request),
    identity,
    ...(body === undefined ? {} : { body }),
  };

  // 4. Handlern. Vad den än kastar blir 500 med fast text: även ett `DataApiError` med en
  //    "användarvänlig" text, eftersom handlern inte äger gatewayns felsvar. Felet loggas här,
  //    utan meddelande, och ersätts av ett medvetet nekande som inte loggas en gång till.
  let candidate: unknown;
  try {
    candidate = await builder.handler.handle(platformRequest);
  } catch (error) {
    log({ level: 'error', event: 'internal_error', method, route: 'builder', ...describeError(error) });
    throw internalError();
  }

  const checked = checkBuilderResponse(candidate);
  response.statusCode = checked.status;
  if (checked.status === 204) {
    response.end();
    return;
  }
  // En kropp utan uttalad typ är ren text — webbläsaren får aldrig gissa.
  response.setHeader('Content-Type', checked.contentType ?? DEFAULT_CONTENT_TYPE);
  response.setHeader('Content-Length', checked.body.length);
  response.end(checked.body);
}
