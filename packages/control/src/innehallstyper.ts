/**
 * Innehållstyp bestäms EN gång, vid importen, ur en allowlist på filändelser. Gatewayn skickar
 * typen vidare som den är och webbläsaren förbjuds gissa (`nosniff`), så det är den här listan
 * som avgör hur en fil tolkas. En okänd ändelse avvisas — vi gissar aldrig och faller aldrig
 * tillbaka på `application/octet-stream`.
 *
 * Jämförelsen är skiftlägeskänslig med flit: `SIDA.HTML` finns inte i listan. Ett bygge ur
 * appmallen ger bara gemena ändelser, och varje "hjälpsam" normalisering är ett ställe där två
 * lager kan tolka samma namn olika.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['map', 'application/json; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['woff2', 'font/woff2'],
]);

/** `undefined` ⇒ filen får inte importeras. Bara den SISTA ändelsen räknas (`a.html.bak` ⇒ `bak`). */
export function contentTypeForFileName(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  return CONTENT_TYPES.get(fileName.slice(dot + 1));
}
