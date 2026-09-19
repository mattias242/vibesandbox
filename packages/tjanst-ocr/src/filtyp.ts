/**
 * Vilken sorts fil är det här — avgjort av filens egna byte, aldrig av den angivna typen eller
 * namnet (en app kan ladda upp vad som helst under vilket namn som helst). Bara huvudet läses:
 * tjänsten avkodar aldrig en bild, så en skadlig bild kan inte utnyttja någon avkodare här.
 *
 * Bredd och höjd behövs för upplösningsgränsen: en liten fil kan beskriva en enorm bild, och det
 * är upplösningen som kostar hos leverantören.
 */

export type IdentifiedFile =
  | { readonly kind: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly width: number; readonly height: number }
  | { readonly kind: 'pdf'; readonly mediaType: 'application/pdf'; readonly estimatedPages: number };

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((b, i) => bytes[offset + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function image(mediaType: 'image/png' | 'image/jpeg' | 'image/webp', width: number, height: number): IdentifiedFile | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { kind: 'image', mediaType, width, height };
}

function png(bytes: Uint8Array): IdentifiedFile | null {
  // Signatur (8) + längd (4) + "IHDR" (4) + bredd (4) + höjd (4).
  if (bytes.length < 24 || !startsWith(bytes, ascii('IHDR'), 12)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return image('image/png', view.getUint32(16), view.getUint32(20));
}

/** Ramhuvudena (SOF) som bär bredd och höjd; C4, C8 och CC är andra markörer med samma nummerserie. */
const SOF_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(bytes: Uint8Array): IdentifiedFile | null {
  let offset = 2;
  // Varje varv flyttar framåt minst 2 byte, så slingan tar alltid slut.
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // utfyllnad
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markörer utan längd
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // slut, eller bilddata före något ramhuvud
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return image('image/jpeg', width, height);
    }
    offset += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): IdentifiedFile | null {
  if (bytes.length < 25) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u24 = (at: number): number => view.getUint16(at, true) | ((bytes[at + 2] ?? 0) << 16);
  if (startsWith(bytes, ascii('VP8X'), 12)) return bytes.length < 30 ? null : image('image/webp', u24(24) + 1, u24(27) + 1);
  if (startsWith(bytes, ascii('VP8 '), 12)) {
    if (bytes.length < 30 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return image('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (startsWith(bytes, ascii('VP8L'), 12)) {
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return image('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/**
 * Ungefärligt antal sidor: sidobjekten (`/Type /Page`, inte `/Pages`) som syns okomprimerade.
 * Komprimerade objektströmmar döljer dem, så det är en undre gräns — minst 1. Den faktiska
 * siffran kommer från leverantören efteråt och är den som räknas mot kvoten.
 */
function pdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return Math.max(1, matches?.length ?? 0);
}

export function identifyFile(bytes: Uint8Array): IdentifiedFile | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(bytes);
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return webp(bytes);
  if (startsWith(bytes, ascii('%PDF-'))) return { kind: 'pdf', mediaType: 'application/pdf', estimatedPages: pdfPages(bytes) };
  return null;
}
