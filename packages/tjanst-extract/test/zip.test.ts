/**
 * Zip-läsaren. Arkivet är fientliga indata: varje längd och varje offset i filen kommer utifrån,
 * och ingen av dem får få läsaren att läsa utanför bufferten, packa upp en bomb eller tro på ett
 * filnamn som pekar utanför arkivet.
 */
import { describe, expect, it } from 'vitest';
import { ZipError, openZip } from '../src/zip.ts';
import { byggZip, docx, zipBomb, zipMedSokvagar } from './exempel.ts';

const GRANSER = { maxEntries: 200, maxUnpackedBytes: 8 * 1024 * 1024, maxExpansion: 50 } as const;

function text(bytes: Uint8Array | null): string {
  return bytes === null ? '' : new TextDecoder().decode(bytes);
}

describe('openZip', () => {
  it('läser namnen och innehållet, både lagrat och packat', () => {
    const arkiv = openZip(byggZip([{ namn: 'a.txt', innehall: 'ett' }, { namn: 'b.txt', innehall: 'två', packa: true }]), GRANSER);
    expect(arkiv.names()).toEqual(['a.txt', 'b.txt']);
    expect(text(arkiv.read('a.txt'))).toBe('ett');
    expect(text(arkiv.read('b.txt'))).toBe('två');
  });

  it('en post som inte finns ger null', () => {
    const arkiv = openZip(docx(), GRANSER);
    expect(arkiv.read('word/finnsinte.xml')).toBeNull();
  });

  it('en tom post ger noll byte, inte ett fel', () => {
    const arkiv = openZip(byggZip([{ namn: 'tom.xml', innehall: '' }]), GRANSER);
    expect(arkiv.read('tom.xml')).toEqual(new Uint8Array(0));
  });

  it('vägrar en zip-bomb: mer utpackat än gränsen', () => {
    expect(() => openZip(zipBomb(), { ...GRANSER, maxUnpackedBytes: 1024 })).toThrow(ZipError);
  });

  it('vägrar en zip-bomb: fler gånger större än gränsen tillåter', () => {
    expect(() => openZip(zipBomb(4 * 1024 * 1024), { ...GRANSER, maxUnpackedBytes: 64 * 1024 * 1024, maxExpansion: 10 })).toThrow(ZipError);
  });

  it('vägrar en post vars namn pekar utanför arkivet', () => {
    expect(() => openZip(zipMedSokvagar(), GRANSER)).toThrow(ZipError);
  });

  it('vägrar namn med absolut sökväg, omvänt snedstreck eller NUL', () => {
    for (const namn of ['/etc/passwd', 'word\\document.xml', 'word/doc\u0000.xml', 'a/../../b']) {
      expect(() => openZip(byggZip([{ namn, innehall: 'x' }]), GRANSER), namn).toThrow(ZipError);
    }
  });

  it('vägrar fler poster än gränsen', () => {
    const poster = Array.from({ length: 12 }, (_, i) => ({ namn: `f${i}.txt`, innehall: 'x' }));
    expect(() => openZip(byggZip(poster), { ...GRANSER, maxEntries: 10 })).toThrow(ZipError);
  });

  it('vägrar en post som packar upp till mer än den säger sig göra', () => {
    const arkiv = openZip(
      byggZip([{ namn: 'lögn.txt', innehall: 'x'.repeat(5000), packa: true, ljugOmStorlek: 10 }]),
      GRANSER,
    );
    expect(() => arkiv.read('lögn.txt')).toThrow(ZipError);
  });

  it('vägrar sopor som inte är en zip alls', () => {
    expect(() => openZip(new Uint8Array(0), GRANSER)).toThrow(ZipError);
    expect(() => openZip(Uint8Array.from(Buffer.from('PK\u0003\u0004 men resten är skräp')), GRANSER)).toThrow(ZipError);
  });

  it('vägrar en katalog som pekar utanför filen', () => {
    const bytes = docx();
    // Katalogens offset i slutposten (EOCD) pekas om till långt bortom filens slut.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(bytes.length - 22 + 16, 0x7ffffff0, true);
    expect(() => openZip(bytes, GRANSER)).toThrow(ZipError);
  });

  it('räknar ihop alla poster mot utrymmet, inte en i taget', () => {
    const poster = [
      { namn: 'a', innehall: 'a'.repeat(4000), packa: true },
      { namn: 'b', innehall: 'b'.repeat(4000), packa: true },
    ];
    expect(() => openZip(byggZip(poster), { ...GRANSER, maxUnpackedBytes: 5000 })).toThrow(ZipError);
    expect(openZip(byggZip(poster), { ...GRANSER, maxUnpackedBytes: 9000 }).names()).toHaveLength(2);
  });
});
