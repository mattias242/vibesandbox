/**
 * Den gemensamma anropsvägen till plattformstjänsterna (`/_api/<namn>`): relativ adress på appens
 * egen origin, skyddshuvudet på skrivande anrop, och fel som `SdkError` i klarspråk.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import { callService } from '../src/tjanster/anrop.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';

function fejk(svar: { status: number; body?: unknown; bytes?: Uint8Array; contentType?: string }) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    return {
      status: svar.status,
      ok: svar.status >= 200 && svar.status < 300,
      headers: { get: (namn: string) => (namn.toLowerCase() === 'content-type' ? (svar.contentType ?? 'application/json') : null) },
      json: async () => svar.body,
      arrayBuffer: async () => (svar.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
    };
  };
  return { fetch, anrop };
}

describe('callService', () => {
  it('GET till /_api/<namn>/<väg>, relativt, med kakor bara för samma origin, JSON tillbaka', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: { ok: 1 } });
    const svar = await callService('files', 'GET', '/abc?x=1', { fetch });
    expect(svar).toEqual({ ok: 1 });
    expect(anrop[0]?.url).toBe('/_api/files/abc?x=1');
    expect(anrop[0]?.init.credentials).toBe('same-origin');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBeUndefined();
  });

  it('skrivande anrop bär skyddshuvudet, och JSON skickas som JSON', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: {} });
    await callService('llm', 'POST', '/complete', { fetch, json: { prompt: 'hej' } });
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(anrop[0]?.init.headers['content-type']).toBe('application/json');
    expect(anrop[0]?.init.body).toBe('{"prompt":"hej"}');
  });

  it('råa byte skickas oförändrade med angiven typ', async () => {
    const { fetch, anrop } = fejk({ status: 201, body: { id: 'f1' } });
    const bytes = new Uint8Array([1, 2, 3]);
    await callService('files', 'POST', '', { fetch, bytes, contentType: 'image/png' });
    expect(anrop[0]?.url).toBe('/_api/files');
    expect(anrop[0]?.init.body).toBe(bytes);
    expect(anrop[0]?.init.headers['content-type']).toBe('image/png');
  });

  it('kan ge byte tillbaka', async () => {
    const { fetch } = fejk({ status: 200, bytes: new Uint8Array([9, 8]), contentType: 'application/pdf' });
    const svar = await callService('files', 'GET', '/f1/content', { fetch, expect: 'bytes' });
    expect(svar).toEqual({ bytes: new Uint8Array([9, 8]), contentType: 'application/pdf' });
  });

  it('204 ger undefined', async () => {
    const { fetch } = fejk({ status: 204 });
    expect(await callService('files', 'DELETE', '/f1', { fetch })).toBeUndefined();
  });

  it('plattformens felsvar blir SdkError med plattformens klarspråk', async () => {
    const { fetch } = fejk({ status: 413, body: { error: { code: 'too_large', message: 'Filen är för stor.' } } });
    const fel = await callService('files', 'POST', '', { fetch, bytes: new Uint8Array() }).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect((fel as SdkError).code).toBe('too_large');
    expect((fel as SdkError).message).toBe('Filen är för stor.');
  });

  it('nätverksfel blir network, och orsaken läcker inte', async () => {
    const fetch: ServiceFetch = async () => {
      throw new Error('Failed to fetch: hemlig detalj');
    };
    const fel = (await callService('files', 'GET', '', { fetch }).catch((e: unknown) => e)) as SdkError;
    expect(fel.code).toBe('network');
    expect(fel.message).not.toContain('hemlig');
  });

  it.each(['../data', 'Files', 'a/b', ''])('vägrar ett ogiltigt tjänstenamn: %j', async (namn) => {
    const { fetch, anrop } = fejk({ status: 200, body: {} });
    await expect(callService(namn, 'GET', '', { fetch })).rejects.toBeInstanceOf(SdkError);
    expect(anrop).toHaveLength(0);
  });

  it.each(['//evil.example/x', 'http://evil.example', '/../collections'])('vägrar en väg som kan lämna tjänsten: %j', async (vag) => {
    const { fetch, anrop } = fejk({ status: 200, body: {} });
    await expect(callService('files', 'GET', vag, { fetch })).rejects.toBeInstanceOf(SdkError);
    expect(anrop).toHaveLength(0);
  });
});
