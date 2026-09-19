/**
 * Allowlistan för filtyper, och hur en fils typ avgörs.
 *
 * Typen avgörs av INNEHÅLLET (magiska byte, och för Office-dokument zip-arkivets innehållsförteckning).
 * Den typ klienten påstår (`Content-Type`) får bara bekräfta det innehållet visar: påstår den
 * något annat nekas filen. Det som sparas och sedan skickas tillbaka är alltid den typ innehållet
 * visade — aldrig klientens.
 *
 * SVG och HTML finns inte i listan: båda kan bära skript, och en fil som serveras från appens egen
 * origin skulle köra i appens namn (XSS). Text som ser ut som märkspråk nekas därför också, även
 * när den påstår sig vara vanlig text.
 */

export interface FileType {
  /** Det som sparas och skickas i `Content-Type`. */
  readonly contentType: string;
  /** Tillåtna filändelser, gemener; den första används om namnet saknar en som stämmer. */
  readonly extensions: readonly string[];
  /** Bilder visas direkt (`inline`); allt annat laddas ned som bilaga. */
  readonly inline: boolean;
}

export type TypeCheck =
  | { readonly ok: true; readonly type: FileType }
  | { readonly ok: false; readonly reason: 'empty' | 'unsupported' | 'mismatch' };

interface Kind extends FileType {
  /** Påstådda typer (utan parametrar, gemener) som stämmer med innehållet. */
  readonly accepts: readonly string[];
}

function kind(contentType: string, extensions: readonly string[], accepts: readonly string[], inline = false): Kind {
  return { contentType, extensions, inline, accepts: [contentType, ...accepts] };
}

const PNG = kind('image/png', ['png'], [], true);
const JPEG = kind('image/jpeg', ['jpg', 'jpeg'], ['image/jpg', 'image/pjpeg'], true);
const GIF = kind('image/gif', ['gif'], [], true);
const WEBP = kind('image/webp', ['webp'], [], true);
const PDF = kind('application/pdf', ['pdf'], ['application/x-pdf']);
const MP3 = kind('audio/mpeg', ['mp3'], ['audio/mp3', 'audio/mpeg3']);
const MP4_AUDIO = kind('audio/mp4', ['m4a', 'mp4', 'm4b'], ['audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-mp4']);
const WAV = kind('audio/wav', ['wav'], ['audio/x-wav', 'audio/wave', 'audio/vnd.wave']);
const OGG = kind('audio/ogg', ['ogg', 'oga', 'opus'], ['application/ogg', 'audio/opus']);
const WEBM_AUDIO = kind('audio/webm', ['webm', 'weba'], []);
const DOCX = kind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx'], []);
const XLSX = kind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx'], []);

const TEXT_ACCEPTS = ['text/plain'];
// Windows rapporterar ofta .csv som `application/vnd.ms-excel`.
const CSV_ACCEPTS = ['text/csv', 'application/csv', 'text/x-csv', 'text/comma-separated-values', 'application/vnd.ms-excel'];

/** Påstådda typer som betyder "vet inte" — då avgör innehållet ensamt. */
const UNKNOWN_DECLARED: ReadonlySet<string> = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function normalizeDeclared(declared: string | undefined): string {
  return (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return '';
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

// ── Zip: Office-dokument ─────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ZIP_ENTRIES = 10_000;

/**
 * Namnen i zip-arkivets centrala katalog, eller `null` om arkivet inte går att läsa. Vi packar
 * aldrig upp något — namnen räcker för att skilja docx och xlsx från andra zip-filer.
 * Varje läsning kontrolleras mot buffertens längd: offset i filen är fientliga indata.
 */
function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count > MAX_ZIP_ENTRIES || offset + size > eocd) return null;

  const names: string[] = [];
  let position = offset;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n += 1) {
    if (position + 46 > eocd || view.getUint32(position, true) !== CENTRAL_SIGNATURE) return null;
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const end = position + 46 + nameLength;
    if (end > eocd) return null;
    names.push(decoder.decode(bytes.subarray(position + 46, end)));
    position = end + extraLength + commentLength;
  }
  return names;
}

function officeKind(bytes: Uint8Array): Kind | null {
  const names = zipEntryNames(bytes);
  if (names === null) return null;
  const has = new Set(names);
  // Makron (docm/xlsm förklädda som docx/xlsx) tas inte emot.
  if (names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name) || /(^|\/)vbaData\.xml$/i.test(name))) return null;
  if (!has.has('[Content_Types].xml')) return null;
  const word = has.has('word/document.xml');
  const excel = has.has('xl/workbook.xml');
  if (word === excel) return null;
  return word ? DOCX : XLSX;
}

// ── Ljud och video i behållare ───────────────────────────────────────────────────

/** Varumärken i `ftyp` som används för ljud i MP4 (m4a, och det webbläsare spelar in). */
const MP4_AUDIO_BRANDS: ReadonlySet<string> = new Set(['M4A ', 'M4B ', 'mp41', 'mp42', 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'dash']);

