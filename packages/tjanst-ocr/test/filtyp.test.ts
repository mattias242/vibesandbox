/**
 * Filtypen avgörs av filens egna byte, aldrig av den angivna typen eller namnet — en app kan
 * ladda upp vad som helst under vilket namn som helst.
 */
import { describe, expect, it } from 'vitest';
import { identifyFile } from '../src/filtyp.ts';
import { jpeg, pdf, png, webpVp8, webpVp8l, webpVp8x } from './bilder.ts';

describe('identifyFile', () => {
  it('PNG: typ och storlek ur IHDR', () => {
    expect(identifyFile(png(640, 480))).toEqual({ kind: 'image', mediaType: 'image/png', width: 640, height: 480 });
  });

  it('JPEG: storlek ur ramhuvudet, även progressiv (SOF2)', () => {
    expect(identifyFile(jpeg(1024, 768))).toEqual({ kind: 'image', mediaType: 'image/jpeg', width: 1024, height: 768 });
    expect(identifyFile(jpeg(300, 200, 0xc2))).toEqual({ kind: 'image', mediaType: 'image/jpeg', width: 300, height: 200 });
  });

  it('WebP: alla tre varianterna', () => {
    expect(identifyFile(webpVp8x(5000, 3000))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 5000, height: 3000 });
    expect(identifyFile(webpVp8(320, 240))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 320, height: 240 });
    expect(identifyFile(webpVp8l(100, 50))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 100, height: 50 });
  });

  it('PDF: typ och uppskattat antal sidor', () => {
    expect(identifyFile(pdf(3))).toEqual({ kind: 'pdf', mediaType: 'application/pdf', estimatedPages: 3 });
  });

  it('PDF där sidorna inte syns (komprimerade objekt) räknas som minst en sida', () => {
    expect(identifyFile(new TextEncoder().encode('%PDF-1.7\n%%EOF\n'))).toEqual({ kind: 'pdf', mediaType: 'application/pdf', estimatedPages: 1 });
  });

  it('text, HTML, SVG, GIF och tomt avvisas', () => {
    for (const text of ['hej', '<html></html>', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'GIF89a......', '']) {
      expect(identifyFile(new TextEncoder().encode(text))).toBeNull();
    }
  });

  it('avhuggna huvuden avvisas i stället för att läsas utanför bufferten', () => {
    for (const hel of [png(10, 10), jpeg(10, 10), webpVp8x(10, 10), webpVp8(10, 10), webpVp8l(10, 10)]) {
      for (const langd of [4, 12, 20, hel.length - 12]) {
        const kort = hel.subarray(0, langd);
        const svar = identifyFile(kort);
        expect(svar === null || svar.kind === 'image').toBe(true);
        if (svar !== null && svar.kind === 'image') expect(svar.width).toBeGreaterThan(0);
      }
    }
    expect(identifyFile(png(10, 10).subarray(0, 20))).toBeNull();
  });

  it('en bild med bredd eller höjd noll avvisas', () => {
    expect(identifyFile(png(0, 10))).toBeNull();
    expect(identifyFile(jpeg(10, 0))).toBeNull();
  });

  it('en JPEG utan ramhuvud avvisas', () => {
    expect(identifyFile(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    // Ett segment med längd 0 får inte ge en oändlig slinga.
    expect(identifyFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xe0, 0x00, 0x00]))).toBeNull();
  });
});
