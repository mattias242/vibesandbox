/**
 * `next`: vart webbläsaren skickas efter inloggningen. Ren funktion, ingen I/O.
 *
 * Värdet kommer från adressfältet och är därmed angriparens att välja. Det enda som godtas är en
 * sökväg på SAMMA värd; allt annat blir `/`. Gatewayn prövar dessutom `Location` själv
 * (inloggningsrutt.ts), men en inloggning som skickar vidare till fel ställe ska aldrig ens
 * formuleras här.
 */
import { AUTH_PREFIX } from '@vibesandbox/contracts';

export const DEFAULT_NEXT = '/';
const MAX_NEXT_LENGTH = 2048;
/** Hur många lager procentkodning vi skalar av när vi letar efter ett gömt `//` eller `\`. */
const MAX_DECODE_ROUNDS = 4;

/** Synliga ASCII-tecken utan blanksteg: inga kontrolltecken, som webbläsare stryker ur en URL. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

function looksLikeAnotherHost(path: string): boolean {
  // `//värd` är protokollrelativ; `/\värd` blir det, eftersom webbläsare läser `\` som `/`.
  if (path.startsWith('//') || path.startsWith('/\\')) return true;
  if (path.includes('\\')) return true;
  // Kontrolltecken efter avkodning (`%09`, `%0A`) har ingen plats i en sökväg vi skickar till.
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isAuthRoute(path: string): boolean {
  const pathOnly = path.split(/[?#]/, 1)[0] ?? '';
  return pathOnly === AUTH_PREFIX || pathOnly.startsWith(`${AUTH_PREFIX}/`);
}

/**
 * Returnerar `next` om det är en säker, relativ sökväg som börjar med exakt ett `/` — annars `/`.
 *
 * Vi prövar även de AVKODADE formerna: själva `Location` avkodas inte av webbläsaren för att hitta
 * värden, men målsidan (en SPA) kan mycket väl avkoda och navigera vidare. Hellre `/` en gång för
 * mycket. Inloggningsrutterna själva är inte heller ett mål (`next=/_auth/logout`).
 */
export function safeNext(input: unknown): string {
  if (typeof input !== 'string') return DEFAULT_NEXT;
  if (input.length === 0 || input.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT;
  if (!VISIBLE_ASCII.test(input)) return DEFAULT_NEXT;
  if (!input.startsWith('/')) return DEFAULT_NEXT;
  if (input.includes('#')) return DEFAULT_NEXT;

  let current = input;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (looksLikeAnotherHost(current) || isAuthRoute(current)) return DEFAULT_NEXT;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Trasig procentkodning: ingen vet vad någon annan skulle göra av den.
      return DEFAULT_NEXT;
    }
    if (decoded === current) return input;
    current = decoded;
  }
  // Fler lager än rimligt: det är inte en vanlig länk.
  return DEFAULT_NEXT;
}
