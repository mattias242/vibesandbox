/**
 * Gatewayn: plattformens enda ingång till en app. Den avgör vilken app en förfrågan hör till,
 * vem användaren är, och sätter de skyddsregler som hindrar appkod från att skicka ut data.
 *
 * Hanteraren är en rak följd av steg, och ordningen ÄR säkerhetsmodellen (fail-closed):
 *
 *   0. säkerhetshuvuden        — först av allt, så att även 400/401/404/500 bär dem. Värdnamnet
 *                                tolkas (rent, utan I/O) BARA för att välja värdsortens CSP; det
 *                                nekas inte förrän i steg 2. Okänd värd ⇒ strängaste varianten.
 *   1. förfrågans form         — metod ur en allowlist, inga dubbletter av beslutsgrundande huvuden
 *   2. värdnamn                — ren funktion, ingen I/O; ogiltigt ⇒ 400 (vardnamn.ts)
 *   3. service worker-spärr    — 403
 *   3½. inloggningsrutter      — `/_auth/…` lämnas till identitetsleverantören och SLUTAR här
 *   4. autentisering           — ingen eller osäker identitet ⇒ 401, eller 303 till
 *                                inloggningssidan för en sidnavigering (inloggningssida.ts)
 *   ── byggverktygets värd går härifrån till byggverktyg.ts: strikt CSRF → fråga → kropp → handler.
 *      Den når aldrig register, filer eller lagring, och blir aldrig ett TenantContext.
 *   5. register                — okänd app eller version ⇒ 404; här skapas TenantContext (hyresgast.ts)
 *   6. CSRF för skrivande      — 403
 *   7. routning                — sökvägen normaliseras, sedan API eller statiska filer
 *
 * Ett steg nekar genom att kasta; inget senare steg körs då. Autentiseringen ligger FÖRE
 * registret: en oinloggad kan då inte avgöra om ett app-id finns (401 oavsett), och oinloggad
 * trafik kostar aldrig ett registeruppslag. Varken `store` eller `files` nås före steg 7.
 *
 * Metoder: GET, HEAD, POST, PUT, DELETE. `HEAD` fungerar som `GET` utan kropp för statiska filer
 * och ger 405 i API:t. `OPTIONS` ger 405: allt är same-origin, det finns ingen CORS, och
 * gatewayn svarar aldrig med `Access-Control-Allow-*` — en förfrågan från en annan origin som
 * kräver preflight blir därmed alltid stoppad av webbläsaren.
 *
 * Inloggningsrutterna (3½) är det enda som körs utan inloggning, och de gör det utan register,
 * filer och lagring: svaret beror aldrig på om appen finns. De ligger EFTER steg 1–3, så att
 * värdnamnet är lika strikt validerat där som överallt annars. Se inloggningsrutt.ts.
 *
 * Kakor: gatewayn läser inga kakor och hittar aldrig på någon (ADR 0002). Huvudena lämnas i sin
 * helhet till identitetsleverantören, som äger den frågan. En kaka kan SÄTTAS på ett enda ställe
 * — i svaret från en inloggningsrutt — och där vägrar gatewayn `Domain=` och kräver `HttpOnly`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PREFIX, CSRF_HEADER } from '@vibesandbox/contracts';
import type { AppFiles, AppRegistry, Identity, IdentityProvider, TenantStore } from '@vibesandbox/contracts';
import { handleApi } from './api.ts';
import { createBuilderConfig, handleBuilderRequest } from './byggverktyg.ts';
import type { BuilderConfig, BuilderOptions } from './byggverktyg.ts';
import { forbidden, invalidHost, invalidRequest, methodNotAllowed, toFailure, unauthenticated } from './fel.ts';
import {
  NO_FRAMING,
  appContentSecurityPolicy,
  applySecurityHeaders,
  hasDuplicateOfSingleValueHeader,
  toAuthHeaders,
} from './huvuden.ts';
import { resolveTenant } from './hyresgast.ts';
import { createLoginRedirect } from './inloggningssida.ts';
import type { LoginRedirect } from './inloggningssida.ts';
import { AUTH_SEGMENT, handleAuthRoute } from './inloggningsrutt.ts';
import { appIdPrefix, describeError, safeLogger, silentLogger } from './logg.ts';
import type { GatewayLogEntry, GatewayLogger } from './logg.ts';
import { normalizeTarget } from './sokvag.ts';
import { handleStatic } from './statiskt.ts';
import { sendFailure } from './svar.ts';
import { createHostParser } from './vardnamn.ts';
import type { BuilderHost, ParsedHost } from './vardnamn.ts';

export { createTestIdentityProvider, signTestIdentity, testLoginPath } from './testidentitet.ts';
export type { SignTestIdentityOptions, TestIdentityProviderOptions } from './testidentitet.ts';
export type { GatewayLogEntry, GatewayLogger } from './logg.ts';
export type { BuilderOptions } from './byggverktyg.ts';
export { RECOMMENDED_SERVER_OPTIONS, handleClientError } from './server.ts';

export interface GatewayOptions {
  /** Publicerade appar nås på `<appId>.<appDomain>`. */
  readonly appDomain: string;
  /** Förhandsvisningar (utkast) nås på `p-<appId>.<previewDomain>`. Får vara samma domän som `appDomain`. */
  readonly previewDomain: string;
  readonly identityProvider: IdentityProvider;
  readonly registry: AppRegistry;
  readonly files: AppFiles;
  readonly store: TenantStore;
  /** Driftlogg. Standard: tyst. Får aldrig e-postadresser, huvudvärden, kroppar eller kakor (se logg.ts). */
  readonly logger?: GatewayLogger;
  /**
   * Byggverktyget på `bygg.<previewDomain>`. Saknas det är den värden ett okänt värdnamn (400),
   * och förhandsvisningar får inte ramas in av någon.
   */
  readonly builder?: BuilderOptions;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

const ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
const WRITING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE']);
const API_SEGMENT = API_PREFIX.slice(1);

/** Fält som fylls i allteftersom stegen passeras, så att loggposten säger hur långt förfrågan kom. */
type RequestTrace = { -readonly [K in Exclude<keyof GatewayLogEntry, 'level' | 'event'>]?: GatewayLogEntry[K] };

/**
 * Klientens adress för leverantörens hastighetsbegränsning: TCP-anslutningens motpart. ALDRIG
 * `X-Forwarded-For`, `Forwarded` eller liknande — de skriver klienten själv. Bakom en omvänd proxy
 * blir det proxyns adress; att lita på ett huvud därifrån kräver att proxyn är känd, och det
 * beslutet hör inte hemma i en förfrågningshanterare.
 */
function clientAddressOf(request: IncomingMessage): string | undefined {
  const address = request.socket.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : undefined;
}

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== 'object' || value === null) return false;
  const { userId, email, roles } = value as Record<string, unknown>;
  return typeof userId === 'string' && userId.length > 0 && typeof email === 'string' && Array.isArray(roles);
}

/** `null` = inte inloggad (anroparen avgör om det blir 401 eller 303). Kastar 401 om leverantören kraschar. */
async function authenticate(
  provider: IdentityProvider,
  request: IncomingMessage,
  hostname: string,
  log: GatewayLogger,
): Promise<Identity | null> {
  let identity: Identity | null;
  try {
    const clientAddress = clientAddressOf(request);
    identity = await provider.authenticate({
      host: hostname,
      headers: toAuthHeaders(request.headers),
      ...(clientAddress === undefined ? {} : { clientAddress }),
    });
  } catch (error) {
    // 401 och inte 500: för den som anropar är läget "din inloggning kunde inte bekräftas", och
    // rätt åtgärd är att logga in igen. 500 skulle dessutom berätta för en angripare exakt vilka
    // indata som får inloggningen att krascha. Felet göms inte för driften — det loggas som fel.
    log({ level: 'error', event: 'identity_provider_failed', ...describeError(error) });
    throw unauthenticated();
  }
  // `null` betyder "inte inloggad". Ett svar som inte ser ut som en identitet behandlas likadant:
  // osäkerhet ⇒ neka, aldrig ett gissat standardvärde.
  return isIdentity(identity) ? identity : null;
}

