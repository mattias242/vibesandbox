/**
 * Inloggningsrutter: sökvägar under `AUTH_PREFIX` lämnas till identitetsleverantörens krok
 * `handleAuthRoute`. Det är här en apps värd byter en biljett mot sin EGEN host-only-kaka — det
 * enda sättet att logga in en webbläsare när varje app har egen origin (ADR 0002).
 *
 * Rutten körs FÖRE inloggningskontrollen (den som ska logga in är per definition oinloggad) och
 * UTAN registeruppslag: svaret får inte bero på om appen finns, annars blir rutten ett orakel för
 * app-id:n — som är den hemliga delningslänken.
 *
 * Leverantören är plattformskod, inte appkod, men den behandlas ändå som opålitlig UTDATA. Skälet
 * är att just de här svaren är de farligaste gatewayn skickar: de sätter sessionskakor och
 * omdirigerar en webbläsare som just har autentiserat sig. Ett enda slarvfel i en leverantör —
 * en `retur`-parameter som ekas i `Location`, ett `Domain=` på kakan — vore en öppen
 * omdirigering eller en session som alla syskonappar kan läsa. Därför:
 *
 *   - status, huvuden och kropp går igenom ALLOWLISTOR; det som inte står här når aldrig ut
 *   - ett huvud utanför allowlisten släpps tyst (skyddshuvudena är redan satta och står kvar)
 *   - ett TILLÅTET huvud med otillåtet innehåll fäller HELA svaret: 500 och en felrad i loggen.
 *     Då sätts ingen kaka alls — hellre en misslyckad inloggning än en halv.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthRouteRequest, IdentityProvider } from '@vibesandbox/contracts';
import { AUTH_PREFIX, AUTH_ROUTE_STATUSES, MAX_AUTH_BODY_BYTES } from '@vibesandbox/contracts';
import { invalidRequest, methodNotAllowed, notFound, unauthenticated } from './fel.ts';
import { readBody } from './kropp.ts';
import { describeError } from './logg.ts';
import type { GatewayLogger } from './logg.ts';

export const AUTH_SEGMENT = AUTH_PREFIX.slice(1);

/**
 * Inloggning behöver en länk att följa (GET) och ett formulär att skicka (POST). Inget annat —
 * i synnerhet inte HEAD, som en förhandsgranskande klient annars kunde förbruka en biljett med.
 */
const AUTH_METHODS: readonly string[] = ['GET', 'POST'];

/**
 * Kontraktets lista (`AUTH_ROUTE_STATUSES`): 200 (sida), 303 (vidare efter lyckat byte — 303 och
 * inte 302/307, så att en POST aldrig görs om mot målet), och de nekanden en inloggning kan behöva
 * — bland dem 403, som leverantören själv svarar när en POST saknar exakt rätt `Origin` (rutterna
 * körs före gatewayns CSRF-steg). Inga andra omdirigeringar, inget 5xx: går något sönder hos
 * leverantören ska den kasta, inte formulera ett eget felsvar.
 */
const ALLOWED_STATUSES: ReadonlySet<number> = new Set(AUTH_ROUTE_STATUSES);

/**
 * ALLA svarshuvuden en leverantör kan få ut, med gemener. Listan får ALDRIG innehålla ett
 * skyddshuvud (se `SECURITY_HEADERS`) — det är hela skälet till att den är en allowlist: en
 * leverantör kan då varken ersätta, dubblera eller ta bort ett sådant, och inte heller sätta
 * `Access-Control-*`, `Refresh` eller något annat vi inte har tänkt på. Testas.
 */
export const ALLOWED_PROVIDER_HEADERS: ReadonlySet<string> = new Set(['allow', 'content-type', 'location', 'set-cookie']);

/**
 * Exakta värden, inte ett mönster: teckenkodningen ska alltid vara uttalad, och inget här får gå
 * att köra som skript eller tolkas som något annat än text (`X-Content-Type-Options: nosniff`
 * och appens CSP gäller dessutom, som för alla svar).
 */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain; charset=utf-8',
  'text/html; charset=utf-8',
  'application/json; charset=utf-8',
]);
const DEFAULT_CONTENT_TYPE = 'text/plain; charset=utf-8';

const ALLOWED_ALLOW_VALUES: ReadonlySet<string> = new Set(['GET', 'POST', 'GET, POST']);

const MAX_LOCATION_LENGTH = 2048;
/** Webbläsare godtar högst 4096 byte per kaka; längre än så är ett fel hos leverantören. */
const MAX_SET_COOKIE_LENGTH = 4096;
const MAX_SET_COOKIES = 8;
const MAX_BODY_BYTES = 64 * 1024;

/** Kaknamn enligt RFC 6265: en HTTP-"token". */
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type AuthRouteRule = 'shape' | 'status' | 'headers' | 'location' | 'set-cookie' | 'content-type' | 'allow' | 'body';

/**
 * Leverantören bröt mot kontraktet. INTE ett `GatewayError`: felet är vårt, inte besökarens, så
 * `toFailure` gör det till 500 `internal` och hanteraren loggar det som ett fel. Namnet bär
 * VILKEN regel som bröts — en fast sträng ur koden — och aldrig det otillåtna värdet, som kan
 * innehålla en biljett eller en adress.
 */
