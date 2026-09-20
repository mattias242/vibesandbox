/**
 * Fuzz: giltiga PDF:er klipps av och får bitar vända, och för varje variant krävs att
 * `extractPdfText` antingen svarar eller kastar `PdfError` — aldrig hänger, kraschar processen
 * eller kastar något annat. Fröet är fast, så ett fel går alltid att återskapa.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { extractPdfText, PdfError } from '../src/pdf.ts';
import type { PdfLimits } from '../src/pdf.ts';
import {
  b,
  byggPdf,
  byggPdfXrefStrom,
  enkelPdf,
  flerSidorsPdf,
  pdfStrang,
  textInnehall,
} from './pdf-bygg.ts';

const GRANSER: PdfLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxPages: 200,
  maxChars: 200_000,
  // Kort tidsgräns: varje variant ska antingen bli klar fort eller avbrytas på tiden.
  maxMs: 400,
};

/** Liten deterministisk slumpgenerator (mulberry32) — samma frö ger samma varianter. */
function slump(fro: number): () => number {
  let a = fro >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kallor(): { namn: string; bytes: Uint8Array }[] {
  const toUnicode = [
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<0041> <0043> <00E5>',
    'endbfrange',
    'endcmap',
  ].join('\n');
  return [
    { namn: 'enkel', bytes: enkelPdf({ innehall: textInnehall('Hej varlden') }) },
    { namn: 'komprimerad', bytes: enkelPdf({ innehall: textInnehall('Komprimerat'), komprimera: true }) },
    {
      namn: 'winansi',
      bytes: enkelPdf({
        innehall: `BT /F1 12 Tf 72 720 Td ${pdfStrang('Får äta öl på ÅÄÖ')} Tj ET`,
        typsnitt: '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding >>',
      }),
    },
    {
      namn: 'identity-h',
      bytes: enkelPdf({
        innehall: 'BT /F1 12 Tf 72 720 Td <004100420043> Tj ET',
        typsnitt:
          '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>',
        extra: [{ dict: '/Filter /FlateDecode', data: new Uint8Array(deflateSync(b(toUnicode))) }, '<< /Type /Font /Subtype /CIDFontType2 >>'],
      }),
    },
    {
      namn: 'flera sidor',
      bytes: flerSidorsPdf([textInnehall('ett'), textInnehall('tva'), textInnehall('tre')]),
    },
    {
      namn: 'xref-strom',
      bytes: byggPdfXrefStrom(
        [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          { dict: '', data: b(textInnehall('Modern')) },
        ],
        { iObjStrom: [1, 2, 4] },
      ),
    },
    {
      namn: 'bild och formular',
      bytes: enkelPdf({
        innehall: 'BT /F1 12 Tf 72 720 Td (text) Tj ET /Fm1 Do q 1 0 0 1 0 0 cm /Im1 Do Q',
        resurser: '/XObject << /Fm1 6 0 R /Im1 7 0 R >>',
        extra: [
          {
            dict: '/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F1 4 0 R >> >>',
            data: b('BT /F1 12 Tf 1 1 Td (i formularet) Tj ET'),
          },
          {
            dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode',
            data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
          },
        ],
      }),
    },
  ];
}

/** Ett anrop får bara sluta på två sätt: ett resultat, eller ett PdfError. */
function kravUppforande(bytes: Uint8Array, beskrivning: string): void {
  let resultat: unknown;
  try {
    resultat = extractPdfText(bytes, GRANSER);
  } catch (fel) {
    if (fel instanceof PdfError) {
      expect(typeof fel.reason).toBe('string');
      expect(fel.message.length).toBeGreaterThan(0);
      return;
    }
    throw new Error(`${beskrivning}: kastade ${String(fel)} i stället för PdfError`);
  }
  if (resultat === null) return;
  const r = resultat as { text: string; pages: number; truncated: boolean };
  expect(typeof r.text, beskrivning).toBe('string');
  expect(Number.isInteger(r.pages), beskrivning).toBe(true);
  expect(r.pages, beskrivning).toBeGreaterThanOrEqual(0);
  expect(typeof r.truncated, beskrivning).toBe('boolean');
  expect(r.text.length, beskrivning).toBeLessThanOrEqual(GRANSER.maxChars);
}

describe('fuzz: avklippta filer', () => {
  it('klarar varje prefix av varje giltig fil', () => {
    for (const kalla of kallor()) {
      const rnd = slump(20260920);
      // Alla korta prefix plus ett urval längre — en avklippt fil är det vanligaste felet.
      const langder = new Set<number>([0, 1, 8, 9, 20, 100]);
      for (let i = 0; i < 60; i++) langder.add(Math.floor(rnd() * kalla.bytes.length));
      langder.add(kalla.bytes.length - 1);
      for (const langd of langder) {
        if (langd < 0 || langd > kalla.bytes.length) continue;
        kravUppforande(kalla.bytes.subarray(0, langd), `${kalla.namn} klippt till ${langd}`);
      }
    }
  });

  it('klarar filer där slutet saknas men huvudet finns kvar', () => {
    for (const kalla of kallor()) {
      for (const del of [0.25, 0.5, 0.75, 0.9, 0.99]) {
        const langd = Math.floor(kalla.bytes.length * del);
        kravUppforande(kalla.bytes.subarray(0, langd), `${kalla.namn} vid ${del}`);
      }
    }
  });
});

describe('fuzz: bitflippade filer', () => {
  it('klarar enstaka vända bitar var som helst i filen', () => {
    for (const kalla of kallor()) {
      const rnd = slump(0x5eed);
      for (let varv = 0; varv < 120; varv++) {
        const kopia = Uint8Array.from(kalla.bytes);
        const plats = Math.floor(rnd() * kopia.length);
        const bit = 1 << Math.floor(rnd() * 8);
        kopia[plats] = (kopia[plats] ?? 0) ^ bit;
        kravUppforande(kopia, `${kalla.namn} bit ${bit} vid ${plats}`);
      }
    }
  });

  it('klarar många vända bitar samtidigt', () => {
    for (const kalla of kallor()) {
      const rnd = slump(0xc0ffee);
      for (let varv = 0; varv < 40; varv++) {
        const kopia = Uint8Array.from(kalla.bytes);
        const antal = 1 + Math.floor(rnd() * 40);
        for (let i = 0; i < antal; i++) {
          const plats = Math.floor(rnd() * kopia.length);
          kopia[plats] = (kopia[plats] ?? 0) ^ (1 << Math.floor(rnd() * 8));
        }
        kravUppforande(kopia, `${kalla.namn} ${antal} vända bitar, varv ${varv}`);
      }
    }
  });

  it('klarar byte som byts ut mot tecken med särskild betydelse', () => {
    const elaka = [0x00, 0x25, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x5c, 0x52, 0x20];
    for (const kalla of kallor()) {
      const rnd = slump(0xbadf00d);
      for (let varv = 0; varv < 80; varv++) {
        const kopia = Uint8Array.from(kalla.bytes);
        const antal = 1 + Math.floor(rnd() * 20);
        for (let i = 0; i < antal; i++) {
          const plats = Math.floor(rnd() * kopia.length);
          kopia[plats] = elaka[Math.floor(rnd() * elaka.length)] ?? 0x20;
        }
        kravUppforande(kopia, `${kalla.namn} elaka byte, varv ${varv}`);
      }
    }
  });
});

describe('fuzz: skräp runt en giltig fil', () => {
  it('klarar skräp före, efter och i stället för huvudet', () => {
    const rnd = slump(4711);
    for (const kalla of kallor()) {
      const skrap = new Uint8Array(500);
      for (let i = 0; i < skrap.length; i++) skrap[i] = Math.floor(rnd() * 256);
      const fore = new Uint8Array(skrap.length + kalla.bytes.length);
      fore.set(skrap, 0);
      fore.set(kalla.bytes, skrap.length);
      kravUppforande(fore, `${kalla.namn} med skräp före`);

      const efter = new Uint8Array(kalla.bytes.length + skrap.length);
      efter.set(kalla.bytes, 0);
      efter.set(skrap, kalla.bytes.length);
      kravUppforande(efter, `${kalla.namn} med skräp efter`);
    }
  });

  it('klarar rena slumpbyte som börjar med ett PDF-huvud', () => {
    const rnd = slump(1234567);
    for (let varv = 0; varv < 50; varv++) {
      const langd = 100 + Math.floor(rnd() * 4000);
      const bytes = new Uint8Array(langd);
      for (let i = 0; i < langd; i++) bytes[i] = Math.floor(rnd() * 256);
      bytes.set(b('%PDF-1.4\n'), 0);
      kravUppforande(bytes, `slumpfil ${varv}`);
    }
  });

  it('klarar en fil som bara består av objektnyckelord', () => {
    const delar: string[] = ['%PDF-1.4\n'];
    for (let i = 1; i < 200; i++) delar.push(`${i} 0 obj\n${i - 1} 0 R\nendobj\n`);
    delar.push('trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
    kravUppforande(b(delar.join('')), 'kedja av referenser');
  });

  it('klarar en fil där alla objekt pekar på varandra i en ring', () => {
    const objekt: string[] = [];
    for (let i = 1; i <= 50; i++) objekt.push(`<< /Type /Pages /Kids [${(i % 50) + 1} 0 R] /Count 1 >>`);
    kravUppforande(byggPdf(objekt, { rot: 1 }), 'ring av sidträdsnoder');
  });
});