/** Det som räknas fram en gång vid start och delas av alla förfrågningar. */
interface Gateway {
  readonly options: GatewayOptions;
  readonly parseHost: ReturnType<typeof createHostParser>;
  readonly log: GatewayLogger;
  readonly builder: BuilderConfig | undefined;
  readonly loginRedirect: LoginRedirect | undefined;
}

/** 303 och inte 302: webbläsaren ska alltid göra en GET mot inloggningssidan. Ingen kropp. */
function sendLoginRedirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader('Location', location);
  response.setHeader('Content-Length', 0);
  response.end();
}

/**
 * Skrivande anrop måste bära plattformens eget huvud. En annan origin kan inte sätta det utan
 * preflight, och preflight beviljas aldrig. Skickar webbläsaren dessutom `Origin` ska den vara
 * appens egen — alla appar är same-site (ADR 0002), så `SameSite` på en kaka skyddar inte här.
 */
function assertCsrfProtection(request: IncomingMessage, hostname: string): void {
  const marker = request.headers[CSRF_HEADER];
  if (typeof marker !== 'string' || marker.length === 0) {
    throw forbidden('Anropet saknar plattformens skyddshuvud och nekades.');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    // Porten ignoreras: en proxy framför oss kan ha strippat den ur `Host`. Värdnamnet räcker,
    // eftersom en annan app alltid har ett annat värdnamn.
    const match = /^https?:\/\/([^/:]+)(?::[0-9]{1,5})?$/.exec(origin);
    if (match?.[1] !== hostname) throw forbidden('Anropet kom från en annan webbplats och nekades.');
  }
}

async function handle(
  gateway: Gateway,
  host: ParsedHost | BuilderHost | 'ogiltigt',
  request: IncomingMessage,
  response: ServerResponse,
  trace: RequestTrace,
): Promise<void> {
  const { options, log } = gateway;

  // 1. Förfrågans form — rena kontroller utan I/O.
  const method = request.method ?? '';
  if (!ALLOWED_METHODS.includes(method)) throw methodNotAllowed(ALLOWED_METHODS);
  trace.method = method;
  if (hasDuplicateOfSingleValueHeader(request.rawHeaders)) {
    throw invalidRequest('Förfrågan innehåller samma huvud flera gånger.');
  }

  // 2. Värdnamnet — det enda som avgör vilken app det gäller. Ren tolkning, inget uppslag (gjord
  //    redan i steg 0, av samma funktion, på samma huvud).
  if (host === 'ogiltigt') throw invalidHost();
  const hostname = host.hostname;
  if (host.kind === 'builder') {
    trace.route = 'builder';
  } else {
    trace.appIdPrefix = appIdPrefix(host.appId);
    trace.kind = host.kind;
  }

  // 3. Webbläsaren sätter `Service-Worker` när den hämtar ett skript för registrering som
  //    bakgrundsskript. Ett sådant överlever sidan och kan avlyssna all appens trafik, så det
  //    nekas oavsett värde (dubbla huvuden slås ihop till "script, script" — också nekat).
  if (request.headers['service-worker'] !== undefined) {
    throw forbidden('Bakgrundsskript är inte tillåtna på plattformen.');
  }

  // 3½. Inloggningsrutter — det enda som körs FÖRE autentiseringen, och som aldrig går vidare:
  //     varken till registret (rutten får inte röja om appen finns), filerna eller SPA-fallbacken.
  //     Sökvägen tolkas av samma rena funktion som i steg 7, så `/%5Fauth/` och `/_auth/` är samma
  //     rutt och det finns fortfarande bara EN tolkning. En OGILTIG sökväg är ingen inloggningsrutt;
  //     den nekas i steg 7 som förut — efter autentiseringen, så att ordningen där är orörd.
  const target = normalizeTarget(request.url);
  if (target !== 'ogiltig' && target.segments[0] === AUTH_SEGMENT) {
    trace.route = 'auth';
    await handleAuthRoute({
      request,
      response,
      provider: options.identityProvider,
      log,
      method,
      hostname,
      segments: target.segments,
      rawQuery: target.query,
      headers: toAuthHeaders(request.headers),
      clientAddress: clientAddressOf(request),
    });
    return;
  }

  // 4. Autentisering. Gäller ALLT ANNAT, även statiska filer: länken ensam räcker inte.
  const identity = await authenticate(options.identityProvider, request, hostname, log);
  if (identity === null) {
    // En människa i en webbläsare skickas till inloggningssidan; allt annat får 401. Före
    // registret, så att svaret är detsamma oavsett om appen finns.
    const location = gateway.loginRedirect?.(method, request.headers, target, API_SEGMENT) ?? null;
    if (location === null) throw unauthenticated();
    sendLoginRedirect(response, location);
    return;
  }
  trace.userId = identity.userId;

  // Byggverktyget: egen väg härifrån, utan register och utan TenantContext.
  if (host.kind === 'builder') {
    // `builder` finns alltid här: utan den känner värdnamnstolken inte igen värden (steg 2).
    if (gateway.builder === undefined) throw invalidHost();
    await handleBuilderRequest({ request, response, method, target, identity, builder: gateway.builder, log });
    return;
  }

  // 5. Register → TenantContext. Först nu, när vi vet vem som frågar.
  const tenant = await resolveTenant(host, options.registry);

  // 6. CSRF-skydd för skrivande metoder — före routningen, så att inget skrivande når en rutt utan det.
  if (WRITING_METHODS.has(method)) assertCsrfProtection(request, hostname);

  // 7. Routning på den normaliserade sökvägen (tolkad i steg 3½).
  if (target === 'ogiltig') throw invalidRequest('Adressen är ogiltig.');

  if (target.segments[0] === API_SEGMENT) {
    trace.route = 'api';
    await handleApi({
      request,
      response,
      method,
      segments: target.segments.slice(1),
      query: target.query,
      tenant,
      identity,
      store: options.store,
    });
    return;
  }

  trace.route = 'static';
  await handleStatic({ response, method, segments: target.segments, tenant, files: options.files });
}

