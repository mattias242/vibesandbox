/**
 * Mellanrum mätta med glyfbredder.
 *
 * En PDF säger inte var orden slutar — den säger var varje glyf ska stå. Många verktyg placerar
 * dessutom varje enskild bokstav med sitt eget `Td` eller `Tm`. Ett mellanslag får därför bara
 * skrivas när nästa textposition ligger *längre fram* än där pennan redan står efter föregående
 * glyf. Här provas att bredderna verkligen läses ur typsnittet: `/Widths` för enkla typsnitt,
 * `/W` och `/DW` för sammansatta, och en uppskattning när filen inte anger några alls.
 */
import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../src/pdf.ts';
import type { PdfLimits } from '../src/pdf.ts';
import { b, enkelPdf } from './pdf-bygg.ts';

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

/**
 * Ett enkelt typsnitt där varje tecken i synlig ASCII är exakt en halv em brett. Med
 * teckenstorleken 12 blir varje glyf 6 enheter bred, vilket gör positionerna i testerna
 * lätta att räkna ut för hand.
 */
const HALV_EM =
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ' +
  `/FirstChar 32 /LastChar 126 /Widths [${Array.from({ length: 95 }, () => '500').join(' ')}] >>`;

/** Samma typsnitt, men utan breddtabell: då måste modulen uppskatta bredderna. */
const UTAN_BREDDER = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

