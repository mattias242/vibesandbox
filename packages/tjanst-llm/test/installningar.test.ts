/**
 * Fabriken: tjänsten startar bara när den är rätt inställd, och säger annars i klarspråk vad som
 * saknas — vid start, aldrig vid första förfrågan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factory } from '../src/index.ts';
import { readSettings } from '../src/installningar.ts';
import { skapaTestmiljo } from './hjalp.ts';
import type { Testmiljo } from './hjalp.ts';

let miljo: Testmiljo;
beforeEach(async () => {
  miljo = await skapaTestmiljo();
});
afterEach(async () => {
  await miljo.stada();
});

function felVidStart(env: Record<string, string | undefined>, berget?: null): string {
  try {
    const instans = factory(miljo.beroenden(env, berget));
    void instans.service.close?.();
  } catch (fel) {
    return (fel as Error).message;
  }
  throw new Error('Fabriken startade trots felaktiga inställningar.');
}

describe('fabriken', () => {
  it('skapar tjänsten "llm" med en begränsad kroppsstorlek', async () => {
    const { service } = factory(miljo.beroenden());
    expect(service.name).toBe('llm');
    expect(service.maxBodyBytes).toBeGreaterThan(0);
    expect(service.maxBodyBytes).toBeLessThanOrEqual(512 * 1024);
    await service.close?.();
  });

  it('kräver SVC_LLM_MODEL och säger det i klarspråk', () => {
    expect(felVidStart({})).toContain('SVC_LLM_MODEL');
    expect(felVidStart({ SVC_LLM_MODEL: '   ' })).toContain('SVC_LLM_MODEL');
  });

  it('kräver en nyckel till Berget', () => {
    expect(felVidStart({ SVC_LLM_MODEL: 'm' }, null)).toMatch(/Berget|BERGET_API_KEY/);
  });

  it.each([
    ['SVC_LLM_TOKENS_PER_APP_DAY', 'många'],
    ['SVC_LLM_TOKENS_PER_APP_DAY', '0'],
    ['SVC_LLM_TOKENS_PER_APP_DAY', '-5'],
    ['SVC_LLM_TOKENS_PER_USER_HOUR', '1.5'],
    ['SVC_LLM_TOKENS_PER_USER_HOUR', '1e6'],
    ['SVC_LLM_TIMEOUT_MS', '10'],
    ['SVC_LLM_TIMEOUT_MS', '99999999'],
    ['SVC_LLM_REASONING_EFFORT', 'maximal'],
  ])('avvisar %s=%s och nämner inställningen', (namn, varde) => {
    expect(felVidStart({ SVC_LLM_MODEL: 'm', [namn]: varde })).toContain(namn);
  });
});

describe('inställningarna', () => {
  it('har rimliga standardvärden', () => {
    const s = readSettings({ SVC_LLM_MODEL: ' zai-org/GLM-5.3-Flash ' });
    expect(s.model).toBe('zai-org/GLM-5.3-Flash');
    expect(s.tokensPerAppDay).toBe(200_000);
    expect(s.tokensPerUserHour).toBe(20_000);
    expect(s.timeoutMs).toBe(60_000);
    expect(s.reasoningEffort).toBe('low');
  });

  it('läser egna värden', () => {
    const s = readSettings({
      SVC_LLM_MODEL: 'm',
      SVC_LLM_TOKENS_PER_APP_DAY: '5000',
      SVC_LLM_TOKENS_PER_USER_HOUR: '700',
      SVC_LLM_TIMEOUT_MS: '1000',
      SVC_LLM_REASONING_EFFORT: 'medium',
    });
    expect(s).toMatchObject({ tokensPerAppDay: 5000, tokensPerUserHour: 700, timeoutMs: 1000, reasoningEffort: 'medium' });
  });

  it('läser bara sina egna variabler', () => {
    const s = readSettings({ SVC_LLM_MODEL: 'm', LLM_MODEL: 'annan', SVC_OCR_TIMEOUT_MS: '5' });
    expect(s.model).toBe('m');
    expect(s.timeoutMs).toBe(60_000);
  });
});
