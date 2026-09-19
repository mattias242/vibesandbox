/**
 * SDK:t för tjänsten `files`: rätt anrop till `/_api/files`, svaren kontrolleras innan de lämnas
 * till appen, och fel blir `SdkError`. Webbläsarens `fetch` byts mot en fejk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import * as files from '../src/tjanster/files.ts';

interface Anrop {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; credentials: string };
}

const FIL = {
  id: '0123456789abcdef0123456789abcdef',
  name: 'semester.png',
  contentType: 'image/png',
  size: 3,
  createdAt: '2026-09-19T08:00:00.000Z',
  uploadedBy: 'anv-anna',
  personal: false,
};

function fejk(svar: { status: number; body?: unknown; bytes?: Uint8Array; contentType?: string }): Anrop[] {
  const anrop: Anrop[] = [];
  vi.stubGlobal('fetch', async (url: string, init: Anrop['init']) => {
    anrop.push({ url, init });
    return {
      status: svar.status,
      ok: svar.status >= 200 && svar.status < 300,
      headers: { get: (namn: string) => (namn.toLowerCase() === 'content-type' ? (svar.contentType ?? 'application/json') : null) },
      json: async () => svar.body,
      arrayBuffer: async () => Uint8Array.from(svar.bytes ?? []).buffer,
    };
  });
  return anrop;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('files.upload', () => {
  it('skickar råa byte med typ, namn i frågan och skyddshuvudet', async () => {
    const anrop = fejk({ status: 201, body: FIL });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await files.upload(bytes, { name: 'semester.png', contentType: 'image/png' })).toEqual(FIL);
    expect(anrop[0]?.url).toBe('/_api/files?name=semester.png');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.body).toBe(bytes);
    expect(anrop[0]?.init.headers['content-type']).toBe('image/png');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
  });

  it('en File från <input type="file"> ger namn och typ själv', async () => {
    const anrop = fejk({ status: 201, body: FIL });
    const fil = new File([new Uint8Array([1, 2, 3])], 'Min bild å.png', { type: 'image/png' });
    await files.upload(fil);
    expect(anrop[0]?.url).toBe(`/_api/files?name=${encodeURIComponent('Min bild å.png')}`);
    expect(anrop[0]?.init.headers['content-type']).toBe('image/png');
    expect(anrop[0]?.init.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('personal: true ger en personlig fil', async () => {
    const anrop = fejk({ status: 201, body: { ...FIL, personal: true } });
    await files.upload(new Blob(['hej'], { type: 'text/plain' }), { name: 'a.txt', personal: true });
    expect(anrop[0]?.url).toBe('/_api/files?name=a.txt&personal=true');
  });

  it('namn med tecken som betyder något i en adress kodas', async () => {
    const anrop = fejk({ status: 201, body: FIL });
    await files.upload(new Uint8Array([1]), { name: '../a&personal=true#?.png' });
    expect(anrop[0]?.url).toBe(`/_api/files?name=${encodeURIComponent('../a&personal=true#?.png')}`);
  });

  it('utan typ skickas octet-stream och plattformen avgör typen', async () => {
    const anrop = fejk({ status: 201, body: FIL });
    await files.upload(new Uint8Array([1]));
    expect(anrop[0]?.init.headers['content-type']).toBe('application/octet-stream');
  });

  it('plattformens fel blir SdkError med plattformens klarspråk', async () => {
    fejk({ status: 400, body: { error: { code: 'invalid_request', message: 'Filens innehåll stämmer inte med filtypen.' } } });
    const fel = (await files.upload(new Uint8Array([1])).catch((e: unknown) => e)) as SdkError;
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel.message).toBe('Filens innehåll stämmer inte med filtypen.');
  });

  it('ett svar som inte är en fil blir internal', async () => {
    fejk({ status: 201, body: { id: 5 } });
    await expect(files.upload(new Uint8Array([1]))).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('files.list, get och remove', () => {
  it('list ger filerna', async () => {
    const anrop = fejk({ status: 200, body: { files: [FIL] } });
    expect(await files.list()).toEqual([FIL]);
    expect(anrop[0]?.url).toBe('/_api/files');
    expect(anrop[0]?.init.method).toBe('GET');
  });

  it('list nekar ett svar med fel form', async () => {
    fejk({ status: 200, body: { files: [{ ...FIL, size: 'stor' }] } });
    await expect(files.list()).rejects.toMatchObject({ code: 'internal' });
  });

  it('get ger en fils uppgifter', async () => {
    const anrop = fejk({ status: 200, body: FIL });
    expect(await files.get(FIL.id)).toEqual(FIL);
    expect(anrop[0]?.url).toBe(`/_api/files/${FIL.id}`);
  });

  it('remove tar bort', async () => {
    const anrop = fejk({ status: 204 });
    await files.remove(FIL.id);
    expect(anrop[0]?.url).toBe(`/_api/files/${FIL.id}`);
    expect(anrop[0]?.init.method).toBe('DELETE');
  });

  it('ett id med fel form når aldrig nätverket', async () => {
    const anrop = fejk({ status: 200, body: FIL });
    for (const id of ['../whoami', 'a/b', '', 'x'.repeat(33), 'ABCDEF0123456789ABCDEF0123456789']) {
      await expect(files.get(id)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(files.remove(id)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(files.download(id)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(() => files.url(id)).toThrow(SdkError);
    }
    expect(anrop).toHaveLength(0);
  });
});

describe('files.url och download', () => {
  it('url är en relativ adress till innehållet, för <img src>', () => {
    expect(files.url(FIL.id)).toBe(`/_api/files/${FIL.id}/content`);
  });

  it('download ger innehållet som en Blob med rätt typ', async () => {
    const anrop = fejk({ status: 200, bytes: new Uint8Array([9, 8, 7]), contentType: 'application/pdf' });
    const blob = await files.download(FIL.id);
    expect(anrop[0]?.url).toBe(`/_api/files/${FIL.id}/content`);
    expect(blob.type).toBe('application/pdf');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });
});
