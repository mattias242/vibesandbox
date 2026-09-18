/**
 * Adresser. En app får inte peka ut något utanför sin egen origin: plattformens CSP stoppar
 * anropen i webbläsaren, och policyn stoppar dem redan här så att modellen får veta varför.
 */

/**
 * Adresser som får stå i appens källkod. De är IDENTIFIERARE, inte nätanrop: XML-namnrymder
 * som skickas till `document.createElementNS` (React behöver dem för SVG och MathML). En
 * webbläsare hämtar aldrig något från dem. Exakt jämförelse — `http://www.w3.org/2000/svg.x`
 * är inte samma sak.
 */
export const ALLOWED_SOURCE_URLS: readonly string[] = [
  'http://www.w3.org/2000/svg', // SVG
  'http://www.w3.org/1998/Math/MathML', // MathML
  'http://www.w3.org/1999/xlink', // xlink:href i äldre SVG
  'http://www.w3.org/1999/xhtml', // XHTML, t.ex. i <foreignObject>
  'http://www.w3.org/XML/1998/namespace', // xml:lang
];

/**
 * Adresser som får stå i den BYGGDA bunten: namnrymderna ovan samt Reacts felsida, som står i
 * TEXTEN till minifierade felmeddelanden ("visit https://react.dev/errors/418"). Samma lista som
 * mallens test/build.test.ts. Poster som slutar med `/` gäller som prefix.
 */
export const ALLOWED_BUNDLE_URLS: readonly string[] = [...ALLOWED_SOURCE_URLS, 'https://react.dev/errors/'];

const ABSOLUTE_URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>\\)]*/gi;

export interface UrlHit {
  readonly url: string;
  readonly index: number;
}

export function findExternalUrls(text: string, allowed: readonly string[]): UrlHit[] {
  const hits: UrlHit[] = [];
  for (const match of text.matchAll(ABSOLUTE_URL)) {
    const url = match[0];
    const ok = allowed.some((entry) => url === entry || (entry.endsWith('/') && url.startsWith(entry)));
    if (!ok) hits.push({ url, index: match.index });
  }
  return hits;
}

/** `//värd/…` — tar samma schema som sidan, dvs. en extern adress. Inte `a // b` och inte `https://`. */
export const PROTOCOL_RELATIVE = /(?<![:\w/\\])\/\/[A-Za-z0-9[]/;

/** `javascript:` även med blanktecken insprängda, som webbläsare ignorerar i adresser. */
export const JAVASCRIPT_URL = new RegExp(`${[...'javascript'].join('\\s*')}\\s*:`, 'i');

export const DATA_HTML_URL = /data:\s*text\/html/i;