function isWebm(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  // DocType-elementet (0x4282) i EBML-huvudet, med en storlek på en byte.
  const limit = Math.min(bytes.length - 3, 64);
  for (let i = 4; i < limit; i += 1) {
    if (bytes[i] === 0x42 && bytes[i + 1] === 0x82) {
      const size = (bytes[i + 2] ?? 0) & 0x7f;
      return ((bytes[i + 2] ?? 0) & 0x80) !== 0 && ascii(bytes, i + 3, size) === 'webm';
    }
  }
  return false;
}

function isMp3Frame(bytes: Uint8Array): boolean {
  // Ramsynk (11 bitar) och Layer III. AAC (ADTS) har layer 00 och räknas inte hit.
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  return bytes.length >= 4 && b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) === 0x02 && (b1 & 0x18) !== 0x08;
}

/** Den binära typ innehållet visar, eller `null` om det inte är någon av dem. */
function binaryKind(bytes: Uint8Array): Kind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // Signaturen följs alltid av IHDR-blocket; utan det är det ingen bild.
    return ascii(bytes, 12, 4) === 'IHDR' ? PNG : null;
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return GIF;
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const format = ascii(bytes, 8, 4);
    if (format === 'WEBP') return WEBP;
    if (format === 'WAVE') return WAV;
    return null;
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return PDF;
  if (ascii(bytes, 0, 4) === 'OggS') return OGG;
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return isWebm(bytes) ? WEBM_AUDIO : null;
  if (ascii(bytes, 4, 4) === 'ftyp') return MP4_AUDIO_BRANDS.has(ascii(bytes, 8, 4)) ? MP4_AUDIO : null;
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return officeKind(bytes);
  if (ascii(bytes, 0, 3) === 'ID3' || isMp3Frame(bytes)) return MP3;
  return null;
}

// ── Text ─────────────────────────────────────────────────────────────────────────

/** Byte som inte är definierade i Windows-1252. */
const CP1252_UNDEFINED: ReadonlySet<number> = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** Tillåtna kontrolltecken i text: tab, radbrytningar och sidbrytning. */
function isAllowedControl(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * Teckenkodningen om det är text: UTF-8 i första hand, annars Windows-1252 (som Excel sparar
 * CSV i på svenska Windows). Inga kontrolltecken utöver radbrytning och tab, och ingen NUL.
 */
function textCharset(bytes: Uint8Array): { charset: 'utf-8' | 'windows-1252'; text: string } | null {
  let text: string;
  let charset: 'utf-8' | 'windows-1252';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    charset = 'utf-8';
  } catch {
    if (bytes.some((b) => CP1252_UNDEFINED.has(b))) return null;
    text = new TextDecoder('windows-1252').decode(bytes);
    charset = 'windows-1252';
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && !isAllowedControl(code)) || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return { charset, text };
}

/** Märkspråk som en webbläsare skulle tolka: HTML och SVG, också med XML-huvud eller kommentar först. */
const MARKUP_START = /^[\s﻿]*<[!?a-z]/i;
const MARKUP_ANYWHERE = /<(?:!doctype\s+html|html|head|body|svg|script|iframe|object|embed)[\s>/]/i;

function looksLikeMarkup(text: string): boolean {
  const start = text.slice(0, 4096);
  return MARKUP_START.test(start) || MARKUP_ANYWHERE.test(start);
}

// ── Allt ihop ────────────────────────────────────────────────────────────────────

export function checkFileType(bytes: Uint8Array, declaredContentType: string | undefined): TypeCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  const declared = normalizeDeclared(declaredContentType);
  const unknown = UNKNOWN_DECLARED.has(declared);

  const binary = binaryKind(bytes);
  if (binary !== null) {
    if (!unknown && !binary.accepts.includes(declared)) return { ok: false, reason: 'mismatch' };
    return { ok: true, type: { contentType: binary.contentType, extensions: binary.extensions, inline: binary.inline } };
  }

  const text = textCharset(bytes);
  if (text === null || looksLikeMarkup(text.text)) return { ok: false, reason: 'unsupported' };
  const csv = CSV_ACCEPTS.includes(declared);
  if (!unknown && !csv && !TEXT_ACCEPTS.includes(declared)) return { ok: false, reason: 'mismatch' };
  return {
    ok: true,
    type: csv
      ? { contentType: `text/csv; charset=${text.charset}`, extensions: ['csv'], inline: false }
      : { contentType: `text/plain; charset=${text.charset}`, extensions: ['txt'], inline: false },
  };
}

/** För felmeddelanden: vad som går att ladda upp, i klarspråk. */
export const ALLOWED_TYPES_TEXT =
  'bilder (PNG, JPEG, WebP, GIF), PDF, text och CSV, Word- och Excel-dokument (docx, xlsx) och ljud (MP3, M4A, WAV, Ogg, WebM)';
