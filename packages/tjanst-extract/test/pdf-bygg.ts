/**
 * Bygger PDF-filer åt testerna. Inga binära testfiler i repot: varje fall sätts ihop här ur
 * objekt, korsreferenstabell och slutpost, så att det går att se i testet exakt vad som läses.
 */
import { deflateSync } from 'node:zlib';

/** Ett objekt är antingen en färdig kropp, eller en ordbok med en ström efter sig. */
export type Kropp = string | { readonly dict: string; readonly data: Uint8Array };

export function b(text: string): Uint8Array {
  const ut = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) ut[i] = text.charCodeAt(i) & 0xff;
  return ut;
}

export function sammanfoga(delar: readonly Uint8Array[]): Uint8Array {
  let langd = 0;
  for (const d of delar) langd += d.length;
  const ut = new Uint8Array(langd);
  let p = 0;
  for (const d of delar) {
    ut.set(d, p);
    p += d.length;
  }
  return ut;
}

/** En PDF-litteralsträng: allt utanför synlig ASCII skrivs som oktal rymning. */
export function pdfStrang(text: string): string {
  let ut = '(';
  for (const tecken of text) {
    const kod = tecken.charCodeAt(0);
    if (tecken === '(' || tecken === ')' || tecken === '\\') ut += `\\${tecken}`;
    else if (kod >= 32 && kod <= 126) ut += tecken;
    else ut += `\\${(kod & 0xff).toString(8).padStart(3, '0')}`;
  }
  return `${ut})`;
}

/** En innehållsström som skriver en textrad. */
export function textInnehall(text: string, typsnitt = 'F1'): string {
  return `BT /${typsnitt} 12 Tf 72 720 Td ${pdfStrang(text)} Tj ET`;
}

function objektBytes(num: number, kropp: Kropp): Uint8Array {
  if (typeof kropp === 'string') return b(`${num} 0 obj\n${kropp}\nendobj\n`);
  return sammanfoga([
    b(`${num} 0 obj\n<< ${kropp.dict} /Length ${kropp.data.length} >>\nstream\n`),
    kropp.data,
    b('\nendstream\nendobj\n'),
  ]);
}

export interface PdfVal {
  /** Extra nycklar i slutposten, t.ex. `/Encrypt 9 0 R`. */
  readonly slutpost?: string;
  /** Objektnumret för `/Root`. Standard 1. */
  readonly rot?: number;
  /** Läggs till på varje offset i xref-tabellen — en tabell som ljuger. */
  readonly xrefForskjutning?: number;
  /** Skriv ingen xref-tabell alls. */
  readonly utanXref?: boolean;
  /** Skriv ingen slutpost. */
  readonly utanSlutpost?: boolean;
  readonly version?: string;
}