export class AuthRouteContractError extends Error {
  constructor(rule: AuthRouteRule) {
    super('Identitetsleverantörens svar på en inloggningsrutt bröt mot kontraktet.');
    this.name = `AuthRouteContractError(${rule})`;
  }
}

/** Bara synliga ASCII-tecken: inga kontrolltecken (CR, LF, tabb, NUL), inget blanktecken, inget över 0x7e. */
function isVisibleAscii(text: string, allowSpace: boolean): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x20 ? !allowSpace : code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * `Location` måste vara en sökväg på SAMMA värd: exakt ett inledande `/`.
 *
 * - `//värd` är protokollrelativt, och `/\värd` blir det: webbläsare läser `\` som `/`. Bakåtstreck
 *   nekas därför överallt, inte bara på andra plats.
 * - Kontrolltecken nekas inte bara för att de kan dela huvudet (CR/LF): webbläsare STRYKER tabb
 *   och radbrytning ur en URL, så `/<tabb>/värd` blir `//värd`.
 * - Allt som inte börjar med `/` är antingen en absolut URL, ett schema (`javascript:`) eller en
 *   relativ sökväg som tolkas mot `/_auth/…` — inget av det ska en inloggning skicka någon till.
 */
export function isSafeRedirectTarget(location: unknown): location is string {
  if (typeof location !== 'string') return false;
  if (location.length === 0 || location.length > MAX_LOCATION_LENGTH) return false;
  if (!isVisibleAscii(location, false)) return false;
  if (location.charCodeAt(0) !== 0x2f) return false;
  if (location.charCodeAt(1) === 0x2f) return false;
  if (location.includes('\\')) return false;
  return true;
}

/**
 * En kaka från en inloggningsrutt får ALDRIG ha attributet `Domain`: utan det är kakan host-only
 * och når bara den här appens värd; med det når den alla syskonappar — som kör opålitlig kod.
 * Webbläsare tolkar attributnamn skiftlägesokänsligt och med blanktecken runt om, och `Domain`
 * utan värde är fortfarande attributet `Domain`; allt det räknas.
 *
 * Den ska också ALLTID ha `HttpOnly`: appens kod är AI-genererad och ogranskad i en
 * förhandsvisning, och CSP hindrar inte en sidnavigering med kakans värde i adressen.
 *
 * Kommatecken delar INTE upp värdet i flera kakor (webbläsare gör inte det heller), så ett
 * `Domain` efter ett kommatecken hittas som det attribut det är.
 */
export function isSafeSetCookie(cookie: unknown): cookie is string {
  if (typeof cookie !== 'string') return false;
  if (cookie.length === 0 || cookie.length > MAX_SET_COOKIE_LENGTH) return false;
  if (!isVisibleAscii(cookie, true)) return false;

  const [pair = '', ...attributes] = cookie.split(';');
  const equals = pair.indexOf('=');
  if (equals === -1 || !COOKIE_NAME_PATTERN.test(pair.slice(0, equals).trim())) return false;

  let httpOnly = false;
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    const attributeName = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    if (attributeName === 'domain') return false;
    if (attributeName === 'httponly') httpOnly = true;
  }
  return httpOnly;
}

/** Det enda som skrivs ut: redan kontrollerat, med våra egna huvudnamn. */
interface CheckedResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [name: string, value: string | readonly string[]]>;
  readonly body: Buffer;
}

function checkSetCookies(value: unknown): readonly string[] {
  // Kontraktets typ är EN sträng per huvudnamn. En lista godtas ändå — bara här — eftersom flera
  // kakor inte går att uttrycka på något annat säkert sätt: `Set-Cookie` kan inte slås ihop med
  // kommatecken (`Expires=Wed, 09 …`). Varje kaka prövas för sig.
  const cookies: readonly unknown[] = Array.isArray(value) ? value : [value];
  if (cookies.length === 0 || cookies.length > MAX_SET_COOKIES) throw new AuthRouteContractError('set-cookie');
  if (!cookies.every(isSafeSetCookie)) throw new AuthRouteContractError('set-cookie');
  return cookies;
}

