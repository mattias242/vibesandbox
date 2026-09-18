/**
 * Inspelad språkmodell för tester och scenarier: svarar med förbestämda texter i tur och
 * ordning, strömmar dem i bitar som en riktig leverantör och spelar in varje förfrågan så att
 * testet kan kontrollera exakt vad som skulle ha lämnat servern.
 */

import type { ChatMessage, CompletionRequest, CompletionResult, LlmProvider } from '@vibesandbox/contracts';
import { LlmError } from './fel.ts';

export type FakeReply =
  | string
  | {
      readonly text: string;
      readonly finishReason?: CompletionResult['finishReason'];
      readonly usage?: CompletionResult['usage'];
    }
  /** Hänger tills anroparen avbryter — för att testa avbrott. */
  | { readonly hang: true }
  | Error;

/** Det som spelades in: allt utom callback och signal, som kopior. */
export interface RecordedRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
}

export interface FakeProvider extends LlmProvider {
  readonly requests: readonly RecordedRequest[];
}

const CHUNK_SIZE = 64;

export function createFakeProvider(script: readonly FakeReply[], options: { readonly model?: string } = {}): FakeProvider {
  const queue = [...script];
  const requests: RecordedRequest[] = [];
  const model = options.model ?? 'fake/inspelad';

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.signal?.aborted === true) throw new LlmError('aborted');
    requests.push({
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    });
    const reply = queue.shift();
    if (reply === undefined) throw new LlmError('script_exhausted');
    if (reply instanceof Error) throw reply;
    if (typeof reply !== 'string' && 'hang' in reply) {
      const signal = request.signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new LlmError('aborted')), { once: true });
      });
    }
    const text = typeof reply === 'string' ? reply : reply.text;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      request.onText?.(text.slice(i, i + CHUNK_SIZE));
    }
    const result: { text: string; finishReason: CompletionResult['finishReason']; model: string; usage?: NonNullable<CompletionResult['usage']> } = {
      text,
      finishReason: typeof reply === 'string' ? 'stop' : (reply.finishReason ?? 'stop'),
      model,
    };
    if (typeof reply !== 'string' && reply.usage !== undefined) result.usage = reply.usage;
    return result;
  }

  return { name: 'fake', requests, complete };
}
