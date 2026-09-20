/**
 * Teckenkodning: svensk text ska bli svensk text. Här provas WinAnsiEncoding, MacRomanEncoding,
 * StandardEncoding, /Differences och Identity-H med ToUnicode — och att en teckenkod som inte går
 * att översätta hoppas över i stället för att gissas.
 */
import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../src/pdf.ts';
import type { PdfLimits } from '../src/pdf.ts';
import { b, enkelPdf, pdfStrang } from './pdf-bygg.ts';

const GRANSER: PdfLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 500,
  maxChars: 2_000_000,
  maxMs: 10_000,
};

function text(bytes: Uint8Array): string {
  const resultat = extractPdfText(bytes, GRANSER);
  expect(resultat).not.toBeNull();
  return resultat?.text ?? '';
}

/** En sida med ett typsnitt och en textsträng, skriven som oktala rymningar. */
function medTypsnitt(typsnitt: string, strang: string): Uint8Array {
  return enkelPdf({ innehall: `BT /F1 12 Tf 72 720 Td ${strang} Tj ET`, typsnitt });
}

const WINANSI = '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding >>';
const MACROMAN = '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /MacRomanEncoding >>';
const STANDARD = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>';

describe('WinAnsiEncoding', () => {
  it('läser å, ä och ö rätt', () => {
    // 0xE5 = å, 0xE4 = ä, 0xF6 = ö, 0xC5 = Å, 0xC4 = Ä, 0xD6 = Ö
    expect(text(medTypsnitt(WINANSI, pdfStrang('Får äta öl på ÅÄÖ')))).toBe('Får äta öl på ÅÄÖ');
  });

  it('läser de typografiska tecknen i 0x80–0x9F-fönstret', () => {
    // 0x93/0x94 = citattecken, 0x96 = tankstreck, 0x80 = euro, 0x92 = apostrof
    expect(text(medTypsnitt(WINANSI, '(\\223citat\\224 \\226 \\200 \\222)'))).toBe('“citat” – € ’');
  });

  it('läser hårt mellanslag och mjukt bindestreck som vanliga tecken', () => {
    expect(text(medTypsnitt(WINANSI, '(a\\240b\\255c)'))).toBe('a b-c');
  });
});

describe('MacRomanEncoding', () => {
  it('läser å, ä och ö rätt', () => {
    // MacRoman lägger dem på andra koder än WinAnsi: 0x8A = ä, 0x8C = å, 0x9A = ö
    expect(text(medTypsnitt(MACROMAN, '(\\212\\214\\232)'))).toBe('äåö');
  });

  it('skiljer sig från WinAnsi på samma byte', () => {
    // 0xA5 är bullet i MacRoman men yen i WinAnsi.
    expect(text(medTypsnitt(MACROMAN, '(\\245)'))).toBe('•');
    expect(text(medTypsnitt(WINANSI, '(\\245)'))).toBe('¥');
  });
});

describe('StandardEncoding', () => {
  it('används när typsnittet inte anger någon kodning', () => {
    // 0x27 är quoteright och 0x60 quoteleft i StandardEncoding, inte ASCII-apostrof.
    expect(text(medTypsnitt(STANDARD, "(det\\047s \\140citat\\047)"))).toBe('det’s ‘citat’');
  });

  it('hoppar över teckenkoder som inte finns i kodningen i stället för att gissa', () => {
    // 0xE4 är odefinierad i StandardEncoding. Tecknet faller bort, resten läses.
    expect(text(medTypsnitt(STANDARD, '(f\\344r)'))).toBe('fr');
  });

  it('läser ligaturer och specialtecken ur den höga halvan', () => {
    // 0xAE = fi, 0xAF = fl, 0xFB = germandbls, 0xF9 = oslash
    expect(text(medTypsnitt(STANDARD, '(\\256\\257\\373\\371)'))).toBe('ﬁﬂßø');
  });
});

describe('/Differences', () => {
  it('låter namngivna glyfer styra över basen', () => {
    const typsnitt =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding ' +
      '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /aring /adieresis /odieresis 97 /Aring] >> >>';
    // 65, 66 och 67 får nya glyfer; 97 byts separat, och 68 behåller basens D.
    expect(text(medTypsnitt(typsnitt, '(ABCDa)'))).toBe('åäöDÅ');
  });

  it('förstår flera startkoder i samma Differences-lista', () => {
    const typsnitt =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding ' +
      '<< /Differences [49 /odieresis 65 /aring 200 /adieresis] >> >>';
    expect(text(medTypsnitt(typsnitt, '(1A\\310)'))).toBe('öåä');
  });

  it('förstår uniXXXX-namn', () => {
    const typsnitt =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding ' +
      '<< /Differences [65 /uni00E5 /uni00E4 /uni00F6] >> >>';
    expect(text(medTypsnitt(typsnitt, '(ABC)'))).toBe('åäö');
  });

  it('hoppar över glyfnamn som inte går att översätta', () => {
    const typsnitt =
      '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding ' +
      '<< /Differences [65 /nagotheltokant /aring] >> >>';
    expect(text(medTypsnitt(typsnitt, '(ABC)'))).toBe('åC');
  });
});

// ---------------------------------------------------------------------------
// Identity-H med ToUnicode
// ---------------------------------------------------------------------------

