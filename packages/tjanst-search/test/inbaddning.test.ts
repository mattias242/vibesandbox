/** Klienten mot Bergets OpenAI-kompatibla `/embeddings`. Aldrig det riktiga API:t. */
import { describe, expect, it } from 'vitest';
import { createBergetEmbedder, EmbeddingError } from '../src/inbaddning.ts';

type Anrop = { url: string; init: RequestInit };

function fejkFetch(svar: (anrop: Anrop) => Response | Promise<Response>) {
  const anrop: Anrop[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const a = { url: String(url), init: init ?? {} };
    anrop.push(a);
    return svar(a);
  }) as typeof globalThis.fetch;
  return { fetch, anrop };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function svarMed(vektorer: number[][], tokens = 7): Response {
  return ok({
    object: 'list',
    model: 'm',
    // Omvänd ordning: klienten ska sortera på `index`, inte lita på ordningen.
    data: vektorer.map((embedding, index) => ({ object: 'embedding', index, embedding })).reverse(),
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  });
}

const grund = { baseUrl: 'https://api.example.org/v1/', apiKey: 'nyckel-123', model: 'intfloat/multilingual-e5-large', timeoutMs: 1000 };

describe('createBergetEmbedder', () => {
  it('POST <bas>/embeddings med nyckel, modell, texterna och flyttal', async () => {
    const { fetch, anrop } = fejkFetch(() => svarMed([[1, 0], [0, 1]]));
    const embedder = createBergetEmbedder({ ...grund, fetch });
    const svar = await embedder.embed(['a', 'b']);
    expect(anrop).toHaveLength(1);
    expect(anrop[0]?.url).toBe('https://api.example.org/v1/embeddings');
    expect(anrop[0]?.init.method).toBe('POST');
    const huvuden = anrop[0]?.init.headers as Record<string, string>;
    expect(huvuden['authorization']).toBe('Bearer nyckel-123');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ model: grund.model, input: ['a', 'b'], encoding_format: 'float' });
    expect(svar.tokens).toBe(7);
    expect([...(svar.vectors[0] ?? [])]).toEqual([1, 0]);
    expect([...(svar.vectors[1] ?? [])]).toEqual([0, 1]);
  });

  it('räknar tokens själv om leverantören inte anger några', async () => {
    const { fetch } = fejkFetch(() => ok({ object: 'list', model: 'm', data: [{ object: 'embedding', index: 0, embedding: [1] }] }));
    const svar = await createBergetEmbedder({ ...grund, fetch }).embed(['abcdefgh']);
    expect(svar.tokens).toBeGreaterThan(0);
  });

  it.each([429, 500, 502, 503, 504])('status %i ⇒ unavailable, och felkroppen läses aldrig', async (status) => {
    const { fetch } = fejkFetch(() => new Response('{"error":{"message":"din text: hemlig"}}', { status }));
    const fel = await createBergetEmbedder({ ...grund, fetch }).embed(['hemlig']).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(EmbeddingError);
    expect((fel as EmbeddingError).code).toBe('unavailable');
    expect((fel as Error).message).not.toContain('hemlig');
  });

  it.each([400, 401, 403, 404])('status %i ⇒ config (inställningsfel hos oss, inte hos användaren)', async (status) => {
    const { fetch } = fejkFetch(() => new Response('', { status }));
    await expect(createBergetEmbedder({ ...grund, fetch }).embed(['x'])).rejects.toMatchObject({ code: 'config' });
  });

  it('nätverksfel ⇒ unavailable, utan det ursprungliga felet', async () => {
    const fetch = (async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1 nyckel-123');
    }) as typeof globalThis.fetch;
    const fel = await createBergetEmbedder({ ...grund, fetch }).embed(['x']).catch((e: unknown) => e);
    expect(fel).toMatchObject({ code: 'unavailable' });
    expect((fel as Error).message).not.toContain('nyckel');
    expect((fel as Error).cause).toBeUndefined();
  });

  it('tidsgräns ⇒ unavailable', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('avbruten', 'AbortError')));
      })) as typeof globalThis.fetch;
    await expect(createBergetEmbedder({ ...grund, timeoutMs: 20, fetch }).embed(['x'])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([
    ['inte JSON', new Response('<html>', { status: 200 })],
    ['fel antal', ok({ data: [{ index: 0, embedding: [1] }] })],
    ['saknat index', ok({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] })],
    ['ojämna dimensioner', ok({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }] })],
    ['inte tal', ok({ data: [{ index: 0, embedding: ['a'] }, { index: 1, embedding: ['b'] }] })],
    ['tom vektor', ok({ data: [{ index: 0, embedding: [] }, { index: 1, embedding: [] }] })],
    ['base64 i stället för flyttal', ok({ data: [{ index: 0, embedding: 'AAAA' }, { index: 1, embedding: 'AAAA' }] })],
  ])('oläsbart svar (%s) ⇒ bad_response', async (_namn, svar) => {
    const { fetch } = fejkFetch(() => svar);
    await expect(createBergetEmbedder({ ...grund, fetch }).embed(['a', 'b'])).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('vägrar starta utan nyckel, modell eller adress', () => {
    expect(() => createBergetEmbedder({ ...grund, apiKey: '' })).toThrow(EmbeddingError);
    expect(() => createBergetEmbedder({ ...grund, model: ' ' })).toThrow(EmbeddingError);
    expect(() => createBergetEmbedder({ ...grund, baseUrl: '' })).toThrow(EmbeddingError);
  });
});