describe('glyfvis placering med Tm', () => {
  it('sätter ihop orden igen när varje bokstav har ett eget Tm', () => {
    // H e j på 72, 78, 84 — precis en glyfbredd isär, alltså inget mellanrum.
    // Sedan ett hopp på 12 (två glyfbredder) före h o p p: där finns ett riktigt ordmellanrum.
    const rader = [
      '1 0 0 1 72 720 Tm (H) Tj',
      '1 0 0 1 78 720 Tm (e) Tj',
      '1 0 0 1 84 720 Tm (j) Tj',
      '1 0 0 1 96 720 Tm (h) Tj',
      '1 0 0 1 102 720 Tm (o) Tj',
      '1 0 0 1 108 720 Tm (p) Tj',
      '1 0 0 1 114 720 Tm (p) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('Hej hopp');
  });

  it('ger inget mellanslag av kerning som drar glyferna närmare varandra', () => {
    // Positionerna ligger en halv enhet före pennan: en normal kerningjustering.
    const rader = [
      '1 0 0 1 72 720 Tm (V) Tj',
      '1 0 0 1 77.5 720 Tm (a) Tj',
      '1 0 0 1 83.2 720 Tm (r) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('Var');
  });
});

describe('glyfvis placering med Td', () => {
  it('sätter ihop orden igen när varje bokstav flyttas fram med Td', () => {
    // Td är relativt: 6 enheter är en glyfbredd, 12 enheter är en glyfbredd plus ett mellanrum.
    const rader = [
      '72 720 Td (H) Tj',
      '6 0 Td (e) Tj',
      '6 0 Td (j) Tj',
      '12 0 Td (h) Tj',
      '6 0 Td (o) Tj',
      '6 0 Td (p) Tj',
      '6 0 Td (p) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('Hej hopp');
  });

  it('bryter fortfarande rad när Td flyttar nedåt', () => {
    const rader = ['72 720 Td (H) Tj', '6 0 Td (e) Tj', '-6 -14 Td (j) Tj'].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('He\nj');
  });
});

describe('TJ-justeringar', () => {
  it('skiljer kerning från ett riktigt ordmellanrum', () => {
    // -40 tusendelar är kerning (0,04 em), -400 är ett ordmellanrum (0,4 em).
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td [(Hej) -40 (san) -400 (du)] TJ ET',
      typsnitt: HALV_EM,
    });
    expect(text(pdf)).toBe('Hejsan du');
  });

  it('mäter justeringen mot em och inte mot ett fast tal', () => {
    // Samma justeringar i två teckenstorlekar: 0,15 em är kerning och 0,3 em är ordmellanrum,
    // oavsett om texten är satt i 12 eller 24 punkter.
    const rader = '72 720 Td [(ab) -150 (cd)] TJ 0 -30 Td [(ef) -300 (gh)] TJ';
    const litet = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: HALV_EM });
    const stort = enkelPdf({ innehall: `BT /F1 24 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(litet)).toBe('abcd\nef gh');
    expect(text(stort)).toBe('abcd\nef gh');
  });

  it('tar de hoppressade mellanslag en sättare skriver vid rak marginal', () => {
    // −200 och −250 är vad TeX skriver för ett mellanslag när raden pressas ihop; −100 är
    // kerning även i de grövsta typsnitten. Alla tre finns i riktiga filer.
    const rader = '72 720 Td [(ett) -200 (tva) -250 (tre) -100 (fyra)] TJ';
    const pdf = enkelPdf({ innehall: `BT /F1 11 Tf ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('ett tva trefyra');
  });

  it('låter en positiv justering dra ihop texten utan mellanslag', () => {
    const pdf = enkelPdf({
      innehall: 'BT /F1 12 Tf 72 720 Td [(ab) 300 (cd)] TJ ET',
      typsnitt: HALV_EM,
    });
    expect(text(pdf)).toBe('abcd');
  });
});

describe('typsnitt utan breddtabell', () => {
  it('uppskattar bredderna och får ändå orden hela', () => {
    // Uppskattningen: versal ≈ 0,68 em, gemen ≈ 0,54 em, smal gemen ≈ 0,30 em. Vid 12 punkter
    // står pennan efter "Hej" strax över 90, så hoppet till 120 är ett ordmellanrum.
    const rader = [
      '1 0 0 1 72 720 Tm (H) Tj',
      '1 0 0 1 80 720 Tm (e) Tj',
      '1 0 0 1 87 720 Tm (j) Tj',
      '1 0 0 1 120 720 Tm (du) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: UTAN_BREDDER });
    expect(text(pdf)).toBe('Hej du');
  });
});

describe('textrummets egna inställningar', () => {
  it('räknar med teckenavståndet Tc', () => {
    // Tc lägger 4 enheter efter varje glyf: H e j hamnar då på 72, 82, 92 utan mellanrum.
    const rader = [
      '1 0 0 1 72 720 Tm (H) Tj',
      '1 0 0 1 82 720 Tm (e) Tj',
      '1 0 0 1 92 720 Tm (j) Tj',
      '1 0 0 1 112 720 Tm (du) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf 4 Tc ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('Hej du');
  });

  it('räknar med ordavståndet Tw för kod 32', () => {
    // Tw lägger 10 enheter efter mellanslaget: (a b) tar 6 + 6 + 10 + 6 = 28 enheter.
    const rader = ['1 0 0 1 72 720 Tm (a b) Tj', '1 0 0 1 94 720 Tm (c) Tj'].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf 10 Tw ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('a bc');
  });

  it('räknar med den vågräta skalningen Tz', () => {
    // 50 % skalning halverar både glyfbredden och em: glyferna står 3 enheter isär, och hoppet
    // på 2 enheter före "du" är då ett ordmellanrum — i oskalad text vore det ett steg bakåt.
    const rader = [
      '1 0 0 1 72 720 Tm (H) Tj',
      '1 0 0 1 75 720 Tm (e) Tj',
      '1 0 0 1 78 720 Tm (j) Tj',
      '1 0 0 1 83 720 Tm (du) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf 50 Tz ${rader} ET`, typsnitt: HALV_EM });
    expect(text(pdf)).toBe('Hej du');
  });
});

describe('Type3-typsnitt', () => {
  /**
   * Ett Type3-typsnitt mäter sina bredder i sitt eget glyfrum, och `/FontMatrix` säger hur stort
   * det rummet är. Här är en enhet 1/100 em, så bredden 50 är en halv em precis som i `HALV_EM`.
   * Verktyg som Google Docs exporterar just sådana här typsnitt.
   */
  const TYPE3 =
    '<< /Type /Font /Subtype /Type3 /FontMatrix [0.01 0 0 -0.01 0 0] ' +
    '/FontBBox [0 0 100 100] /Encoding /WinAnsiEncoding ' +
    `/FirstChar 32 /LastChar 126 /Widths [${Array.from({ length: 95 }, () => '50').join(' ')}] >>`;

  it('läser bredderna genom /FontMatrix i stället för genom tusendelar', () => {
    const rader = [
      '1 0 0 1 72 720 Tm (H) Tj',
      '1 0 0 1 78 720 Tm (e) Tj',
      '1 0 0 1 84 720 Tm (j) Tj',
      '1 0 0 1 96 720 Tm (h) Tj',
    ].join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf ${rader} ET`, typsnitt: TYPE3 });
    expect(text(pdf)).toBe('Hej h');
  });
});

// ---------------------------------------------------------------------------
// Sammansatta typsnitt: /W i sina båda former, och /DW när koden saknas i /W
// ---------------------------------------------------------------------------

const TO_UNICODE = [
  'begincmap',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  '1 beginbfrange',
  '<0001> <0004> <0041>',
  'endbfrange',
  'endcmap',
].join('\n');

/**
 * `/W [1 [1000] 2 3 250]`: kod 1 får sin bredd ur listformen, koderna 2–3 ur intervallformen,
 * och kod 4 saknas helt och faller tillbaka på `/DW 200`.
 */
const NEDSTIGANDE =
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Anpassad ' +
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
  '/DW 200 /W [1 [1000] 2 3 250] >>';

const TYPE0 =
  '<< /Type /Font /Subtype /Type0 /BaseFont /Anpassad /Encoding /Identity-H ' +
  '/DescendantFonts [7 0 R] /ToUnicode 6 0 R >>';

function type0Pdf(innehall: string): Uint8Array {
  return enkelPdf({
    innehall,
    typsnitt: TYPE0,
    extra: [{ dict: '', data: b(TO_UNICODE) }, NEDSTIGANDE],
  });
}

describe('sammansatt typsnitt med /W och /DW', () => {
  it('följer pennan genom alla tre breddformerna', () => {
    // Vid 12 punkter: kod 1 = 12 enheter, koderna 2 och 3 = 3 enheter, kod 4 = 2,4 enheter.
    const rader = [
      '1 0 0 1 72 720 Tm <0001> Tj', // A, pennan hamnar på 84
      '1 0 0 1 84 720 Tm <0002> Tj', // B, pennan hamnar på 87
      '1 0 0 1 87 720 Tm <0003> Tj', // C, pennan hamnar på 90
      '1 0 0 1 90 720 Tm <0004> Tj', // D, pennan hamnar på 92,4
      '1 0 0 1 92.4 720 Tm <0001> Tj', // A, pennan hamnar på 104,4
      '1 0 0 1 110 720 Tm <0002> Tj', // hopp på 5,6 — ett ordmellanrum
    ].join(' ');
    expect(text(type0Pdf(`BT /F1 12 Tf ${rader} ET`))).toBe('ABCDA B');
  });
});
