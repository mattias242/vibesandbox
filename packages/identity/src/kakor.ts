/**
 * Kakor: strikt läsning av en namngiven kaka, och de kakor leverantören sätter.
 *
 * Läsningen följer samma regel som gatewayns `kakor.ts` (koden dupliceras medvetet — ett
 * identitetspaket ska inte bero på gatewayn): förekommer namnet mer än en gång är svaret
 * "tvetydigt" och den som frågar NEKAR. En syskonapp kan plantera en `Domain=`-kaka som når vår
 * värd (ADR 0002, mätt i spik S1); att välja en av två är att låta angriparen välja.
 * Okända namn ignoreras. Värdet lämnas ordagrant.
 */

export const MAX_COOKIE_HEADER_LENGTH = 8192;

export type CookieLookup =
  | { readonly outcome: 'found'; readonly value: string }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'ambiguous' }
  | { readonly outcome: 'oversized' };

function trimOptionalWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start += 1;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end -= 1;
  return text.slice(start, end);
}

export function readSingleCookie(cookieHeader: unknown, name: string): CookieLookup {
  if (typeof cookieHeader !== 'string') return { outcome: 'missing' };
  if (cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) return { outcome: 'oversized' };

  let value: string | undefined;
  for (const pair of cookieHeader.split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    if (trimOptionalWhitespace(pair.slice(0, equals)) !== name) continue;
    if (value !== undefined) return { outcome: 'ambiguous' };
    value = trimOptionalWhitespace(pair.slice(equals + 1));
  }
  return value === undefined ? { outcome: 'missing' } : { outcome: 'found', value };
}

/** Kakans namn och attribut, bestämda EN gång ur `publicScheme` — aldrig ur en förfrågan. */
export interface CookieNames {
  readonly session: string;
  readonly challenge: string;
  /** `; Secure` eller tomt. */
  readonly secure: string;
}

/**
 * Över https: `__Host-`-prefix + `Secure`. Webbläsaren vägrar då `Domain=` och kräver `Path=/`,
 * så en syskonvärd kan varken plantera eller skriva över kakan (ADR 0002, villkor 1).
 *
 * Över http (lokal utveckling på `*.localtest.me`) avvisar webbläsare både `Secure` och
 * `__Host-`, så där används vanliga namn. Valet görs ENBART av inställningen: en förfrågan som
 * påstår sig vara över http ska aldrig kunna sänka skyddet på en https-server.
 */
export function cookieNames(publicScheme: 'http' | 'https'): CookieNames {
  return publicScheme === 'https'
    ? { session: '__Host-vs-session', challenge: '__Host-vs-challenge', secure: '; Secure' }
    : { session: 'vs-session', challenge: 'vs-challenge', secure: '' };
}

/**
 * Sessionen: `SameSite=Lax`, så att en länk i ett mejl eller en chatt öppnar appen inloggad.
 * Den skyddar INTE mellan subdomäner — det gör `__Host-` och Origin-kontrollen.
 */
export function sessionCookie(names: CookieNames, value: string, maxAgeSeconds: number): string {
  return `${names.session}=${value}; Path=/; HttpOnly${names.secure}; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * Utmaningen: `SameSite=Strict`. Koden skrivs in på sidan som samma värd just visade, så kakan
 * behövs aldrig i en förfrågan som börjar någon annanstans.
 */
export function challengeCookie(names: CookieNames, value: string, maxAgeSeconds: number): string {
  return `${names.challenge}=${value}; Path=/; HttpOnly${names.secure}; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(names: CookieNames): string {
  return sessionCookie(names, '', 0);
}

export function clearChallengeCookie(names: CookieNames): string {
  return challengeCookie(names, '', 0);
}
