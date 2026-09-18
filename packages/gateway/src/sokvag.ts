/**
 * Normalisering av förfrågans sökväg. Ren funktion.
 *
 * Principen är att NEKA hellre än att "rätta": en sökväg som behöver lagas för att bli ofarlig
 * är redan ett angreppsförsök eller ett fel, och varje lagning är ett ställe där vår tolkning
 * kan skilja sig från nästa lagers. Resultatet är en lista segment; både API-routningen och
 * filservern arbetar på den listan, aldrig på den råa strängen — det finns alltså bara EN
 * tolkning av sökvägen i hela gatewayn.
 *
 * Ordningen är vald så att ett kodat snedstreck aldrig kan bli en avdelare: vi delar på `/`
 * FÖRST och avkodar sedan varje segment EN gång. `..%2fx` blir då ett enda segment `../x`, som
 * faller på teckenlistan — inte två segment `..` och `x`.
 */

/** Tak för hela den råa mål-URL:en (sökväg + fråga). */
const MAX_TARGET_LENGTH = 2048;
const MAX_SEGMENT_LENGTH = 255;
const MAX_SEGMENTS = 32;

/**
 * Tillåtna tecken i ett avkodat segment: bokstäver (även å, ä, ö — SPA-adresser och filnamn),
 * kombinerande tecken, siffror och en liten uppsättning skiljetecken. Allt annat nekas, däribland
 * `/`, `\`, `%`, `:`, `?`, `#`, NUL och övriga kontrolltecken.
 */
const SEGMENT_PATTERN = /^[\p{L}\p{M}\p{N}._~@+=,() -]+$/u;

/** Finns procentkodning kvar EFTER avkodningen var indata dubbelkodat (`%252e` ⇒ `%2e`). */
const REMAINING_PERCENT_ENCODING = /%[0-9a-fA-F]{2}/;

export interface NormalizedTarget {
  /** Avkodade, godkända segment. `/` ⇒ tom lista. Avslutande snedstreck är borttaget. */
  readonly segments: readonly string[];
  /** Rå frågesträng utan `?` (tom om den saknas). Tolkas bara av API-routningen. */
  readonly query: string;
}

function hasForbiddenCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    // Kontrolltecken (inklusive NUL, kod 0), DEL och bakåtstreck. Skrivs som teckenkoder i
    // stället för escape-sekvenser så att källfilen aldrig kan råka innehålla en rå NUL-byte.
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function decodeSegment(raw: string): string | 'ogiltig' {
  let decoded: string;
  try {
    // Kastar vid trasig procentkodning och vid byteföljder som inte är giltig UTF-8.
    decoded = decodeURIComponent(raw);
  } catch {
    return 'ogiltig';
  }
  if (decoded.length === 0 || decoded.length > MAX_SEGMENT_LENGTH) return 'ogiltig';
  if (hasForbiddenCharacter(decoded)) return 'ogiltig';
  if (REMAINING_PERCENT_ENCODING.test(decoded)) return 'ogiltig';
  // `.` och `..` är traversering; övriga punktfiler (`.env`, `.git`) ska en app aldrig servera.
  if (decoded.startsWith('.')) return 'ogiltig';
  if (!SEGMENT_PATTERN.test(decoded)) return 'ogiltig';
  return decoded;
}

export function normalizeTarget(rawTarget: string | undefined): NormalizedTarget | 'ogiltig' {
  if (typeof rawTarget !== 'string') return 'ogiltig';
  if (rawTarget.length === 0 || rawTarget.length > MAX_TARGET_LENGTH) return 'ogiltig';
  // Bara origin-form (`/sökväg`). Absolut form (`http://annan-värd/…`) och `*` nekas: de bär en
  // andra uppgift om värd som aldrig får konkurrera med `Host`.
  if (!rawTarget.startsWith('/')) return 'ogiltig';

  const questionMark = rawTarget.indexOf('?');
  const rawPath = questionMark === -1 ? rawTarget : rawTarget.slice(0, questionMark);
  const query = questionMark === -1 ? '' : rawTarget.slice(questionMark + 1);

  const rawSegments = rawPath.slice(1).split('/');
  // Ett avslutande snedstreck (`/mapp/`, och `/` självt) ger ett sista tomt segment; det tas bort.
  // Tomma segment på andra ställen (`//`, `/a//b`) nekas.
  if (rawSegments[rawSegments.length - 1] === '') rawSegments.pop();
  if (rawSegments.length > MAX_SEGMENTS) return 'ogiltig';

  const segments: string[] = [];
  for (const raw of rawSegments) {
    const decoded = decodeSegment(raw);
    if (decoded === 'ogiltig') return 'ogiltig';
    segments.push(decoded);
  }
  return { segments, query };
}
