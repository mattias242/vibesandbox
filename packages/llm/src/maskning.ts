/**
 * Maskning av personuppgifter i text innan den lämnar servern.
 *
 * Det här är ett SKYDDSNÄT, inte en garanti: det hittar uppgifter med en bestämd form
 * (personnummer, telefon, e-post, kort, IBAN). Namn, adresser och fritext om personer har
 * ingen sådan form och maskas INTE — se README.
 *
 * Grundregel när formen är tvetydig: hellre maska i onödan än släppa igenom. En platshållare
 * för mycket kostar lite; en personuppgift som skickats iväg går inte att ta tillbaka.
 *
 * Alla reguljära uttryck är skrivna så att varje startposition avgörs i linjär tid
 * (ankrade med negativa lookbehinds och utan nästlade kvantifierare), så att en fientligt
 * lång text inte kan låsa servern.
 */

export type PersonalDataKind = 'personnummer' | 'telefon' | 'e-post' | 'kortnummer' | 'iban';

export interface MaskResult {
  readonly text: string;
  /** Vilka SORTERS uppgifter som maskades, en post per träff. Aldrig själva värdena. */
  readonly found: readonly PersonalDataKind[];
}

const PLACEHOLDER: Readonly<Record<PersonalDataKind, string>> = {
  personnummer: '[PERSONNUMMER]',
  telefon: '[TELEFON]',
  'e-post': '[E-POST]',
  kortnummer: '[KORTNUMMER]',
  iban: '[IBAN]',
};

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  // mod-97 bit för bit, så att vi slipper stora heltal.
  let rest = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) rest = (rest * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

/** Giltigt datum ÅÅMMDD; dag + 60 är samordningsnummer. Året spelar ingen roll för skottdagen här. */
function validBirthDate(yymmdd: string): boolean {
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (day > 60) day -= 60;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

// ── Mönster ──────────────────────────────────────────────────────────────────────

// IBAN: landskod, två kontrollsiffror och sedan tecken i grupper om högst fyra (med eller utan
// mellanslag). Kandidaten kan ha svalt ett efterföljande ord med versaler; se trimningen nedan.
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}(?![A-Za-z0-9])/g;

// Kort: 13–19 siffror i följd, eller i fyrgrupper med samma skiljetecken, eller Amex 4-6-5.
const CARD_CONTIGUOUS = /(?<![\d])\d{13,19}(?!\d)/g;
const CARD_GROUPED = /(?<![\d-])\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?(?![\d])/g;
const CARD_AMEX = /(?<![\d-])\d{4}([ -])\d{6}\1\d{5}(?![\d])/g;

// Personnummer: (ÅÅ)ÅÅMMDD, valfritt - eller +, NNNN. Inte en del av en längre sifferföljd.
const PERSONNUMMER = /(?<![\d+-])((?:19|20)?)(\d{6})([-+]?)(\d{4})(?![\d])/g;

// Telefon: +46/0046 (valfritt "(0)") eller 0, följt av 7–9 siffror med enstaka mellanslag
// eller bindestreck. Svenska nationella nummer har 7–9 siffror efter nollan.
const PHONE_INTERNATIONAL = /(?<![\w+])(?:\+46|0046)[ -]?(?:\(0\)[ -]?)?[1-9](?:[ -]?\d){6,8}(?![\d])/g;
const PHONE_NATIONAL = /(?<![\w+-])0[1-9](?:[ -]?\d){6,8}(?![\d])/g;

// E-post, även med å/ä/ö. Lookbehind gör att bara början av ett ord prövas (linjär tid).
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;

// ── Maskning ─────────────────────────────────────────────────────────────────────

export function maskPersonalData(input: string): MaskResult {
  const found: PersonalDataKind[] = [];
  let text = input;

  const replace = (pattern: RegExp, kind: PersonalDataKind, accept: (match: RegExpExecArray) => string | null) => {
    text = text.replace(pattern, (...args: unknown[]) => {
      // Återskapa en RegExpExecArray-liknande struktur av replace-argumenten.
      const groupCount = args.findIndex((a) => typeof a === 'number') - 1;
      const match = args.slice(0, groupCount + 1) as unknown as RegExpExecArray;
      const whole = match[0];
      const keep = accept(match);
      if (keep === null) return whole;
      found.push(kind);
      // `keep` är den del av träffen som INTE var personuppgiften (t.ex. ett ord som IBAN-mönstret svalde).
      return PLACEHOLDER[kind] + keep;
    });
  };

  // Ordningen spelar roll: de längsta och mest specifika formerna först, så att t.ex. ett
  // IBAN inte delvis tolkas som telefonnummer. Platshållarna innehåller inga siffror och
  // kan därför inte matchas av senare mönster.
  replace(EMAIL, 'e-post', () => '');

  replace(IBAN, 'iban', (m) => {
    // Pröva längsta möjliga prefix först och korta av med en grupp i taget, så att ett
    // efterföljande versalord ("… 7466 OCR") inte gör att hela IBAN:et släpps igenom.
    const groups = m[0].split(' ');
    for (let n = groups.length; n >= 1; n--) {
      const candidate = groups.slice(0, n).join('');
      if (ibanValid(candidate)) {
        const rest = groups.slice(n).join(' ');
        return rest === '' ? '' : ' ' + rest;
      }
    }
    return null;
  });

  const card = (m: RegExpExecArray) => {
    const digits = m[0].replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '' : null;
  };
  replace(CARD_GROUPED, 'kortnummer', card);
  replace(CARD_AMEX, 'kortnummer', card);
  replace(CARD_CONTIGUOUS, 'kortnummer', card);

  replace(PERSONNUMMER, 'personnummer', (m) => {
    const date = m[2] ?? '';
    const separator = m[3] ?? '';
    const serial = m[4] ?? '';
    if (!validBirthDate(date)) return null;
    // Med skiljetecken är formen entydig: det är ett personnummer, även om kontrollsiffran är
    // fel (felskrivet eller påhittat). Utan skiljetecken kan tio siffror vara vad som helst,
    // så där får kontrollsiffran avgöra.
    if (separator !== '') return '';
    return luhnValid(date + serial) ? '' : null;
  });

  replace(PHONE_INTERNATIONAL, 'telefon', () => '');
  replace(PHONE_NATIONAL, 'telefon', () => '');

  return { text, found };
}
