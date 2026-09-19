/**
 * Filtypen avgörs av innehållet, inte av vad klienten påstår. Det påstådda (`Content-Type`)
 * får bara bekräfta — aldrig ändra — det innehållet visar.
 */
import { describe, expect, it } from 'vitest';
import { checkFileType } from '../src/filtyper.ts';
import {
  CSV,
  DOCX,
  DOCX_MED_MAKRON,
  DOCX_TYP,
  GIF,
  HTML,
  JPEG,
  M4A,
  MATROSKA,
  MP3_ID3,
  MP3_RAM,
  MP4_LJUD,
  OGG,
  PDF,
  PNG,
  QUICKTIME,
  SVG,
  SVG_MED_XML,
  TEXT,
  VANLIG_ZIP,
  WAV,
  WEBM,
  WEBP,
  XLSX,
  XLSX_TYP,
  zip,
} from './exempelfiler.ts';

function typ(bytes: Uint8Array, pastatt?: string): string {
  const resultat = checkFileType(bytes, pastatt);
  if (!resultat.ok) throw new Error(`nekad: ${resultat.reason}`);
  return resultat.type.contentType;
}

function nekad(bytes: Uint8Array, pastatt?: string): string {
  const resultat = checkFileType(bytes, pastatt);
  if (resultat.ok) throw new Error(`godtogs som ${resultat.type.contentType}`);
  return resultat.reason;
}

describe('tillåtna typer känns igen på sina magiska byte', () => {
  it.each([
    ['png', PNG, 'image/png', 'image/png'],
    ['jpeg', JPEG, 'image/jpeg', 'image/jpeg'],
    ['gif', GIF, 'image/gif', 'image/gif'],
    ['webp', WEBP, 'image/webp', 'image/webp'],
    ['pdf', PDF, 'application/pdf', 'application/pdf'],
    ['mp3 med ID3', MP3_ID3, 'audio/mpeg', 'audio/mpeg'],
    ['mp3 utan ID3', MP3_RAM, 'audio/mpeg', 'audio/mpeg'],
    ['m4a', M4A, 'audio/x-m4a', 'audio/mp4'],
    ['mp4-ljud', MP4_LJUD, 'audio/mp4', 'audio/mp4'],
    ['wav', WAV, 'audio/wav', 'audio/wav'],
    ['ogg', OGG, 'audio/ogg', 'audio/ogg'],
    ['webm-ljud', WEBM, 'audio/webm;codecs=opus', 'audio/webm'],
    ['docx', DOCX, DOCX_TYP, DOCX_TYP],
    ['xlsx', XLSX, XLSX_TYP, XLSX_TYP],
    ['text', TEXT, 'text/plain', 'text/plain; charset=utf-8'],
    ['csv', CSV, 'text/csv', 'text/csv; charset=utf-8'],
    ['csv från Windows', CSV, 'application/vnd.ms-excel', 'text/csv; charset=utf-8'],
  ])('%s', (_namn, bytes, pastatt, vantat) => {
    expect(typ(bytes, pastatt)).toBe(vantat);
  });

  it('utan påstådd typ (eller octet-stream) avgör innehållet ensamt', () => {
    expect(typ(PNG)).toBe('image/png');
    expect(typ(PDF, 'application/octet-stream')).toBe('application/pdf');
    expect(typ(TEXT, '')).toBe('text/plain; charset=utf-8');
  });

  it('parametrar och versaler i den påstådda typen spelar ingen roll', () => {
    expect(typ(PNG, 'IMAGE/PNG; name=x')).toBe('image/png');
  });

  it('text i Windows-1252 (som Excel sparar CSV på svenska Windows) godtas med rätt teckenkodning', () => {
    const ansi = Uint8Array.from(Buffer.from('namn;ort\nÅsa;Västerås\n', 'latin1'));
    expect(typ(ansi, 'text/csv')).toBe('text/csv; charset=windows-1252');
  });
});

describe('fientliga filer nekas', () => {
  it('SVG nekas, vad den än påstår sig vara', () => {
    for (const pastatt of ['image/svg+xml', 'image/png', 'text/plain', 'application/octet-stream', undefined]) {
      expect(() => typ(SVG, pastatt)).toThrow();
      expect(() => typ(SVG_MED_XML, pastatt)).toThrow();
    }
  });

  it('HTML nekas, vad den än påstår sig vara', () => {
    for (const pastatt of ['text/html', 'text/plain', 'text/csv', 'application/octet-stream', undefined]) {
      expect(() => typ(HTML, pastatt)).toThrow();
    }
    // Också när sidan inte börjar direkt med en tagg.
    const gomd = Uint8Array.from(Buffer.from('Hej\n\n<html><script>alert(1)</script></html>', 'utf8'));
    expect(() => typ(gomd, 'text/plain')).toThrow();
  });

  it('fel magiska byte: en PDF som påstår att den är en bild', () => {
    expect(nekad(PDF, 'image/png')).toBe('mismatch');
    expect(nekad(PNG, 'application/pdf')).toBe('mismatch');
    expect(nekad(PNG, 'text/plain')).toBe('mismatch');
  });

  it('en bild som påstår sig vara text nekas', () => {
    expect(nekad(JPEG, 'text/plain')).toBe('mismatch');
  });

  it('en påstådd typ utanför allowlistan nekas även om innehållet är tillåtet', () => {
    expect(nekad(TEXT, 'text/html')).toBe('mismatch');
    expect(nekad(TEXT, 'application/javascript')).toBe('mismatch');
    expect(nekad(WEBM, 'video/x-matroska')).toBe('mismatch');
  });

  it('binärt som inte är en känd typ nekas', () => {
    expect(nekad(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBe('unsupported'); // ELF
    expect(nekad(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBe('unsupported'); // Windows-program
    expect(nekad(MATROSKA)).toBe('unsupported');
    expect(nekad(QUICKTIME)).toBe('unsupported');
  });

  it('text med NUL eller andra kontrolltecken är inte text', () => {
    expect(nekad(Uint8Array.from(Buffer.from('hej\u0000då', 'utf8')), 'text/plain')).toBe('unsupported');
    expect(nekad(Uint8Array.from(Buffer.from('hej\u001bdå', 'utf8')), 'text/plain')).toBe('unsupported');
  });

  it('en tom fil nekas', () => {
    expect(nekad(new Uint8Array(0), 'text/plain')).toBe('empty');
  });

  it('zip som inte är ett Office-dokument nekas', () => {
    expect(nekad(VANLIG_ZIP, 'application/zip')).toBe('unsupported');
    expect(nekad(VANLIG_ZIP)).toBe('unsupported');
  });

  it('Office-dokument med makron nekas', () => {
    expect(nekad(DOCX_MED_MAKRON, DOCX_TYP)).toBe('unsupported');
    expect(nekad(zip(['[Content_Types].xml', 'xl/workbook.xml', 'xl/vbaProject.bin']), XLSX_TYP)).toBe('unsupported');
  });

  it('en trasig zip (avkortad, eller med påhittade offset) nekas utan att kasta', () => {
    expect(nekad(DOCX.subarray(0, DOCX.length - 10))).toBe('unsupported');
    const trasig = Uint8Array.from(DOCX);
    const slut = trasig.length - 22;
    Buffer.from(trasig.buffer).writeUInt32LE(0xfffffff0, slut + 16);
    expect(nekad(trasig)).toBe('unsupported');
    expect(nekad(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe('unsupported');
  });

  it('en PNG-signatur utan IHDR är ingen bild', () => {
    expect(nekad(PNG.subarray(0, 8), 'image/png')).toBe('unsupported');
  });
});
