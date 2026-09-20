/**
 * Textlagret ur en PDF: strukturen. Teckenkodningen provas i `pdf-kodning.test.ts`,
 * gränserna i `pdf-granser.test.ts` och fientlig indata i `pdf-fuzz.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { extractPdfText, PdfError } from '../src/pdf.ts';
import type { PdfLimits } from '../src/pdf.ts';
import {
  ascii85Koda,
  asciiHexKoda,
  b,
  byggPdf,
  byggPdfXrefStrom,
  enkelPdf,
  flerSidorsPdf,
  lzwKoda,
  pdfStrang,
  sammanfoga,
  textInnehall,
} from './pdf-bygg.ts';

export const GRANSER: PdfLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 500,
  maxChars: 2_000_000,
  maxMs: 10_000,
};

function text(bytes: Uint8Array, granser: Partial<PdfLimits> = {}): string {
  const resultat = extractPdfText(bytes, { ...GRANSER, ...granser });
  expect(resultat).not.toBeNull();
  return resultat?.text ?? '';
}

describe('extractPdfText: enkel text', () => {
  it('läser en rad text ur en ensidig PDF', () => {
    const pdf = enkelPdf({ innehall: textInnehall('Hej varlden') });
    const resultat = extractPdfText(pdf, GRANSER);
    expect(resultat).toEqual({ text: 'Hej varlden', pages: 1, truncated: false });
  });

  it('läser text även när innehållsströmmen är komprimerad', () => {
    const pdf = enkelPdf({ innehall: textInnehall('Komprimerat'), komprimera: true });
    expect(text(pdf)).toBe('Komprimerat');
  });

  it('läser text ur en ström med ASCIIHexDecode', () => {
    const rader = b(textInnehall('Hexad text'));
    const medHex = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter /ASCIIHexDecode', data: asciiHexKoda(rader) },
    ]);
    expect(text(medHex)).toBe('Hexad text');
  });

  it('läser text ur en ström med ASCII85Decode ovanpå FlateDecode', () => {
    const rader = deflateSync(b(textInnehall('Dubbelt filtrerat')));
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter [/ASCII85Decode /FlateDecode]', data: ascii85Koda(new Uint8Array(rader)) },
    ]);
    expect(text(pdf)).toBe('Dubbelt filtrerat');
  });

  it('läser text ur en LZW-komprimerad ström', () => {
    const rader = b(textInnehall('LZW fungerar ocksa'));
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter /LZWDecode', data: lzwKoda(rader) },
    ]);
    expect(text(pdf)).toBe('LZW fungerar ocksa');
  });

  it('läser flera innehållsströmmar på samma sida som en enda text', () => {
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R 6 0 R] >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b('BT /F1 12 Tf 72 720 Td (Forsta) Tj ET') },
      { dict: '', data: b('BT /F1 12 Tf 72 700 Td (Andra) Tj ET') },
    ]);
    expect(text(pdf)).toBe('Forsta\nAndra');
  });
});

describe('extractPdfText: sidor', () => {
  it('tar sidorna i ordning med sidbrytning emellan', () => {
    const pdf = flerSidorsPdf([
      textInnehall('Sida ett'),
      textInnehall('Sida tva'),
      textInnehall('Sida tre'),
    ]);
    const resultat = extractPdfText(pdf, GRANSER);
    expect(resultat?.text).toBe('Sida ett\n\nSida tva\n\nSida tre');
    expect(resultat?.pages).toBe(3);
  });

  it('räknar bara sidor som bidrog med text', () => {
    const pdf = flerSidorsPdf([textInnehall('Bara har'), 'q 1 0 0 1 0 0 cm Q']);
    const resultat = extractPdfText(pdf, GRANSER);
    expect(resultat?.text).toBe('Bara har');
    expect(resultat?.pages).toBe(1);
  });

  it('följer ett nästlat sidträd och ärver resurser från föräldern', () => {
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 3 0 R /Contents 6 0 R >>',
      '<< /Type /Page /Parent 3 0 R /Contents 8 0 R >>',
      { dict: '', data: b(textInnehall('Barn ett')) },
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('Barn tva')) },
    ]);
    expect(text(pdf)).toBe('Barn ett\n\nBarn tva');
  });
});

describe('extractPdfText: xref-strömmar och objektströmmar', () => {
  it('läser en PDF 1.5 med xref-ström', () => {
    const pdf = byggPdfXrefStrom([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('Modern PDF')) },
    ]);
    expect(text(pdf)).toBe('Modern PDF');
  });

  it('läser objekt som ligger i en komprimerad objektström', () => {
    const pdf = byggPdfXrefStrom(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        { dict: '', data: b(textInnehall('Ur objektstrommen')) },
      ],
      { iObjStrom: [1, 2, 3, 4] },
    );
    expect(text(pdf)).toBe('Ur objektstrommen');
  });
});

describe('extractPdfText: mellanrum och radbrytning', () => {
  it('gör en stor TJ-justering till mellanslag men lämnar en liten i fred', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td [(Ett) -400 (tva)] TJ 0 -14 Td [(Tre) -20 (fyra)] TJ ET',
    });
    expect(text(pdf)).toBe('Ett tva\nTrefyra');
  });

  it('skriver ihop två Tj utan förflyttning emellan', () => {
    const pdf = enkelPdf({ innehall: 'BT /F1 12 Tf 72 720 Td (Hej) Tj (san) Tj ET' });
    expect(text(pdf)).toBe('Hejsan');
  });

  it('bryter rad när Td flyttar nedåt', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (rad ett) Tj 0 -14 Td (rad tva) Tj ET',
    });
    expect(text(pdf)).toBe('rad ett\nrad tva');
  });

  it('bryter rad vid TD och T* med ledning', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (ett) Tj 0 -14 TD (tva) Tj T* (tre) Tj ET',
    });
    expect(text(pdf)).toBe('ett\ntva\ntre');
  });

  it('bryter rad när Tm flyttar nedåt men ger mellanslag i sidled', () => {
    const pdf = enkelPdf({
      innehall:
        'BT /F1 12 Tf 1 0 0 1 72 720 Tm (vanster) Tj 1 0 0 1 300 720 Tm (hoger) Tj ' +
        '1 0 0 1 72 700 Tm (nasta rad) Tj ET',
    });
    expect(text(pdf)).toBe('vanster hoger\nnasta rad');
  });

  it("hanterar ' och \" som radbyte plus text", () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 14 TL 72 720 Td (ett) Tj (tva) \' 1 2 (tre) " ET',
    });
    expect(text(pdf)).toBe('ett\ntva\ntre');
  });
});

describe('extractPdfText: formulär-XObject och inbäddade bilder', () => {
  it('läser text inne i ett formulär-XObject', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (Pa sidan) Tj ET /Fm1 Do',
      resurser: '/XObject << /Fm1 6 0 R >>',
      extra: [
        {
          dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >>',
          data: b('BT /F1 12 Tf 10 10 Td (I formularet) Tj ET'),
        },
      ],
    });
    expect(text(pdf)).toBe('Pa sidan\nI formularet');
  });

  it('hoppar över en inbäddad bild utan att tappa texten efter den', () => {
    const innehall = sammanfoga([
      b('BT /F1 12 Tf 72 720 Td (fore) Tj ET\nq BI /W 2 /H 2 /BPC 8 /CS /G ID '),
      Uint8Array.from([0x00, 0xff, 0x45, 0x49, 0x00]),
      b(' EI Q\nBT /F1 12 Tf 72 700 Td (efter) Tj ET'),
    ]);
    expect(text(enkelPdf({ innehall }))).toBe('fore\nefter');
  });

  it('ger null för en inskannad sida som bara är en bild', () => {
    const pdf = enkelPdf({
      innehall: 'q 612 0 0 792 0 0 cm /Im1 Do Q',
      resurser: '/XObject << /Im1 6 0 R >>',
      extra: [
        {
          dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode',
          data: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]),
        },
      ],
    });
    expect(extractPdfText(pdf, GRANSER)).toBeNull();
  });
});

describe('extractPdfText: trasiga filer', () => {
  it('kastar encrypted när slutposten har /Encrypt', () => {
    const pdf = enkelPdf({ innehall: textInnehall('hemligt'), slutpost: '/Encrypt 6 0 R' });
    expect(() => extractPdfText(pdf, GRANSER)).toThrow(PdfError);
    try {
      extractPdfText(pdf, GRANSER);
    } catch (fel) {
      expect((fel as PdfError).reason).toBe('encrypted');
    }
  });

  it('läser filen ändå när xref-tabellen pekar fel', () => {
    // Varje offset ligger sju byte fel: tabellen är oanvändbar och skanningen får ta över.
    expect(text(enkelPdfMedForskjutenXref())).toBe('Trots trasig xref');
  });

  it('läser filen ändå när det inte finns någon xref alls', () => {
    const pdf = byggPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        { dict: '', data: b(textInnehall('Utan xref')) },
      ],
      { utanXref: true },
    );
    expect(text(pdf)).toBe('Utan xref');
  });

  it('hittar katalogen även utan slutpost', () => {
    const pdf = byggPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        { dict: '', data: b(textInnehall('Ingen slutpost')) },
      ],
      { utanXref: true, utanSlutpost: true },
    );
    expect(text(pdf)).toBe('Ingen slutpost');
  });

  it('kastar invalid för noll byte', () => {
    expect(() => extractPdfText(new Uint8Array(0), GRANSER)).toThrow(PdfError);
  });

  it('kastar invalid för något som inte är en PDF', () => {
    const skrap = b('Det har ar inte en PDF, bara vanlig text.');
    try {
      extractPdfText(skrap, GRANSER);
      expect.unreachable('skulle ha kastat');
    } catch (fel) {
      expect(fel).toBeInstanceOf(PdfError);
      expect((fel as PdfError).reason).toBe('invalid');
    }
  });

  it('ger null när filen är en PDF utan innehåll att läsa', () => {
    const pdf = byggPdf(['<< /Type /Catalog >>']);
    expect(extractPdfText(pdf, GRANSER)).toBeNull();
  });

  it('hänger sig inte på cirkulära objektreferenser i /Contents', () => {
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>',
      '6 0 R',
      '5 0 R',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('Den hela sidan')) },
    ]);
    expect(text(pdf)).toBe('Den hela sidan');
  });

  it('hänger sig inte på ett sidträd som pekar på sig självt', () => {
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('Trots cirkeln')) },
    ]);
    expect(text(pdf)).toBe('Trots cirkeln');
  });

  it('hänger sig inte på ett formulär-XObject som ritar sig självt', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (start) Tj ET /Fm1 Do',
      resurser: '/XObject << /Fm1 6 0 R >>',
      extra: [
        {
          dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >>',
          data: b('BT /F1 12 Tf 10 10 Td (inuti) Tj ET /Fm1 Do'),
        },
      ],
    });
    expect(text(pdf)).toBe('start\ninuti');
  });
});

function enkelPdfMedForskjutenXref(): Uint8Array {
  return byggPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('Trots trasig xref')) },
    ],
    { xrefForskjutning: 7 },
  );
}

describe('extractPdfText: strängar och namn', () => {
  it('förstår rymningar i litteralsträngar', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (a\\(b\\)c \\\\ d\\101e) Tj ET',
    });
    expect(text(pdf)).toBe('a(b)c \\ dAe');
  });

  it('läser hexsträngar', () => {
    const pdf = enkelPdf({ innehall: 'BT /F1 12 Tf 72 720 Td <48656A> Tj ET' });
    expect(text(pdf)).toBe('Hej');
  });

  it('förstår namn med rymningar', () => {
    const pdf = enkelPdf({
      innehall: `BT /F#31 12 Tf 72 720 Td ${pdfStrang('Namnrymning')} Tj ET`,
    });
    expect(text(pdf)).toBe('Namnrymning');
  });
});
