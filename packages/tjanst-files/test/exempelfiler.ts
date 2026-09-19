/**
 * Små, riktiga exempelfiler för tester och scenarier — och fientliga varianter av dem.
 * Varje fil har de magiska byte som en riktig fil av typen har; allt annat är så kort som möjligt.
 */

/** En riktig 1×1-bild i PNG. */
export const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

export const GIF = Uint8Array.from(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));

function riff(format: string, resten: string): Uint8Array {
  const kropp = Buffer.from(format + resten, 'latin1');
  const huvud = Buffer.alloc(8);
  huvud.write('RIFF', 0, 'latin1');
  huvud.writeUInt32LE(kropp.length, 4);
  return Uint8Array.from(Buffer.concat([huvud, kropp]));
}

export const WEBP = riff('WEBP', 'VP8 \x00\x00\x00\x00');
export const WAV = riff('WAVE', 'fmt \x10\x00\x00\x00');

export const PDF = Uint8Array.from(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1'));

export const MP3_ID3 = Uint8Array.from(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'));
/** MPEG-1 Layer III utan ID3-tagg: ramsynk 0xFFFB. */
export const MP3_RAM = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);

function ftyp(varumarke: string): Uint8Array {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(varumarke, 8, 'latin1');
  b.write('isomiso2', 16, 'latin1');
  return Uint8Array.from(b);
}

export const M4A = ftyp('M4A ');
export const MP4_LJUD = ftyp('mp42');
/** QuickTime — inte ljud i MP4, ska nekas. */
export const QUICKTIME = ftyp('qt  ');

export const OGG = Uint8Array.from(Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'));

function ebml(doctype: string): Uint8Array {
  const typ = Buffer.from(doctype, 'latin1');
  return Uint8Array.from(
    Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | typ.length]), typ, Buffer.alloc(8)]),
  );
}

export const WEBM = ebml('webm');
/** Matroska (mkv) — samma behållare men inte webm, ska nekas. */
export const MATROSKA = ebml('matroska');

export const TEXT = Uint8Array.from(Buffer.from('Hej!\nDet här är en vanlig textfil med åäö.\n', 'utf8'));
export const CSV = Uint8Array.from(Buffer.from('namn;antal\nStora salen;12\nLilla salen;4\n', 'utf8'));

export const SVG = Uint8Array.from(
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>', 'utf8'),
);
export const SVG_MED_XML = Uint8Array.from(Buffer.from('﻿  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'));
export const HTML = Uint8Array.from(Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>', 'utf8'));

// ── ZIP (docx/xlsx) ────────────────────────────────────────────────────────────

/** En giltig (okomprimerad, "stored") zip med de angivna filnamnen och tomt innehåll. */
export function zip(namn: readonly string[]): Uint8Array {
  const lokala: Buffer[] = [];
  const centrala: Buffer[] = [];
  let offset = 0;
  for (const n of namn) {
    const namnbyte = Buffer.from(n, 'utf8');
    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4);
    lokal.writeUInt16LE(namnbyte.length, 26);
    lokala.push(lokal, namnbyte);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(namnbyte.length, 28);
    central.writeUInt32LE(offset, 42);
    centrala.push(central, namnbyte);
    offset += lokal.length + namnbyte.length;
  }
  const katalog = Buffer.concat(centrala);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(namn.length, 8);
  slut.writeUInt16LE(namn.length, 10);
  slut.writeUInt32LE(katalog.length, 12);
  slut.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...lokala, katalog, slut]));
}

export const DOCX = zip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
export const XLSX = zip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
/** Ett Word-dokument med makron (docm) förklätt som docx. */
export const DOCX_MED_MAKRON = zip(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']);
/** En vanlig zip, t.ex. med en webbsida i — inget Office-dokument. */
export const VANLIG_ZIP = zip(['index.html']);

export const DOCX_TYP = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_TYP = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
