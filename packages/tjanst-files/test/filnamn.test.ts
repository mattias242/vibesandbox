/**
 * Filnamnet kommer från användaren och visas för andra användare, och hamnar i ett svarshuvud
 * (`Content-Disposition`). Det används ALDRIG som sökväg — filerna på disk namnges av plattformen —
 * men saneras ändå så att det inte kan lura en människa eller ett huvud.
 */
import { describe, expect, it } from 'vitest';
import { checkFileType } from '../src/filtyper.ts';
import type { FileType } from '../src/filtyper.ts';
import { MAX_FILE_NAME_LENGTH, asciiFileName, sanitizeFileName } from '../src/filnamn.ts';
import { PDF, PNG, TEXT } from './exempelfiler.ts';

function typAv(bytes: Uint8Array): FileType {
  const r = checkFileType(bytes, undefined);
  if (!r.ok) throw new Error('testfilen godtogs inte');
  return r.type;
}

const BILD = typAv(PNG);
const PDF_TYP = typAv(PDF);
const TEXT_TYP = typAv(TEXT);

describe('sanitizeFileName', () => {
  it('lämnar ett vanligt namn orört, även med å, ä och ö', () => {
    expect(sanitizeFileName('Semester i Västerås.png', BILD)).toBe('Semester i Västerås.png');
  });

  it('tar bara sista ledet ur en sökväg, med snedstreck åt båda hållen', () => {
    expect(sanitizeFileName('../../../etc/passwd.png', BILD)).toBe('passwd.png');
    expect(sanitizeFileName('..\\..\\windows\\system32\\bild.png', BILD)).toBe('bild.png');
    expect(sanitizeFileName('/abs/bild.png', BILD)).toBe('bild.png');
  });

  it('tar bort NUL och andra kontrolltecken', () => {
    expect(sanitizeFileName('bild\u0000.png', BILD)).toBe('bild.png');
    expect(sanitizeFileName('bi\r\nld\u007f\u0085.png', BILD)).toBe('bild.png');
  });

  it('tar bort citattecken och tecken som inte hör hemma i ett filnamn', () => {
    expect(sanitizeFileName('"bild" \'1\' `2` <3>:*?|.png', BILD)).toBe('bild 1 2 3.png');
  });

  it('tar bort osynliga tecken och riktningstecken som kan förfalska ändelsen', () => {
    // "faktura‮gnp.exe" visas som "fakturaexe.png" men heter något annat.
    expect(sanitizeFileName('faktura\u202egnp.pdf', PDF_TYP)).toBe('fakturagnp.pdf');
    expect(sanitizeFileName('a\u200bb\ufeffc.pdf', PDF_TYP)).toBe('abc.pdf');
  });

  it('ett namn som bara är punkter eller tomt blir ett neutralt namn', () => {
    expect(sanitizeFileName('..', BILD)).toBe('fil.png');
    expect(sanitizeFileName('', BILD)).toBe('fil.png');
    expect(sanitizeFileName('   ', PDF_TYP)).toBe('fil.pdf');
    expect(sanitizeFileName('../', PDF_TYP)).toBe('fil.pdf');
  });

  it('inga ledande punkter (dolda filer)', () => {
    expect(sanitizeFileName('.htaccess.txt', TEXT_TYP)).toBe('htaccess.txt');
  });

  it('ändelsen följer innehållet: en ändelse som inte stämmer får rätt ändelse efter sig', () => {
    expect(sanitizeFileName('sida.html', TEXT_TYP)).toBe('sida.html.txt');
    expect(sanitizeFileName('bild', BILD)).toBe('bild.png');
    expect(sanitizeFileName('BILD.PNG', BILD)).toBe('BILD.PNG');
  });

  it('överlånga namn kortas, och ändelsen behålls', () => {
    const namn = sanitizeFileName(`${'å'.repeat(5000)}.png`, BILD);
    expect([...namn].length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(namn.endsWith('.png')).toBe(true);
  });

  it('kortar aldrig mitt i ett tecken som består av två UTF-16-enheter', () => {
    const namn = sanitizeFileName(`${'😀'.repeat(500)}.png`, BILD);
    expect(namn).toBe(`${'😀'.repeat(MAX_FILE_NAME_LENGTH - 4)}.png`);
  });
});

describe('asciiFileName (för Content-Disposition)', () => {
  it('byter å, ä, ö mot a, a, o och annat mot understreck', () => {
    expect(asciiFileName('Lönespec för Åsa.pdf')).toBe('Lonespec for Asa.pdf');
    expect(asciiFileName('文件.pdf')).toBe('__.pdf');
  });

  it('ger bara tecken som gatewayn släpper igenom i ett filnamn', () => {
    const namn = asciiFileName('a"b\\c\u0000d.pdf');
    expect(namn).toMatch(/^[\x20-\x7e]+$/);
    expect(namn).not.toMatch(/["\\]/);
  });
});