/** Hela kontrollen görs FÖRE första skrivningen, så att ett underkänt svar inte lämnar spår. */
function checkResponse(candidate: unknown): CheckedResponse {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new AuthRouteContractError('shape');
  }
  const { status, headers, body } = candidate as Record<string, unknown>;

  if (typeof status !== 'number' || !ALLOWED_STATUSES.has(status)) throw new AuthRouteContractError('status');
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new AuthRouteContractError('headers');
  }

  // Huvudnamn är skiftlägesokänsliga. Förekommer ett tillåtet namn under två nycklar
  // (`Location` och `location`) finns det två svar på vilken som gäller — då gäller ingen.
  const allowed = new Map<string, unknown>();
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (!ALLOWED_PROVIDER_HEADERS.has(lowered)) continue;
    if (allowed.has(lowered)) throw new AuthRouteContractError('headers');
    allowed.set(lowered, value);
  }

  const checked: Array<readonly [string, string | readonly string[]]> = [];

  // En omdirigering har ett mål, och bara en omdirigering har det.
  const location = allowed.get('location');
  if ((status === 303) !== allowed.has('location')) throw new AuthRouteContractError('location');
  if (allowed.has('location')) {
    if (!isSafeRedirectTarget(location)) throw new AuthRouteContractError('location');
    checked.push(['Location', location]);
  }

  if (allowed.has('set-cookie')) checked.push(['Set-Cookie', checkSetCookies(allowed.get('set-cookie'))]);

  if (allowed.has('allow')) {
    const allow = allowed.get('allow');
    if (typeof allow !== 'string' || !ALLOWED_ALLOW_VALUES.has(allow)) throw new AuthRouteContractError('allow');
    checked.push(['Allow', allow]);
  }

  if (body !== undefined && typeof body !== 'string') throw new AuthRouteContractError('body');
  const payload = Buffer.from(body ?? '', 'utf8');
  if (payload.length > MAX_BODY_BYTES) throw new AuthRouteContractError('body');

  let contentType: string | undefined;
  if (allowed.has('content-type')) {
    const value = allowed.get('content-type');
    if (typeof value !== 'string' || !ALLOWED_CONTENT_TYPES.has(value)) throw new AuthRouteContractError('content-type');
    contentType = value;
  }
  // En kropp utan uttalad typ är ren text — webbläsaren får aldrig gissa.
  if (payload.length > 0) checked.push(['Content-Type', contentType ?? DEFAULT_CONTENT_TYPE]);

  return { status, headers: checked, body: payload };
}

/**
 * Samma regel som i API:t: en parameter som anges flera gånger nekas, vi väljer aldrig en av dem.
 * Används även för byggverktygets värd (byggverktyg.ts).
 */
export function parseQuery(rawQuery: string): Readonly<Record<string, string>> {
  // Utan prototyp, så att en parameter som heter `__proto__` eller `constructor` bara är ett värde.
  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of new URLSearchParams(rawQuery)) {
    // Meddelandet nämner medvetet inte VILKEN parameter: inget ur förfrågan ekas i svaret.
    if (Object.hasOwn(query, name)) throw invalidRequest('En parameter i adressen får bara anges en gång.');
    query[name] = value;
  }
  return query;
}

export interface AuthRouteContext {
  /** Bara för kroppen vid POST. Allt annat ur förfrågan kommer via fälten nedan. */
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly provider: IdentityProvider;
  readonly log: GatewayLogger;
  readonly method: string;
  /** Det validerade värdnamnet ur vardnamn.ts — aldrig `Host`-huvudet som det kom. */
  readonly hostname: string;
  /** Redan normaliserade segment från sokvag.ts; det första är `AUTH_SEGMENT`. */
  readonly segments: readonly string[];
  readonly rawQuery: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** TCP-anslutningens adress (se `clientAddressOf` i index.ts) — aldrig ur ett huvud. */
  readonly clientAddress: string | undefined;
}

export async function handleAuthRoute(context: AuthRouteContext): Promise<void> {
  const { provider, response, log } = context;

  if (!AUTH_METHODS.includes(context.method)) throw methodNotAllowed(AUTH_METHODS);
  const query = parseQuery(context.rawQuery);

  // Ingen krok ⇒ inga inloggningsrutter. 404, och framför allt: ALDRIG vidare till appens filer.
  // Före kroppen: en rutt som inte finns ska inte kosta en inläsning.
  if (typeof provider.handleAuthRoute !== 'function') throw notFound();

  // Kroppen bara vid POST, rå, med ett litet eget tak: ett formulär med adress eller kod. Över
  // taket ⇒ 413 (readBody slutar spara vid gränsen och litar inte på Content-Length), och
  // leverantören tillfrågas inte. GET får ingen kropp, även om klienten skickar en.
  const body = context.method === 'POST' ? new Uint8Array(await readBody(context.request, MAX_AUTH_BODY_BYTES)) : undefined;

  // Leverantören får värdnamn, sökväg, huvuden och kropp — men inget `TenantContext` och ingen väg
  // till register, filer eller lagring. Den kan alltså varken se eller påverka vilken app det gäller.
  const request: AuthRouteRequest = {
    host: context.hostname,
    headers: context.headers,
    method: context.method,
    path: `/${context.segments.join('/')}`,
    query,
    ...(context.clientAddress === undefined ? {} : { clientAddress: context.clientAddress }),
    ...(body === undefined ? {} : { body }),
  };

  let candidate: unknown;
  try {
    candidate = await provider.handleAuthRoute(request);
  } catch (error) {
    // Samma resonemang som i `authenticate`: 401 och inte 500, men loggat som fel för driften.
    log({ level: 'error', event: 'identity_provider_failed', ...describeError(error) });
    throw unauthenticated();
  }
  if (candidate === null) throw notFound();

  const checked = checkResponse(candidate);
  response.statusCode = checked.status;
  for (const [name, value] of checked.headers) response.setHeader(name, value);
  response.setHeader('Content-Length', checked.body.length);
  response.end(checked.body);
}