/** Hela gatewayn som en vanlig `node:http`-hanterare. Kastar direkt om domänerna är felkonfigurerade. */
export function createGateway(options: GatewayOptions): RequestHandler {
  const builder = options.builder === undefined ? undefined : createBuilderConfig(options.builder, options.previewDomain);
  const parseHost = createHostParser({
    appDomain: options.appDomain,
    previewDomain: options.previewDomain,
    builder: builder !== undefined,
  });
  const gateway: Gateway = {
    options,
    parseHost,
    log: safeLogger(options.logger ?? silentLogger),
    builder,
    loginRedirect: createLoginRedirect(options.identityProvider),
  };
  const log = gateway.log;

  // CSP per värdsort (huvuden.ts). Förhandsvisningar ramas in av byggverktyget — och bara av det.
  const cspFor: Readonly<Record<'published' | 'draft' | 'builder', string>> = {
    published: appContentSecurityPolicy(NO_FRAMING),
    draft: appContentSecurityPolicy(builder?.origin ?? NO_FRAMING),
    builder: builder?.contentSecurityPolicy ?? appContentSecurityPolicy(NO_FRAMING),
  };

  return (request, response) => {
    const trace: RequestTrace = {};

    // 0. Säkerhetshuvudena FÖRST, innan något kan gå fel — med värdsortens CSP.
    const host = parseHost(request.headers.host);
    applySecurityHeaders(response, host === 'ogiltigt' ? undefined : cspFor[host.kind]);

    handle(gateway, host, request, response, trace)
      .catch((error: unknown) => {
        const failure = toFailure(error);
        if (failure.unexpected) log({ level: 'error', event: 'internal_error', ...trace, ...describeError(error) });
        trace.code = failure.body.error.code;
        if (response.headersSent) {
          // Svaret var redan påbörjat; det enda ärliga som återstår är att bryta anslutningen.
          response.destroy();
          return;
        }
        sendFailure(response, failure);
      })
      .catch(() => {
        // Även felsvaret gick inte att skriva (t.ex. klienten försvann). Inget får läcka ut härifrån.
        response.destroy();
      })
      .finally(() => {
        const status = response.statusCode;
        log({ level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', event: 'request', ...trace, status });
      });
  };
}
