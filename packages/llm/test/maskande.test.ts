import { describe, expect, it } from 'vitest';
import { createFakeProvider, createMaskingProvider, LlmError } from '../src/index.ts';

const PNR = '900101-1234';

describe('createMaskingProvider', () => {
  it('maskar användarens meddelanden innan de når den inre leverantören', async () => {
    const inner = createFakeProvider(['ok']);
    const provider = createMaskingProvider(inner);
    const result = await provider.complete({
      messages: [
        { role: 'system', content: 'Du är en hjälpsam assistent.' },
        { role: 'user', content: `Elever, till exempel ${PNR}, ring 070-123 45 67 eller mejla anna@example.org` },
      ],
      maxTokens: 10,
      temperature: 0,
    });
    expect(result.text).toBe('ok');
    const sent = JSON.stringify(inner.requests);
    expect(sent).not.toContain(PNR);
    expect(sent).not.toContain('070-123 45 67');
    expect(sent).not.toContain('anna@example.org');
    expect(inner.requests[0]!.messages[1]!.content).toBe('Elever, till exempel [PERSONNUMMER], ring [TELEFON] eller mejla [E-POST]');
  });

  it('maskar inte systemprompten', async () => {
    const inner = createFakeProvider(['ok']);
    await createMaskingProvider(inner).complete({
      messages: [{ role: 'system', content: `Exempel: ${PNR}` }],
      maxTokens: 10,
      temperature: 0,
    });
    expect(inner.requests[0]!.messages[0]!.content).toBe(`Exempel: ${PNR}`);
  });

  it('maskar inte kod i fil-block, men väl texten runt dem', async () => {
    const inner = createFakeProvider(['ok']);
    const code = ['<vs-file path="src/App.tsx">', "const exempel = 'kontakt@example.org';", '</vs-file>'].join('\n');
    await createMaskingProvider(inner).complete({
      messages: [{ role: 'user', content: `${code}\nNytt önskemål: skriv till anna@example.org` }],
      maxTokens: 10,
      temperature: 0,
    });
    const sent = inner.requests[0]!.messages[0]!.content;
    expect(sent).toContain("const exempel = 'kontakt@example.org';");
    expect(sent).toContain('Nytt önskemål: skriv till [E-POST]');
  });

  it('maskar en ostängd blockrad som vanlig text (ingen väg runt maskningen)', async () => {
    const inner = createFakeProvider(['ok']);
    await createMaskingProvider(inner).complete({
      messages: [{ role: 'user', content: `<vs-file path="src/a.ts">\n${PNR}` }],
      maxTokens: 10,
      temperature: 0,
    });
    expect(inner.requests[0]!.messages[0]!.content).not.toContain(PNR);
  });

  it('är FAIL-CLOSED: kastar maskningen anropas aldrig den inre leverantören', async () => {
    const inner = createFakeProvider(['ok']);
    const provider = createMaskingProvider(inner, {
      mask: () => {
        throw new Error(`trasig maskning ${PNR}`);
      },
    });
    const error = await provider
      .complete({ messages: [{ role: 'user', content: PNR }], maxTokens: 10, temperature: 0 })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('masking_failed');
    expect(JSON.stringify({ m: (error as LlmError).message, c: String((error as LlmError).cause) })).not.toContain(PNR);
    expect(inner.requests).toHaveLength(0);
  });

  it('behåller den inre leverantörens namn och resultat', async () => {
    const inner = createFakeProvider([{ text: 'svar', finishReason: 'length' }], { model: 'x/y' });
    const provider = createMaskingProvider(inner);
    expect(provider.name).toBe(inner.name);
    expect(await provider.complete({ messages: [], maxTokens: 1, temperature: 0 })).toMatchObject({ text: 'svar', finishReason: 'length', model: 'x/y' });
  });
});