const TO_UNICODE = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CMapName /Anpassad def',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  '2 beginbfchar',
  '<0003> <0020>',
  '<0047> <00F6>',
  'endbfchar',
  '2 beginbfrange',
  '<0024> <0026> <0041>',
  '<0044> <0046> <00E4>',
  'endbfrange',
  'endcmap',
  'CMapName currentdict /CMap defineresource pop',
  'end',
  'end',
].join('\n');

const TYPE0 =
  '<< /Type /Font /Subtype /Type0 /BaseFont /Anpassad /Encoding /Identity-H ' +
  '/DescendantFonts [7 0 R] /ToUnicode 6 0 R >>';

const NEDSTIGANDE =
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Anpassad ' +
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>';

function identityPdf(hexText: string, medToUnicode = true): Uint8Array {
  return enkelPdf({
    innehall: `BT /F1 12 Tf 72 720 Td <${hexText}> Tj ET`,
    typsnitt: medToUnicode
      ? TYPE0
      : '<< /Type /Font /Subtype /Type0 /BaseFont /Anpassad /Encoding /Identity-H /DescendantFonts [7 0 R] >>',
    extra: [{ dict: '', data: b(TO_UNICODE) }, NEDSTIGANDE],
  });
}

describe('Identity-H med ToUnicode', () => {
  it('översätter tvåbyteskoder via bfchar', () => {
    expect(text(identityPdf('00470003 0047'))).toBe('ö ö');
  });

  it('översätter tvåbyteskoder via bfrange', () => {
    // 0024–0026 → A B C, 0044–0046 → ä å æ
    expect(text(identityPdf('002400250026 0003 004400450046'))).toBe('ABC äåæ');
  });

  it('läser två byte per teckenkod, inte en', () => {
    // Samma byte som i ett enkelt typsnitt skulle bli fyra tecken; här blir det två.
    const resultat = extractPdfText(identityPdf('00240044'), GRANSER);
    expect(resultat?.text).toBe('Aä');
  });

  it('ger null när koderna inte går att översätta utan ToUnicode', () => {
    // Hellre ingen text alls än påhittade tecken ur en CID-rymd vi inte kan tolka.
    expect(extractPdfText(identityPdf('002400250026', false), GRANSER)).toBeNull();
  });

  it('låter ToUnicode gälla före kodtabellen även för ett enkelt typsnitt', () => {
    const cmap = [
      'begincmap',
      '1 begincodespacerange',
      '<00> <FF>',
      'endcodespacerange',
      '1 beginbfchar',
      '<41> <00E5>',
      'endbfchar',
      'endcmap',
    ].join('\n');
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (AB) Tj ET',
      typsnitt:
        '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
      extra: [{ dict: '', data: b(cmap) }],
    });
    expect(text(pdf)).toBe('åB');
  });

  it('klarar en ToUnicode-post som ger flera tecken (ligatur)', () => {
    const cmap = [
      'begincmap',
      '1 beginbfchar',
      '<41> <00660069>',
      'endbfchar',
      'endcmap',
    ].join('\n');
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (AB) Tj ET',
      typsnitt:
        '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
      extra: [{ dict: '', data: b(cmap) }],
    });
    expect(text(pdf)).toBe('fiB');
  });

  it('klarar en bfrange med en lista av mål', () => {
    const cmap = [
      'begincmap',
      '1 beginbfrange',
      '<41> <43> [<00E5> <00E4> <00F6>]',
      'endbfrange',
      'endcmap',
    ].join('\n');
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (ABC) Tj ET',
      typsnitt: '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /ToUnicode 6 0 R >>',
      extra: [{ dict: '', data: b(cmap) }],
    });
    expect(text(pdf)).toBe('åäö');
  });
});

describe('sammansatta typsnitt med inbäddad CMap', () => {
  const ENBYTES_CMAP = [
    'begincmap',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 begincidrange',
    '<41> <5A> 1',
    'endcidrange',
    'endcmap',
  ].join('\n');

  const ENBYTES_TOUNICODE = [
    'begincmap',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<41> <43> [<00E5> <00E4> <00F6>]',
    'endbfrange',
    'endcmap',
  ].join('\n');

  const NEDSTIGANDE_CID = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /X >>';

  it('läser en byte per teckenkod när typsnittets egen CMap säger så', () => {
    // Ett Type0-typsnitt är inte alltid tvåbyteskodat. Läser man två byte i taget här blir hela
    // texten obegriplig — precis vad som hände med ett riktigt EU-dokument innan kodrymderna
    // började användas.
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (ABC) Tj ET',
      typsnitt:
        '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding 8 0 R /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>',
      extra: [
        { dict: '', data: b(ENBYTES_TOUNICODE) },
        NEDSTIGANDE_CID,
        {
          dict: '/Type /CMap /CMapName /Egen /CIDSystemInfo << /Registry (X) /Ordering (Y) /Supplement 0 >>',
          data: b(ENBYTES_CMAP),
        },
      ],
    });
    expect(text(pdf)).toBe('åäö');
  });

  it('tar kodrymden ur ToUnicode när typsnittet inte har någon egen CMap', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td (ABC) Tj ET',
      typsnitt:
        '<< /Type /Font /Subtype /Type0 /BaseFont /X /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>',
      extra: [{ dict: '', data: b(ENBYTES_TOUNICODE) }, NEDSTIGANDE_CID],
    });
    expect(text(pdf)).toBe('åäö');
  });

  it('håller fast vid två byte när kodrymden är tvåbytes', () => {
    expect(text(identityPdf('002400250026'))).toBe('ABC');
  });
});
