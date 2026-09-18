/**
 * Testinloggningen: en identitetsleverantör för tester och lokal utveckling.
 *
 * Format på `Authorization`-huvudet:
 *
 *   Test <base64url(JSON-nyttolast)>.<base64url(HMAC-SHA256)>
 *
 * Nyttolasten är `{ userId, email, roles, exp }` där `exp` är utgångstiden i sekunder sedan
 * 1970. Den som kan hemligheten kan utge sig för vem som helst — därför vägrar leverantören
 * finnas när `NODE_ENV=production`, och kräver en hemlighet som inte går att gissa.
 *
 * En webbläsare kan inte skicka `Authorization` vid en sidnavigering. För lokal utveckling finns
 * därför samma token som kaka:
 *
 *   GET /_auth/test-login?token=<token>   giltig ⇒ 303 till `/` + kakan `vs-test-session`
 *   GET /_auth/test-logout                rensar kakan, 303 till `/`
 *
 * `<token>` är värdet ovan UTAN prefixet `Test `. Finns `Authorization` i förfrågan avgör det
 * ensamt — kakan läses då inte alls. En källa per förfrågan: ett trasigt `Authorization` ska inte
 * tyst kunna bli en annan användare via en kaka som råkar följa med.
 *
 * KÄND SVAGHET, godtagbar bara för att detta aldrig körs i produktion: kakan saknar
 * `__Host-`-prefix (se nedan), så en syskonapp kan plantera en egen `vs-test-session` med
 * `Domain=`. Har offret redan en kaka skickas namnet två gånger och inloggningen NEKAS (kakor.ts).
 * Har offret ingen blir hen inloggad som ANGRIPAREN. Inloggningsadressen kan på samma sätt öppnas
 * av vem som helst åt vem som helst (inloggnings-CSRF). En riktig leverantör måste binda biljetten
 * till webbläsaren som begärde den.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AUTH_PREFIX } from '@vibesandbox/contracts';
import type { AuthRouteResponse, Identity, IdentityProvider, Role } from '@vibesandbox/contracts';
import { readSingleCookie } from './kakor.ts';

const SCHEME_PREFIX = 'Test ';

/**
 * Kakan som bär testinloggningen. Den sätts med `Path=/; HttpOnly; SameSite=Lax` och ALDRIG med
 * `Domain` — utan `Domain` är en kaka host-only och når bara den här appens värd.
 *
 * `Secure` sätts INTE, och namnet har INTE prefixet `__Host-`: lokal utveckling går över http på
 * `*.localtest.me`, och en webbläsare avvisar då både `Secure`-kakor och `__Host-`-namn (som
 * kräver `Secure`). Det är en eftergift för just den här leverantören. RIKTIGA leverantörer SKA
 * använda `__Host-`-prefix + `Secure` (ADR 0002, villkor 1): det är det enda som hindrar en
 * syskonapp från att plantera eller skriva över sessionskakan.
 */
export const TEST_SESSION_COOKIE = 'vs-test-session';
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax';

const TEST_LOGIN_PATH = `${AUTH_PREFIX}/test-login`;
const TEST_LOGOUT_PATH = `${AUTH_PREFIX}/test-logout`;

/** Efter in- och utloggning går webbläsaren ALLTID till appens startsida; ingen parameter styr målet. */
const AFTER_AUTH_LOCATION = '/';

/** Räknas i BYTES, inte tecken: det är mängden nyckelmaterial som spelar roll. */
export const MIN_TEST_SECRET_BYTES = 32;

const DEFAULT_LIFETIME_SECONDS = 60 * 60;

/** Inget giltigt värde är i närheten av så här långt; skräp ska inte ens nå regex och HMAC. */
const MAX_HEADER_LENGTH = 4096;

const TOKEN_PATTERN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Binder signaturen till just det här ändamålet, så att samma hemlighet använd någon annanstans
 * aldrig råkar ge en signatur som går att använda som inloggning här.
 */
const SIGNING_CONTEXT = 'vibesandbox-test-identity.v1.';

const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>(['admin', 'builder', 'viewer']);

export interface TestIdentityProviderOptions {
  /** Delad hemlighet för HMAC-signering av testinloggningar. Minst 32 byte. */
  readonly secret: string;
}

export interface SignTestIdentityOptions {
  /** Livslängd i sekunder (standard: en timme). Ett negativt värde ger en redan utgången inloggning. */
  readonly expiresInSeconds?: number;
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_TEST_SECRET_BYTES) {
    throw new Error(`Testinloggningens hemlighet måste vara minst ${MIN_TEST_SECRET_BYTES} byte.`);
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(SIGNING_CONTEXT).update(encodedPayload).digest('base64url');
}

/**
 * Jämför signaturerna som TEXT, inte som avkodade bytes: base64url-avkodning är förlåtande
 * (sista tecknet bär oanvända bitar), så två olika texter kan avkodas till samma bytes — och då
 * vore en manipulerad signatur giltig. Båda sidor hashas först till samma längd, eftersom
 * `timingSafeEqual` KASTAR om längderna skiljer sig; så kan den aldrig kasta här.
 */
function signaturesMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isRoleList(value: unknown): value is Role[] {
  return Array.isArray(value) && value.every((role) => typeof role === 'string' && KNOWN_ROLES.has(role));
}

interface VerifiedToken {
  readonly identity: Identity;
  /** Utgångstid i sekunder sedan 1970 — kakan får aldrig leva längre än så. */
  readonly exp: number;
}

