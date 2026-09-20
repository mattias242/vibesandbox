/**
 * Små, riktiga exempelfiler för testerna — och fientliga varianter av dem. Zip-arkiven byggs här
 * för hand (`node:zlib`), så att testerna kan göra sådant inget verktyg gör: ljuga om storlekar,
 * lägga in `../` i namnen, packa en bomb.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipPost {
  readonly namn: string;
  readonly innehall: Uint8Array | string;
  /** Packa i stället för att lagra rått. */
  readonly packa?: boolean;
  /** Skriv en annan (lögnaktig) okomprimerad storlek i katalogen. */
  readonly ljugOmStorlek?: number;
}

function byte(innehall: Uint8Array | string): Buffer {
  return typeof innehall === 'string' ? Buffer.from(innehall, 'utf8') : Buffer.from(innehall);
}

/** Bygger ett zip-arkiv av posterna. Ingen ordning eller komprimering antas av läsaren. */
export function byggZip(poster: readonly ZipPost[]): Uint8Array {
  const lokala: Buffer[] = [];
  const centrala: Buffer[] = [];
  let offset = 0;
  for (const post of poster) {
    const namn = Buffer.from(post.namn, 'utf8');
    const rått = byte(post.innehall);
    const data = post.packa === true ? deflateRawSync(rått) : rått;
    const metod = post.packa === true ? 8 : 0;
    const storlek = post.ljugOmStorlek ?? rått.length;

    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4);
    lokal.writeUInt16LE(metod, 8);
    lokal.writeUInt32LE(crc32(rått), 14);
    lokal.writeUInt32LE(data.length, 18);
    lokal.writeUInt32LE(storlek, 22);
    lokal.writeUInt16LE(namn.length, 26);
    lokala.push(lokal, namn, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(metod, 10);
    central.writeUInt32LE(crc32(rått), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(storlek, 24);
    central.writeUInt16LE(namn.length, 28);
    central.writeUInt32LE(offset, 42);
    centrala.push(central, namn);

    offset += 30 + namn.length + data.length;
  }
  const katalog = Buffer.concat(centrala);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(poster.length, 8);
  slut.writeUInt16LE(poster.length, 10);
  slut.writeUInt32LE(katalog.length, 12);
  slut.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...lokala, katalog, slut]));
}

const TYPER = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

function stycke(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr/><w:t>${text}</w:t></w:r></w:p>`;
}

/** Ett Word-dokument med ett stycke per rad i `stycken`. */
export function docx(stycken: readonly string[] = ['Protokoll 2026-09-20', 'Beslut: ärendet bordläggs.']): Uint8Array {
  const kropp = stycken.map(stycke).join('');
  return byggZip([
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: '_rels/.rels', innehall: '<?xml version="1.0"?><Relationships/>' },
    {
      namn: 'word/document.xml',
      packa: true,
      innehall: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${kropp}</w:body></w:document>`,
    },
  ]);
}

export const DOCX_STYCKEN = ['Protokoll 2026-09-20', 'Beslut: ärendet bordläggs.'];

/** Ett kalkylblad. `rader` är cellernas text; tomma strängar blir tomma celler. */
export function xlsx(rader: readonly (readonly string[])[] = XLSX_RADER, delade = true): Uint8Array {
  const strangar: string[] = [];
  const index = (text: string): number => {
    const finns = strangar.indexOf(text);
    if (finns !== -1) return finns;
    strangar.push(text);
    return strangar.length - 1;
  };
  const kolumn = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : `A${String.fromCharCode(65 + (n - 26))}`);
  const xmlRader = rader
    .map((rad, r) => {
      const celler = rad
        .map((cell, c) => {
          if (cell === '') return '';
          const referens = `${kolumn(c)}${r + 1}`;
          if (/^-?[0-9]+(\.[0-9]+)?$/.test(cell)) return `<c r="${referens}"><v>${cell}</v></c>`;
          return delade
            ? `<c r="${referens}" t="s"><v>${index(cell)}</v></c>`
            : `<c r="${referens}" t="inlineStr"><is><t>${cell}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${celler}</row>`;
    })
    .join('');
  const poster: ZipPost[] = [
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: 'xl/workbook.xml', innehall: '<?xml version="1.0"?><workbook><sheets><sheet name="Blad1" sheetId="1"/></sheets></workbook>' },
    {
      namn: 'xl/worksheets/sheet1.xml',
      packa: true,
      innehall: `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${xmlRader}</sheetData></worksheet>`,
    },
  ];
  if (delade) {
    poster.push({
      namn: 'xl/sharedStrings.xml',
      packa: true,
      innehall: `<?xml version="1.0" encoding="UTF-8"?><sst count="${strangar.length}">${strangar.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    });
  }
  return byggZip(poster);
}

export const XLSX_RADER = [
  ['Ärende', 'Handläggare', 'Belopp'],
  ['2026-114', 'Anna', '4200'],
];

/** En presentation med en bild per lista i `bilder`. */
export function pptx(bilder: readonly (readonly string[])[] = PPTX_BILDER): Uint8Array {
  const poster: ZipPost[] = [
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: 'ppt/presentation.xml', innehall: '<?xml version="1.0"?><p:presentation xmlns:p="ppt"/>' },
  ];
  bilder.forEach((rader, i) => {
    const stycken = rader
      .map((rad) => `<a:p><a:r><a:rPr lang="sv-SE"/><a:t>${rad}</a:t></a:r></a:p>`)
      .join('');
    poster.push({
      namn: `ppt/slides/slide${i + 1}.xml`,
      packa: true,
      innehall: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="draw" xmlns:p="ppt"><p:cSld><p:spTree><p:sp><p:txBody>${stycken}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    });
  });
  return byggZip(poster);
}

export const PPTX_BILDER = [
  ['Budget 2027', 'Kommunstyrelsen'],
  ['Tre förslag', 'Ett, två, tre'],
];

/** En PDF som ser äkta ut i början. Vad som står i den avgör den injicerade pdf-läsaren i testet. */
export const PDF = Uint8Array.from(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n', 'latin1'));

/** En zip som packar upp till mycket mer än den väger. */
export function zipBomb(storlek = 80 * 1024 * 1024): Uint8Array {
  return byggZip([
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: 'word/document.xml', packa: true, innehall: new Uint8Array(storlek) },
  ]);
}

/** En zip vars poster försöker peka utanför arkivet. */
export function zipMedSokvagar(): Uint8Array {
  return byggZip([
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: '../../../etc/passwd', innehall: 'root:x:0:0' },
    { namn: 'word/document.xml', innehall: '<w:document><w:body><w:p><w:t>hej</w:t></w:p></w:body></w:document>' },
  ]);
}
