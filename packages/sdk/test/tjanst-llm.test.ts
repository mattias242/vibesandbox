/**
 * SDK:t för tjänsten `llm`: `complete` och `completeJson` anropar `POST /_api/llm/complete` genom
 * den gemensamma anropsvägen, och fel blir `SdkError` i klarspråk.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import { complete, completeJson } from '../src/tjanster/llm.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';

function fejk(svar: { status: number; body?: unknown } | Error) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    if (svar instanceof Error) throw svar;
    return {
      status: svar.status,
      ok: svar.status >= 200 && svar.status < 300,
      headers: { get: () => 'application/json' },
      json: async () => svar.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const skickat = (i = 0): unknown => JSON.parse(String(anrop[i]?.init.body));
  return { fetch, anrop, skickat };
}

async function fel(lovat: Promise<unknown>): Promise<SdkError> {
  try {
    await lovat;
  } catch (e) {
    expect(e).toBeInstanceOf(SdkError);
    return e as SdkError;
  }
  throw new Error('Inget fel kastades.');
}

describe('complete', () => {
  it('skickar en text som prompt och ger tillbaka svarstexten', async () => {
    const { fetch, anrop, skickat } = fejk({ status: 200, body: { text: 'Kort sammanfattning.', usage: { inputTokens: 5, outputTokens: 3 } } });
    const text = await complete('Sammanfatta: lyktan är släckt.', { fetch });
    expect(text).toBe('Kort sammanfattning.');
    expect(anrop[0]?.url).toBe('/_api/llm/complete');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(skickat()).toEqual({ prompt: 'Sammanfatta: lyktan är släckt.' });
  });

  it('skickar meddelanden och valda inställningar — men aldrig testernas fetch', async () => {
    const { fetch, skickat } = fejk({ status: 200, body: { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } } });
    const messages = [
      { role: 'system', content: 'Skriv klarspråk.' },
      { role: 'user', content: 'Härmed meddelas...' },
    ] as const;
    await complete(messages, { maxTokens: 300, temperature: 0, fetch });
    expect(skickat()).toEqual({ messages, maxTokens: 300, temperature: 0 });
  });

  it('en tom text eller lista skickas aldrig', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: { text: 'ok' } });
    expect((await fel(complete('  ', { fetch }))).code).toBe('invalid_request');
    expect((await fel(complete([], { fetch }))).code).toBe('invalid_request');
    expect(anrop).toHaveLength(0);
  });

  it('plattformens fel och meddelande i klarspråk följer med', async () => {
    const meddelande = 'Du har använt språkmodellen mycket den senaste timmen. Vänta en stund och försök igen.';
    const { fetch } = fejk({ status: 429, body: { error: { code: 'rate_limited', message: meddelande } } });
    const e = await fel(complete('hej', { fetch }));
    expect(e.code).toBe('rate_limited');
    expect(e.message).toBe(meddelande);
  });

  it('språkmodellen som inte svarar (503) blir ett fel att visa', async () => {
    const { fetch } = fejk({ status: 503, body: { error: { code: 'internal', message: 'Språkmodellen svarar inte just nu. Försök igen om en stund.' } } });
    const e = await fel(complete('hej', { fetch }));
    expect(e.message).toMatch(/^Språkmodellen svarar inte/);
  });

  it('ett svar med fel form blir internal', async () => {
    const { fetch } = fejk({ status: 200, body: { svar: 'x' } });
    expect((await fel(complete('hej', { fetch }))).code).toBe('internal');
  });

  it('nätverksfel blir network', async () => {
    const { fetch } = fejk(new Error('ECONNRESET'));
    expect((await fel(complete('hej', { fetch }))).code).toBe('network');
  });
});

describe('completeJson', () => {
  it('ber om JSON och ger tillbaka det tolkade värdet', async () => {
    const { fetch, skickat } = fejk({ status: 200, body: { text: '{"kategori":"belysning"}', usage: { inputTokens: 1, outputTokens: 1 } } });
    const svar = await completeJson<{ kategori: string }>('Klassificera: lyktan är släckt.', { fetch });
    expect(svar).toEqual({ kategori: 'belysning' });
    expect(skickat()).toEqual({ prompt: 'Klassificera: lyktan är släckt.', format: 'json' });
  });

  it('text som inte är JSON blir ett fel i klarspråk', async () => {
    const { fetch } = fejk({ status: 200, body: { text: 'inte json' } });
    const e = await fel(completeJson('x', { fetch }));
    expect(e.code).toBe('internal');
    expect(e.message).toMatch(/Språkmodellen/);
  });
});
