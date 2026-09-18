/**
 * Gatewayn: plattformens enda ingång till en app. Den avgör vilken app en förfrågan hör till,
 * vem användaren är, och sätter de skyddsregler som hindrar appkod från att skicka ut data.
 *
 * Hanteraren är en rak följd av steg, och ordningen ÄR säkerhetsmodellen (fail-closed):
 *
 *   0. säkerhetshuvuden        — först av allt, så att även 400/401/404/500 bär dem
 *   1. förfrågans form         — metod ur en allowlist, inga dubbletter av beslutsgrundande huvuden
 *   2. värdnamn                — ren funktion, ingen I/O; ogiltigt ⇒ 400 (vardnamn.ts)
 *   3. service worker-spärr    — 403
 *   4. autentisering           — ingen eller osäker identitet ⇒ 401
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
 * Kakor: gatewayn läser inga kakor och sätter aldrig någon (ADR 0002). Huvudena lämnas i sin
 * helhet till identitetsleverantören, som äger den frågan.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PREFIX, CSRF_HEADER } from '@vibesandbox/contracts';
import type { AppFiles, AppRegistry, Identity, IdentityProvider, TenantStore } from '@vibesandbox/contracts';
import { handleApi } from './api.ts';
import { forbidden, invalidHost, invalidRequest, methodNotAllowed, toFailure, unauthenticated } from './fel.ts';
import { applySecurityHeaders, hasDuplicateOfSingleValueHeader, toAuthHeaders } from './huvuden.ts';
import { resolveTenant } from './hyresgast.ts';
import { appIdPrefix, describeError, safeLogger, silentLogger } from './logg.ts';
import type { GatewayLogEntry, GatewayLogger } from './logg.ts';
import { normalizeTarget } from './sokvag.ts';
import { handleStatic } from './statiskt.ts';
import { sendFailure } from './svar.ts';
import { createHostParser } from './vardnamn.ts';

export { createTestIdentityProvider, signTestIdentity } from './testidentitet.ts';
export type { SignTestIdentityOptions, TestIdentityProviderOptions } from './testidentitet.ts';
export type { GatewayLogEntry, GatewayLogger } from './logg.ts';
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
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

const ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
const WRITING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE']);
const API_SEGMENT = API_PREFIX.slice(1);

/** Fält som fylls i allteftersom stegen passeras, så att loggposten säger hur långt förfrågan kom. */
type RequestTrace = { -readonly [K in Exclude<keyof GatewayLogEntry, 'level' | 'event'>]?: GatewayLogEntry[K] };

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== 'object' || value === null) return false;
  const { userId, email, roles } = value as Record<string, unknown>;
  return typeof userId === 'string' && userId.length > 0 && typeof email === 'string' && Array.isArray(roles);
}

async function authenticate(
  provider: IdentityProvider,
  request: IncomingMessage,
  hostname: string,
  log: GatewayLogger,
): Promise<Identity> {
  let identity: Identity | null;
  try {
    identity = await provider.authenticate({ host: hostname, headers: toAuthHeaders(request.headers) });
  } catch (error) {
    // 401 och inte 500: för den som anropar är läget "din inloggning kunde inte bekräftas", och
    // rätt åtgärd är att logga in igen. 500 skulle dessutom berätta för en angripare exakt vilka
    // indata som får inloggningen att krascha. Felet göms inte för driften — det loggas som fel.
    log({ level: 'error', event: 'identity_provider_failed', ...describeError(error) });
    throw unauthenticated();
  }
  // `null` betyder "inte inloggad". Ett svar som inte ser ut som en identitet behandlas likadant:
  // osäkerhet ⇒ neka, aldrig ett gissat standardvärde.
  if (!isIdentity(identity)) throw unauthenticated();
  return identity;
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
  options: GatewayOptions,
  parseHost: ReturnType<typeof createHostParser>,
  log: GatewayLogger,
  request: IncomingMessage,
  response: ServerResponse,
  trace: RequestTrace,
): Promise<void> {
  // 1. Förfrågans form — rena kontroller utan I/O.
  const method = request.method ?? '';
  if (!ALLOWED_METHODS.includes(method)) throw methodNotAllowed(ALLOWED_METHODS);
  trace.method = method;
  if (hasDuplicateOfSingleValueHeader(request.rawHeaders)) {
    throw invalidRequest('Förfrågan innehåller samma huvud flera gånger.');
  }

  // 2. Värdnamnet — det enda som avgör vilken app det gäller. Ren tolkning, inget uppslag.
  const host = parseHost(request.headers.host);
  if (host === 'ogiltigt') throw invalidHost();
  const hostname = host.hostname;
  trace.appIdPrefix = appIdPrefix(host.appId);
  trace.kind = host.kind;

  // 3. Webbläsaren sätter `Service-Worker` när den hämtar ett skript för registrering som
  //    bakgrundsskript. Ett sådant överlever sidan och kan avlyssna all appens trafik, så det
  //    nekas oavsett värde (dubbla huvuden slås ihop till "script, script" — också nekat).
  if (request.headers['service-worker'] !== undefined) {
    throw forbidden('Bakgrundsskript är inte tillåtna på plattformen.');
  }

  // 4. Autentisering. Gäller ALLT, även statiska filer: länken ensam räcker inte.
  const identity = await authenticate(options.identityProvider, request, hostname, log);
  trace.userId = identity.userId;

  // 5. Register → TenantContext. Först nu, när vi vet vem som frågar.
  const tenant = await resolveTenant(host, options.registry);

  // 6. CSRF-skydd för skrivande metoder — före routningen, så att inget skrivande når en rutt utan det.
  if (WRITING_METHODS.has(method)) assertCsrfProtection(request, hostname);

  // 7. Routning på den normaliserade sökvägen.
  const target = normalizeTarget(request.url);
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
  const parseHost = createHostParser({ appDomain: options.appDomain, previewDomain: options.previewDomain });
  const log = safeLogger(options.logger ?? silentLogger);

  return (request, response) => {
    const trace: RequestTrace = {};

    // 0. Säkerhetshuvudena FÖRST, innan något kan gå fel.
    applySecurityHeaders(response);

    handle(options, parseHost, log, request, response, trace)
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
