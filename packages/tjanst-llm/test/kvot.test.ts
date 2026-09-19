/**
 * Kvoter: tokens per app och dygn, per användare och timme, och högst några samtidiga anrop per
 * app. Uppskattad åtgång prövas FÖRE anropet och faktisk åtgång räknas EFTER. Utkast och
 * publicerad version har var sin kvot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeProvider } from '@vibesandbox/llm';
import type { FakeProvider, FakeReply } from '@vibesandbox/llm';
import type { AppService } from '@vibesandbox/contracts';
import { createLlmService } from '../src/index.ts';
import { APP_B, felkod, felmeddelande, forfragan, skapaTestmiljo } from './hjalp.ts';
import type { Anrop, Testmiljo } from './hjalp.ts';

let miljo: Testmiljo;
let tjanster: AppService[] = [];

beforeEach(async () => {
  miljo = await skapaTestmiljo();
});
afterEach(async () => {
  for (const t of tjanster) await t.close?.();
  tjanster = [];
  await miljo.stada();
});

const KVOT = { SVC_LLM_MODEL: 'm', SVC_LLM_TOKENS_PER_USER_HOUR: '3000', SVC_LLM_TOKENS_PER_APP_DAY: '9000' };

/** Svar som kostar exakt så många tokens (in + ut). */
function kostar(tokens: number): FakeReply {
  return { text: 'ok', usage: { inputTokens: tokens - 100, outputTokens: 100 } };
}

function starta(svar: FakeReply[], env: Record<string, string> = KVOT): { tjanst: AppService; modell: FakeProvider } {
  const modell = createFakeProvider(svar);
  const tjanst = createLlmService(miljo.beroenden(env), { provider: modell }).service;
  tjanster.push(tjanst);
  return { tjanst, modell };
}

const fraga = (tjanst: AppService, anrop: Anrop = {}) => tjanst.handle(forfragan({ json: { prompt: 'hej', maxTokens: 500 }, ...anrop }));

describe('per användare och timme', () => {
  it('faktisk åtgång räknas: över gränsen ⇒ rate_limited i klarspråk, och inget skickas', async () => {
    const { tjanst, modell } = starta([kostar(2800), 'ok']);
    expect((await fraga(tjanst)).status).toBe(200);
    const svar = await fraga(tjanst);
    expect(svar.status).toBe(429);
    expect(felkod(svar)).toBe('rate_limited');
    expect(felmeddelande(svar)).toMatch(/timme/);
    expect(modell.requests).toHaveLength(1);
  });

  it('uppskattningen prövas före anropet: ett för stort maxTokens nekas direkt', async () => {
    const { tjanst, modell } = starta(['ok']);
    const svar = await fraga(tjanst, { json: { prompt: 'hej', maxTokens: 3500 } });
    expect(svar.status).toBe(429);
    expect(modell.requests).toHaveLength(0);
  });

  it('en annan användare i samma app påverkas inte', async () => {
    const { tjanst } = starta([kostar(2800), 'ok']);
    await fraga(tjanst);
    expect((await fraga(tjanst, { userId: 'anv-bertil' })).status).toBe(200);
  });

  it('nästa timme går det igen', async () => {
    const { tjanst } = starta([kostar(2800), 'ok']);
    await fraga(tjanst);
    miljo.tid.nu = new Date('2026-09-19T11:00:00Z');
    expect((await fraga(tjanst)).status).toBe(200);
  });

  it('kvoten överlever en omstart', async () => {
    const forsta = starta([kostar(2800)]).tjanst;
    await fraga(forsta);
    await forsta.close?.();
    tjanster = [];
    const { tjanst } = starta(['ok']);
    expect((await fraga(tjanst)).status).toBe(429);
  });
});

describe('per app och dygn', () => {
  it('flera användare delar appens dygnskvot; över ⇒ rate_limited som nämner appen', async () => {
    const { tjanst } = starta([kostar(2900), kostar(2900), kostar(2900), 'ok']);
    for (const userId of ['a', 'b', 'c']) expect((await fraga(tjanst, { userId })).status).toBe(200);
    const svar = await fraga(tjanst, { userId: 'd' });
    expect(svar.status).toBe(429);
    expect(felmeddelande(svar)).toMatch(/[Aa]ppen/);
  });

  it('en annan app påverkas inte', async () => {
    const { tjanst } = starta([kostar(2900), kostar(2900), kostar(2900), 'ok']);
    for (const userId of ['a', 'b', 'c']) await fraga(tjanst, { userId });
    expect((await fraga(tjanst, { userId: 'd', app: APP_B })).status).toBe(200);
  });

  it('utkastet och den publicerade versionen har var sin kvot', async () => {
    const { tjanst } = starta([kostar(2900), kostar(2900), kostar(2900), 'ok', 'ok']);
    for (const userId of ['a', 'b', 'c']) await fraga(tjanst, { userId });
    expect((await fraga(tjanst, { userId: 'a', kind: 'draft' })).status).toBe(200);
    expect((await fraga(tjanst, { userId: 'd', kind: 'published' })).status).toBe(429);
  });

  it('nästa dygn går det igen', async () => {
    const { tjanst } = starta([kostar(2900), kostar(2900), kostar(2900), 'ok']);
    for (const userId of ['a', 'b', 'c']) await fraga(tjanst, { userId });
    miljo.tid.nu = new Date('2026-09-20T00:00:01Z');
    expect((await fraga(tjanst, { userId: 'd' })).status).toBe(200);
  });
});

describe('misslyckade anrop och samtidighet', () => {
  it('ett misslyckat anrop kostar inte hela uppskattningen', async () => {
    const { tjanst } = starta([new Error('borta'), new Error('borta'), new Error('borta'), new Error('borta'), new Error('borta'), new Error('borta'), 'ok']);
    for (let i = 0; i < 6; i++) expect((await fraga(tjanst)).status).toBe(503);
    expect((await fraga(tjanst)).status).toBe(200);
  });

  it('ett avvisat anrop (ogiltigt) kostar ingenting', async () => {
    const { tjanst } = starta([kostar(2800)]);
    for (let i = 0; i < 20; i++) await fraga(tjanst, { json: { prompt: 'hej', roll: 'x' } });
    expect((await fraga(tjanst)).status).toBe(200);
  });

  it('samtidiga anrop reserverar sin uppskattning, så att de inte tillsammans går över gränsen', async () => {
    const { tjanst, modell } = starta(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const svar = await Promise.all(Array.from({ length: 6 }, () => fraga(tjanst, { json: { prompt: 'hej', maxTokens: 900 } })));
    const godkanda = svar.filter((s) => s.status === 200).length;
    expect(godkanda).toBeLessThanOrEqual(3);
    expect(modell.requests.length).toBe(godkanda);
  });

  it('högst fyra samtidiga anrop per app; fler ⇒ rate_limited', async () => {
    const env = { SVC_LLM_MODEL: 'm' };
    const { tjanst } = starta(Array.from({ length: 6 }, () => ({ hang: true }) as const), env);
    const pagaende = Array.from({ length: 4 }, (_, i) => fraga(tjanst, { userId: `u${i}` }));
    await new Promise((r) => setTimeout(r, 20));
    const svar = await fraga(tjanst, { userId: 'u9' });
    expect(svar.status).toBe(429);
    await tjanst.close?.();
    tjanster = [];
    await Promise.all(pagaende);
  });
});
