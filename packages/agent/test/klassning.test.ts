import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeProvider, LlmError } from '@vibesandbox/llm';
import type { FakeProvider, FakeReply } from '@vibesandbox/llm';
import { buildClassificationMessages, CLASSIFICATION_LIMITS, createClassifier } from '../src/index.ts';
import type { ClassifierOptions } from '../src/index.ts';

const REQUEST = 'En sida där invånare bokar mötesrum i stadshuset';

function setup(script: readonly FakeReply[], options: Omit<ClassifierOptions, 'provider'> = {}): {
  readonly provider: FakeProvider;
  readonly classify: ReturnType<typeof createClassifier>;
} {
  const provider = createFakeProvider(script, { model: 'org/Modell-1' });
  return { provider, classify: createClassifier({ provider, ...options }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('klassningens meddelanden', () => {
  it('ger två meddelanden: ett till systemet och ett med beskrivningen', () => {
    const messages = buildClassificationMessages(REQUEST);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('lägger önskemålet i användarmeddelandet, aldrig i systemprompten', () => {
    // Skulle önskemålet hamna i systemprompten läser modellen det som instruktioner från
    // plattformen i stället för som text att bedöma. Markören bevisar var det tog vägen.
    const messages = buildClassificationMessages(`Bokning av rum ONSKEMAL-MARKOR-4711`);
    const [system, user] = messages;
    expect(user?.content).toContain('ONSKEMAL-MARKOR-4711');
    expect(system?.content).not.toContain('ONSKEMAL-MARKOR-4711');
  });

  it('kapar ett överlångt önskemål till taket', () => {
    // 'x' finns inte i ledtexten framför önskemålet, så körningen mäter bara önskemålet.
    const request = `${'x'.repeat(CLASSIFICATION_LIMITS.maxRequestChars)}SLUTMARKOR`;
    const user = buildClassificationMessages(request)[1];
    expect(user?.content).not.toContain('SLUTMARKOR');
    expect(/x+/.exec(user?.content ?? '')?.[0]).toHaveLength(CLASSIFICATION_LIMITS.maxRequestChars);
  });

  it('ger samma systemprompt oavsett önskemål', () => {
    const first = buildClassificationMessages('En lista över lediga lokaler');
    const second = buildClassificationMessages('Ett register över elevers frånvaro och diagnoser');
    expect(first[0]?.content).toBe(second[0]?.content);
    expect(first[1]?.content).not.toBe(second[1]?.content);
  });
});

describe('klassaren: den lyckliga vägen', () => {
  it('lämnar tillbaka modellens råa text', () => {
    // Filen tolkar ingenting — vilket ord som betyder vilken klass bor i @vibesandbox/policy.
    // Texten lämnas därför oförändrad; `trim` används bara för att avgöra om svaret är tomt.
    const { classify } = setup(['  kanslig\n']);
    return expect(classify(REQUEST)).resolves.toBe('  kanslig\n');
  });

  it('frågar utan slumpmässighet och med taket ur gränserna', async () => {
    const { provider, classify } = setup(['oppen']);
    await classify(REQUEST);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ temperature: 0, maxTokens: CLASSIFICATION_LIMITS.maxTokens });
    expect(provider.requests[0]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(provider.requests[0]?.messages[1]?.content).toContain(REQUEST);
  });

  it('låter en egen maxTokens slå igenom', async () => {
    const { provider, classify } = setup(['intern'], { maxTokens: 4 });
    await classify(REQUEST);
    expect(provider.requests[0]?.maxTokens).toBe(4);
  });

  it('låter en egen tidsgräns slå igenom', async () => {
    // Bevis: leverantören svarar aldrig, och ändå är vi klara långt före standardgränsen på 20 s.
    const { classify } = setup([{ hang: true }], { timeoutMs: 5 });
    const started = Date.now();
    await expect(classify(REQUEST)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(CLASSIFICATION_LIMITS.timeoutMs);
  });
});

describe('klassaren: allt som går fel ger null', () => {
  it('ett fel från leverantören', async () => {
    const { classify } = setup([new LlmError('unavailable')]);
    await expect(classify(REQUEST)).resolves.toBeNull();
  });

  it('ett avkapat svar tolkas aldrig, inte ens dess första ord', async () => {
    // "oppen, men uppgifterna om hälsa gör den kanslig" kapat efter första ordet skulle läsas
    // som den mildaste klassen. Ett avkapat svar är därför "vi vet inte".
    const { classify } = setup([{ text: 'oppen, men uppgifterna om hälsa gör den', finishReason: 'length' }]);
    await expect(classify(REQUEST)).resolves.toBeNull();
  });

  it('ett svar som slutade av något annat skäl än att modellen var färdig', async () => {
    const { classify } = setup([{ text: 'kanslig', finishReason: 'other' }]);
    await expect(classify(REQUEST)).resolves.toBeNull();
  });

  it.each([
    ['ett tomt svar', ''],
    ['ett svar med bara blanktecken', ' \n\t  '],
  ])('%s', async (_namn, text) => {
    const { classify } = setup([text]);
    await expect(classify(REQUEST)).resolves.toBeNull();
  });

  it('tidsgränsen löper ut innan leverantören svarar', async () => {
    const { classify } = setup([{ hang: true }], { timeoutMs: 5 });
    await expect(classify(REQUEST)).resolves.toBeNull();
  });

  it('en redan avbruten signal — då görs inget anrop alls', async () => {
    const { provider, classify } = setup(['kanslig']);
    await expect(classify(REQUEST, AbortSignal.abort())).resolves.toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it('signalen avbryts medan anropet pågår', async () => {
    const { classify } = setup([{ hang: true }]);
    const controller = new AbortController();
    const pending = classify(REQUEST, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).resolves.toBeNull();
  });
});

describe('klassningen läcker inte', () => {
  it('ett leverantörsfel kastas inte vidare och loggas inte', async () => {
    // Texten i ett leverantörsfel kan eka tillbaka det som skickades, alltså önskemålet.
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { classify } = setup([new Error(`400 från leverantören: ${REQUEST}`)]);

    await expect(classify(REQUEST)).resolves.toBeNull();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('lämnar ingen timer kvar efter ett lyckat anrop', async () => {
    // Klassningen görs vid varje önskemål; en kvarlämnad timer per anrop håller processen vaken.
    vi.useFakeTimers();
    const { classify } = setup(['oppen']);
    await expect(classify(REQUEST)).resolves.toBe('oppen');
    expect(vi.getTimerCount()).toBe(0);
  });
});