/** En PDF med klassisk korsreferenstabell. Objekten numreras 1..N i den ordning de ges. */
export function byggPdf(objekt: readonly Kropp[], val: PdfVal = {}): Uint8Array {
  const delar: Uint8Array[] = [];
  let langd = 0;
  const skriv = (d: Uint8Array): void => {
    delar.push(d);
    langd += d.length;
  };
  skriv(b(`%PDF-${val.version ?? '1.4'}\n%\xe2\xe3\xcf\xd3\n`));

  const offsets: number[] = [];
  objekt.forEach((kropp, i) => {
    offsets.push(langd);
    skriv(objektBytes(i + 1, kropp));
  });

  const xrefOffset = langd;
  if (val.utanXref !== true) {
    let tabell = `xref\n0 ${objekt.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      const justerad = Math.max(0, off + (val.xrefForskjutning ?? 0));
      tabell += `${String(justerad).padStart(10, '0')} 00000 n \n`;
    }
    skriv(b(tabell));
  }
  if (val.utanSlutpost !== true) {
    skriv(
      b(
        `trailer\n<< /Size ${objekt.length + 1} /Root ${val.rot ?? 1} 0 R ${val.slutpost ?? ''} >>\n` +
          `startxref\n${xrefOffset}\n%%EOF\n`,
      ),
    );
  }
  return sammanfoga(delar);
}

export interface XrefStromVal extends PdfVal {
  /** Objektnummer (1-baserade) vars kroppar flyttas in i en objektström. Måste vara strängar. */
  readonly iObjStrom?: readonly number[];
}

/** En PDF med xref-ström (PDF 1.5) och, om man vill, en objektström. */
export function byggPdfXrefStrom(objekt: readonly Kropp[], val: XrefStromVal = {}): Uint8Array {
  const iStrom = new Set(val.iObjStrom ?? []);
  const objStromNum = objekt.length + 1;
  const xrefNum = objekt.length + 2;

  const delar: Uint8Array[] = [];
  let langd = 0;
  const skriv = (d: Uint8Array): void => {
    delar.push(d);
    langd += d.length;
  };
  skriv(b(`%PDF-${val.version ?? '1.5'}\n%\xe2\xe3\xcf\xd3\n`));

  type Post = { typ: 1; off: number } | { typ: 2; strom: number; index: number };
  const poster = new Map<number, Post>();

  objekt.forEach((kropp, i) => {
    const num = i + 1;
    if (iStrom.has(num)) return;
    poster.set(num, { typ: 1, off: langd });
    skriv(objektBytes(num, kropp));
  });

  if (iStrom.size > 0) {
    const nummer = [...iStrom].sort((x, y) => x - y);
    let huvud = '';
    let kroppar = '';
    nummer.forEach((num, index) => {
      const kropp = objekt[num - 1];
      if (typeof kropp !== 'string') throw new Error('objekt i en objektström måste vara en sträng');
      huvud += `${num} ${kroppar.length} `;
      kroppar += `${kropp} `;
      poster.set(num, { typ: 2, strom: objStromNum, index });
    });
    const data = deflateSync(b(huvud + kroppar));
    poster.set(objStromNum, { typ: 1, off: langd });
    skriv(
      objektBytes(objStromNum, {
        dict: `/Type /ObjStm /N ${nummer.length} /First ${huvud.length} /Filter /FlateDecode`,
        data,
      }),
    );
  }

  const xrefOffset = langd;
  poster.set(xrefNum, { typ: 1, off: xrefOffset });

  // W [1 4 2]: typ i en byte, fält 2 i fyra, fält 3 i två.
  const rader: number[] = [0, 0, 0, 0, 0, 255, 255];
  for (let num = 1; num <= xrefNum; num++) {
    const post = poster.get(num);
    if (post === undefined) {
      rader.push(0, 0, 0, 0, 0, 0, 0);
      continue;
    }
    if (post.typ === 1) {
      const off = post.off + (val.xrefForskjutning ?? 0);
      rader.push(1, (off >>> 24) & 0xff, (off >>> 16) & 0xff, (off >>> 8) & 0xff, off & 0xff, 0, 0);
    } else {
      rader.push(2, 0, 0, 0, post.strom & 0xff, (post.index >>> 8) & 0xff, post.index & 0xff);
    }
  }
  skriv(
    objektBytes(xrefNum, {
      dict:
        `/Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root ${val.rot ?? 1} 0 R ` +
        `/Filter /FlateDecode ${val.slutpost ?? ''}`,
      data: deflateSync(Uint8Array.from(rader)),
    }),
  );
  skriv(b(`startxref\n${xrefOffset}\n%%EOF\n`));
  return sammanfoga(delar);
}

export interface EnkelVal {
  /** Innehållsströmmen för den enda sidan. */
  readonly innehall: string | Uint8Array;
  /** Ordboken för `/F1`. Standard: Helvetica utan angiven kodning. */
  readonly typsnitt?: string;
  /** Extra resurser i sidans `/Resources`, t.ex. `/XObject << /Fm1 6 0 R >>`. */
  readonly resurser?: string;
  /** Objekt 6 och framåt. */
  readonly extra?: readonly Kropp[];
  readonly komprimera?: boolean;
  readonly slutpost?: string;
}

/**
 * En ensidig PDF. Objekt 1 katalog, 2 sidträd, 3 sidan, 4 typsnittet `/F1`, 5 innehållet,
 * 6 och framåt det anroparen lägger till.
 */
export function enkelPdf(val: EnkelVal): Uint8Array {
  const rader = typeof val.innehall === 'string' ? b(val.innehall) : val.innehall;
  const innehall: Kropp = val.komprimera === true
    ? { dict: '/Filter /FlateDecode', data: deflateSync(rader) }
    : { dict: '', data: rader };
  return byggPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${val.resurser ?? ''} >> /Contents 5 0 R >>`,
      val.typsnitt ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      innehall,
      ...(val.extra ?? []),
    ],
    val.slutpost === undefined ? {} : { slutpost: val.slutpost },
  );
}

