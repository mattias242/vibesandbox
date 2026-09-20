/**
 * Textlagret ur en PDF — bara Nodes standardbibliotek (`node:zlib` för FlateDecode).
 *
 * Filen kommer från en användare och är därför fientlig indata tills motsatsen bevisats. Modulen
 * läser aldrig från disk, når aldrig nätet och loggar ingenting: in-byte → ut-text. Allt som kan
 * växa obegränsat har ett tak (tid, tecken, utpackade byte, sidor, rekursionsdjup, besökta objekt),
 * och varje slinga som följer referenser håller reda på vad den redan sett — objektreferenser i en
 * PDF kan peka i cirkel.
 *
 * Teckenkodningen är själva poängen: en svensk text ska bli svensk text. Därför tolkas
 * WinAnsiEncoding, MacRomanEncoding, StandardEncoding, `/Differences` i typsnittets encoding och
 * `Identity-H` med `ToUnicode`-CMap. Går en teckenkod inte att översätta hoppas tecknet över —
 * ett tappat tecken är bättre än ett påhittat.
 *
 * Målet är läsbar löptext, inte exakt layout. Sidor kommer i ordning med tom rad emellan.
 */
import { inflateSync, constants as zlibKonstanter } from 'node:zlib';

// ---------------------------------------------------------------------------
// Publikt gränssnitt
// ---------------------------------------------------------------------------

export interface PdfText {
  readonly text: string;
  readonly pages: number;
  readonly truncated: boolean;
}

export interface PdfLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxChars: number;
  readonly maxMs: number;
}

export type PdfErrorReason = 'invalid' | 'encrypted' | 'too_large' | 'too_many_pages' | 'timeout';

/** Klarspråk på svenska: meddelandet kan nå en användare och röjer inga interna detaljer. */
const FELTEXT: Record<PdfErrorReason, string> = {
  invalid: 'Filen går inte att läsa som PDF.',
  encrypted: 'PDF:en är lösenordsskyddad och går inte att läsa.',
  too_large: 'PDF:en är för stor för att läsas.',
  too_many_pages: 'PDF:en har fler sidor än vad som kan läsas.',
  timeout: 'PDF:en tog för lång tid att läsa.',
};

export class PdfError extends Error {
  readonly reason: PdfErrorReason;

