/**
 * Klient för Bergets OpenAI-kompatibla `POST <bas>/embeddings`
 * (https://api.berget.ai/openapi.json: `{ model, input: string[], encoding_format }` →
 * `{ data: [{ index, embedding }], usage: { prompt_tokens, total_tokens } }`).
 *
 * `@vibesandbox/llm` har bara en klient för `/chat/completions` (strömmande SSE) — den går inte
 * att återanvända här, så det här är en minimal klient med `fetch`. Samma regler som där:
 * leverantörens felkroppar läses aldrig (de kan eka texten), och det ursprungliga felet släpps
 * (det kan bära adress och rubriker med nyckeln). Maskning görs INNAN texten når hit (tjanst.ts).
 */

export type EmbeddingErrorCode = 'unavailable' | 'bad_response' | 'config';

const MESSAGES: Readonly<Record<EmbeddingErrorCode, string>> = {
  unavailable: 'Tjänsten för inbäddningar svarar inte just nu.',
  bad_response: 'Tjänsten för inbäddningar gav ett svar som inte gick att läsa.',
  config: 'Tjänsten för inbäddningar är inte rätt inställd på servern.',
};

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode) {
    super(MESSAGES[code]);
    this.name = 'EmbeddingError';
    this.code = code;
  }
}

export interface EmbeddingResult {
  /** En vektor per text, i samma ordning som texterna. */
  readonly vectors: readonly Float32Array[];
  /** Förbrukade tokens enligt leverantören (eller vår egen uppskattning om den inte anger det). */
  readonly tokens: number;
}

/** Utbytbar: Berget i drift, en fejk i tester. Texterna är redan maskade och försedda med prefix. */
export interface Embedder {
  /** Modellens fullständiga id. Ingår i indexets nyckel: vektorer från olika modeller jämförs aldrig. */
  readonly model: string;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

export interface BergetEmbedderOptions {
  /** T.ex. `https://api.berget.ai/v1` — utan `/embeddings`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/**
 * Grov, medvetet hög uppskattning när leverantören inte anger tokens: hellre räkna för mycket mot
 * kvoten än för lite.
 */
export function estimateTokens(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + Math.ceil(text.length / 2) + 2, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(body: unknown, count: number): EmbeddingResult {
  if (!isRecord(body) || !Array.isArray(body['data']) || body['data'].length !== count) throw new EmbeddingError('bad_response');
  const vectors: (Float32Array | undefined)[] = new Array(count).fill(undefined);
  let dimensions: number | undefined;
  for (const item of body['data'] as unknown[]) {
    if (!isRecord(item)) throw new EmbeddingError('bad_response');
    const index = item['index'];
    const embedding = item['embedding'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || vectors[index] !== undefined) {
      throw new EmbeddingError('bad_response');
    }
    if (!Array.isArray(embedding) || embedding.length === 0 || (dimensions !== undefined && embedding.length !== dimensions)) {
      throw new EmbeddingError('bad_response');
    }
    dimensions = embedding.length;
    const vector = new Float32Array(embedding.length);
    for (let i = 0; i < embedding.length; i += 1) {
      const value: unknown = embedding[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new EmbeddingError('bad_response');
      vector[i] = value;
    }
    vectors[index] = vector;
  }
  const usage = body['usage'];
  const tokens = isRecord(usage) && typeof usage['total_tokens'] === 'number' && Number.isFinite(usage['total_tokens']) && usage['total_tokens'] >= 0
    ? usage['total_tokens']
    : undefined;
  return { vectors: vectors as Float32Array[], tokens: tokens ?? -1 };
}

export function createBergetEmbedder(options: BergetEmbedderOptions): Embedder {
  if (options.apiKey.trim() === '' || options.model.trim() === '' || options.baseUrl.trim() === '') throw new EmbeddingError('config');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new EmbeddingError('config');
  let baseUrl = options.baseUrl;
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  const url = `${baseUrl}/embeddings`;
  const fetchFn = options.fetch ?? fetch;

  return {
    model: options.model,
    async embed(texts) {
      const signal = AbortSignal.timeout(options.timeoutMs);
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ model: options.model, input: texts, encoding_format: 'float' }),
          signal,
          redirect: 'error',
        });
      } catch {
        throw new EmbeddingError('unavailable');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // 429 och 5xx är tillfälliga hos leverantören; övriga betyder att VÅR förfrågan eller
        // nyckel är fel — inget användaren kan göra något åt, men lika fullt "går inte just nu".
        throw new EmbeddingError(response.status === 429 || response.status >= 500 ? 'unavailable' : 'config');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new EmbeddingError(signal.aborted ? 'unavailable' : 'bad_response');
      }
      const result = parse(body, texts.length);
      return result.tokens >= 0 ? result : { vectors: result.vectors, tokens: estimateTokens(texts) };
    },
  };
}
