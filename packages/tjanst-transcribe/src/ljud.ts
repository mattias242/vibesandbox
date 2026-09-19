/**
 * Vilket ljud det är och hur långt det är — utan beroenden.
 *
 * Typen avgörs av BÅDE den uppgivna typen och filens första byte. Den uppgivna typen kommer från
 * den som laddade upp och är inte att lita på; en pdf som kallar sig `audio/mpeg` ska inte skickas
 * till Berget. Formaten är de Berget tar emot: mp3, mp4/m4a, wav och webm.
 *
 * Längden behövs för kvoten (ljudminuter per app och dygn). Exakt längd ur mp3, mp4 och webm
 * kräver en avkodare eller en containertolk — ett beroende eller mycket egen kod för ett tal som
 * Berget ändå ger tillbaka (`duration`). Därför: WAV läses exakt ur huvudet (enkelt och vanligt vid
 * inspelning), allt annat uppskattas ur storleken som en RESERVATION när jobbet beställs, och
 * ersätts med Bergets verkliga längd när jobbet är klart.
 */

export type AudioFormat = 'mp3' | 'mp4' | 'wav' | 'webm';

export interface DetectedAudio {
  readonly format: AudioFormat;
  /** Typen som skickas till Berget — plattformens, inte uppladdarens. */
  readonly mimeType: string;
  /** Filnamnets ändelse till Berget. Namnet är alltid `ljud.<ext>`; uppladdarens filnamn skickas aldrig. */
  readonly extension: string;
}

const TYPES: Readonly<Record<string, AudioFormat>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'mp4',
  'audio/x-m4a': 'mp4',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
};

const OUTGOING: Readonly<Record<AudioFormat, Omit<DetectedAudio, 'format'>>> = {
  mp3: { mimeType: 'audio/mpeg', extension: 'mp3' },
  mp4: { mimeType: 'audio/mp4', extension: 'm4a' },
  wav: { mimeType: 'audio/wav', extension: 'wav' },
  webm: { mimeType: 'audio/webm', extension: 'webm' },
};

function ascii(body: Uint8Array, offset: number, text: string): boolean {
  if (body.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (body[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function looksLike(format: AudioFormat, body: Uint8Array): boolean {
  switch (format) {
    case 'mp3':
      // ID3-tagg, eller direkt en MPEG-ram (11 synkbitar).
      return ascii(body, 0, 'ID3') || (body[0] === 0xff && ((body[1] ?? 0) & 0xe0) === 0xe0);
    case 'mp4':
      return ascii(body, 4, 'ftyp');
    case 'wav':
      return ascii(body, 0, 'RIFF') && ascii(body, 8, 'WAVE');
    case 'webm':
      return body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3;
  }
}

/** Ljudet, om typen är tillåten OCH innehållet stämmer med den. Annars `null`. */
export function detectAudio(contentType: string, body: Uint8Array): DetectedAudio | null {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const format = Object.hasOwn(TYPES, base) ? TYPES[base] : undefined;
  if (format === undefined || !looksLike(format, body)) return null;
  return { format, ...OUTGOING[format] };
}

/**
 * Antagen bithastighet för ljud vars längd inte kan läsas: 64 kbit/s, typiskt för tal inspelat i
 * webbläsaren (Opus/AAC) och i telefonens röstmemo. Lägre bithastighet ger en för låg reservation
 * — men den rättas med Bergets verkliga längd när jobbet är klart, så en app kan som mest gå över
 * sin kvot med ett jobb. Högre bithastighet ger en för hög reservation, som också rättas.
 */
export const ASSUMED_BYTES_PER_SECOND = 8000;

function wavSeconds(body: Uint8Array): number | undefined {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let byteRate: number | undefined;
  let offset = 12;
  // Gå igenom chunkarna: `fmt ` ger byte per sekund, `data` ljudets storlek.
  for (let chunks = 0; chunks < 64 && offset + 8 <= body.byteLength; chunks += 1) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(body, offset, 'fmt ') && offset + 16 <= body.byteLength) {
      byteRate = view.getUint32(offset + 16, true);
    } else if (ascii(body, offset, 'data')) {
      if (byteRate === undefined || byteRate === 0) return undefined;
      // Ett huvud som påstår mer än filen innehåller räknas på det som faktiskt finns.
      const available = Math.min(size, body.byteLength - offset - 8);
      return available / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** Ljudets längd i hela sekunder (uppåt), aldrig under 1. */
export function estimateSeconds(format: AudioFormat, body: Uint8Array): number {
  const exact = format === 'wav' ? wavSeconds(body) : undefined;
  const seconds = exact ?? body.byteLength / ASSUMED_BYTES_PER_SECOND;
  return Math.max(1, Math.ceil(seconds - 1e-9));
}