  constructor(reason: PdfErrorReason) {
    super(FELTEXT[reason] ?? FELTEXT.invalid);
    this.name = 'PdfError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Tak som inte kommer från anroparen. Allt här skyddar processen, inte kvaliteten.
// ---------------------------------------------------------------------------

/** Hur djupt en array eller ordbok får nästlas innan innehållet hoppas över. */
const MAX_DJUP = 48;
/** Hur många poster en array eller ordbok får ha. */
const MAX_POSTER = 500_000;
/** Hur många led en referenskedja får ha innan den betraktas som trasig. */
const MAX_REF_HOPP = 32;
/** Hur många noder sidträdet får ha (skyddar mot ett träd som bara är bredd). */
const MAX_TRADNODER = 200_000;
/** Hur djupt ett formulär-XObject får anropa ett annat. */
const MAX_XOBJECT_DJUP = 6;
/** Hur många xref-sektioner en kedja får ha. */
const MAX_XREF_LED = 64;
/** Hur många tecken en ToUnicode-CMap får beskriva. */
const MAX_CMAP_POSTER = 200_000;
/** Hur många operationer en innehållsström får innehålla. */
const MAX_OPERATIONER = 5_000_000;
/** Under detta värde blir en TJ-justering ett mellanslag (tusendelar av textrutan). */
const TJ_MELLANSLAG = -100;
/** Hur stor vertikal förflyttning som räknas som en ny rad (i textrummets enheter). */
const RADBYTE_GRANS = 0.5;

// ---------------------------------------------------------------------------
// Värden i en PDF
// ---------------------------------------------------------------------------

type Namn = { readonly t: 'name'; readonly v: string };
type Strang = { readonly t: 'str'; readonly v: Uint8Array };
type Referens = { readonly t: 'ref'; readonly num: number; readonly gen: number };
type Lista = { readonly t: 'arr'; readonly v: Varde[] };
type Ordbok = { readonly t: 'dict'; readonly v: Map<string, Varde> };
type Strom = { readonly t: 'stream'; readonly v: Map<string, Varde>; readonly start: number; readonly slut: number };
/** En operator i en innehållsström, eller ett nyckelord vi inte känner igen. */
type Operator = { readonly t: 'op'; readonly v: string };

type Varde = number | boolean | null | Namn | Strang | Referens | Lista | Ordbok | Strom | Operator;

function arDict(v: Varde | undefined): v is Ordbok {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'dict';
}
function arStrom(v: Varde | undefined): v is Strom {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'stream';
}
/** Både ordböcker och strömmar bär en ordbok. */
function taOrdbok(v: Varde | undefined): Map<string, Varde> | null {
  if (arDict(v)) return v.v;
  if (arStrom(v)) return v.v;
  return null;
}
function taNamn(v: Varde | undefined): string | null {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'name' ? v.v : null;
}
function taTal(v: Varde | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function taLista(v: Varde | undefined): Varde[] | null {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'arr' ? v.v : null;
}
function taStrang(v: Varde | undefined): Uint8Array | null {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'str' ? v.v : null;
}
function arRef(v: Varde | undefined): v is Referens {
  return typeof v === 'object' && v !== null && 't' in v && v.t === 'ref';
}

// ---------------------------------------------------------------------------
// Byteläsning
// ---------------------------------------------------------------------------

const BLANK = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) BLANK[c] = 1;
const AVGRANSARE = new Uint8Array(256);
for (const c of '()<>[]{}/%') AVGRANSARE[c.charCodeAt(0)] = 1;

function arBlank(b: number | undefined): boolean {
  return b !== undefined && BLANK[b] === 1;
}
function arVanlig(b: number | undefined): boolean {
  return b !== undefined && BLANK[b] !== 1 && AVGRANSARE[b] !== 1;
}

function bokstaver(text: string): number[] {
  const ut: number[] = [];
  for (let i = 0; i < text.length; i++) ut.push(text.charCodeAt(i) & 0xff);
  return ut;
}

/**
 * Enkel framåtsökning efter en kort byteföljd. Naiv sökning duger: nålarna är några få byte och
 * intervallen är avgränsade, så det kan inte bli kvadratiskt på riktig indata — och till skillnad
 * från ett reguljärt uttryck finns här ingen backtracking alls.
 */
function hittaBytes(buf: Uint8Array, nal: readonly number[], fran: number, till: number): number {
  const forsta = nal[0];
  if (forsta === undefined) return -1;
  const slut = Math.min(till, buf.length) - nal.length;
  for (let i = Math.max(0, fran); i <= slut; i++) {
    if (buf[i] !== forsta) continue;
    let traff = true;
    for (let j = 1; j < nal.length; j++) {
      if (buf[i + j] !== nal[j]) {
        traff = false;
        break;
      }
    }
    if (traff) return i;
  }
  return -1;
}

function hittaBytesBaklanges(buf: Uint8Array, nal: readonly number[], fran: number, till: number): number {
  const forsta = nal[0];
  if (forsta === undefined) return -1;
  for (let i = Math.min(till, buf.length) - nal.length; i >= Math.max(0, fran); i--) {
    if (buf[i] !== forsta) continue;
    let traff = true;
    for (let j = 1; j < nal.length; j++) {
      if (buf[i + j] !== nal[j]) {
        traff = false;
        break;
      }
    }
    if (traff) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { k: 'eof' }
  | { k: 'num'; num: number }
  | { k: 'name'; str: string }
  | { k: 'str'; bytes: Uint8Array }
  | { k: 'kw'; str: string }
  | { k: 'arr-start' }
  | { k: 'arr-slut' }
  | { k: 'dict-start' }
  | { k: 'dict-slut' }
  | { k: 'klammer' };

class Lexer {
  buf: Uint8Array;
  pos: number;
  slut: number;

  constructor(buf: Uint8Array, pos = 0, slut = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.slut = Math.min(slut, buf.length);
  }

  hoppaBlanka(): void {
    const { buf } = this;
    while (this.pos < this.slut) {
      const b = buf[this.pos];
      if (arBlank(b)) {
        this.pos++;
      } else if (b === 0x25) {
        // Kommentar till radslut.
        while (this.pos < this.slut && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos++;
      } else {
        return;
      }
    }
  }

  lasToken(): Token {
    this.hoppaBlanka();
    if (this.pos >= this.slut) return { k: 'eof' };
    const { buf } = this;
    const b = buf[this.pos] ?? 0;

    if (b === 0x5b) {
      this.pos++;
      return { k: 'arr-start' };
    }
    if (b === 0x5d) {
      this.pos++;
      return { k: 'arr-slut' };
    }
    if (b === 0x7b || b === 0x7d) {
      this.pos++;
      return { k: 'klammer' };
    }
    if (b === 0x3c) {
      if (buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { k: 'dict-start' };
      }
      return { k: 'str', bytes: this.lasHexStrang() };
    }
    if (b === 0x3e) {
      if (buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { k: 'dict-slut' };
      }
      this.pos++; // ensamt '>' är skräp
      return this.lasToken();
    }
    if (b === 0x28) return { k: 'str', bytes: this.lasLitteralStrang() };
    if (b === 0x29) {
      this.pos++; // ensamt ')' är skräp
      return this.lasToken();
    }
    if (b === 0x2f) return { k: 'name', str: this.lasNamn() };
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const tal = this.lasTal();
      if (tal !== null) return { k: 'num', num: tal };
      return this.lasToken();
    }
    return { k: 'kw', str: this.lasNyckelord() };
  }

  lasNyckelord(): string {
    const start = this.pos;
    while (this.pos < this.slut && arVanlig(this.buf[this.pos])) this.pos++;
    if (this.pos === start) this.pos++; // aldrig stå still
    return latin1(this.buf, start, this.pos);
  }

  lasTal(): number | null {
    const start = this.pos;
    let tecken = 1;
    let sagPunkt = false;
    let heltal = 0;
    let brak = 0;
    let brakVikt = 1;
    let siffror = 0;
    while (this.pos < this.slut) {
      const b = this.buf[this.pos] ?? 0;
      if (b === 0x2b || b === 0x2d) {
        // Flera tecken i rad förekommer i trasiga filer; sista gäller.
        tecken = b === 0x2d ? -1 : 1;
        this.pos++;
      } else if (b === 0x2e) {
        sagPunkt = true;
        this.pos++;
      } else if (b >= 0x30 && b <= 0x39) {
        siffror++;
        if (sagPunkt) {
          brakVikt /= 10;
          brak += (b - 0x30) * brakVikt;
        } else {
          heltal = heltal * 10 + (b - 0x30);
        }
        this.pos++;
      } else {
        break;
      }
      // Ett tal som är längre än så är inte ett tal.
      if (this.pos - start > 64) break;
    }
    if (siffror === 0) {
      if (this.pos === start) this.pos++;
      return null;
    }
    const v = tecken * (heltal + brak);
    return Number.isFinite(v) ? v : 0;
  }

  lasNamn(): string {
    this.pos++; // '/'
    const delar: number[] = [];
    while (this.pos < this.slut && arVanlig(this.buf[this.pos])) {
      let b = this.buf[this.pos] ?? 0;
      if (b === 0x23 && this.pos + 2 < this.slut) {
        const hi = hexVarde(this.buf[this.pos + 1]);
        const lo = hexVarde(this.buf[this.pos + 2]);
        if (hi >= 0 && lo >= 0) {
          b = hi * 16 + lo;
          this.pos += 2;
        }
      }
      delar.push(b);
      this.pos++;
      if (delar.length > 256) break; // namn är korta
    }
    return String.fromCharCode(...delar);
  }

  lasLitteralStrang(): Uint8Array {
    this.pos++; // '('
    const ut: number[] = [];
    let niva = 1;
    while (this.pos < this.slut) {
      const b = this.buf[this.pos++] ?? 0;
      if (b === 0x5c) {
        const n = this.buf[this.pos++] ?? 0;
        if (n === 0x6e) ut.push(10);
        else if (n === 0x72) ut.push(13);
        else if (n === 0x74) ut.push(9);
        else if (n === 0x62) ut.push(8);
        else if (n === 0x66) ut.push(12);
        else if (n === 10) {
          /* radfortsättning */
        } else if (n === 13) {
          if (this.buf[this.pos] === 10) this.pos++;
        } else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let i = 0; i < 2; i++) {
            const c = this.buf[this.pos];
            if (c === undefined || c < 0x30 || c > 0x37) break;
            v = v * 8 + (c - 0x30);
            this.pos++;
          }
          ut.push(v & 0xff);
        } else {
          ut.push(n);
        }
      } else if (b === 0x28) {
        niva++;
        ut.push(b);
      } else if (b === 0x29) {
        niva--;
        if (niva === 0) break;
        ut.push(b);
      } else {
        ut.push(b);
      }
      if (ut.length > 1 << 22) break; // en enskild sträng behöver aldrig vara större
    }
    return Uint8Array.from(ut);
  }

  lasHexStrang(): Uint8Array {
    this.pos++; // '<'
    const ut: number[] = [];
    let hog = -1;
    while (this.pos < this.slut) {
      const b = this.buf[this.pos++] ?? 0;
      if (b === 0x3e) break;
      const v = hexVarde(b);
      if (v < 0) continue;
      if (hog < 0) {
        hog = v;
      } else {
        ut.push(hog * 16 + v);
        hog = -1;
      }
      if (ut.length > 1 << 22) break;
    }
    if (hog >= 0) ut.push(hog * 16); // udda antal siffror: sista fylls med 0
    return Uint8Array.from(ut);
  }
}

function hexVarde(b: number | undefined): number {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

function latin1(buf: Uint8Array, fran: number, till: number): string {
  let ut = '';
  const slut = Math.min(till, buf.length);
  for (let i = fran; i < slut; i++) ut += String.fromCharCode(buf[i] ?? 0);
  return ut;
}

// ---------------------------------------------------------------------------
// Värdeparsning
// ---------------------------------------------------------------------------

function lasVarde(lx: Lexer, djup: number): Varde | undefined {
  const t = lx.lasToken();
  switch (t.k) {
    case 'eof':
      return undefined;
    case 'num':
      return t.num;
    case 'name':
      return { t: 'name', v: t.str };
    case 'str':
      return { t: 'str', v: t.bytes };
    case 'arr-start':
      if (djup >= MAX_DJUP) {
        hoppaBehallare(lx, djup);
        return null;
      }
      return { t: 'arr', v: lasPoster(lx, djup + 1, 'arr-slut') };
    case 'dict-start': {
      if (djup >= MAX_DJUP) {
        hoppaBehallare(lx, djup);
        return null;
      }
      const poster = lasPoster(lx, djup + 1, 'dict-slut');
      return { t: 'dict', v: parihop(poster) };
    }
    case 'arr-slut':
      return { t: 'op', v: ']' };
    case 'dict-slut':
      return { t: 'op', v: '>>' };
    case 'klammer':
      return { t: 'op', v: '{' };
    case 'kw':
      if (t.str === 'true') return true;
      if (t.str === 'false') return false;
      if (t.str === 'null') return null;
      return { t: 'op', v: t.str };
  }
}

/** Läser poster tills behållaren stängs. `R` slår ihop de två föregående talen till en referens. */
function lasPoster(lx: Lexer, djup: number, slutTecken: 'arr-slut' | 'dict-slut'): Varde[] {
  const poster: Varde[] = [];
  const slutOp = slutTecken === 'arr-slut' ? ']' : '>>';
  for (;;) {
    const v = lasVarde(lx, djup);
    if (v === undefined) return poster; // filslut mitt i en behållare
    if (typeof v === 'object' && v !== null && 't' in v && v.t === 'op') {
      if (v.v === slutOp) return poster;
      if (v.v === ']' || v.v === '>>') return poster; // fel sorts avslut: sluta ändå
      if (v.v === 'R') {
        const gen = poster.pop();
        const num = poster.pop();
        if (typeof num === 'number' && typeof gen === 'number' && num > 0 && Number.isInteger(num)) {
          poster.push({ t: 'ref', num, gen });
        }
        continue;
      }
      if (v.v === 'endobj' || v.v === 'stream') return poster; // trasig behållare
      continue; // annat nyckelord inuti en behållare är skräp
    }
    poster.push(v);
    if (poster.length > MAX_POSTER) return poster;
  }
}

/** Hoppar över en behållare utan att bygga något, när nästlingen blivit för djup. */
function hoppaBehallare(lx: Lexer, _djup: number): void {
  let niva = 1;
  let varv = 0;
  while (niva > 0 && varv++ < MAX_POSTER) {
    const t = lx.lasToken();
    if (t.k === 'eof') return;
    if (t.k === 'arr-start' || t.k === 'dict-start') niva++;
    else if (t.k === 'arr-slut' || t.k === 'dict-slut') niva--;
  }
}

/**
 * Ett objekts kropp på översta nivån. Till skillnad från inuti en behållare måste `N G R`
 * plockas ihop här för hand — `2 0 R` som hel kropp är en giltig indirekt referens.
 */
function lasToppVarde(lx: Lexer): Varde | undefined {
  const forsta = lasVarde(lx, 0);
  if (typeof forsta !== 'number') return forsta;
  const spar = lx.pos;
  const andra = lasVarde(lx, 0);
  if (typeof andra === 'number') {
    const tredje = lasVarde(lx, 0);
    if (typeof tredje === 'object' && tredje !== null && 't' in tredje && tredje.t === 'op' && tredje.v === 'R') {
      if (Number.isInteger(forsta) && forsta > 0) return { t: 'ref', num: forsta, gen: andra };
    }
  }
  lx.pos = spar;
  return forsta;
}

function parihop(poster: Varde[]): Map<string, Varde> {
  const m = new Map<string, Varde>();
  for (let i = 0; i + 1 < poster.length; i += 2) {
    const nyckel = taNamn(poster[i]);
    if (nyckel === null) {
      i--; // skräpvärde: gå fram ett steg i taget tills ett namn dyker upp
      continue;
    }
    const v = poster[i + 1];
    if (v !== undefined && !m.has(nyckel)) m.set(nyckel, v);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Teckenkodning
// ---------------------------------------------------------------------------

const ASCII_GLYFER = (
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine ' +
  'colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'bracketleft backslash bracketright asciicircum underscore grave ' +
  'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'
).split(' ');

const LATIN1_GLYFER = (
  'space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine ' +
  'guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior ' +
  'acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter ' +
  'onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla ' +
  'Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute ' +
  'Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn ' +
  'germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex ' +
  'edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis ' +
  'divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'
).split(' ');

/** Glyfnamn utanför ASCII och Latin-1: typografi, ligaturer och accenter. */
const EXTRA_GLYFER: Record<string, number> = {
  Euro: 0x20ac, quotesinglbase: 0x201a, florin: 0x0192, quotedblbase: 0x201e, ellipsis: 0x2026,
  dagger: 0x2020, daggerdbl: 0x2021, circumflex: 0x02c6, perthousand: 0x2030, Scaron: 0x0160,
  guilsinglleft: 0x2039, OE: 0x0152, Zcaron: 0x017d, quoteleft: 0x2018, quoteright: 0x2019,
  quotedblleft: 0x201c, quotedblright: 0x201d, bullet: 0x2022, endash: 0x2013, emdash: 0x2014,
  tilde: 0x02dc, trademark: 0x2122, scaron: 0x0161, guilsinglright: 0x203a, oe: 0x0153,
  zcaron: 0x017e, Ydieresis: 0x0178, fi: 0xfb01, fl: 0xfb02, dotlessi: 0x0131, lslash: 0x0142,
  Lslash: 0x0141, minus: 0x2212, fraction: 0x2044, breve: 0x02d8, caron: 0x02c7, ring: 0x02da,
  ogonek: 0x02db, hungarumlaut: 0x02dd, dotaccent: 0x02d9, nbspace: 0x00a0, sfthyphen: 0x00ad,
  Delta: 0x2206, Omega: 0x03a9, pi: 0x03c0, radical: 0x221a, infinity: 0x221e, notequal: 0x2260,
  lessequal: 0x2264, greaterequal: 0x2265, partialdiff: 0x2202, summation: 0x2211, product: 0x220f,
  integral: 0x222b, approxequal: 0x2248, lozenge: 0x25ca, apple: 0xf8ff,
};

const GLYF_TILL_TECKEN: Map<string, string> = (() => {
  const m = new Map<string, string>();
  ASCII_GLYFER.forEach((namn, i) => m.set(namn, String.fromCharCode(32 + i)));
  LATIN1_GLYFER.forEach((namn, i) => {
    if (!m.has(namn)) m.set(namn, String.fromCharCode(0xa0 + i));
  });
  for (const [namn, kod] of Object.entries(EXTRA_GLYFER)) {
    if (!m.has(namn)) m.set(namn, String.fromCodePoint(kod));
  }
  return m;
})();

/** Ett glyfnamn till ett tecken. `uniXXXX`, `uXXXX+` och `gNN`/`cidNN` hanteras separat. */
function glyfTillTecken(namn: string): string | null {
  const direkt = GLYF_TILL_TECKEN.get(namn);
  if (direkt !== undefined) return direkt;
  // Namn med variantsuffix: "aring.sc" → "aring".
  const punkt = namn.indexOf('.');
  if (punkt > 0) return glyfTillTecken(namn.slice(0, punkt));
  if (namn.startsWith('uni') && namn.length >= 7) {
    let ut = '';
    for (let i = 3; i + 4 <= namn.length; i += 4) {
      const v = Number.parseInt(namn.slice(i, i + 4), 16);
      if (!Number.isFinite(v)) return null;
      ut += String.fromCharCode(v);
    }
    return ut === '' ? null : ut;
  }
  if (namn.startsWith('u') && namn.length >= 5 && namn.length <= 7) {
    const v = Number.parseInt(namn.slice(1), 16);
    if (Number.isFinite(v) && v >= 0 && v <= 0x10ffff) return String.fromCodePoint(v);
  }
  return null;
}

const CP1252_HOG = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

const MACROMAN_HOG = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3,
  0x00e5, 0x00e7, 0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3,
  0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa,
  0x00ba, 0x03a9, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
  0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce,
  0x00cf, 0x00cc, 0x00d3, 0x00d4, 0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/** StandardEncoding 0xA0–0xFF. 0 = ingen glyf på den koden. */
const STANDARD_HOG = [
  0, 0x00a1, 0x00a2, 0x00a3, 0x2044, 0x00a5, 0x0192, 0x00a7, 0x00a4, 0x0027, 0x201c, 0x00ab,
  0x2039, 0x203a, 0xfb01, 0xfb02, 0, 0x2013, 0x2020, 0x2021, 0x00b7, 0, 0x00b6, 0x2022, 0x201a,
  0x201e, 0x201d, 0x00bb, 0x2026, 0x2030, 0, 0x00bf, 0, 0x0060, 0x00b4, 0x02c6, 0x02dc, 0x00af,
  0x02d8, 0x02d9, 0x00a8, 0, 0x02da, 0x00b8, 0, 0x02dd, 0x02db, 0x02c7, 0x2014, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00c6, 0, 0x00aa, 0, 0, 0, 0, 0x0141, 0x00d8, 0x0152, 0x00ba, 0,
  0, 0, 0, 0, 0x00e6, 0, 0, 0, 0x0131, 0, 0, 0x0142, 0x00f8, 0x0153, 0x00df, 0, 0, 0, 0,
];

/** Bygger en kodtabell: ASCII i botten och `hog` inlagd från `start` och uppåt. */
function byggTabell(hog: readonly number[], start: number, standardLag: boolean): (string | null)[] {
  const tab: (string | null)[] = new Array<string | null>(256).fill(null);
  for (let i = 32; i <= 126; i++) tab[i] = String.fromCharCode(i);
  if (standardLag) {
    // StandardEncoding har typografiska citattecken där ASCII har apostrof och grav accent.
    tab[0x27] = '’';
    tab[0x60] = '‘';
  }
  for (let i = 0; i < hog.length; i++) {
    const v = hog[i] ?? 0;
    if (v > 0) tab[start + i] = String.fromCodePoint(v);
  }
  return tab;
}

const WINANSI = (() => {
  const tab = byggTabell(CP1252_HOG, 0x80, false);
  for (let i = 0xa0; i <= 0xff; i++) tab[i] = String.fromCharCode(i);
  // WinAnsi ritar hårt mellanslag och mjukt bindestreck som vanligt mellanslag respektive
  // bindestreck; det är också så texten ska läsas.
  tab[0xa0] = ' ';
  tab[0xad] = '-';
  return tab;
})();

const MACROMAN = byggTabell(MACROMAN_HOG, 0x80, false);
const STANDARD = byggTabell(STANDARD_HOG, 0xa0, true);

function basTabell(namn: string | null): (string | null)[] {
  if (namn === 'WinAnsiEncoding') return WINANSI;
  if (namn === 'MacRomanEncoding') return MACROMAN;
  return STANDARD;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function packaUppFlate(data: Uint8Array, tak: number): Uint8Array | null {
  const flaggor = { maxOutputLength: Math.max(1, tak), finishFlush: zlibKonstanter.Z_SYNC_FLUSH };
  try {
    return new Uint8Array(inflateSync(data, flaggor));
  } catch (fel) {
    if ((fel as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('too_large');
    // Vissa filer saknar zlib-huvudet; pröva rå deflate innan strömmen ges upp.
    try {
      return new Uint8Array(inflateSync(data.subarray(0), { ...flaggor, windowBits: -15 }));
    } catch (fel2) {
      if ((fel2 as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('too_large');
      return null;
    }
  }
}

function packaUppLzw(data: Uint8Array, tak: number, tidigtByte: number): Uint8Array | null {
  const ut: number[] = [];
  let ordbok: (number[] | undefined)[] = [];
  const nollstall = (): void => {
    ordbok = new Array<number[] | undefined>(4096);
    for (let i = 0; i < 256; i++) ordbok[i] = [i];
  };
  nollstall();
  let nasta = 258;
  let bredd = 9;
  let buffert = 0;
  let bitar = 0;
  let forra: number[] | null = null;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      buffert = (buffert << 8) | (data[i] ?? 0);
      bitar += 8;
    } else if (bitar < bredd) {
      break;
    }
    while (bitar >= bredd) {
      const kod = (buffert >> (bitar - bredd)) & ((1 << bredd) - 1);
      bitar -= bredd;
      if (kod === 256) {
        nollstall();
        nasta = 258;
        bredd = 9;
        forra = null;
        continue;
      }
      if (kod === 257) return Uint8Array.from(ut);
      let post: number[] | undefined = ordbok[kod];
      if (post === undefined) {
        if (forra === null) return null;
        post = [...forra, forra[0] ?? 0];
      }
      for (const b of post) ut.push(b);
      if (ut.length > tak) throw new PdfError('too_large');
      if (forra !== null && nasta < 4096) {
        ordbok[nasta++] = [...forra, post[0] ?? 0];
      }
      forra = post;
      const grans = nasta + tidigtByte;
      if (grans >= 512 && bredd === 9) bredd = 10;
      else if (grans >= 1024 && bredd === 10) bredd = 11;
      else if (grans >= 2048 && bredd === 11) bredd = 12;
    }
  }
  return Uint8Array.from(ut);
}

function packaUppAsciiHex(data: Uint8Array, tak: number): Uint8Array {
  const ut: number[] = [];
  let hog = -1;
  for (const b of data) {
    if (b === 0x3e) break;
    const v = hexVarde(b);
    if (v < 0) continue;
    if (hog < 0) hog = v;
    else {
      ut.push(hog * 16 + v);
      hog = -1;
    }
    if (ut.length > tak) throw new PdfError('too_large');
  }
  if (hog >= 0) ut.push(hog * 16);
  return Uint8Array.from(ut);
}

function packaUppAscii85(data: Uint8Array, tak: number): Uint8Array {
  const ut: number[] = [];
  let grupp: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i] ?? 0;
    if (arBlank(b)) continue;
    if (b === 0x7e) break; // '~>'
    if (b === 0x7a && grupp.length === 0) {
      ut.push(0, 0, 0, 0);
      continue;
    }
    if (b < 0x21 || b > 0x75) continue;
    grupp.push(b - 0x21);
    if (grupp.length === 5) {
      let v = 0;
      for (const g of grupp) v = v * 85 + g;
      ut.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      grupp = [];
      if (ut.length > tak) throw new PdfError('too_large');
    }
  }
  if (grupp.length > 1) {
    const antal = grupp.length - 1;
    while (grupp.length < 5) grupp.push(84);
    let v = 0;
    for (const g of grupp) v = v * 85 + g;
    const byte = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let i = 0; i < antal; i++) ut.push(byte[i] ?? 0);
  }
  return Uint8Array.from(ut);
}

function packaUppRunLength(data: Uint8Array, tak: number): Uint8Array {
  const ut: number[] = [];
  let i = 0;
  while (i < data.length) {
    const langd = data[i++] ?? 128;
    if (langd === 128) break;
    if (langd < 128) {
      for (let j = 0; j <= langd && i < data.length; j++) ut.push(data[i++] ?? 0);
    } else {
      const b = data[i++] ?? 0;
      for (let j = 0; j < 257 - langd; j++) ut.push(b);
    }
    if (ut.length > tak) throw new PdfError('too_large');
  }
  return Uint8Array.from(ut);
}

/** PNG- och TIFF-prediktorer. Används framför allt av xref-strömmar. */
function avPrediktera(data: Uint8Array, prediktor: number, kolumner: number, farger: number, bitar: number): Uint8Array {
  if (prediktor < 2) return data;
  const bpp = Math.max(1, Math.ceil((farger * bitar) / 8));
  const radbyte = Math.max(1, Math.ceil((kolumner * farger * bitar) / 8));
  if (prediktor === 2) {
    if (bitar !== 8) return data; // andra bitdjup är ovanliga; låt dem vara
    const ut = Uint8Array.from(data);
    for (let rad = 0; rad + radbyte <= ut.length; rad += radbyte) {
      for (let i = bpp; i < radbyte; i++) {
        ut[rad + i] = ((ut[rad + i] ?? 0) + (ut[rad + i - bpp] ?? 0)) & 0xff;
      }
    }
    return ut;
  }
  const rader = Math.floor(data.length / (radbyte + 1));
  const ut = new Uint8Array(rader * radbyte);
  let forra = new Uint8Array(radbyte);
  for (let r = 0; r < rader; r++) {
    const typ = data[r * (radbyte + 1)] ?? 0;
    const in_ = data.subarray(r * (radbyte + 1) + 1, r * (radbyte + 1) + 1 + radbyte);
    const rad = new Uint8Array(radbyte);
    for (let i = 0; i < radbyte; i++) {
      const raw = in_[i] ?? 0;
      const a = i >= bpp ? (rad[i - bpp] ?? 0) : 0;
      const b = forra[i] ?? 0;
      const c = i >= bpp ? (forra[i - bpp] ?? 0) : 0;
      let v: number;
      if (typ === 0) v = raw;
      else if (typ === 1) v = raw + a;
      else if (typ === 2) v = raw + b;
      else if (typ === 3) v = raw + ((a + b) >> 1);
      else if (typ === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else v = raw;
      rad[i] = v & 0xff;
    }
    ut.set(rad, r * radbyte);
    forra = rad;
  }
  return ut;
}

// ---------------------------------------------------------------------------
// Utdata
// ---------------------------------------------------------------------------

/** Kastas internt när teckengränsen är nådd. Lämnar aldrig modulen. */
class Fullt extends Error {}

class Ut {
  delar: string[];
  langd: number;
  tak: number;
  avkortad: boolean;
  vantandeRader: number;
  vantandeMellanslag: boolean;

  constructor(tak: number) {
    this.delar = [];
    this.langd = 0;
    this.tak = tak;
    this.avkortad = false;
    this.vantandeRader = 0;
    this.vantandeMellanslag = false;
  }

  lagg(s: string): void {
    if (s.length === 0) return;
    const kvar = this.tak - this.langd;
    if (kvar <= 0) {
      this.avkortad = true;
      throw new Fullt();
    }
    if (s.length > kvar) {
      this.delar.push(s.slice(0, kvar));
      this.langd = this.tak;
      this.avkortad = true;
      throw new Fullt();
    }
    this.delar.push(s);
    this.langd += s.length;
  }

  spola(): void {
    if (this.langd === 0) {
      // Inget skrivet än: inledande radbrytningar och mellanslag är bara skräp.
      this.vantandeRader = 0;
      this.vantandeMellanslag = false;
      return;
    }
    if (this.vantandeRader > 0) {
      const n = this.vantandeRader;
      this.vantandeRader = 0;
      this.vantandeMellanslag = false;
      this.lagg('\n'.repeat(n));
    } else if (this.vantandeMellanslag) {
      this.vantandeMellanslag = false;
      this.lagg(' ');
    }
  }

  text(s: string): void {
    if (s.length === 0) return;
    this.spola();
    this.lagg(s);
  }

  mellanslag(): void {
    if (this.langd === 0 || this.vantandeRader > 0) return;
    this.vantandeMellanslag = true;
  }

  rad(antal = 1): void {
    if (this.langd === 0) return;
    this.vantandeRader = Math.max(this.vantandeRader, antal);
    this.vantandeMellanslag = false;
  }

  varde(): string {
    return this.delar.join('');
  }
}

// ---------------------------------------------------------------------------
// Typsnitt
// ---------------------------------------------------------------------------

interface Typsnitt {
  /** Sant för sammansatta typsnitt (Type0): två byte per teckenkod. */
  readonly tvaByte: boolean;
  /** ToUnicode-CMap när den finns; den är alltid mest tillförlitlig. */
  readonly tillTecken: Map<number, string> | null;
  /** Kodtabell för enkla typsnitt (bas-encoding + /Differences). */
  readonly tabell: (string | null)[] | null;
}

const STANDARDTYPSNITT: Typsnitt = { tvaByte: false, tillTecken: null, tabell: STANDARD };

function avkoda(typsnitt: Typsnitt, kod: number): string | null {
  const viaCmap = typsnitt.tillTecken?.get(kod);
  if (viaCmap !== undefined) return viaCmap;
  if (typsnitt.tvaByte) return null; // ingen ToUnicode: gissa aldrig på en CID
  return typsnitt.tabell?.[kod] ?? null;
}

// ---------------------------------------------------------------------------
// Dokumentet
// ---------------------------------------------------------------------------

type XrefPost = { k: 1; off: number } | { k: 2; strom: number; index: number };

interface Textlage {
  typsnitt: Typsnitt;
  tm: number[];
  tlm: number[];
  ledning: number;
  sistX: number;
  sistY: number;
  harText: boolean;
}

class Doc {
  buf: Uint8Array;
  lim: PdfLimits;
  t0: number;
  xref: Map<number, XrefPost>;
  slutposter: Map<string, Varde>[];
  cache: Map<number, Varde | undefined>;
  laddar: Set<number>;
  skanning: Map<number, number> | null;
  budget: number;
  objstm: Map<number, Map<number, Varde> | null>;
  typsnittCache: Map<number, Typsnitt>;

  constructor(buf: Uint8Array, lim: PdfLimits, t0: number) {
    this.buf = buf;
    this.lim = lim;
    this.t0 = t0;
    this.xref = new Map();
    this.slutposter = [];
    this.cache = new Map();
    this.laddar = new Set();
    this.skanning = null;
    // Utpackningsbudget: en PDF kan ha en liten ström som packas upp till gigabyte. Taket följer
    // filens storlek så att en normalt komprimerad fil får plats men en zip-bomb inte gör det.
    this.budget = Math.max(1 << 20, Math.min(lim.maxBytes, buf.length) * 20);
    this.objstm = new Map();
    this.typsnittCache = new Map();
  }

  /** Alla slingor som kan bli långa passerar hit. Tiden mäts, den uppskattas inte. */
  klocka(): void {
    if (Date.now() - this.t0 >= this.lim.maxMs) throw new PdfError('timeout');
  }

  // --- xref -----------------------------------------------------------------

  laddaXref(): void {
    const buf = this.buf;
    const svansStart = Math.max(0, buf.length - 2048);
    const sx = hittaBytesBaklanges(buf, bokstaver('startxref'), svansStart, buf.length);
    if (sx < 0) return;
    const lx = new Lexer(buf, sx + 9);
    const t = lx.lasToken();
    if (t.k !== 'num') return;
    let off: number | null = Math.trunc(t.num);
    const sedda = new Set<number>();
    let led = 0;
    while (off !== null && off >= 0 && off < buf.length && !sedda.has(off) && led++ < MAX_XREF_LED) {
      this.klocka();
      sedda.add(off);
      off = this.laddaXrefSektion(off, sedda);
    }
  }

  /** Läser en xref-sektion (tabell eller ström) och returnerar offset till nästa (/Prev). */
  laddaXrefSektion(off: number, sedda: Set<number>): number | null {
    const lx = new Lexer(this.buf, off);
    lx.hoppaBlanka();
    const spar = lx.pos;
    const t = lx.lasToken();
    if (t.k === 'kw' && t.str === 'xref') return this.laddaXrefTabell(lx, sedda);
    lx.pos = spar;
    return this.laddaXrefStrom(off);
  }

  laddaXrefTabell(lx: Lexer, sedda: Set<number>): number | null {
    for (;;) {
      this.klocka();
      const spar = lx.pos;
      const t = lx.lasToken();
      if (t.k === 'kw' && t.str === 'trailer') break;
      if (t.k !== 'num') {
        lx.pos = spar;
        break;
      }
      const t2 = lx.lasToken();
      if (t2.k !== 'num') break;
      const start = Math.trunc(t.num);
      const antal = Math.trunc(t2.num);
      if (antal < 0 || antal > 10_000_000) break;
      for (let i = 0; i < antal; i++) {
        const a = lx.lasToken();
        const b = lx.lasToken();
        const c = lx.lasToken();
        if (a.k !== 'num' || b.k !== 'num' || c.k !== 'kw') return null;
        const num = start + i;
        if (c.str === 'n' && num > 0 && !this.xref.has(num)) {
          this.xref.set(num, { k: 1, off: Math.trunc(a.num) });
        }
        if ((i & 1023) === 0) this.klocka();
      }
    }
    // Efter tabellen står nyckelordet trailer och dess ordbok.
    const spar2 = lx.pos;
    const t3 = lx.lasToken();
    if (!(t3.k === 'kw' && t3.str === 'trailer')) lx.pos = spar2;
    const v = lasVarde(lx, 0);
    const ordbok = taOrdbok(v);
    if (ordbok === null) return null;
    this.slutposter.push(ordbok);
    // Hybridfiler: /XRefStm pekar på en xref-ström med objekten som tabellen saknar.
    const hybrid = taTal(ordbok.get('XRefStm'));
    if (hybrid !== null && !sedda.has(hybrid)) {
      sedda.add(hybrid);
      this.laddaXrefStrom(Math.trunc(hybrid));
    }
    const prev = taTal(ordbok.get('Prev'));
    return prev === null ? null : Math.trunc(prev);
  }

  laddaXrefStrom(off: number): number | null {
    const objekt = this.parseIndirekt(off, null);
    if (objekt === null || !arStrom(objekt.varde)) return null;
    const d = objekt.varde.v;
    if (taNamn(d.get('Type')) !== 'XRef') return null;
    const data = this.stromData(objekt.varde);
    if (data === null) return null;
    const w = taLista(d.get('W'));
    if (w === null) return null;
    const bredder = w.map((x) => Math.max(0, Math.trunc(taTal(x) ?? 0)));
    const post = bredder.reduce((a, b) => a + b, 0);
    if (post <= 0 || post > 32) return null;

    const storlek = Math.trunc(taTal(d.get('Size')) ?? 0);
    const indexLista = taLista(d.get('Index'));
    const index: number[] = [];
    if (indexLista !== null) {
      for (const x of indexLista) index.push(Math.trunc(taTal(x) ?? 0));
    } else {
      index.push(0, storlek);
    }

    let p = 0;
    for (let i = 0; i + 1 < index.length; i += 2) {
      const start = index[i] ?? 0;
      const antal = index[i + 1] ?? 0;
      if (antal < 0 || antal > 10_000_000) break;
      for (let j = 0; j < antal; j++) {
        if (p + post > data.length) break;
        const falt: number[] = [];
        for (const bredd of bredder) {
          let v = 0;
          for (let k = 0; k < bredd; k++) v = v * 256 + (data[p++] ?? 0);
          falt.push(v);
        }
        const typ = (bredder[0] ?? 0) === 0 ? 1 : (falt[0] ?? 0);
        const num = start + j;
        if (num > 0 && !this.xref.has(num)) {
          if (typ === 1) this.xref.set(num, { k: 1, off: falt[1] ?? 0 });
          else if (typ === 2) this.xref.set(num, { k: 2, strom: falt[1] ?? 0, index: falt[2] ?? 0 });
        }
        if ((j & 1023) === 0) this.klocka();
      }
    }
    this.slutposter.push(d);
    const prev = taTal(d.get('Prev'));
    return prev === null ? null : Math.trunc(prev);
  }

  /**
   * Reservplan när xref är trasig eller saknas: hela filen skannas efter `N G obj`. Ett svep,
   * ingen backtracking. Senare objekt vinner — de är de nyaste.
   */
  skannaObjekt(): Map<number, number> {
    if (this.skanning !== null) return this.skanning;
    const buf = this.buf;
    const karta = new Map<number, number>();
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] !== 0x6f || buf[i + 1] !== 0x62 || buf[i + 2] !== 0x6a) continue;
      if (i + 3 < buf.length && arVanlig(buf[i + 3])) continue;
      let p = i - 1;
      while (p >= 0 && arBlank(buf[p])) p--;
      const genSlut = p + 1;
      while (p >= 0 && (buf[p] ?? 0) >= 0x30 && (buf[p] ?? 0) <= 0x39) p--;
      const genStart = p + 1;
      if (genStart === genSlut) continue;
      while (p >= 0 && arBlank(buf[p])) p--;
      const numSlut = p + 1;
      if (numSlut === genSlut) continue;
      while (p >= 0 && (buf[p] ?? 0) >= 0x30 && (buf[p] ?? 0) <= 0x39) p--;
      const numStart = p + 1;
      if (numStart === numSlut || numSlut - numStart > 10) continue;
      const num = Number.parseInt(latin1(buf, numStart, numSlut), 10);
      if (Number.isFinite(num) && num > 0) karta.set(num, numStart);
      if ((i & 0xffff) === 0) this.klocka();
    }
    this.skanning = karta;
    return karta;
  }

  /** Slutposter som skanningen hittar när xref inte går att lita på. */
  skannaSlutposter(): void {
    const buf = this.buf;
    let i = 0;
    let antal = 0;
    const nal = bokstaver('trailer');
    for (;;) {
      const traff = hittaBytes(buf, nal, i, buf.length);
      if (traff < 0 || antal++ > 64) break;
      i = traff + nal.length;
      const lx = new Lexer(buf, i);
      const v = lasVarde(lx, 0);
      const ordbok = taOrdbok(v);
      if (ordbok !== null) this.slutposter.push(ordbok);
      this.klocka();
    }
  }

  // --- objekt ---------------------------------------------------------------

  objekt(num: number): Varde | undefined {
    if (this.cache.has(num)) return this.cache.get(num);
    if (this.laddar.has(num)) return undefined; // cirkulär referens
    this.klocka();
    this.laddar.add(num);
    let v: Varde | undefined;
    try {
      v = this.laddaObjekt(num);
    } finally {
      this.laddar.delete(num);
    }
    this.cache.set(num, v);
    return v;
  }

  laddaObjekt(num: number): Varde | undefined {
    const post = this.xref.get(num);
    if (post !== undefined && post.k === 1) {
      const res = this.parseIndirekt(post.off, num);
      if (res !== null) return res.varde;
    } else if (post !== undefined && post.k === 2) {
      const karta = this.laddaObjStrom(post.strom);
      const v = karta?.get(num);
      if (v !== undefined) return v;
    }
    // xref ljög eller saknades: fall tillbaka på skanningen.
    const off = this.skannaObjekt().get(num);
    if (off === undefined) return undefined;
    const res = this.parseIndirekt(off, num);
    return res === null ? undefined : res.varde;
  }

  parseIndirekt(off: number, vantatNum: number | null): { varde: Varde; num: number } | null {
    if (off < 0 || off >= this.buf.length) return null;
    const lx = new Lexer(this.buf, off);
    const a = lx.lasToken();
    if (a.k !== 'num') return null;
    const b = lx.lasToken();
    if (b.k !== 'num') return null;
    const c = lx.lasToken();
    if (c.k !== 'kw' || c.str !== 'obj') return null;
    const num = Math.trunc(a.num);
    if (vantatNum !== null && num !== vantatNum) return null;
    const varde = lasToppVarde(lx);
    if (varde === undefined) return null;

    const spar = lx.pos;
    const d = lx.lasToken();
    if (d.k === 'kw' && d.str === 'stream') {
      const ordbok = taOrdbok(varde);
      if (ordbok === null) return { varde, num };
      let p = lx.pos;
      if (this.buf[p] === 13) p++;
      if (this.buf[p] === 10) p++;
      const slut = this.stromSlut(ordbok, p);
      return { varde: { t: 'stream', v: ordbok, start: p, slut }, num };
    }
    lx.pos = spar;
    return { varde, num };
  }

  /** /Length kan vara indirekt och kan ljuga. Sanningen är var `endstream` står. */
  stromSlut(ordbok: Map<string, Varde>, start: number): number {
    const nal = bokstaver('endstream');
    const angiven = taTal(this.los(ordbok.get('Length')));
    if (angiven !== null && angiven >= 0 && start + angiven <= this.buf.length) {
      const slut = start + Math.trunc(angiven);
      const lx = new Lexer(this.buf, slut);
      lx.hoppaBlanka();
      if (hittaBytes(this.buf, nal, lx.pos, lx.pos + nal.length) === lx.pos) return slut;
    }
    const traff = hittaBytes(this.buf, nal, start, this.buf.length);
    if (traff < 0) return this.buf.length;
    let slut = traff;
    // Radslutet före `endstream` hör inte till data.
    if (slut > start && this.buf[slut - 1] === 10) slut--;
    if (slut > start && this.buf[slut - 1] === 13) slut--;
    return slut;
  }

  laddaObjStrom(num: number): Map<number, Varde> | null {
    const cachad = this.objstm.get(num);
    if (cachad !== undefined) return cachad;
    this.objstm.set(num, null); // markera först: en objektström får inte innehålla sig själv
    const stm = this.objekt(num);
    if (!arStrom(stm)) return null;
    const data = this.stromData(stm);
    if (data === null) return null;
    const antal = Math.trunc(taTal(this.los(stm.v.get('N'))) ?? 0);
    const forsta = Math.trunc(taTal(this.los(stm.v.get('First'))) ?? 0);
    if (antal <= 0 || antal > 100_000 || forsta < 0 || forsta > data.length) return null;

    const huvud = new Lexer(data, 0, forsta);
    const par: { num: number; off: number }[] = [];
    for (let i = 0; i < antal; i++) {
      const a = huvud.lasToken();
      const b = huvud.lasToken();
      if (a.k !== 'num' || b.k !== 'num') break;
      par.push({ num: Math.trunc(a.num), off: Math.trunc(b.num) });
    }
    const karta = new Map<number, Varde>();
    for (const p of par) {
      this.klocka();
      const start = forsta + p.off;
      if (start < 0 || start >= data.length) continue;
      const lx = new Lexer(data, start);
      const v = lasToppVarde(lx);
      if (v !== undefined && !karta.has(p.num)) karta.set(p.num, v);
    }
    this.objstm.set(num, karta);
    return karta;
  }

  /** Följer en referenskedja. Cirklar bryts, de följs inte. */
  los(v: Varde | undefined): Varde | undefined {
    let nuvarande = v;
    const sedda = new Set<number>();
    for (let i = 0; i < MAX_REF_HOPP; i++) {
      if (!arRef(nuvarande)) return nuvarande;
      if (sedda.has(nuvarande.num)) return undefined;
      sedda.add(nuvarande.num);
      nuvarande = this.objekt(nuvarande.num);
    }
    return undefined;
  }

  hamta(d: Map<string, Varde> | null, nyckel: string): Varde | undefined {
    if (d === null) return undefined;
    return this.los(d.get(nyckel));
  }

  // --- strömdata ------------------------------------------------------------

  stromData(s: Strom): Uint8Array | null {
    this.klocka();
    let data = this.buf.subarray(s.start, Math.max(s.start, s.slut));
    const filter = this.los(s.v.get('Filter'));
    const namnlista: string[] = [];
    const ettNamn = taNamn(filter);
    if (ettNamn !== null) namnlista.push(ettNamn);
    const flera = taLista(filter);
    if (flera !== null) {
      for (const f of flera) {
        const n = taNamn(this.los(f));
        if (n !== null) namnlista.push(n);
      }
    }
    const parmsVarde = this.los(s.v.get('DecodeParms')) ?? this.los(s.v.get('DP'));
    const parmsLista = taLista(parmsVarde);

    for (let i = 0; i < namnlista.length; i++) {
      this.klocka();
      const namn = namnlista[i] ?? '';
      const tak = Math.max(1, this.budget);
      let nasta: Uint8Array | null;
      if (namn === 'FlateDecode' || namn === 'Fl') {
        nasta = packaUppFlate(data, tak);
      } else if (namn === 'LZWDecode' || namn === 'LZW') {
        const parms = taOrdbok(parmsLista === null ? parmsVarde : this.los(parmsLista[i]));
        const tidigt = Math.trunc(taTal(this.hamta(parms, 'EarlyChange')) ?? 1);
        nasta = packaUppLzw(data, tak, tidigt === 0 ? 0 : 1);
      } else if (namn === 'ASCIIHexDecode' || namn === 'AHx') {
        nasta = packaUppAsciiHex(data, tak);
      } else if (namn === 'ASCII85Decode' || namn === 'A85') {
        nasta = packaUppAscii85(data, tak);
      } else if (namn === 'RunLengthDecode' || namn === 'RL') {
        nasta = packaUppRunLength(data, tak);
      } else {
        // Bildfilter (DCT, JPX, CCITT, JBIG2), okända filter och /Crypt: ingen text här.
        return null;
      }
      if (nasta === null) return null;
      this.budget -= nasta.length;
      if (this.budget <= 0) throw new PdfError('too_large');
      data = nasta;

      if (namn === 'FlateDecode' || namn === 'Fl' || namn === 'LZWDecode' || namn === 'LZW') {
        const parms = taOrdbok(parmsLista === null ? parmsVarde : this.los(parmsLista[i]));
        const prediktor = Math.trunc(taTal(this.hamta(parms, 'Predictor')) ?? 1);
        if (prediktor > 1) {
          const kolumner = Math.trunc(taTal(this.hamta(parms, 'Columns')) ?? 1);
          const farger = Math.trunc(taTal(this.hamta(parms, 'Colors')) ?? 1);
          const bitar = Math.trunc(taTal(this.hamta(parms, 'BitsPerComponent')) ?? 8);
          if (kolumner > 0 && kolumner < 1 << 24 && farger > 0 && farger <= 32 && bitar > 0 && bitar <= 32) {
            data = avPrediktera(data, prediktor, kolumner, farger, bitar);
          }
        }
      }
    }
    return data;
  }

  // --- sidor ----------------------------------------------------------------

  rotOrdbok(): Map<string, Varde> | null {
    for (const slutpost of this.slutposter) {
      const rot = taOrdbok(this.los(slutpost.get('Root')));
      if (rot !== null) return rot;
    }
    // Ingen användbar slutpost: leta rätt på katalogen bland objekten.
    for (const num of this.allaObjektnummer()) {
      this.klocka();
      const v = this.objekt(num);
      const d = taOrdbok(v);
      if (d !== null && taNamn(d.get('Type')) === 'Catalog') return d;
    }
    return null;
  }

  allaObjektnummer(): number[] {
    const nummer = new Set<number>(this.xref.keys());
    for (const n of this.skannaObjekt().keys()) nummer.add(n);
    return [...nummer].sort((a, b) => a - b);
  }

  /** Sidorna i ordning, var och en med de resurser den ärvt. */
  sidor(): { sida: Map<string, Varde>; resurser: Map<string, Varde> | null }[] {
    const rot = this.rotOrdbok();
    const ut: { sida: Map<string, Varde>; resurser: Map<string, Varde> | null }[] = [];
    const noder = { antal: 0 };
    const rotSidor = taOrdbok(this.hamta(rot, 'Pages'));
    if (rotSidor !== null) {
      this.gaSidtrad(rotSidor, null, ut, new Set<Map<string, Varde>>(), noder, 0);
    }
    if (ut.length === 0) {
      // Trasigt sidträd: ta sidobjekten som de ligger i filen.
      for (const num of this.allaObjektnummer()) {
        this.klocka();
        const d = taOrdbok(this.objekt(num));
        if (d !== null && taNamn(d.get('Type')) === 'Page') {
          ut.push({ sida: d, resurser: taOrdbok(this.hamta(d, 'Resources')) });
          if (ut.length > this.lim.maxPages) throw new PdfError('too_many_pages');
        }
      }
    }
    return ut;
  }

  gaSidtrad(
    nod: Map<string, Varde>,
    arvdaResurser: Map<string, Varde> | null,
    ut: { sida: Map<string, Varde>; resurser: Map<string, Varde> | null }[],
    pastigen: Set<Map<string, Varde>>,
    noder: { antal: number },
    djup: number,
  ): void {
    this.klocka();
    if (djup > 64 || noder.antal++ > MAX_TRADNODER) return;
    if (pastigen.has(nod)) return; // sidträdet pekar tillbaka på sig självt
    const resurser = taOrdbok(this.hamta(nod, 'Resources')) ?? arvdaResurser;
    const kids = taLista(this.hamta(nod, 'Kids'));
    const typ = taNamn(nod.get('Type'));
    if (kids === null || typ === 'Page') {
      if (typ === 'Pages') return; // en /Pages utan barn är ingen sida
      ut.push({ sida: nod, resurser });
      if (ut.length > this.lim.maxPages) throw new PdfError('too_many_pages');
      return;
    }
    pastigen.add(nod);
    for (const kid of kids) {
      const d = taOrdbok(this.los(kid));
      if (d === null) continue;
      this.gaSidtrad(d, resurser, ut, pastigen, noder, djup + 1);
    }
    pastigen.delete(nod);
  }

  // --- typsnitt -------------------------------------------------------------

  typsnitt(varde: Varde | undefined): Typsnitt {
    const nyckel = arRef(varde) ? varde.num : -1;
    if (nyckel >= 0) {
      const cachad = this.typsnittCache.get(nyckel);
      if (cachad !== undefined) return cachad;
    }
    const byggt = this.byggTypsnitt(taOrdbok(this.los(varde)));
    if (nyckel >= 0) this.typsnittCache.set(nyckel, byggt);
    return byggt;
  }

  byggTypsnitt(d: Map<string, Varde> | null): Typsnitt {
    if (d === null) return STANDARDTYPSNITT;
    const subtyp = taNamn(d.get('Subtype'));
    const tillTecken = this.laddaToUnicode(d);

    if (subtyp === 'Type0') {
      // Identity-H och övriga tvåbyteskodningar. Utan ToUnicode går koderna inte att översätta,
      // och då hoppas de över i stället för att gissas.
      return { tvaByte: true, tillTecken, tabell: null };
    }

    const enc = this.los(d.get('Encoding'));
    let tabell: (string | null)[];
    const encNamn = taNamn(enc);
    if (encNamn !== null) {
      tabell = [...basTabell(encNamn)];
    } else {
      const encDict = taOrdbok(enc);
      tabell = [...basTabell(taNamn(this.hamta(encDict, 'BaseEncoding')))];
      const diffar = taLista(this.hamta(encDict, 'Differences'));
      if (diffar !== null) {
        let kod = 0;
        for (const post of diffar) {
          const v = this.los(post);
          const tal = taTal(v);
          if (tal !== null) {
            kod = Math.trunc(tal);
            continue;
          }
          const namn = taNamn(v);
          if (namn !== null && kod >= 0 && kod < 256) {
            tabell[kod] = glyfTillTecken(namn);
            kod++;
          }
        }
      }
    }
    return { tvaByte: false, tillTecken, tabell };
  }

  laddaToUnicode(d: Map<string, Varde>): Map<number, string> | null {
    const stm = this.los(d.get('ToUnicode'));
    if (!arStrom(stm)) return null;
    const data = this.stromData(stm);
    if (data === null) return null;
    return tolkaCmap(data, this);
  }
}

// ---------------------------------------------------------------------------
// ToUnicode-CMap
// ---------------------------------------------------------------------------

function hexTillKod(bytes: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < bytes.length && i < 4; i++) v = v * 256 + (bytes[i] ?? 0);
  return v;
}

/** Hex-strängen i en bfchar/bfrange är UTF-16BE, ibland flera kodenheter (ligaturer). */
function hexTillText(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (bytes.length === 1) return String.fromCharCode(bytes[0] ?? 0);
  let ut = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    ut += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return ut;
}

function tolkaCmap(data: Uint8Array, doc: Doc): Map<number, string> {
  const karta = new Map<number, string>();
  const lx = new Lexer(data);
  const stack: Varde[] = [];
  let poster = 0;
  let varv = 0;
  for (;;) {
    if ((varv++ & 1023) === 0) doc.klocka();
    if (varv > MAX_OPERATIONER) break;
    const v = lasVarde(lx, 0);
    if (v === undefined) break;
    if (typeof v === 'object' && v !== null && 't' in v && v.t === 'op') {
      const op = v.v;
      if (op === 'endbfchar') {
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const kod = taStrang(stack[i]);
          const mal = taStrang(stack[i + 1]);
          if (kod === null || mal === null) continue;
          karta.set(hexTillKod(kod), hexTillText(mal));
          if (++poster > MAX_CMAP_POSTER) return karta;
        }
      } else if (op === 'endbfrange') {
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = taStrang(stack[i]);
          const hi = taStrang(stack[i + 1]);
          if (lo === null || hi === null) continue;
          const start = hexTillKod(lo);
          const slut = hexTillKod(hi);
          if (slut < start || slut - start > 65535) continue;
          const mal = stack[i + 2];
          const malLista = taLista(mal);
          if (malLista !== null) {
            for (let k = 0; k <= slut - start && k < malLista.length; k++) {
              const s = taStrang(malLista[k]);
              if (s !== null) karta.set(start + k, hexTillText(s));
              if (++poster > MAX_CMAP_POSTER) return karta;
            }
            continue;
          }
          const malStrang = taStrang(mal);
          if (malStrang === null) continue;
          const bas = hexTillText(malStrang);
          if (bas.length === 0) continue;
          const sista = bas.charCodeAt(bas.length - 1);
          const prefix = bas.slice(0, -1);
          for (let k = 0; k <= slut - start; k++) {
            karta.set(start + k, prefix + String.fromCharCode((sista + k) & 0xffff));
            if (++poster > MAX_CMAP_POSTER) return karta;
          }
        }
      }
      if (op.startsWith('begin') || op.startsWith('end')) stack.length = 0;
      if (stack.length > 4096) stack.length = 0;
      continue;
    }
    stack.push(v);
    if (stack.length > 100_000) stack.splice(0, 50_000);
  }
  return karta;
}

