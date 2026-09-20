/**
 * Texten ur ett Office-dokument. Målet är läsbar text, inte en kopia av dokumentet:
 * styckeindelningen bevaras, allt som är formatering (typsnitt, färger, ramar, bilder) slängs.
 *
 * - **Word:** ett stycke (`w:p`) per rad. Tabb och radbrytning inuti stycket följer med.
 * - **Excel:** ett blad i taget, en rad per rad och tabb mellan cellerna. Celler som saknas i
 *   filen blir tomma celler, så att kolumnerna står kvar på sina platser. Texten i en cell kan
 *   ligga i den delade stränglistan (`sharedStrings.xml`), direkt i cellen eller som resultatet
 *   av en formel — formeln själv tas aldrig med.
 * - **PowerPoint:** en bild i taget, åtskilda av en tomrad.
 *
 * Både teckenantalet och tiden är begränsade, och de kontrolleras MITT i arbetet: en fil som
 * packar upp till något orimligt ska stoppas medan den läses, inte efteråt.
 */
import type { ZipArchive } from './zip.ts';
import { XmlError, localName, parseXml } from './xml.ts';

export class OfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeError';
  }
}

/** Arbetet tog för lång tid. Egen sort, så att tjänsten kan svara något annat än "trasig fil". */
export class OfficeTimeout extends Error {
  constructor() {
    super('Det tog för lång tid att läsa filen.');
    this.name = 'OfficeTimeout';
  }
}

export interface OfficeLimits {
  readonly maxChars: number;
  /** Tidpunkt (`Date.now()`) då arbetet ska vara klart. */
  readonly deadline: number;
}

export interface OfficeText {
  readonly text: string;
  readonly truncated: boolean;
  /** Antal bilder i en presentation. Saknas för Word och Excel. */
  readonly pages?: number;
}

/** Kastas inifrån läsningen när det redan finns tillräckligt med text; fångas i `read`. */
class Enough extends Error {}

/**
 * Raderna i svaret, med taket på antalet tecken. Delarna hålls i en lista och sätts ihop en
 * gång på slutet — strängar som växer bit för bit är det som gör stora dokument långsamma.
 * Avskiljaren skrivs FÖRE nästa rad, aldrig efter en: ett tomt blad ska inte lämna en tomrad.
 */
class Lines {
  readonly #parts: string[] = [];
  readonly #max: number;
  #length = 0;
  #first = true;
  #separator = '\n';
  truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  get full(): boolean {
    return this.#length >= this.#max;
  }

