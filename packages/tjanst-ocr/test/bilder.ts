/**
 * Små, riktiga filhuvuden för testerna: rätt magiska byte och rätt fält för bredd och höjd.
 * Innehållet behöver inte gå att avkoda — tjänsten avkodar aldrig bilden, den läser bara huvudet.
 */
import { crc32 } from 'node:zlib';

function chunk(typ: string, data: Uint8Array): Buffer {
  const langd = Buffer.alloc(4);
  langd.writeUInt32BE(data.length);
  const typOchData = Buffer.concat([Buffer.from(typ, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typOchData));
  return Buffer.concat([langd, typOchData, crc]);
}

export function png(bredd: number, hojd: number, fyllnad = 0): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bredd, 0);
  ihdr.writeUInt32BE(hojd, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', Buffer.from([fyllnad])),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** JPEG med ett APP0-segment före ramhuvudet (SOF), som en vanlig kamerabild. */
export function jpeg(bredd: number, hojd: number, sof = 0xc0): Uint8Array {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sofSegment = Buffer.alloc(19);
  sofSegment.set([0xff, sof, 0x00, 0x11, 0x08]);
  sofSegment.writeUInt16BE(hojd, 5);
  sofSegment.writeUInt16BE(bredd, 7);
  sofSegment[9] = 3;
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSegment, Buffer.from([0xff, 0xd9])]));
}

export function webpVp8x(bredd: number, hojd: number): Uint8Array {
  const data = Buffer.alloc(10);
  data.writeUIntLE(bredd - 1, 4, 3);
  data.writeUIntLE(hojd - 1, 7, 3);
  return riff('VP8X', data);
}

export function webpVp8(bredd: number, hojd: number): Uint8Array {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(bredd & 0x3fff, 6);
  data.writeUInt16LE(hojd & 0x3fff, 8);
  return riff('VP8 ', data);
}

export function webpVp8l(bredd: number, hojd: number): Uint8Array {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  const bitar = ((bredd - 1) & 0x3fff) | (((hojd - 1) & 0x3fff) << 14);
  data.writeUInt32LE(bitar >>> 0, 1);
  return riff('VP8L', data);
}

function riff(typ: string, data: Buffer): Uint8Array {
  const kropp = Buffer.concat([Buffer.from('WEBP', 'latin1'), Buffer.from(typ, 'latin1'), le32(data.length), data]);
  return new Uint8Array(Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(kropp.length), kropp]));
}

function le32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** En PDF med `sidor` sidobjekt (okomprimerat, som från en enkel skanner). */
export function pdf(sidor: number): Uint8Array {
  const objekt = Array.from({ length: sidor }, (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`).join('');
  return new TextEncoder().encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${sidor} >>\nendobj\n${objekt}%%EOF\n`,
  );
}
