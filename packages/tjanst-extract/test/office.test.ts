/**
 * Texten ur Office-dokumenten: styckeindelningen bevaras, formateringen slängs. Fientliga fall:
 * trasig XML, ett kalkylblad utan delade strängar, ett dokument utan den fil texten bor i.
 */
import { describe, expect, it } from 'vitest';
import { OfficeError, extractDocx, extractPptx, extractXlsx } from '../src/office.ts';
import { openZip } from '../src/zip.ts';
import { byggZip, docx, pptx, xlsx } from './exempel.ts';

const GRANSER = { maxEntries: 200, maxUnpackedBytes: 8 * 1024 * 1024, maxExpansion: 50 } as const;

function arkiv(bytes: Uint8Array) {
  return openZip(bytes, GRANSER);
}

const RUM = { maxChars: 200_000, deadline: Number.MAX_SAFE_INTEGER } as const;

describe('extractDocx', () => {
  it('ger ett stycke per rad', () => {
    expect(extractDocx(arkiv(docx()), RUM)).toEqual({
      text: 'Protokoll 2026-09-20\nBeslut: ärendet bordläggs.',
      truncated: false,
    });
  });

  it('slår ihop flera textbitar i samma stycke och avkodar entiteter', () => {
    const xml =
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Anna </w:t></w:r><w:r><w:t>&amp; Bertil</w:t></w:r></w:p></w:body></w:document>';
    const bytes = byggZip([{ namn: 'word/document.xml', innehall: xml }]);
    expect(extractDocx(arkiv(bytes), RUM).text).toBe('Anna & Bertil');
  });

  it('gör tabb och radbrytning inuti ett stycke till tabb och radbrytning', () => {
    const xml = '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p></w:body></w:document>';
    expect(extractDocx(arkiv(byggZip([{ namn: 'word/document.xml', innehall: xml }])), RUM).text).toBe('a\tb\nc');
  });

  it('hoppar över tomma stycken i stället för att lämna tomrader', () => {
    expect(extractDocx(arkiv(docx(['Ett', '', '  ', 'Två'])), RUM).text).toBe('Ett\nTvå');
  });

  it('kapar texten vid gränsen och säger att den är kapad', () => {
    const svar = extractDocx(arkiv(docx(['a'.repeat(100), 'b'.repeat(100)])), { ...RUM, maxChars: 50 });
    expect(svar.truncated).toBe(true);
    expect(svar.text).toHaveLength(50);
  });

  it('ett dokument utan word/document.xml är inte läsbart', () => {
    expect(() => extractDocx(arkiv(byggZip([{ namn: 'annat.xml', innehall: '<a/>' }])), RUM)).toThrow(OfficeError);
  });

  it('trasig XML blir ett fel, inte halv text', () => {
    const bytes = byggZip([{ namn: 'word/document.xml', innehall: '<w:document><w:body><w:p><w:t>hej' }]);
    expect(() => extractDocx(arkiv(bytes), RUM)).toThrow(OfficeError);
  });
});

describe('extractXlsx', () => {
  it('ger en rad per rad med tabb mellan cellerna', () => {
    expect(extractXlsx(arkiv(xlsx()), RUM).text).toBe('Ärende\tHandläggare\tBelopp\n2026-114\tAnna\t4200');
  });

  it('klarar ett kalkylblad utan delade strängar', () => {
    expect(extractXlsx(arkiv(xlsx(undefined, false)), RUM).text).toBe('Ärende\tHandläggare\tBelopp\n2026-114\tAnna\t4200');
  });

  it('en saknad fil med delade strängar ger tomma celler, inte ett kraschat anrop', () => {
    const utan = byggZip([
      { namn: 'xl/workbook.xml', innehall: '<workbook/>' },
      {
        namn: 'xl/worksheets/sheet1.xml',
        innehall: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect(extractXlsx(arkiv(utan), RUM).text).toBe('\t7');
  });

  it('håller kolumnerna på plats när celler saknas', () => {
    const glest = byggZip([
      { namn: 'xl/workbook.xml', innehall: '<workbook/>' },
      {
        namn: 'xl/worksheets/sheet1.xml',
        innehall: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect(extractXlsx(arkiv(glest), RUM).text).toBe('1\t\t3');
  });

  it('läser flera blad i nummerordning, åtskilda av en tomrad', () => {
    const flera = byggZip([
      { namn: 'xl/workbook.xml', innehall: '<workbook/>' },
      { namn: 'xl/worksheets/sheet10.xml', innehall: '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>tio</v></c></row></sheetData></worksheet>' },
      { namn: 'xl/worksheets/sheet2.xml', innehall: '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>två</v></c></row></sheetData></worksheet>' },
    ]);
    expect(extractXlsx(arkiv(flera), RUM).text).toBe('två\n\ntio');
  });

  it('tar inte med formeln, bara värdet', () => {
    const formel = byggZip([
      { namn: 'xl/workbook.xml', innehall: '<workbook/>' },
      {
        namn: 'xl/worksheets/sheet1.xml',
        innehall: '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>42</v></c></row></sheetData></worksheet>',
      },
    ]);
    expect(extractXlsx(arkiv(formel), RUM).text).toBe('42');
  });

  it('ett arkiv utan blad är inte läsbart', () => {
    expect(() => extractXlsx(arkiv(byggZip([{ namn: 'xl/workbook.xml', innehall: '<workbook/>' }])), RUM)).toThrow(OfficeError);
  });
});

describe('extractPptx', () => {
  it('ger en bild i taget och räknar bilderna', () => {
    expect(extractPptx(arkiv(pptx()), RUM)).toEqual({
      text: 'Budget 2027\nKommunstyrelsen\n\nTre förslag\nEtt, två, tre',
      truncated: false,
      pages: 2,
    });
  });

  it('läser bilderna i nummerordning, inte i bokstavsordning', () => {
    const bilder = Array.from({ length: 11 }, (_, i) => [`bild ${i + 1}`]);
    const svar = extractPptx(arkiv(pptx(bilder)), RUM);
    expect(svar.text.split('\n\n')).toEqual(bilder.map(([rad]) => rad));
    expect(svar.pages).toBe(11);
  });

  it('en presentation utan bilder är inte läsbar', () => {
    expect(() => extractPptx(arkiv(byggZip([{ namn: 'ppt/presentation.xml', innehall: '<p/>' }])), RUM)).toThrow(OfficeError);
  });
});
