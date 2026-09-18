/**
 * Strikt läsning av EN namngiven kaka ur `Cookie`-huvudet. Ren funktion: ingen I/O, kastar aldrig.
 *
 * Varför inte "ta första träffen", som de flesta kakbibliotek gör: alla appar ligger under samma
 * domän, och en syskonapp KAN plantera en kaka med `Domain=` som når vår värd (ADR 0002, mätt i
 * spik S1). Webbläsaren skickar då kaknamnet TVÅ gånger, och ordningen styrs av angriparen
 * (längst `Path` först, sedan äldst). Att välja en av dem är att låta angriparen välja. Därför:
 * förekommer namnet mer än en gång är svaret "tvetydigt", och den som frågar ska neka.
 *
 * Priset är att en syskonapp kan hindra en inloggning (samma slags driftstörning som
 * kakbombning, en känd restrisk i ADR 0002) — men aldrig byta ut den.
 *
 * Kakor med andra namn ignoreras helt (ADR 0002, villkor 4). Värdet lämnas ordagrant: ingen
 * procentavkodning och inga borttagna citattecken. Det vi själva satt behöver ingetdera, och varje
 * "hjälpsam" avkodning är ett ställe där två olika värden på tråden blir samma värde hos oss.
 */

/**
 * Inget rimligt `Cookie`-huvud är i närheten av så här långt (serverns rekommenderade tak för
 * ALLA huvuden tillsammans är 8 KiB, se server.ts). Längre än så nekas utan att tolkas.
 */
export const MAX_COOKIE_HEADER_LENGTH = 8192;

export type CookieLookup =
  | { readonly outcome: 'found'; readonly value: string }
  | { readonly outcome: 'missing' }
  /** Namnet förekom mer än en gång. Den som frågar ska NEKA, aldrig välja. */
  | { readonly outcome: 'ambiguous' }
  | { readonly outcome: 'oversized' };

/** Blanktecken som får omge ett kakpar enligt RFC 6265: mellanslag och tabb (teckenkod 9). */
function trimOptionalWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start += 1;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end -= 1;
  return text.slice(start, end);
}

/**
 * `cookieHeader` är värdet Node ger för `cookie`: flera `Cookie`-huvuden i samma förfrågan är då
 * redan hopslagna med "; ", så en dubblett över två huvuden syns här precis som en dubblett i ett.
 */
export function readSingleCookie(cookieHeader: unknown, name: string): CookieLookup {
  if (typeof cookieHeader !== 'string') return { outcome: 'missing' };
  if (cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) return { outcome: 'oversized' };

  let value: string | undefined;
  for (const pair of cookieHeader.split(';')) {
    const equals = pair.indexOf('=');
    // Ett par utan `=` är en namnlös kaka; den kan aldrig vara vår.
    if (equals === -1) continue;
    // Bara det FÖRSTA `=` delar namn från värde; resten hör till värdet. Namnet jämförs exakt och
    // skiftlägeskänsligt — okända namn når aldrig längre än hit.
    if (trimOptionalWhitespace(pair.slice(0, equals)) !== name) continue;
    if (value !== undefined) return { outcome: 'ambiguous' };
    value = trimOptionalWhitespace(pair.slice(equals + 1));
  }
  return value === undefined ? { outcome: 'missing' } : { outcome: 'found', value };
}