// ---------------------------------------------------------------------------
// Innehållsströmmar
// ---------------------------------------------------------------------------

function matrisGanger(a: readonly number[], b: readonly number[]): number[] {
  const [a0, a1, a2, a3, a4, a5] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0];
  const [b0, b1, b2, b3, b4, b5] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0, b[4] ?? 0, b[5] ?? 0];
  return [
    a0 * b0 + a1 * b2,
    a0 * b1 + a1 * b3,
    a2 * b0 + a3 * b2,
    a2 * b1 + a3 * b3,
    a4 * b0 + a5 * b2 + b4,
    a4 * b1 + a5 * b3 + b5,
  ];
}

/**
 * Efter en förflyttning: nedåt (eller uppåt) är ny rad, i sidled är ett mellanslag. Utan
 * glyfbredder går det inte att mäta ett verkligt avstånd, och ett mellanslag för mycket är
 * lättare att läsa än två ihopskrivna ord.
 */
function efterFlytt(lage: Textlage, ut: Ut): void {
  const x = lage.tm[4] ?? 0;
  const y = lage.tm[5] ?? 0;
  if (!lage.harText) {
    lage.sistX = x;
    lage.sistY = y;
    return;
  }
  if (Math.abs(y - lage.sistY) > RADBYTE_GRANS) ut.rad();
  else if (Math.abs(x - lage.sistX) > RADBYTE_GRANS) ut.mellanslag();
  lage.sistX = x;
  lage.sistY = y;
}

