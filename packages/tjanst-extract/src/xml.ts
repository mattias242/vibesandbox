/**
 * En liten XML-läsare för Office-dokumentens XML. Den gör med flit mindre än en riktig
 * XML-tolk, och det är själva poängen:
 *
 * - **Inga externa entiteter.** En dokumenttypsdeklaration (`<!DOCTYPE …>`) är enda vägen till
 *   både XXE (`<!ENTITY x SYSTEM "file:///etc/passwd">`) och entitetsbomber. Office-filer har
 *   aldrig någon, så läsaren vägrar filen i stället för att tolka deklarationen. En entitet den
 *   inte känner igen slås ALDRIG upp någonstans — den blir bara text.
 * - **Inget dokumentträd.** Händelser lämnas ut en i taget, så minnet växer inte med filen.
 * - **Ingen gissning.** Trasig XML blir ett fel, inte halv text ur en halv fil.
 */

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface XmlTag {
  /** Namnet som det står i filen, med eventuell namnrymdsförkortning (`w:t`). */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
}

export type XmlEvent =
  | { readonly kind: 'open'; readonly tag: XmlTag }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string };

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

function codePoint(digits: string): string | null {
  const value = digits[1] === 'x' || digits[1] === 'X' ? Number.parseInt(digits.slice(2), 16) : Number.parseInt(digits.slice(1), 10);
  // Ogiltiga tecken lämnas som de står: ingen halv surrogatpar-text, ingen NUL i utdata.
  if (!Number.isSafeInteger(value) || value < 0x20 || value > 0x10ffff) {
    return value === 0x09 || value === 0x0a || value === 0x0d ? String.fromCodePoint(value) : null;
  }
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

/** Avkodar XML-entiteter. Okända entiteter lämnas orörda — de slås aldrig upp någon annanstans. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (hela, namn: string) => {
    if (namn.startsWith('#')) return codePoint(namn) ?? hela;
    return NAMED[namn] ?? hela;
  });
}

/** Slutet på taggen som börjar vid `start`, med hänsyn till citattecken i attributvärden. */
function findTagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
    else if (char === '<') throw new XmlError('En tagg är inte avslutad.');
  }
  throw new XmlError('En tagg är inte avslutad.');
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(rest: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!rest.includes('=')) return attributes;
  ATTRIBUTE.lastIndex = 0;
  let match = ATTRIBUTE.exec(rest);
  while (match !== null) {
    attributes[match[1] as string] = decodeEntities(match[2] ?? match[3] ?? '');
    match = ATTRIBUTE.exec(rest);
  }
  return attributes;
}

/** Namnet utan namnrymdsförkortning: `w:t` → `t`. */
export function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Läser igenom dokumentet och lämnar ut en händelse i taget. Kastar `onEvent` något avbryts
 * läsningen med det felet — så kan den som läser sluta när den fått nog.
 */
export function parseXml(source: string, onEvent: (event: XmlEvent) => void): void {
  const open: string[] = [];
  let i = 0;

  const text = (value: string): void => {
    if (value !== '') onEvent({ kind: 'text', text: decodeEntities(value) });
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      text(source.slice(i));
      break;
    }
    if (lt > i) text(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('En kommentar är inte avslutad.');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('Ett CDATA-block är inte avslutat.');
      // CDATA är ordagrant innehåll: inga entiteter att avkoda.
      const value = source.slice(lt + 9, end);
      if (value !== '') onEvent({ kind: 'text', text: value });
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // Dokumenttyp eller entitetsdeklaration: enda vägen till en extern entitet. Vi läser den inte.
      throw new XmlError('Filen har en dokumenttypsdeklaration och läses inte.');
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('En bearbetningsanvisning är inte avslutad.');
      i = end + 2;
      continue;
    }

    const gt = findTagEnd(source, lt);
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (open.pop() !== name) throw new XmlError('Ett element stängs av fel sluttagg.');
      onEvent({ kind: 'close', name });
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd === -1 ? body : body.slice(0, nameEnd)).trim();
    if (name === '') throw new XmlError('En tagg saknar namn.');
    const attributes = parseAttributes(nameEnd === -1 ? '' : body.slice(nameEnd));
    onEvent({ kind: 'open', tag: { name, attributes, selfClosing } });
    if (selfClosing) onEvent({ kind: 'close', name });
    else open.push(name);
  }

  if (open.length > 0) throw new XmlError('Ett element är inte avslutat.');
}