  /** Nästa rad börjar ett nytt avsnitt (blad, bild) och skiljs av med `separator`. */
  section(separator: string): void {
    if (!this.#first) this.#separator = separator;
  }

  write(line: string): void {
    if (line.trim() === '') return;
    if (!this.#first) this.#add(this.#separator);
    this.#separator = '\n';
    this.#first = false;
    this.#add(line);
    if (this.full) throw new Enough();
  }

  #add(value: string): void {
    if (value === '' || this.full) return;
    const room = this.#max - this.#length;
    if (value.length > room) {
      this.#parts.push(value.slice(0, room));
      this.#length = this.#max;
      this.truncated = true;
      return;
    }
    this.#parts.push(value);
    this.#length += value.length;
  }

  result(pages?: number): OfficeText {
    const text = this.#parts.join('');
    return pages === undefined ? { text, truncated: this.truncated } : { text, truncated: this.truncated, pages };
  }
}

function decode(bytes: Uint8Array | null, what: string): string {
  if (bytes === null) throw new OfficeError(`Filen saknar ${what}.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OfficeError('Filens innehåll går inte att läsa som text.');
  }
}

/** Läser XML och gör om `XmlError` till `OfficeError` — appen ska inte se tolkens ordval. */
function read(source: string, limits: OfficeLimits, onEvent: Parameters<typeof parseXml>[1]): void {
  let ticks = 0;
  try {
    parseXml(source, (event) => {
      ticks += 1;
      if ((ticks & 0x3ff) === 0 && Date.now() > limits.deadline) throw new OfficeTimeout();
      onEvent(event);
    });
  } catch (failure) {
    if (failure instanceof Enough) return;
    if (failure instanceof XmlError) throw new OfficeError('Filen är skadad och går inte att läsa.');
    throw failure;
  }
}

// ── Word ─────────────────────────────────────────────────────────────────────────

export function extractDocx(zip: ZipArchive, limits: OfficeLimits): OfficeText {
  const source = decode(zip.read('word/document.xml'), 'den del som texten står i');
  const lines = new Lines(limits.maxChars);
  let paragraph: string[] = [];
  let inText = false;

  read(source, limits, (event) => {
    if (event.kind === 'open') {
      const name = localName(event.tag.name);
      if (name === 'p') paragraph = [];
      else if (name === 'tab') paragraph.push('\t');
      else if (name === 'br' || name === 'cr') paragraph.push('\n');
      else if (name === 't' && !event.tag.selfClosing) inText = true;
      return;
    }
    if (event.kind === 'text') {
      if (inText) paragraph.push(event.text);
      return;
    }
    const name = localName(event.name);
    if (name === 't') inText = false;
    else if (name === 'p') lines.write(paragraph.join(''));
  });

  return lines.result();
}

// ── Excel ────────────────────────────────────────────────────────────────────────

const SHEET = /^xl\/worksheets\/sheet([0-9]+)\.xml$/;

function sharedStrings(zip: ZipArchive, limits: OfficeLimits): string[] {
  // Saknas listan har arkivet inga delade strängar. Cellerna blir då tomma, inte ett fel.
  const bytes = zip.read('xl/sharedStrings.xml');
  if (bytes === null) return [];
  const source = decode(bytes, 'listan med delade strängar');
  const strings: string[] = [];
  let current: string[] | undefined;
  let inText = false;

  read(source, limits, (event) => {
    if (event.kind === 'open') {
      const name = localName(event.tag.name);
      if (name === 'si') current = [];
      else if (name === 't' && !event.tag.selfClosing) inText = true;
      return;
    }
    if (event.kind === 'text') {
      if (inText && current !== undefined) current.push(event.text);
      return;
    }
    const name = localName(event.name);
    if (name === 't') inText = false;
    else if (name === 'si') {
      strings.push(current?.join('') ?? '');
      current = undefined;
    }
  });
  return strings;
}

/** Kolumnens nummer ur en cellreferens: `A1` → 0, `C1` → 2. Ingen läsbar referens ⇒ `null`. */
function column(reference: string | undefined): number | null {
  if (reference === undefined) return null;
  let value = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    value = value * 26 + (code - 64);
  }
  return value === 0 ? null : value - 1;
}

/** Så många tomma celler en rad får fyllas ut med — en trasig referens ska inte ge en jätterad. */
const MAX_COLUMNS = 4096;

function extractSheet(source: string, limits: OfficeLimits, strings: readonly string[], lines: Lines): void {
  let cells: string[] = [];
  let next = 0;
  let type = '';
  let reference: string | undefined;
  let value: string[] = [];
  let inValue = false;
  let inInline = false;

  read(source, limits, (event) => {
    if (event.kind === 'open') {
      const name = localName(event.tag.name);
      if (name === 'row') {
        cells = [];
        next = 0;
      } else if (name === 'c') {
        type = event.tag.attributes['t'] ?? '';
        reference = event.tag.attributes['r'];
        value = [];
      } else if (name === 'v') inValue = true;
      // Texten i en cell som bär sin sträng själv (`inlineStr`). Formeln (`f`) står utanför båda.
      else if (name === 'is') inInline = true;
      return;
    }
    if (event.kind === 'text') {
      if (inValue || inInline) value.push(event.text);
      return;
    }
    const name = localName(event.name);
    if (name === 'v') inValue = false;
    else if (name === 'is') inInline = false;
    else if (name === 'c') {
      const raw = value.join('');
      let text = raw;
      if (type === 's') {
        const index = Number.parseInt(raw, 10);
        text = Number.isSafeInteger(index) && index >= 0 ? (strings[index] ?? '') : '';
      }
      const at = column(reference);
      if (at !== null && at >= next && at - next <= MAX_COLUMNS) {
        for (let n = next; n < at; n += 1) cells.push('');
        next = at;
      }
      cells.push(text);
      next += 1;
      value = [];
      type = '';
      reference = undefined;
    } else if (name === 'row') lines.write(cells.join('\t'));
  });
}

export function extractXlsx(zip: ZipArchive, limits: OfficeLimits): OfficeText {
  const sheets = numbered(zip, SHEET);
  if (sheets.length === 0) throw new OfficeError('Filen saknar kalkylblad.');

  const lines = new Lines(limits.maxChars);
  const strings = sharedStrings(zip, limits);
  for (const sheet of sheets) {
    if (lines.full) break;
    lines.section('\n\n');
    extractSheet(decode(zip.read(sheet), 'kalkylbladet'), limits, strings, lines);
  }
  return lines.result();
}

// ── PowerPoint ───────────────────────────────────────────────────────────────────

const SLIDE = /^ppt\/slides\/slide([0-9]+)\.xml$/;

/** Posterna som stämmer med mönstret, sorterade på sitt NUMMER: blad 10 kommer efter blad 2. */
function numbered(zip: ZipArchive, pattern: RegExp): string[] {
  return zip
    .names()
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry) => entry.name);
}

function extractSlide(source: string, limits: OfficeLimits, lines: Lines): void {
  let paragraph: string[] = [];
  let inText = false;

  read(source, limits, (event) => {
    if (event.kind === 'open') {
      const name = localName(event.tag.name);
      if (name === 'p') paragraph = [];
      else if (name === 'br') paragraph.push('\n');
      else if (name === 't' && !event.tag.selfClosing) inText = true;
      return;
    }
    if (event.kind === 'text') {
      if (inText) paragraph.push(event.text);
      return;
    }
    const name = localName(event.name);
    if (name === 't') inText = false;
    else if (name === 'p') lines.write(paragraph.join(''));
  });
}

export function extractPptx(zip: ZipArchive, limits: OfficeLimits): OfficeText {
  const slides = numbered(zip, SLIDE);
  if (slides.length === 0) throw new OfficeError('Filen saknar bilder.');

  const lines = new Lines(limits.maxChars);
  for (const slide of slides) {
    if (lines.full) break;
    lines.section('\n\n');
    extractSlide(decode(zip.read(slide), 'bilden'), limits, lines);
  }
  return lines.result(slides.length);
}