/** Tolkar nyttolasten EFTER att signaturen godkänts. Allt oväntat ⇒ `null` (nekas). */
function parsePayload(encodedPayload: string, nowSeconds: number): VerifiedToken | null {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { userId, email, roles, exp } = payload as Record<string, unknown>;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof email !== 'string') return null;
  if (!isRoleList(roles)) return null;
  // Saknad eller obegriplig utgångstid är en utgången inloggning, inte en evig.
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) return null;
  return { identity: { userId, email, roles }, exp };
}

/** `<nyttolast>.<signatur>` utan prefix — samma kontroll oavsett om token kom i huvud, kaka eller adress. */
function verifyToken(token: unknown, secret: string): VerifiedToken | null {
  if (typeof token !== 'string' || token.length > MAX_HEADER_LENGTH) return null;
  const match = TOKEN_PATTERN.exec(token);
  const encodedPayload = match?.[1];
  const presentedSignature = match?.[2];
  if (encodedPayload === undefined || presentedSignature === undefined) return null;

  // Signaturen FÖRST. Nyttolasten tolkas inte förrän vi vet att vi själva har skrivit den.
  if (!signaturesMatch(presentedSignature, sign(encodedPayload, secret))) return null;

  return parsePayload(encodedPayload, Math.floor(Date.now() / 1000));
}

/**
 * Skapar HELA värdet till `Authorization`-huvudet, inklusive prefixet `Test `:
 * `Test <base64url(JSON)>.<base64url(HMAC-SHA256)>`.
 */
export function signTestIdentity(identity: Identity, secret: string, options: SignTestIdentityOptions = {}): string {
  assertSecret(secret);
  const exp = Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? DEFAULT_LIFETIME_SECONDS);
  const payload = { userId: identity.userId, email: identity.email, roles: identity.roles, exp };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${SCHEME_PREFIX}${encodedPayload}.${sign(encodedPayload, secret)}`;
}

/**
 * Sökväg (med fråga) som loggar in en WEBBLÄSARE som `identity` på den värd den öppnas på:
 * `/_auth/test-login?token=…`. Sätt appens värd framför och skriv ut den som en klickbar adress.
 * Adressen ÄR inloggningen — den hör hemma i en lokal terminal, aldrig i en logg eller ett ärende.
 */
export function testLoginPath(identity: Identity, secret: string, options: SignTestIdentityOptions = {}): string {
  const token = signTestIdentity(identity, secret, options).slice(SCHEME_PREFIX.length);
  return `${TEST_LOGIN_PATH}?token=${encodeURIComponent(token)}`;
}

/** Svaren har fasta texter: inget ur förfrågan — allra minst token — ekas någonsin tillbaka. */
const LOGIN_REJECTED: AuthRouteResponse = {
  status: 401,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: 'Inloggningslänken är ogiltig eller har gått ut.',
};

const ONLY_GET: AuthRouteResponse = {
  status: 405,
  headers: { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' },
  body: 'Metoden stöds inte för den här adressen.',
};

function redirectWithCookie(value: string, maxAgeSeconds: number): AuthRouteResponse {
  return {
    status: 303,
    headers: {
      Location: AFTER_AUTH_LOCATION,
      'Set-Cookie': `${TEST_SESSION_COOKIE}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAgeSeconds}`,
    },
  };
}

/**
 * Inloggning för tester och lokal utveckling: `Authorization: Test <nyttolast>.<signatur>`, eller
 * samma token i kakan `vs-test-session` (sätts av `GET /_auth/test-login`).
 * KASTAR när `NODE_ENV=production` och när hemligheten är kortare än 32 byte.
 */
export function createTestIdentityProvider(options: TestIdentityProviderOptions): IdentityProvider {
  if (isProduction()) {
    throw new Error('Testinloggningen får inte användas när NODE_ENV=production.');
  }
  assertSecret(options.secret);
  const secret = options.secret;

  return {
    name: 'test',
    async authenticate(request) {
      // Kontrolleras även här: miljön kan ha ändrats efter att leverantören skapades.
      if (isProduction()) return null;

      // `Authorization` vinner: finns huvudet avgör det ensamt, även när det är ogiltigt.
      const header = request.headers.authorization;
      if (header !== undefined) {
        if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return null;
        if (!header.startsWith(SCHEME_PREFIX)) return null;
        return verifyToken(header.slice(SCHEME_PREFIX.length), secret)?.identity ?? null;
      }

      // Annars kakan — men bara om namnet förekommer exakt EN gång (se kakor.ts för varför).
      const cookie = readSingleCookie(request.headers.cookie, TEST_SESSION_COOKIE);
      if (cookie.outcome !== 'found') return null;
      return verifyToken(cookie.value, secret)?.identity ?? null;
    },

    async handleAuthRoute(request) {
      // Spärren gäller även här: i produktion FINNS inte rutterna (`null` ⇒ 404).
      if (isProduction()) return null;

      if (request.path === TEST_LOGIN_PATH) {
        if (request.method !== 'GET') return ONLY_GET;
        const verified = verifyToken(request.query.token, secret);
        if (verified === null) return LOGIN_REJECTED;
        // Kakan lever exakt så länge som token: `verifyToken` har redan nekat en utgången, så
        // återstoden är minst en sekund.
        const remaining = Math.max(1, Math.floor(verified.exp - Date.now() / 1000));
        return redirectWithCookie(request.query.token ?? '', remaining);
      }

      if (request.path === TEST_LOGOUT_PATH) {
        if (request.method !== 'GET') return ONLY_GET;
        // Utloggning kräver ingen giltig kaka: att rensa är ofarligt, och en trasig kaka ska gå att bli av med.
        return redirectWithCookie('', 0);
      }

      return null;
    },
  };
}
