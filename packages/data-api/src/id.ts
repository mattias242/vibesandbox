/**
 * Dokument-id: 26 tecken Crockford-base32 i gemener, uppbyggt som ett ULID.
 *
 *   tttttttttt rrrrrrrrrrrrrrrr
 *   10 tecken  16 tecken
 *   tid (ms)   80 bitar slump ur node:crypto
 *
 * Varför tidsprefix: id:n sorterar då ungefär i skapandeordning, så listning kan sidindelas med
 * ett enkelt "id större än det förra" mot primärnyckelns index — stabilt även när dokument läggs
 * till eller tas bort mellan sidorna.
 *
 * Varför kryptografisk slump: ett id är inte en hemlighet (åtkomst avgörs av hyresgäst och ägare),
 * men det ska inte heller gå att gissa sig till id:n i en annan app eller kollektion.
 *
 * SKAPANDEORDNING: kontraktet lovar att listning ger dokumenten i den ordning de skapades.
 * Tidsprefixet räcker inte för det — inom samma millisekund avgör slumpdelen, och en serverklocka
 * som ställs bakåt (NTP) ger nya id som sorteras FÖRE gamla. Därför `nextDocumentId`: ett nytt id
 * är alltid större än kollektionens hittills största. Är det slumpade id:t inte det, räknas det
 * största upp med ett. Inom en och samma kollektion kan grann-id:n då räknas ut, vilket är
 * ofarligt: den som får lista kollektionen ser dem ändå, och i en personlig kollektion ger någon
 * annans id `not_found` hur väl man än gissar.
 */
import { randomBytes } from 'node:crypto';

/** Crockfords alfabet utesluter i, l, o och u. Samma teckenuppsättning som DOCUMENT_ID_PATTERN. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export function newDocumentId(nowMs: number = Date.now()): string {
  // 10 tecken rymmer 50 bitar; klockan i millisekunder behöver 41 i dag och ryms gott och väl.
  // Vanlig heltalsaritmetik är exakt här eftersom värdet ligger långt under 2^53.
  let time = '';
  let remaining = Math.max(0, Math.floor(nowMs));
  for (let i = 0; i < TIME_LENGTH; i++) {
    time = ALPHABET.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }

  // En byte per tecken, de fem lägsta bitarna används. 256 är jämnt delbart med 32, så varje
  // tecken är likformigt fördelat — ingen modulo-snedvridning.
  const bytes = randomBytes(RANDOM_LENGTH);
  let random = '';
  for (const byte of bytes) random += ALPHABET.charAt(byte & 31);

  return time + random;
}

/**
 * Ett id som är strikt större än `previous` — kollektionens hittills största id, eller `undefined`
 * om kollektionen är tom. Anroparen läser `previous` och sparar det nya id:t i SAMMA transaktion.
 */
export function nextDocumentId(previous: string | undefined, nowMs: number = Date.now()): string {
  const candidate = newDocumentId(nowMs);
  if (previous === undefined || candidate > previous) return candidate;
  return increment(previous);
}

/** Tolkar id:t som ett tal i bas 32 och lägger till ett. */
function increment(id: string): string {
  const digits = Array.from(id, (character) => ALPHABET.indexOf(character));
  if (digits.length !== TIME_LENGTH + RANDOM_LENGTH || digits.includes(-1)) {
    throw new Error('Kollektionens största dokument-id har ett oväntat format.');
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit < ALPHABET.length - 1) {
      digits[i] = digit + 1;
      return digits.map((value) => ALPHABET.charAt(value)).join('');
    }
    digits[i] = 0;
  }
  // 130 bitar är slut. Inträffar inte i praktiken; hellre ett tydligt fel än ett id som slår runt.
  throw new Error('Dokument-id:n är slut i kollektionen.');
}
