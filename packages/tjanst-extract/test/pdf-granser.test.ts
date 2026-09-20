/**
 * Gränserna. Filen kommer från en användare, så varje tak måste hålla även när filen är byggd
 * för att spränga det: för stor fil, för många sidor, en ström som packas upp till ingenting
 * annat än minne, en text som aldrig tar slut och en fil som tar för lång tid att läsa.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { extractPdfText, PdfError } from '../src/pdf.ts';
import type { PdfLimits, PdfErrorReason } from '../src/pdf.ts';
import { b, byggPdf, enkelPdf, flerSidorsPdf, textInnehall } from './pdf-bygg.ts';

const GRANSER: PdfLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 500,
  maxChars: 2_000_000,
  maxMs: 10_000,
};

function forvantaFel(bytes: Uint8Array, granser: Partial<PdfLimits>, skal: PdfErrorReason): void {
  try {
    extractPdfText(bytes, { ...GRANSER, ...granser });
    expect.unreachable(`skulle ha kastat ${skal}`);
  } catch (fel) {
    expect(fel).toBeInstanceOf(PdfError);
    expect((fel as PdfError).reason).toBe(skal);
    expect((fel as PdfError).message.length).toBeGreaterThan(0);
  }
}

describe('maxBytes', () => {
  it('kastar too_large för en fil som är större än taket', () => {
    const pdf = enkelPdf({ innehall: textInnehall('liten fil') });
    forvantaFel(pdf, { maxBytes: pdf.length - 1 }, 'too_large');
  });

  it('släpper igenom en fil som är precis lika stor som taket', () => {
    const pdf = enkelPdf({ innehall: textInnehall('precis lagom') });
    expect(extractPdfText(pdf, { ...GRANSER, maxBytes: pdf.length })?.text).toBe('precis lagom');
  });
});

describe('maxPages', () => {
  it('kastar too_many_pages när sidträdet har fler sidor än taket', () => {
    const sidor = Array.from({ length: 20 }, (_, i) => textInnehall(`Sida ${i}`));
    forvantaFel(flerSidorsPdf(sidor), { maxPages: 10 }, 'too_many_pages');
  });

  it('kastar too_many_pages för ett sidträd med orimligt många barn utan att bygga dem', () => {
    // Samma sidobjekt refererat 5000 gånger: filen är några kilobyte men sidorna är många.
    const kids = Array.from({ length: 5000 }, () => '3 0 R').join(' ');
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids}] /Count 5000 >>`,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '', data: b(textInnehall('mangfaldigad')) },
    ]);
    expect(pdf.length).toBeLessThan(80_000);
    forvantaFel(pdf, { maxPages: 100 }, 'too_many_pages');
  });

  it('läser en fil med precis så många sidor som taket tillåter', () => {
    const sidor = Array.from({ length: 10 }, (_, i) => textInnehall(`S${i}`));
    const resultat = extractPdfText(flerSidorsPdf(sidor), { ...GRANSER, maxPages: 10 });
    expect(resultat?.pages).toBe(10);
  });
});

describe('maxChars', () => {
  it('kapar texten och flaggar truncated', () => {
    const rader = Array.from({ length: 50 }, (_, i) => `0 -14 Td (rad ${i} med text) Tj`).join(' ');
    const pdf = enkelPdf({ innehall: `BT /F1 12 Tf 72 720 Td ${rader} ET` });
    const resultat = extractPdfText(pdf, { ...GRANSER, maxChars: 30 });
    expect(resultat?.truncated).toBe(true);
    expect(resultat?.text.length).toBe(30);
  });

  it('flaggar inte truncated när allt fick plats', () => {
    const pdf = enkelPdf({ innehall: textInnehall('kort') });
    expect(extractPdfText(pdf, { ...GRANSER, maxChars: 1000 })?.truncated).toBe(false);
  });

  it('ger ett avkortat svar, inte null, när ingenting alls fick plats', () => {
    // Skillnaden mot null spelar roll: null betyder inskannad fil, det här betyder för lång text.
    const pdf = enkelPdf({ innehall: textInnehall('nagot') });
    expect(extractPdfText(pdf, { ...GRANSER, maxChars: 0 })).toEqual({
      text: '',
      pages: 0,
      truncated: true,
    });
  });
});

describe('maxMs', () => {
  it('kastar timeout direkt när tiden redan är slut', () => {
    const pdf = enkelPdf({ innehall: textInnehall('hinner inte') });
    forvantaFel(pdf, { maxMs: 0 }, 'timeout');
  });

  it('kastar timeout mitt i ett arbete som tar längre tid än taket', () => {
    // 300 sidor med rejäla innehållsströmmar: att läsa alltihop tar många millisekunder.
    const sida = `BT /F1 12 Tf 72 720 Td ${Array.from({ length: 300 }, (_, i) => `0 -2 Td (rad ${i} med ganska mycket text pa raden) Tj`).join(' ')} ET`;
    const pdf = flerSidorsPdf(Array.from({ length: 300 }, () => sida));
    forvantaFel(pdf, { maxMs: 2, maxPages: 1000 }, 'timeout');
  });

  it('hinner läsa en vanlig fil inom en rimlig tidsgräns', () => {
    const pdf = enkelPdf({ innehall: textInnehall('snabbt nog') });
    expect(extractPdfText(pdf, { ...GRANSER, maxMs: 5000 })?.text).toBe('snabbt nog');
  });
});

describe('utpackning', () => {
  it('kastar too_large för en ström som packas upp till orimlig storlek', () => {
    // 16 MB nollor komprimeras till några kilobyte. Utan tak skulle de landa i minnet.
    const bomb = deflateSync(new Uint8Array(16 * 1024 * 1024));
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter /FlateDecode', data: new Uint8Array(bomb) },
    ]);
    expect(pdf.length).toBeLessThan(200_000);
    forvantaFel(pdf, { maxBytes: 200_000 }, 'too_large');
  });

  it('kastar too_large för en kedja av filter som tillsammans spränger budgeten', () => {
    const bomb = deflateSync(deflateSync(new Uint8Array(16 * 1024 * 1024)));
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter [/FlateDecode /FlateDecode]', data: new Uint8Array(bomb) },
    ]);
    forvantaFel(pdf, { maxBytes: 200_000 }, 'too_large');
  });

  it('hoppar över en ström vars komprimerade data är skräp', () => {
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      { dict: '/Filter /FlateDecode', data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
      { dict: '', data: b(textInnehall('den lasbara sidan')) },
    ]);
    expect(extractPdfText(pdf, GRANSER)?.text).toBe('den lasbara sidan');
  });
});

describe('orimliga ordböcker och strängar', () => {
  it('hoppar över en array som är nästlad orimligt djupt utan att spränga stacken', () => {
    const djup = 5000;
    const innehall = `BT /F1 12 Tf 72 720 Td ${'['.repeat(djup)}${']'.repeat(djup)} TJ (efterat) Tj ET`;
    const pdf = enkelPdf({ innehall });
    expect(extractPdfText(pdf, GRANSER)?.text).toBe('efterat');
  });

  it('läser en ström vars /Length ljuger', () => {
    const rader = b(textInnehall('Length ljuger'));
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      // Ordboken skrivs för hand så att /Length kan sättas till något orimligt.
      `<< /Length 999999 >>\nstream\n${String.fromCharCode(...rader)}\nendstream`,
    ]);
    // Objektet skrivs som en färdig kropp; byggaren lägger inte till något /Length.
    expect(extractPdfText(pdf, GRANSER)?.text).toBe('Length ljuger');
  });

  it('läser en ström vars /Length är en indirekt referens', () => {
    const rader = textInnehall('Indirekt Length');
    const pdf = byggPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length 6 0 R >>\nstream\n${rader}\nendstream`,
      `${rader.length}`,
    ]);
    expect(extractPdfText(pdf, GRANSER)?.text).toBe('Indirekt Length');
  });
});
