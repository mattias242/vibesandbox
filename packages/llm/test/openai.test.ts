import { describe, expect, it } from 'vitest';
import type { CompletionRequest } from '@vibesandbox/contracts';
import { createOpenAiCompatibleProvider, LlmError } from '../src/index.ts';

const KEY = 'sk-hemlig-nyckel-123';
const PROMPT = 'Hemlig prompt om Anna';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** Ett SSE-svar i de bitar som anges — byte-gränser kan hamna var som helst. */
function sse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function delta(content: string, extra: Record<string, unknown> = {}): string {
  return event({ model: 'org/Modell-1', choices: [{ index: 0, delta: { content, ...extra } }] });
}

function finish(reason: string): string {
  return event({ model: 'org/Modell-1', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

const USAGE = event({ model: 'org/Modell-1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } });

function fakeFetch(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestInit = init ?? {};
    calls.push({ url: String(input), init: requestInit, body: JSON.parse(String(requestInit.body)) as Record<string, unknown> });
    const next = responses.shift();
    if (next === undefined) throw new Error('inget fler svar');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(requestInit);
    return next;
  };
  return { fn: fn as typeof fetch, calls };
}

function request(extra: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: PROMPT },
    ],
    maxTokens: 800,
    temperature: 0.2,
    ...extra,
  };
}

function provider(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  const p = createOpenAiCompatibleProvider({
    baseUrl: 'https://llm.example.org/v1/',
    apiKey: KEY,
    model: 'org/Modell-1',
    reasoningEffort: 'low',
    timeoutMs: 5000,
    fetch: fetchFn,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { p, sleeps };
}

async function caught(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error('förväntade ett fel');
}

/** Inget i felet får röja nyckel, prompt eller svarstext. */
function expectNoSecrets(error: LlmError, ...secrets: string[]): void {
  const everything = JSON.stringify({ message: error.message, code: error.code, cause: String(error.cause), stack: error.stack });
  for (const secret of [KEY, PROMPT, ...secrets]) expect(everything).not.toContain(secret);
  expect(error.cause).toBeUndefined();
}

describe('createOpenAiCompatibleProvider', () => {
  it('skickar en strömmande förfrågan med modell, tankenivå och nyckel', async () => {
    const { fn, calls } = fakeFetch([sse([delta('hej'), finish('stop'), USAGE, 'data: [DONE]\n\n'])]);
    await provider(fn).p.complete(request());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://llm.example.org/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');
    expect(call.body).toEqual({
      model: 'org/Modell-1',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: PROMPT },
      ],
      max_tokens: 800,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'low',
    });
  });

  it('utelämnar reasoning_effort när den inte är konfigurerad', async () => {
    const { fn, calls } = fakeFetch([sse([delta('x'), finish('stop')])]);
    await provider(fn, { reasoningEffort: undefined }).p.complete(request());
    expect(calls[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('sätter ihop texten, strömmar bitarna och läser usage och modell', async () => {
    const { fn } = fakeFetch([
      sse([delta('Hej '), delta('värl'), 'data: {"model":"org/Modell-1","choices":[{"delta":{"content":"d"}}]}\n', '\n', finish('stop'), USAGE, 'data: [DONE]\n\n']),
    ]);
    const chunks: string[] = [];
    const result = await provider(fn).p.complete(request({ onText: (c) => chunks.push(c) }));
    expect(result).toEqual({ text: 'Hej värld', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 40 }, model: 'org/Modell-1' });
    expect(chunks.join('')).toBe('Hej värld');
  });

  it('klarar ett multibytetecken som delas mellan två nätverksbitar', async () => {
    const bytes = new TextEncoder().encode(delta('åäö') + finish('stop'));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 32));
        controller.enqueue(bytes.slice(32));
        controller.close();
      },
    });
    const { fn } = fakeFetch([new Response(stream, { status: 200 })]);
    const result = await provider(fn).p.complete(request());
    expect(result.text).toBe('åäö');
  });

  it('ignorerar tankefälten reasoning_content och reasoning', async () => {
    const { fn } = fakeFetch([
      sse([
        event({ choices: [{ delta: { reasoning_content: 'jag tänker' } }] }),
        event({ choices: [{ delta: { reasoning: 'mer tankar' } }] }),
        delta('svar'),
        finish('stop'),
      ]),
    ]);
    const chunks: string[] = [];
    const result = await provider(fn).p.complete(request({ onText: (c) => chunks.push(c) }));
    expect(result.text).toBe('svar');
    expect(chunks.join('')).toBe('svar');
  });

  it('tar bort <think>…</think> ur content', async () => {
    const { fn } = fakeFetch([sse([delta('<think>hemliga\ntankar</think>\n'), delta('svar'), finish('stop')])]);
    expect((await provider(fn).p.complete(request())).text).toBe('svar');
  });

  it('tar bort tankar före en ensam </think> (mallen öppnade taggen)', async () => {
    const { fn } = fakeFetch([sse([delta('tankar här</think>svar'), finish('stop')])]);
    expect((await provider(fn).p.complete(request())).text).toBe('svar');
  });

  it('tar bort flera <think>-block och behåller texten mellan dem', async () => {
    const { fn } = fakeFetch([sse([delta('<think>a</think>ett <think>b</think>två'), finish('stop')])]);
    expect((await provider(fn).p.complete(request())).text).toBe('ett två');
  });

  it('tar bort tankar i linjär tid även när svaret är fullt av ostängda <think>', async () => {
    const { fn } = fakeFetch([sse([delta(`svar${'<think>'.repeat(40_000)}`), finish('length')])]);
    const start = performance.now();
    expect((await provider(fn).p.complete(request())).text).toBe('svar');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('tar bort en ostängd <think> till slutet', async () => {
    const { fn } = fakeFetch([sse([delta('svar<think>tankar som aldrig tog slut'), finish('length')])]);
    const result = await provider(fn).p.complete(request());
    expect(result.text).toBe('svar');
    expect(result.finishReason).toBe('length');
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'other'],
    ['tool_calls', 'other'],
  ])('mappar finish_reason %s till %s', async (raw, expected) => {
    const { fn } = fakeFetch([sse([delta('x'), finish(raw)])]);
    expect((await provider(fn).p.complete(request())).finishReason).toBe(expected);
  });

  it('ger other när strömmen tar slut utan finish_reason', async () => {
    const { fn } = fakeFetch([sse([delta('x')])]);
    expect((await provider(fn).p.complete(request())).finishReason).toBe('other');
  });

  it('saknar usage när leverantören inte skickar det, och faller tillbaka på konfigurerat modell-id', async () => {
    const { fn } = fakeFetch([sse([event({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })])]);
    const result = await provider(fn).p.complete(request());
    expect(result.usage).toBeUndefined();
    expect(result.model).toBe('org/Modell-1');
  });

  it.each([429, 502, 503, 504])('försöker igen vid %i', async (status) => {
    const { fn, calls } = fakeFetch([new Response('upptagen', { status }), sse([delta('ok'), finish('stop')])]);
    const { p, sleeps } = provider(fn);
    expect((await p.complete(request())).text).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('försöker högst två gånger till och ger sedan rate_limited', async () => {
    const { fn, calls } = fakeFetch([
      new Response(`nyckel ${KEY}`, { status: 429 }),
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      sse([delta('aldrig'), finish('stop')]),
    ]);
    const { p, sleeps } = provider(fn);
    const error = await caught(p.complete(request()));
    expect(error.code).toBe('rate_limited');
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expectNoSecrets(error);
  });

  it('respekterar Retry-After i sekunder, med tak på 10 s', async () => {
    const { fn } = fakeFetch([
      new Response('', { status: 503, headers: { 'retry-after': '3' } }),
      new Response('', { status: 503, headers: { 'retry-after': '120' } }),
      sse([delta('ok'), finish('stop')]),
    ]);
    const { p, sleeps } = provider(fn);
    await p.complete(request());
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it('respekterar Retry-After som datum', async () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const { fn } = fakeFetch([new Response('', { status: 429, headers: { 'retry-after': future } }), sse([delta('ok'), finish('stop')])]);
    const { p, sleeps } = provider(fn);
    await p.complete(request());
    expect(sleeps[0]).toBeGreaterThan(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(4000);
  });

  it.each([
    [400, 'bad_request'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'bad_request'],
    [500, 'unavailable'],
  ])('försöker inte igen vid %i utan ger %s', async (status, code) => {
    const { fn, calls } = fakeFetch([new Response(`{"error":"${PROMPT} ${KEY}"}`, { status })]);
    const error = await caught(provider(fn).p.complete(request()));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
    expectNoSecrets(error);
  });

  it('försöker igen vid nätverksfel före svaret', async () => {
    const { fn, calls } = fakeFetch([new TypeError('fetch failed'), sse([delta('ok'), finish('stop')])]);
    expect((await provider(fn).p.complete(request())).text).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('försöker ALDRIG igen när strömmen väl har börjat', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta('början')));
        controller.error(new Error(`anslutningen bröts ${KEY}`));
      },
    });
    const { fn, calls } = fakeFetch([new Response(stream, { status: 200 }), sse([delta('ok'), finish('stop')])]);
    const error = await caught(provider(fn).p.complete(request()));
    expect(error.code).toBe('network');
    expect(calls).toHaveLength(1);
    expectNoSecrets(error, 'början');
  });

  it('ger bad_response för trasig JSON i strömmen utan att röja innehållet', async () => {
    const { fn } = fakeFetch([sse([delta('hemligt svar'), 'data: {inte json hemligt svar\n\n'])]);
    const error = await caught(provider(fn).p.complete(request()));
    expect(error.code).toBe('bad_response');
    expectNoSecrets(error, 'hemligt svar');
  });

  it('ger bad_response när leverantören skickar ett fel i strömmen', async () => {
    const { fn } = fakeFetch([sse([event({ error: { message: `överbelastad ${PROMPT}` } })])]);
    const error = await caught(provider(fn).p.complete(request()));
    expect(error.code).toBe('bad_response');
    expectNoSecrets(error);
  });

  it('ger timeout när svaret dröjer för länge', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const { fn } = fakeFetch([hang]);
    const error = await caught(provider(fn, { timeoutMs: 20 }).p.complete(request()));
    expect(error.code).toBe('timeout');
    expectNoSecrets(error);
  });

  it('ger aborted när anroparen avbryter, och försöker inte igen', async () => {
    const controller = new AbortController();
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        setTimeout(() => controller.abort(), 5);
      });
    const { fn, calls } = fakeFetch([hang, sse([delta('ok'), finish('stop')])]);
    const error = await caught(provider(fn).p.complete(request({ signal: controller.signal })));
    expect(error.code).toBe('aborted');
    expect(calls).toHaveLength(1);
  });

  it('anropar inte alls när signalen redan är avbruten', async () => {
    const { fn, calls } = fakeFetch([sse([delta('ok'), finish('stop')])]);
    const error = await caught(provider(fn).p.complete(request({ signal: AbortSignal.abort() })));
    expect(error.code).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('har felmeddelanden på svenska', async () => {
    const { fn } = fakeFetch([new Response('', { status: 401 })]);
    const error = await caught(provider(fn).p.complete(request()));
    expect(error.message).toMatch(/språkmodell/i);
  });

  it('vägrar starta utan nyckel eller modell', () => {
    const { fn } = fakeFetch([]);
    expect(() => provider(fn, { apiKey: '' })).toThrow(LlmError);
    expect(() => provider(fn, { model: '' })).toThrow(LlmError);
  });
});
