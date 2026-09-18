import { describe, expect, it } from 'vitest';
import type { CompletionRequest } from '@vibesandbox/contracts';
import { createFakeProvider, LlmError } from '../src/index.ts';

function request(content: string, extra: Partial<CompletionRequest> = {}): CompletionRequest {
  return { messages: [{ role: 'user', content }], maxTokens: 100, temperature: 0, ...extra };
}

describe('createFakeProvider', () => {
  it('svarar med de inspelade texterna i tur och ordning', async () => {
    const provider = createFakeProvider(['första', { text: 'andra', finishReason: 'length' }]);
    expect(await provider.complete(request('a'))).toMatchObject({ text: 'första', finishReason: 'stop' });
    expect(await provider.complete(request('b'))).toMatchObject({ text: 'andra', finishReason: 'length' });
  });

  it('strömmar texten i flera bitar via onText', async () => {
    const text = 'x'.repeat(500);
    const chunks: string[] = [];
    await createFakeProvider([text]).complete(request('a', { onText: (c) => chunks.push(c) }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('spelar in alla förfrågningar, som kopior', async () => {
    const provider = createFakeProvider(['a', 'b']);
    const messages = [{ role: 'user' as const, content: 'hej' }];
    await provider.complete({ messages, maxTokens: 10, temperature: 0.2 });
    await provider.complete(request('igen'));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({ maxTokens: 10, temperature: 0.2, messages: [{ role: 'user', content: 'hej' }] });
    messages[0]!.content = 'ändrad';
    expect(provider.requests[0]!.messages[0]!.content).toBe('hej');
  });

  it('har ett modell-id och kan ange usage', async () => {
    const provider = createFakeProvider([{ text: 'a', usage: { inputTokens: 5, outputTokens: 1 } }], { model: 'fejk/Modell' });
    expect(await provider.complete(request('a'))).toEqual({
      text: 'a',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 1 },
      model: 'fejk/Modell',
    });
  });

  it('kastar LlmError när manuset är slut', async () => {
    const provider = createFakeProvider([]);
    await expect(provider.complete(request('a'))).rejects.toBeInstanceOf(LlmError);
  });

  it('kan spela upp ett fel', async () => {
    const provider = createFakeProvider([new LlmError('unavailable')]);
    await expect(provider.complete(request('a'))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('kan hänga tills anroparen avbryter', async () => {
    const provider = createFakeProvider([{ hang: true }]);
    const controller = new AbortController();
    const pending = provider.complete(request('a', { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('respekterar en redan avbruten signal', async () => {
    const provider = createFakeProvider(['a']);
    await expect(provider.complete(request('a', { signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'aborted' });
  });
});
