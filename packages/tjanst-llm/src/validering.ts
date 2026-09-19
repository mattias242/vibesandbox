/**
 * Tolkning av `POST /_api/llm/complete`. Allt som kommer från appen är opålitligt: strikt form,
 * inga okända fält, gränser på antal meddelanden, total textlängd och tokens. Ett fel ger ett
 * meddelande i klarspråk som appen kan visa — det innehåller aldrig något av det appen skickade.
 */
import type { ChatMessage } from '@vibesandbox/contracts';

export const MAX_MESSAGES = 50;
/** Summan av alla meddelandens längd. Räcker för ett långt ärende; mer blir dyrt och långsamt. */
export const MAX_TOTAL_CHARS = 40_000;
export const MAX_OUTPUT_TOKENS = 4_000;
export const DEFAULT_MAX_TOKENS = 1_000;
/** Lågt som standard: appar vill oftast ha sakliga, förutsägbara svar (sammanfatta, klassificera). */
export const DEFAULT_TEMPERATURE = 0.2;
/**
 * Kroppens tak. JSON kan koda ett tecken som `\uXXXX` (6 byte), så taket rymmer `MAX_TOTAL_CHARS`
 * med marginal; längre text avvisas redan av gatewayn (413) utan att läsas in.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export type ResponseFormat = 'text' | 'json';

export interface CompleteRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly format: ResponseFormat;
}

export type Parsed = { readonly ok: true; readonly request: CompleteRequest } | { readonly ok: false; readonly message: string };

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);
const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(['prompt', 'messages', 'maxTokens', 'temperature', 'format']);
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['role', 'content']);

function fail(message: string): Parsed {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** NUL och ensamma surrogattecken: inget en människa skrivit, men väl något som kan förvirra en tolk längre fram. */
function badText(text: string): boolean {
  return text.includes('\u0000') || !text.isWellFormed();
}

export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(value.trim());
}

export function parseCompleteRequest(body: Uint8Array | undefined): Parsed {
  if (body === undefined || body.byteLength === 0) return fail('Förfrågan saknar innehåll. Skicka en text i "prompt" eller en lista i "messages".');

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return fail('Förfrågan är inte giltig JSON.');
  }
  if (!isPlainObject(value)) return fail('Förfrågan ska vara ett JSON-objekt.');
  // Object.keys ser även en egen nyckel "__proto__" (JSON.parse skapar en sådan) — den avvisas här.
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(key)) return fail('Förfrågan innehåller ett okänt fält. Tillåtna är prompt, messages, maxTokens, temperature och format.');
  }

  const hasPrompt = value['prompt'] !== undefined;
  const hasMessages = value['messages'] !== undefined;
  if (hasPrompt === hasMessages) return fail('Ange antingen "prompt" (en text) eller "messages" (en lista), inte båda och inte ingen.');

  let messages: ChatMessage[];
  if (hasPrompt) {
    const prompt = value['prompt'];
    if (typeof prompt !== 'string' || prompt.trim() === '') return fail('"prompt" ska vara en text som inte är tom.');
    messages = [{ role: 'user', content: prompt }];
  } else {
    const raw = value['messages'];
    if (!Array.isArray(raw) || raw.length === 0) return fail('"messages" ska vara en lista med minst ett meddelande.');
    if (raw.length > MAX_MESSAGES) return fail(`Högst ${MAX_MESSAGES} meddelanden får skickas åt gången.`);
    messages = [];
    for (const entry of raw) {
      if (!isPlainObject(entry) || Object.keys(entry).some((key) => !MESSAGE_FIELDS.has(key))) {
        return fail('Varje meddelande ska ha exakt fälten "role" och "content".');
      }
      const { role, content } = entry;
      if (typeof role !== 'string' || !ROLES.has(role)) return fail('Rollen i ett meddelande ska vara "system", "user" eller "assistant".');
      if (typeof content !== 'string') return fail('Innehållet i ett meddelande ska vara en text.');
      messages.push({ role: role as ChatMessage['role'], content });
    }
    if (!messages.some((m) => m.role === 'user' && m.content.trim() !== '')) {
      return fail('Minst ett meddelande med rollen "user" och en text behövs.');
    }
  }

  let total = 0;
  for (const m of messages) {
    if (badText(m.content)) return fail('Texten innehåller tecken som inte är tillåtna.');
    total += m.content.length;
  }
  if (total > MAX_TOTAL_CHARS) return fail(`Texten är för lång. Högst ${MAX_TOTAL_CHARS.toLocaleString('sv-SE')} tecken får skickas åt gången.`);

  const maxTokens = value['maxTokens'] ?? DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
    return fail(`"maxTokens" ska vara ett heltal mellan 1 och ${MAX_OUTPUT_TOKENS}.`);
  }
  const temperature = value['temperature'] ?? DEFAULT_TEMPERATURE;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return fail('"temperature" ska vara ett tal mellan 0 och 2.');
  }
  const format = value['format'] ?? 'text';
  if (format !== 'text' && format !== 'json') return fail('"format" ska vara "text" eller "json".');

  return { ok: true, request: { messages, maxTokens, temperature, format } };
}
