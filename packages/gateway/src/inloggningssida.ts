/**
 * Omdirigering av en OINLOGGAD SIDNAVIGERING till identitetsleverantörens inloggningssida
 * (`IdentityProvider.loginPath`), i stället för ett 401 som en människa inte kan göra något med.
 *
 *   303 → `<loginPath>?next=<URL-kodad relativ sökväg + fråga>`
 *
 * Bara när ALLT detta gäller — annars 401 som förut:
 *   - leverantören har en `loginPath` (kontrollerad vid start)
 *   - metoden är GET eller HEAD
 *   - det är en sidnavigering: `Sec-Fetch-Mode: navigate`, eller — bara när Sec-Fetch saknas helt
 *     (äldre webbläsare) — ett `Accept` som innehåller `text/html`. Ett `fetch()` från appens kod
 *     ska få 401 och kunna hantera det, inte en HTML-sida.
 *   - sökvägen är giltig och ligger inte under `/_api/`
 *
 * `next` byggs ur de REDAN GODKÄNDA segmenten från sokvag.ts, aldrig ur den råa adressen. Varje
 * segment är fritt från `/`, `\` och kontrolltecken, och kodas om; resultatet börjar därför alltid
 * med exakt ett `/` och kan aldrig tolkas som ett värdnamn (`//x`, `/\x`). Frågan följer med, men
 * allt i den utom säkra URL-tecken procentkodas — bakåtstreck och kontrolltecken kan alltså inte
 * heller därifrån ta sig in i en senare `Location`.
 *
 * Ingen slinga: inloggningssidan ligger under `/_auth/`, och de rutterna besvaras av leverantören
 * INNAN inloggningskontrollen (index.ts steg 3½) — de kan aldrig nå hit. Omdirigeringen sker före
 * registeruppslaget, så den röjer inte om en app finns.
 */
import { AUTH_PREFIX } from '@vibesandbox/contracts';
import type { IdentityProvider } from '@vibesandbox/contracts';
import type { NormalizedTarget } from './sokvag.ts';

export type LoginRedirect = (
  method: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  target: NormalizedTarget | 'ogiltig',
  apiSegment: string,
) => string | null;

/**
 * `/_auth/<segment>[/<segment>…]`, gemener i prefixet, inga punktsegment, ingen fråga eller
 * fragment. Kontrolleras vid start: det är det enda i `Location` som inte byggs här.
 */
const LOGIN_PATH_PATTERN = new RegExp(`^${AUTH_PREFIX}(?:/[A-Za-z0-9_-][A-Za-z0-9._~-]*)+$`);
const MAX_LOGIN_PATH_LENGTH = 256;

/** Tecken som får stå okodade i `next`s fråga. `%` behålls, så redan kodade tecken förblir kodade. */
const SAFE_QUERY_CHARACTER = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]$/;

const NAVIGATION_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

function encodeQuery(query: string): string | null {
  let encoded = '';
  for (const character of query) {
    if (SAFE_QUERY_CHARACTER.test(character)) {
      encoded += character;
      continue;
    }
    try {
      encoded += encodeURIComponent(character);
    } catch {
      // Ensamt surrogattecken: inget vi kan skicka vidare korrekt. Ingen omdirigering alls.
      return null;
    }
  }
  return encoded;
}

function isPageNavigation(method: string, headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  if (!NAVIGATION_METHODS.has(method)) return false;
  const mode = headers['sec-fetch-mode'];
  // Finns Sec-Fetch avgör det ensamt: `cors`, `no-cors`, `same-origin` är skript och resurser.
  if (mode !== undefined) return mode === 'navigate';
  const accept = headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

/** Kastar om `loginPath` är ogiltig; `undefined` om leverantören inte har någon. Körs en gång vid start. */
export function createLoginRedirect(provider: IdentityProvider): LoginRedirect | undefined {
  const loginPath: unknown = provider.loginPath;
  if (loginPath === undefined) return undefined;
  if (typeof loginPath !== 'string' || loginPath.length > MAX_LOGIN_PATH_LENGTH || !LOGIN_PATH_PATTERN.test(loginPath)) {
    throw new Error(`Ogiltig loginPath hos identitetsleverantören: ska vara en sökväg under ${AUTH_PREFIX}/ utan fråga.`);
  }

  return (method, headers, target, apiSegment) => {
    if (!isPageNavigation(method, headers)) return null;
    if (target === 'ogiltig') return null;
    const first = target.segments[0];
    if (first === apiSegment || first === AUTH_PREFIX.slice(1)) return null;

    const path = `/${target.segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    const query = encodeQuery(target.query);
    if (query === null) return null;
    const next = query.length === 0 ? path : `${path}?${query}`;
    return `${loginPath}?next=${encodeURIComponent(next)}`;
  };
}