/** Flera sidor, var och en med sitt innehåll och samma typsnitt. */
export function flerSidorsPdf(innehall: readonly string[], typsnitt?: string): Uint8Array {
  const n = innehall.length;
  const sidStart = 3;
  const innehallStart = sidStart + n;
  const typsnittNum = innehallStart + n;
  const kids = innehall.map((_, i) => `${sidStart + i} 0 R`).join(' ');
  const objekt: Kropp[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
  ];
  for (let i = 0; i < n; i++) {
    objekt.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${typsnittNum} 0 R >> >> /Contents ${innehallStart + i} 0 R >>`,
    );
  }
  for (const rad of innehall) objekt.push({ dict: '', data: b(rad) });
  objekt.push(typsnitt ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return byggPdf(objekt);
}

// ---------------------------------------------------------------------------
// LZW — bara för testerna, så att avkodaren kan provas mot en riktig ström.
// ---------------------------------------------------------------------------

export function lzwKoda(data: Uint8Array): Uint8Array {
  const ut: number[] = [];
  let buffert = 0;
  let bitar = 0;
  const skriv = (kod: number, bredd: number): void => {
    buffert = (buffert << bredd) | kod;
    bitar += bredd;
    while (bitar >= 8) {
      ut.push((buffert >> (bitar - 8)) & 0xff);
      bitar -= 8;
    }
  };

  let ordbok = new Map<string, number>();
  let nasta = 258;
  let bredd = 9;
  const nollstall = (): void => {
    ordbok = new Map<string, number>();
    nasta = 258;
    bredd = 9;
  };

  skriv(256, bredd);
  nollstall();
  let w = '';
  for (const byte of data) {
    const tecken = String.fromCharCode(byte);
    const wb = w + tecken;
    if (wb.length === 1 || ordbok.has(wb)) {
      w = wb;
      continue;
    }
    skriv(w.length === 1 ? w.charCodeAt(0) : (ordbok.get(w) ?? 0), bredd);
    ordbok.set(wb, nasta++);
    // Tidig breddökning (EarlyChange 1): avkodaren byter bredd ett steg före.
    if (nasta + 1 > 1 << bredd && bredd < 12) bredd++;
    if (nasta >= 4095) {
      skriv(256, bredd);
      nollstall();
    }
    w = tecken;
  }
  if (w.length > 0) skriv(w.length === 1 ? w.charCodeAt(0) : (ordbok.get(w) ?? 0), bredd);
  skriv(257, bredd);
  if (bitar > 0) ut.push((buffert << (8 - bitar)) & 0xff);
  return Uint8Array.from(ut);
}

export function asciiHexKoda(data: Uint8Array): Uint8Array {
  let ut = '';
  for (const byte of data) ut += byte.toString(16).padStart(2, '0');
  return b(`${ut}>`);
}

export function ascii85Koda(data: Uint8Array): Uint8Array {
  let ut = '';
  for (let i = 0; i < data.length; i += 4) {
    const grupp = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
    const antal = Math.min(4, data.length - i);
    let v = 0;
    for (const g of grupp) v = v * 256 + g;
    if (v === 0 && antal === 4) {
      ut += 'z';
      continue;
    }
    const tecken: string[] = [];
    for (let k = 0; k < 5; k++) {
      tecken.unshift(String.fromCharCode(33 + (v % 85)));
      v = Math.floor(v / 85);
    }
    ut += tecken.slice(0, antal + 1).join('');
  }
  return b(`${ut}~>`);
}