function visaText(doc: Doc, bytes: Uint8Array, lage: Textlage, ut: Ut): void {
  const steg = lage.typsnitt.tvaByte ? 2 : 1;
  for (let i = 0; i + steg <= bytes.length; i += steg) {
    if ((i & 1023) === 0) doc.klocka();
    const kod = steg === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0);
    const tecken = avkoda(lage.typsnitt, kod);
    if (tecken === null || tecken.length === 0) continue;
    ut.text(tecken);
    lage.harText = true;
  }
}

/** Hoppar över en inbäddad bild (`BI … ID <binärt> EI`) utan att tolka en enda bildbyte. */
function hoppaInbaddadBild(lx: Lexer): void {
  const buf = lx.buf;
  let i = lx.pos;
  if (i < lx.slut && arBlank(buf[i])) i++;
  while (i + 1 < lx.slut) {
    if (buf[i] === 0x45 && buf[i + 1] === 0x49) {
      const fore = buf[i - 1];
      const efter = buf[i + 2];
      if (arBlank(fore) && (efter === undefined || !arVanlig(efter))) {
        lx.pos = i + 2;
        return;
      }
    }
    i++;
  }
  lx.pos = lx.slut;
}

function korInnehall(
  doc: Doc,
  data: Uint8Array,
  resurser: Map<string, Varde> | null,
  ut: Ut,
  djup: number,
  besokta: Set<number>,
): void {
  const lx = new Lexer(data);
  const stack: Varde[] = [];
  const lage: Textlage = {
    typsnitt: STANDARDTYPSNITT,
    tm: [1, 0, 0, 1, 0, 0],
    tlm: [1, 0, 0, 1, 0, 0],
    ledning: 0,
    sistX: 0,
    sistY: 0,
    // Är något redan skrivet — en tidigare innehållsström eller ett yttre XObject — så ska den
    // första förflyttningen här räknas som en förflyttning, inte som startpunkt.
    harText: ut.langd > 0,
  };
  const typsnittsordbok = taOrdbok(doc.hamta(resurser, 'Font'));
  const xobjekt = taOrdbok(doc.hamta(resurser, 'XObject'));
  let operationer = 0;

  const tal = (n: number): number => {
    const v = stack[stack.length - n];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const flytta = (tx: number, ty: number): void => {
    lage.tlm = matrisGanger([1, 0, 0, 1, tx, ty], lage.tlm);
    lage.tm = [...lage.tlm];
    efterFlytt(lage, ut);
  };

  for (;;) {
    if ((operationer & 255) === 0) doc.klocka();
    if (operationer++ > MAX_OPERATIONER) return;
    const v = lasVarde(lx, 0);
    if (v === undefined) return;
    if (!(typeof v === 'object' && v !== null && 't' in v && v.t === 'op')) {
      stack.push(v);
      if (stack.length > 4096) stack.splice(0, 2048);
      continue;
    }
    const op = v.v;
    switch (op) {
      case 'BT':
        lage.tm = [1, 0, 0, 1, 0, 0];
        lage.tlm = [1, 0, 0, 1, 0, 0];
        lage.sistX = 0;
        lage.sistY = 0;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const namn = taNamn(stack[stack.length - 2]);
        if (namn !== null && typsnittsordbok !== null) {
          const post = typsnittsordbok.get(namn);
          if (post !== undefined) lage.typsnitt = doc.typsnitt(post);
        }
        break;
      }
      case 'TL':
        lage.ledning = tal(1);
        break;
      case 'Td':
        flytta(tal(2), tal(1));
        break;
      case 'TD':
        lage.ledning = -tal(1);
        flytta(tal(2), tal(1));
        break;
      case 'Tm': {
        lage.tlm = [tal(6), tal(5), tal(4), tal(3), tal(2), tal(1)];
        lage.tm = [...lage.tlm];
        efterFlytt(lage, ut);
        break;
      }
      case 'T*':
        flytta(0, -lage.ledning);
        break;
      case 'Tj': {
        const s = taStrang(stack[stack.length - 1]);
        if (s !== null) visaText(doc, s, lage, ut);
        break;
      }
      case "'": {
        flytta(0, -lage.ledning);
        const s = taStrang(stack[stack.length - 1]);
        if (s !== null) visaText(doc, s, lage, ut);
        break;
      }
      case '"': {
        flytta(0, -lage.ledning);
        const s = taStrang(stack[stack.length - 1]);
        if (s !== null) visaText(doc, s, lage, ut);
        break;
      }
      case 'TJ': {
        const lista = taLista(stack[stack.length - 1]);
        if (lista !== null) {
          for (const post of lista) {
            const s = taStrang(post);
            if (s !== null) {
              visaText(doc, s, lage, ut);
              continue;
            }
            const just = taTal(post);
            if (just !== null && just < TJ_MELLANSLAG && lage.harText) ut.mellanslag();
          }
        }
        break;
      }
      case 'ID':
        hoppaInbaddadBild(lx);
        break;
      case 'Do': {
        if (djup >= MAX_XOBJECT_DJUP || xobjekt === null) break;
        const namn = taNamn(stack[stack.length - 1]);
        if (namn === null) break;
        const ref = xobjekt.get(namn);
        const objnum = arRef(ref) ? ref.num : -1;
        if (objnum >= 0 && besokta.has(objnum)) break; // XObject som anropar sig självt
        const stm = doc.los(ref);
        if (!arStrom(stm)) break;
        if (taNamn(stm.v.get('Subtype')) !== 'Form') break;
        const inre = doc.stromData(stm);
        if (inre === null) break;
        if (objnum >= 0) besokta.add(objnum);
        const egnaResurser = taOrdbok(doc.hamta(stm.v, 'Resources')) ?? resurser;
        korInnehall(doc, inre, egnaResurser, ut, djup + 1, besokta);
        if (objnum >= 0) besokta.delete(objnum);
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Ingången
// ---------------------------------------------------------------------------

function heltal(v: number, standard: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : standard;
}

/**
 * Plockar ut textlagret ur en PDF.
 *
 * `null` betyder att det inte finns någon text att hämta — filen är inskannad och består av
 * bilder. Kastar `PdfError` när filen är trasig, krypterad, för stor eller tar för lång tid.
 */
export function extractPdfText(bytes: Uint8Array, limits: PdfLimits): PdfText | null {
  const t0 = Date.now();
  const lim: PdfLimits = {
    maxBytes: heltal(limits?.maxBytes, 0),
    maxPages: heltal(limits?.maxPages, 0),
    maxChars: heltal(limits?.maxChars, 0),
    maxMs: heltal(limits?.maxMs, 0),
  };

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new PdfError('invalid');
  if (bytes.length > lim.maxBytes) throw new PdfError('too_large');

  // Huvudet får ligga en bit in: verktyg lägger ibland skräp först i filen.
  const huvud = hittaBytes(bytes, bokstaver('%PDF-'), 0, Math.min(bytes.length, 1024));
  if (huvud < 0) throw new PdfError('invalid');

  const doc = new Doc(bytes, lim, t0);
  const ut = new Ut(lim.maxChars);
  let sidorMedText = 0;

  try {
    doc.klocka();
    doc.laddaXref();
    if (doc.slutposter.length === 0) doc.skannaSlutposter();

    // Krypterad fil: innehållet är obegripligt utan lösenord, och modulen gissar inte lösenord.
    for (const slutpost of doc.slutposter) {
      if (slutpost.has('Encrypt')) throw new PdfError('encrypted');
    }

    const sidor = doc.sidor();
    if (sidor.length > lim.maxPages) throw new PdfError('too_many_pages');

    for (const { sida, resurser } of sidor) {
      doc.klocka();
      const fore = ut.langd;
      if (sidorMedText > 0 || fore > 0) ut.rad(2); // sidbrytning
      const delar = samlaInnehall(doc, sida);
      for (const del of delar) {
        korInnehall(doc, del, resurser, ut, 0, new Set<number>());
      }
      if (ut.langd > fore) sidorMedText++;
    }
  } catch (fel) {
    if (fel instanceof Fullt) {
      // Teckengränsen nådd: det som hunnit läsas är ett giltigt svar.
    } else if (fel instanceof PdfError) {
      throw fel;
    } else if (fel instanceof RangeError) {
      // Stackdjup eller buffertstorlek: filen är inte läsbar med rimliga resurser.
      throw new PdfError('too_large');
    } else {
      throw new PdfError('invalid');
    }
  }

  const text = ut.varde();
  // Tom text betyder inskannad PDF — men bara om det inte var teckengränsen som stoppade oss.
  // Den skillnaden är viktig för anroparen: det ena är en bild, det andra är en för lång text.
  if (text.trim().length === 0 && !ut.avkortad) return null;
  return {
    text,
    pages: text.length > 0 ? Math.max(1, sidorMedText) : sidorMedText,
    truncated: ut.avkortad,
  };
}

function samlaInnehall(doc: Doc, sida: Map<string, Varde>): Uint8Array[] {
  const innehall = doc.hamta(sida, 'Contents');
  const delar: Uint8Array[] = [];
  const lagg = (v: Varde | undefined): void => {
    if (!arStrom(v)) return;
    const data = doc.stromData(v);
    if (data !== null && data.length > 0) delar.push(data);
  };
  const lista = taLista(innehall);
  if (lista !== null) {
    for (const post of lista) {
      doc.klocka();
      lagg(doc.los(post));
      if (delar.length > 10_000) break;
    }
  } else {
    lagg(innehall);
  }
  return delar;
}
