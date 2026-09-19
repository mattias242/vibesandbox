/**
 * Tjänsten `llm` för appar (`/_api/llm`): be plattformens språkmodell om en text.
 *
 *   import { llm } from '@vibesandbox/sdk';
 *   const sammanfattning = await llm.complete(`Sammanfatta kort:\n${arende}`);
 *   const { kategori } = await llm.completeJson<{ kategori: string }>(messages);
 *
 * Personuppgifter med en känd form (personnummer, telefon, e-post, kort, IBAN) maskas av
 * plattformen innan texten lämnar servern, och svaret innehåller då platshållare som
 * `[PERSONNUMMER]`. Dokumentationen för byggagenten står i packages/sdk/tjanster/llm.md.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmOptions {
  /** Högst så många tokens i svaret (1–4000). Standard: 1000. */
  readonly maxTokens?: number;
  /** 0 (sakligt, förutsägbart) till 2 (friare). Standard: 0.2. */
  readonly temperature?: number;
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(input: string | readonly LlmMessage[], options: LlmOptions, format?: 'json'): Promise<string> {
  const empty = typeof input === 'string' ? input.trim() === '' : input.length === 0;
  if (empty) throw new SdkError('invalid_request', 'Texten till språkmodellen är tom.');

  const body: Record<string, unknown> = typeof input === 'string' ? { prompt: input } : { messages: input };
  if (options.maxTokens !== undefined) body['maxTokens'] = options.maxTokens;
  if (options.temperature !== undefined) body['temperature'] = options.temperature;
  if (format !== undefined) body['format'] = format;

  const response = await callService('llm', 'POST', '/complete', {
    json: body,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (!isRecord(response) || typeof response['text'] !== 'string') throw new SdkError('internal');
  return response['text'];
}

/**
 * Ber språkmodellen om en text. `input` är antingen en text (blir användarens meddelande) eller
 * en lista med meddelanden. Ger svarstexten.
 */
export function complete(input: string | readonly LlmMessage[], options: LlmOptions = {}): Promise<string> {
  return request(input, options);
}

/**
 * Som `complete`, men språkmodellen ombeds svara med JSON och svaret tolkas. Beskriv den form du
 * vill ha i din text — och kontrollera värdet innan du använder det: `T` är ett löfte från
 * modellen, inte en garanti.
 */
export async function completeJson<T = unknown>(input: string | readonly LlmMessage[], options: LlmOptions = {}): Promise<T> {
  const text = await request(input, options, 'json');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SdkError('internal', 'Språkmodellens svar gick inte att använda. Försök igen.');
  }
}
