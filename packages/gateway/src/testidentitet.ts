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
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Identity, IdentityProvider, Role } from '@vibesandbox/contracts';

const SCHEME_PREFIX = 'Test ';

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

/** Tolkar nyttolasten EFTER att signaturen godkänts. Allt oväntat ⇒ `null` (nekas). */
function parsePayload(encodedPayload: string, nowSeconds: number): Identity | null {
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
  return { userId, email, roles };
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
 * Inloggning för tester och lokal utveckling: `Authorization: Test <nyttolast>.<signatur>`.
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

      const header = request.headers.authorization;
      if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return null;
      if (!header.startsWith(SCHEME_PREFIX)) return null;

      const match = TOKEN_PATTERN.exec(header.slice(SCHEME_PREFIX.length));
      const encodedPayload = match?.[1];
      const presentedSignature = match?.[2];
      if (encodedPayload === undefined || presentedSignature === undefined) return null;

      // Signaturen FÖRST. Nyttolasten tolkas inte förrän vi vet att vi själva har skrivit den.
      if (!signaturesMatch(presentedSignature, sign(encodedPayload, secret))) return null;

      return parsePayload(encodedPayload, Math.floor(Date.now() / 1000));
    },
  };
}
