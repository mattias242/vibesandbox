/**
 * Leverantör för OpenAI-kompatibla API:er (`POST <bas>/chat/completions`, strömmande SSE).
 *
 * Skrivet för öppna resonemangsmodeller bakom vLLM och liknande, med deras kända egenheter:
 * - tankar kan komma i `delta.reasoning_content`/`delta.reasoning` — de ignoreras helt;
 * - tankar kan läcka in i `content` som `<think>…</think>` — de skalas bort defensivt;
 * - `reasoning_effort` sätts uttryckligen, eftersom leverantörens standard ofta är högsta nivån,
 *   och `max_tokens` delas mellan tankar och svar.
 *
 * Omförsök sker bara INNAN strömmen har börjat: en halv ström går inte att återuppta, och ett
 * nytt anrop efter att text redan visats skulle ge dubbla framsteg och dubbel kostnad.
 */

import type { CompletionRequest, CompletionResult, LlmProvider } from '@vibesandbox/contracts';
import { LlmError } from './fel.ts';
import type { LlmErrorCode } from './fel.ts';
import { createSseParser } from './sse.ts';

export interface OpenAiCompatibleOptions {
  /** T.ex. `https://api.example.org/v1` — utan `/chat/completions`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Modellens FULLSTÄNDIGA id. Konfiguration, inte kod: modeller avvecklas med kort varsel. */
  readonly model: string;
  /** `low`, `medium` eller `high`. Sätt den: leverantörens standard är ofta högsta. */
  readonly reasoningEffort?: string | undefined;
  /** Tak för hela anropet, inklusive strömmen. */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  /** Namnet i `LlmProvider.name`. */
  readonly name?: string;
  /** För tester: hur väntan mellan omförsök görs. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Statuskoder som betyder "tillfälligt" och som därför är värda ett nytt försök. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_RETRY_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusCode(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

/** Väntetid före försök nummer `attempt + 1`: `Retry-After` om den finns, annars exponentiell. */
function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get('retry-after');
  if (header !== null && header !== undefined && header.trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/**
 * Skalar bort tankar ur svarstexten: hela `<think>…</think>`-block, allt före en ensam
 * `</think>` (när chattmallen själv öppnade taggen) och allt efter en ostängd `<think>`.
 */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const close = out.indexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  const open = out.indexOf('<think>');
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s*\n/, '');
}

function mapFinishReason(reason: string | undefined): CompletionResult['finishReason'] {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  if (options.apiKey.trim() === '' || options.model.trim() === '' || options.baseUrl.trim() === '') {
    throw new LlmError('config');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new LlmError('config');

  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  async function send(request: CompletionRequest, signal: AbortSignal, abortCode: () => LlmErrorCode): Promise<Response> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.reasoningEffort !== undefined) body['reasoning_effort'] = options.reasoningEffort;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    };

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchFn(url, init);
      } catch {
        // Det ursprungliga felet släpps medvetet: det kan bära adress och rubriker.
        if (signal.aborted) throw new LlmError(abortCode());
        if (attempt >= MAX_RETRIES) throw new LlmError('network');
        await wait(retryDelay(undefined, attempt), signal, abortCode);
        continue;
      }
      if (response.ok) return response;
      // Felkroppen läses aldrig: den kan eka prompten.
      await response.body?.cancel().catch(() => undefined);
      if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await wait(retryDelay(response, attempt), signal, abortCode);
        continue;
      }
      throw new LlmError(statusCode(response.status), { status: response.status });
    }
  }

  async function wait(ms: number, signal: AbortSignal, abortCode: () => LlmErrorCode): Promise<void> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new LlmError(abortCode()));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw new LlmError(abortCode());
  }

  async function read(response: Response, request: CompletionRequest, signal: AbortSignal, abortCode: () => LlmErrorCode): Promise<CompletionResult> {
    if (response.body === null) throw new LlmError('bad_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    let text = '';
    let finishReason: string | undefined;
    let model = options.model;
    let usage: CompletionResult['usage'];
    let done = false;

    function handle(data: string): void {
      if (done) return;
      if (data.trim() === '[DONE]') {
        done = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new LlmError('bad_response');
      }
      if (!isRecord(parsed) || 'error' in parsed) throw new LlmError('bad_response');
      if (typeof parsed['model'] === 'string' && parsed['model'] !== '') model = parsed['model'];
      const rawUsage = parsed['usage'];
      if (isRecord(rawUsage) && typeof rawUsage['prompt_tokens'] === 'number' && typeof rawUsage['completion_tokens'] === 'number') {
        usage = { inputTokens: rawUsage['prompt_tokens'], outputTokens: rawUsage['completion_tokens'] };
      }
      const choices = parsed['choices'];
      const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
      if (!isRecord(choice)) return;
      // BARA content. Tankefälten (reasoning_content, reasoning) läses aldrig.
      const delta = choice['delta'];
      if (isRecord(delta) && typeof delta['content'] === 'string' && delta['content'] !== '') {
        text += delta['content'];
        request.onText?.(delta['content']);
      }
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
    }

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        for (const data of parser.push(decoder.decode(value, { stream: true }))) handle(data);
      }
      if (!done) {
        for (const data of parser.push(decoder.decode())) handle(data);
        for (const data of parser.end()) handle(data);
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (signal.aborted) throw new LlmError(abortCode());
      throw new LlmError('network');
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const result: { text: string; finishReason: CompletionResult['finishReason']; model: string; usage?: NonNullable<CompletionResult['usage']> } = {
      text: stripThinking(text),
      finishReason: mapFinishReason(finishReason),
      model,
    };
    if (usage !== undefined) result.usage = usage;
    return result;
  }

  return {
    name: options.name ?? 'openai-compatible',
    async complete(request) {
      if (request.signal?.aborted === true) throw new LlmError('aborted');
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      // Anroparens avbrott har företräde: då är det inte leverantören som var långsam.
      const abortCode = (): LlmErrorCode => (request.signal?.aborted === true ? 'aborted' : 'timeout');
      const response = await send(request, signal, abortCode);
      return read(response, request, signal, abortCode);
    },
  };
}
