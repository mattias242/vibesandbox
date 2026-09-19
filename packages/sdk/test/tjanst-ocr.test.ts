/**
 * SDK:t för tjänsten `ocr`: `ocr.read(fileId, { language })` → `{ text, pages }`.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import { read } from '../src/tjanster/ocr.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';

function fejk(status: number, body: unknown) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, anrop };
}

describe('ocr.read', () => {
  it('POST /_api/ocr med fil-id och ger text och sidor', async () => {
    const { fetch, anrop } = fejk(200, { text: 'Kaffe 20 kr', pages: [{ number: 1, text: 'Kaffe 20 kr' }] });
    const svar = await read('fil_123', { fetch });
    expect(svar).toEqual({ text: 'Kaffe 20 kr', pages: [{ number: 1, text: 'Kaffe 20 kr' }] });
    expect(anrop[0]?.url).toBe('/_api/ocr');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ fileId: 'fil_123' });
  });

  it('skickar språket när det anges', async () => {
    const { fetch, anrop } = fejk(200, { text: 'Coffee' });
    await read('fil_123', { language: 'en', fetch });
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ fileId: 'fil_123', language: 'en' });
  });

  it('en PDF utan uppdelning per sida ger en tom sidlista', async () => {
    const { fetch } = fejk(200, { text: '# Faktura' });
    expect(await read('dok', { fetch })).toEqual({ text: '# Faktura', pages: [] });
  });

  it('ogiltigt fil-id eller språk avvisas utan anrop', async () => {
    const { fetch, anrop } = fejk(200, { text: '' });
    for (const id of ['', '../x', 'a/b', 'x\u0000', 'k'.repeat(201), 42 as unknown as string]) {
      await expect(read(id, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(read('ok', { language: 'de' as 'sv', fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toHaveLength(0);
  });

  it('plattformens fel blir SdkError med plattformens meddelande', async () => {
    const { fetch } = fejk(429, { error: { code: 'rate_limited', message: 'Appen har nått sin gräns för textigenkänning i dag.' } });
    const fel = await read('fil', { fetch }).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel).toMatchObject({ code: 'rate_limited', message: 'Appen har nått sin gräns för textigenkänning i dag.' });
  });

  it('ett svar med fel form blir ett begripligt fel', async () => {
    for (const body of [null, {}, { text: 1 }, { text: 'x', pages: 'nej' }, { text: 'x', pages: [{ number: 'ett', text: 'x' }] }]) {
      const { fetch } = fejk(200, body);
      await expect(read('fil', { fetch })).rejects.toMatchObject({ code: 'internal' });
    }
  });
});
