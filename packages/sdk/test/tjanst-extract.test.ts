/**
 * SDK:t för tjänsten `extract`: `extract.read(fileId)` → `{ text, kind, truncated, pages, hasText }`.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import { read } from '../src/tjanster/extract.ts';
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

describe('extract.read', () => {
  it('POST /_api/extract med fil-id och ger text och filsort', async () => {
    const { fetch, anrop } = fejk(200, { text: 'Protokoll\nBeslut', kind: 'docx', truncated: false, hasText: true });
    const svar = await read('fil_123', { fetch });
    expect(svar).toEqual({ text: 'Protokoll\nBeslut', kind: 'docx', truncated: false, pages: 0, hasText: true });
    expect(anrop[0]?.url).toBe('/_api/extract');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ fileId: 'fil_123' });
  });

  it('ger antalet sidor när tjänsten räknat dem', async () => {
    const { fetch } = fejk(200, { text: 'Bild 1', kind: 'pptx', truncated: false, pages: 4, hasText: true });
    expect(await read('fil', { fetch })).toMatchObject({ kind: 'pptx', pages: 4 });
  });

  it('en kapad text syns på truncated', async () => {
    const { fetch } = fejk(200, { text: 'Bör', kind: 'xlsx', truncated: true, hasText: true });
    expect((await read('fil', { fetch })).truncated).toBe(true);
  });

  it('en fil utan text att hämta ger hasText falskt och en mening att visa', async () => {
    const { fetch } = fejk(200, { text: '', kind: 'pdf', truncated: false, pages: 9, hasText: false, message: 'Filen är inskannad.' });
    expect(await read('fil', { fetch })).toEqual({
      text: '',
      kind: 'pdf',
      truncated: false,
      pages: 9,
      hasText: false,
      message: 'Filen är inskannad.',
    });
  });

  it('ogiltigt fil-id avvisas utan anrop', async () => {
    const { fetch, anrop } = fejk(200, { text: '', kind: 'docx' });
    for (const id of ['', '../x', 'a/b', 'x\u0000', 'k'.repeat(201), 42 as unknown as string]) {
      await expect(read(id, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(anrop).toHaveLength(0);
  });

  it('plattformens fel blir SdkError med plattformens meddelande', async () => {
    const { fetch } = fejk(429, { error: { code: 'rate_limited', message: 'Appen har nått sin gräns för texthämtning i dag.' } });
    const fel = await read('fil', { fetch }).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel).toMatchObject({ code: 'rate_limited', message: 'Appen har nått sin gräns för texthämtning i dag.' });
  });

  it('ett svar med fel form blir ett begripligt fel', async () => {
    for (const body of [
      null,
      {},
      { text: 1, kind: 'docx' },
      { text: 'x' },
      { text: 'x', kind: 'rtf' },
      { text: 'x', kind: 'docx', truncated: 'kanske' },
      { text: 'x', kind: 'docx', pages: 'tre' },
      { text: 'x', kind: 'docx', hasText: 'ja' },
      { text: 'x', kind: 'docx', message: 7 },
    ]) {
      const { fetch } = fejk(200, body);
      await expect(read('fil', { fetch }), JSON.stringify(body)).rejects.toMatchObject({ code: 'internal' });
    }
  });
});
