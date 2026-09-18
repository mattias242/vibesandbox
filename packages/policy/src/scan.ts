/**
 * En liten skanner för TypeScript/TSX och CSS — INTE en parser.
 *
 * Den delar upp texten i kod, kommentarer, strängar, mallsträngar och reguljära uttryck, så att
 * kontrollerna kan skilja `fetch(` i kod från ordet "fetch" i en kommentar. Utan en riktig parser
 * går det inte att göra rätt i alla lägen: JSX-text (`<p>//</p>`, `<p>Don't</p>`) och `/` som
 * kan vara division eller reguljärt uttryck lurar vilken skanner som helst av det här slaget.
 *
 * Därför är felriktningen vald med avsikt:
 *  - Vid tvekan behandlas `/` som division, alltså som KOD (kod granskas hårdast).
 *  - Allt som skannern lägger undan som text (kommentarer, strängar, uttryck) returneras i `texts`
 *    och granskas ändå, med mönster formade som anrop (`fetch(`), så att kod som felaktigt
 *    hamnat i en "kommentar" fortfarande fastnar. Vanlig prosa ("vi använder inte fetch") gör det inte.
 *  - Varje vy har exakt samma längd och samma radbrytningar som källan, så radnummer stämmer.
 */

export type TextKind = 'comment' | 'string' | 'template' | 'regex';

export interface TextSegment {
  readonly kind: TextKind;
  /** Index i källan där innehållet börjar. */
  readonly start: number;
  /** Innehållet som det står i källan (utan citattecken). */
  readonly raw: string;
  /** Strängens värde efter escape-sekvenser (`\x68` → `h`). För kommentarer = `raw`. */
  readonly decoded: string;
}

export interface ScriptScan {
  /** Kommentarer ersatta med blanksteg. Strängar kvar. */
  readonly code: string;
  /** Som `code`, men även innehållet i strängar, mallsträngar och reguljära uttryck blankat. `${…}` är kod och står kvar. */
  readonly bare: string;
  readonly texts: readonly TextSegment[];
}

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i += 1) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

/** Tecken efter vilka ett `/` inleder ett reguljärt uttryck. `)`, `]`, `}` och `<` saknas med avsikt: där blir det division, dvs. kod. */
const REGEX_AFTER_CHAR = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const IDENTIFIER_CHAR = /[\w$]/;

/** Avkodar escape-sekvenser i en JS-sträng, så att `'\x68ttps://'` granskas som `https://`. */
export function decodeJsEscapes(raw: string): string {
  return raw.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(\r\n|\r|\n)|([\s\S]))/g, (_all, hex2, hexBrace, hex4, lineBreak, other) => {
    const code = hex2 ?? hexBrace ?? hex4;
    if (code !== undefined) {
      const point = Number.parseInt(code, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    if (lineBreak !== undefined) return '';
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return simple[other as string] ?? (other as string);
  });
}

export function scanScript(source: string): ScriptScan {
  // split('') delar på UTF-16-enheter, precis som index i källan (spridning delar på kodpunkter).
  const code = source.split('');
  const bare = source.split('');
  const texts: TextSegment[] = [];
  const templateDepths: number[] = [];
  let braceDepth = 0;
  let i = 0;
  const n = source.length;

  function previousSignificant(before: number): { char: string; word: string } {
    let j = before - 1;
    while (j >= 0 && /\s/.test(code[j] ?? '')) j -= 1;
    const char = j >= 0 ? (code[j] ?? '') : '';
    let word = '';
    while (j >= 0 && IDENTIFIER_CHAR.test(code[j] ?? '')) {
      word = (code[j] ?? '') + word;
      j -= 1;
    }
    return { char, word };
  }

  function regexAllowed(at: number): boolean {
    const { char, word } = previousSignificant(at);
    if (char === '') return true;
    if (word !== '') return REGEX_AFTER_WORD.has(word);
    // `=> /re/` är ett uttryck; annars är `>` oftast slutet på en JSX-tagg, och då är `/` text.
    if (char === '>') return previousArrow(at);
    return REGEX_AFTER_CHAR.has(char);
  }

  function previousArrow(at: number): boolean {
    let j = at - 1;
    while (j >= 0 && /\s/.test(code[j] ?? '')) j -= 1;
    return code[j] === '>' && code[j - 1] === '=';
  }

  /** Läser mallsträngstext från `start` till `` ` `` eller `${`. Returnerar nästa index. */
  function readTemplateChunk(start: number): number {
    let j = start;
    while (j < n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) {
      if (source[j] === '\\') j += 1;
      j += 1;
    }
    const end = Math.min(j, n);
    const raw = source.slice(start, end);
    texts.push({ kind: 'template', start, raw, decoded: decodeJsEscapes(raw) });
    blank(bare, start, end);
    if (j >= n) return n;
    if (source[j] === '`') return j + 1;
    templateDepths.push(braceDepth);
    return j + 2;
  }

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      const newline = source.indexOf('\n', i);
      const end = newline < 0 ? n : newline;
      const raw = source.slice(i + 2, end);
      texts.push({ kind: 'comment', start: i + 2, raw, decoded: raw });
      blank(code, i, end);
      blank(bare, i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      const raw = source.slice(i + 2, close < 0 ? n : close);
      texts.push({ kind: 'comment', start: i + 2, raw, decoded: raw });
      blank(code, i, end);
      blank(bare, i, end);
      i = end;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      const end = Math.min(j, n);
      const raw = source.slice(i + 1, end);
      texts.push({ kind: 'string', start: i + 1, raw, decoded: decodeJsEscapes(raw) });
      blank(bare, i + 1, end);
      i = source[end] === c ? end + 1 : end;
      continue;
    }

    if (c === '`') {
      i = readTemplateChunk(i + 1);
      continue;
    }

    if (c === '/' && regexAllowed(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += 1;
      }
      const end = Math.min(j, n);
      const raw = source.slice(i + 1, end);
      texts.push({ kind: 'regex', start: i + 1, raw, decoded: raw });
      blank(bare, i + 1, end);
      i = source[end] === '/' ? end + 1 : end;
      continue;
    }

    if (c === '{') braceDepth += 1;
    if (c === '}') {
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop();
        i = readTemplateChunk(i + 1);
        continue;
      }
      braceDepth -= 1;
    }
    i += 1;
  }

  return { code: code.join(''), bare: bare.join(''), texts };
}

export interface StyleScan {
  /** Kommentarer ersatta med blanksteg. Strängar kvar. */
  readonly code: string;
  /** Även strängarnas innehåll blankat. */
  readonly bare: string;
  readonly strings: readonly TextSegment[];
}

export function scanStyle(source: string): StyleScan {
  const code = source.split('');
  const bare = source.split('');
  const strings: TextSegment[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      blank(code, i, end);
      blank(bare, i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      const end = Math.min(j, n);
      const raw = source.slice(i + 1, end);
      strings.push({ kind: 'string', start: i + 1, raw, decoded: raw });
      blank(bare, i + 1, end);
      i = source[end] === c ? end + 1 : end;
      continue;
    }
    i += 1;
  }
  return { code: code.join(''), bare: bare.join(''), strings };
}

/** Radnummer (1-baserat) för ett index. */
export function lineFinder(source: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
