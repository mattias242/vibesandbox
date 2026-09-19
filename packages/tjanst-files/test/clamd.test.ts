/**
 * Virusskanning med clamd över TCP (INSTREAM). Mot en fejkad clamd som talar samma protokoll.
 * Allt som inte är ett tydligt "OK" eller "FOUND" är ett fel — då sparas filen inte (fail closed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdUnavailableError, createClamdScanner, parseClamdAddress } from '../src/clamd.ts';
import { FEJKVIRUS_MARKOR, startaFejkClamd } from './fejk-clamd.ts';
import type { FejkClamd } from './fejk-clamd.ts';

let clamd: FejkClamd | undefined;

afterEach(async () => {
  await clamd?.stang();
  clamd = undefined;
});

function skanner(adress: string, timeoutMs = 2000) {
  const parsed = parseClamdAddress(adress);
  if (parsed === null) throw new Error('ogiltig adress');
  return createClamdScanner(parsed, { timeoutMs, chunkBytes: 16 });
}

describe('parseClamdAddress', () => {
  it('värd:port', () => {
    expect(parseClamdAddress('clamav:3310')).toEqual({ host: 'clamav', port: 3310 });
    expect(parseClamdAddress('127.0.0.1:3310')).toEqual({ host: '127.0.0.1', port: 3310 });
  });

  it('nekar det som inte är värd:port', () => {
    for (const fel of ['', 'clamav', 'clamav:', ':3310', 'clamav:0', 'clamav:70000', 'clamav:33a', 'http://clamav:3310', 'a b:1']) {
      expect(parseClamdAddress(fel)).toBeNull();
    }
  });
});

describe('createClamdScanner', () => {
  it('ren fil: OK, och filen skickas i bitar', async () => {
    clamd = await startaFejkClamd();
    const svar = await skanner(clamd.adress).scan(Uint8Array.from(Buffer.from('en helt vanlig fil som är längre än en bit')));
    expect(svar).toEqual({ clean: true });
    expect(clamd.skannade()).toBe(1);
  });

  it('smittad fil: FOUND med signaturens namn', async () => {
    clamd = await startaFejkClamd();
    const svar = await skanner(clamd.adress).scan(Uint8Array.from(Buffer.from(`xx${FEJKVIRUS_MARKOR}xx`)));
    expect(svar).toEqual({ clean: false, signature: 'Vibesandbox.Fejkvirus' });
  });

  it('en markör som delas mellan två bitar hittas ändå (clamd ser hela strömmen)', async () => {
    clamd = await startaFejkClamd();
    const svar = await skanner(clamd.adress).scan(Uint8Array.from(Buffer.from(`${'x'.repeat(10)}${FEJKVIRUS_MARKOR}`)));
    expect(svar.clean).toBe(false);
  });

  it('clamd svarar med ett fel ⇒ ClamdUnavailableError', async () => {
    clamd = await startaFejkClamd('fel');
    await expect(skanner(clamd.adress).scan(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ClamdUnavailableError);
  });

  it('clamd stänger utan svar ⇒ ClamdUnavailableError', async () => {
    clamd = await startaFejkClamd('stanger');
    await expect(skanner(clamd.adress).scan(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ClamdUnavailableError);
  });

  it('clamd svarar aldrig ⇒ ClamdUnavailableError efter tidsgränsen', async () => {
    clamd = await startaFejkClamd('tyst');
    const start = Date.now();
    await expect(skanner(clamd.adress, 200).scan(new Uint8Array([1]))).rejects.toBeInstanceOf(ClamdUnavailableError);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('ingen clamd på adressen ⇒ ClamdUnavailableError', async () => {
    const tillfallig = await startaFejkClamd();
    const adress = tillfallig.adress;
    await tillfallig.stang();
    await expect(skanner(adress).scan(new Uint8Array([1]))).rejects.toBeInstanceOf(ClamdUnavailableError);
  });
});
