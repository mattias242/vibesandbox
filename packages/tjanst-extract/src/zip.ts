/**
 * Zip-läsaren. Office-dokument (docx, xlsx, pptx) är zip-arkiv med XML i, och det enda vi vill
 * ha ur dem är ett par namngivna poster. Node har ingen zip-läsare, bara `inflateRaw` — resten
 * står här, och den är skriven för fientliga indata:
 *
 * - Varje längd och varje offset i arkivet kommer utifrån. Ingen av dem används utan att först
 *   jämföras med buffertens verkliga storlek.
 * - En zip-bomb (några kilobyte som packar upp till gigabyte) stoppas på tre sätt: antalet
 *   poster, den sammanlagda utpackade storleken och hur många gånger större arkivet blir.
 *   Katalogens storlekar kan ljuga, så varje uppackning har DESSUTOM ett eget tak (`maxOutputLength`).
 * - Namnen kontrolleras fast ingenting någonsin skrivs till disk: ett arkiv med `../` i namnen
 *   är inget vanligt dokument, och det ska inte behandlas som ett.
 * - Zip64 stöds inte. Ett dokument som behöver det är långt större än tjänstens filgräns.
 */
import { inflateRawSync } from 'node:zlib';

export type ZipFailure = 'broken' | 'too_large';

export class ZipError extends Error {
  readonly failure: ZipFailure;

  constructor(failure: ZipFailure, message: string) {
    super(message);
    this.name = 'ZipError';
    this.failure = failure;
  }
}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxUnpackedBytes: number;
  /** Hur många gånger större arkivet får bli när det packas upp. */
  readonly maxExpansion: number;
}

export interface ZipArchive {
  /** Posternas namn, i katalogens ordning. */
  names(): readonly string[];
  /** Postens innehåll, eller `null` om den inte finns. Kastar `ZipError` om den inte går att packa upp. */
  read(name: string): Uint8Array | null;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_MARKER = 0xffffffff;

/**
 * Under den här storleken spelar förhållandet mellan packat och utpackat ingen roll: en liten
 * XML-fil med mycket upprepning krymper lätt hundra gånger utan att vara något annat än en
 * liten XML-fil. Bomben är det som är både mångdubblat OCH stort.
 */
const EXPANSION_FLOOR_BYTES = 1024 * 1024;

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** Ett namn som inte kan peka någon annanstans än in i arkivet. */
function safeName(name: string): boolean {
  if (name === '' || name.length > 512) return false;
  if (name.includes('\\') || name.includes('\u0000') || name.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..' || part === '.');
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  const earliest = Math.max(0, length - EOCD_SIZE - 0xffff);
  for (let i = length - EOCD_SIZE; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readCentralDirectory(bytes: Uint8Array, view: DataView, limits: ZipLimits): Entry[] {
  const eocd = findEndOfCentralDirectory(view, bytes.length);
  if (eocd === -1) throw new ZipError('broken', 'Arkivet har ingen innehållsförteckning.');

  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || size === ZIP64_MARKER || offset === ZIP64_MARKER) {
    throw new ZipError('broken', 'Arkivet är av en sort som inte går att läsa här.');
  }
  if (count > limits.maxEntries) throw new ZipError('too_large', 'Arkivet innehåller för många filer.');
  if (offset + size > eocd) throw new ZipError('broken', 'Innehållsförteckningen pekar utanför filen.');

  const entries: Entry[] = [];
  const decoder = new TextDecoder('utf-8');
  let position = offset;
  for (let n = 0; n < count; n += 1) {
    if (position + 46 > eocd || view.getUint32(position, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('broken', 'Innehållsförteckningen är trasig.');
    }
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const nameEnd = position + 46 + nameLength;
    if (nameEnd > eocd) throw new ZipError('broken', 'Innehållsförteckningen är trasig.');
    const name = decoder.decode(bytes.subarray(position + 46, nameEnd));
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new ZipError('broken', 'Arkivet är av en sort som inte går att läsa här.');
    }
    if (!safeName(name)) throw new ZipError('broken', 'Arkivet innehåller filnamn som pekar utanför det.');
    if (localOffset + 30 > bytes.length) throw new ZipError('broken', 'En fil i arkivet pekar utanför det.');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    position = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function checkBudget(entries: readonly Entry[], limits: ZipLimits): void {
  let compressed = 0;
  let uncompressed = 0;
  for (const entry of entries) {
    compressed += entry.compressedSize;
    uncompressed += entry.uncompressedSize;
  }
  if (uncompressed > limits.maxUnpackedBytes) throw new ZipError('too_large', 'Filen packar upp till mer än vad som får läsas.');
  if (uncompressed > EXPANSION_FLOOR_BYTES && uncompressed > limits.maxExpansion * Math.max(compressed, 1)) {
    throw new ZipError('too_large', 'Filen packar upp till mångdubbelt mer än den väger.');
  }
}

/** Var postens data börjar: det lokala huvudets längder kan skilja sig från katalogens. */
function dataStart(bytes: Uint8Array, view: DataView, entry: Entry): number {
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) throw new ZipError('broken', 'En fil i arkivet är trasig.');
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > bytes.length) throw new ZipError('broken', 'En fil i arkivet pekar utanför det.');
  return start;
}

export function openZip(bytes: Uint8Array, limits: ZipLimits): ZipArchive {
  if (bytes.length < EOCD_SIZE) throw new ZipError('broken', 'Filen är för kort för att vara ett arkiv.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(bytes, view, limits);
  checkBudget(entries, limits);

  const byName = new Map<string, Entry>();
  // Första posten med ett namn gäller: en andra post med samma namn kan inte skugga den.
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);

  let remaining = limits.maxUnpackedBytes;

  return {
    names: () => entries.map((entry) => entry.name),
    read(name) {
      const entry = byName.get(name);
      if (entry === undefined) return null;
      if (entry.uncompressedSize === 0) return new Uint8Array(0);
      // Katalogens storlek kan ljuga; taket här är det som faktiskt stoppar en bomb.
      const ceiling = Math.min(entry.uncompressedSize, remaining);
      if (ceiling <= 0) throw new ZipError('too_large', 'Filen packar upp till mer än vad som får läsas.');
      const start = dataStart(bytes, view, entry);
      const data = bytes.subarray(start, start + entry.compressedSize);

      let out: Uint8Array;
      if (entry.method === 0) {
        if (data.length > ceiling) throw new ZipError('too_large', 'Filen packar upp till mer än vad som får läsas.');
        out = Uint8Array.prototype.slice.call(data);
      } else if (entry.method === 8) {
        try {
          out = Uint8Array.prototype.slice.call(inflateRawSync(data, { maxOutputLength: ceiling }));
        } catch (failure) {
          const code = (failure as { code?: string }).code;
          if (code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError('too_large', 'Filen packar upp till mer än vad som får läsas.');
          throw new ZipError('broken', 'En fil i arkivet går inte att packa upp.');
        }
      } else {
        throw new ZipError('broken', 'Arkivet är packat på ett sätt som inte går att läsa här.');
      }
      remaining -= out.length;
      return out;
    },
  };
}
