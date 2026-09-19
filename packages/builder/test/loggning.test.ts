/**
 * Driftloggen får aldrig innehålla meddelandetext, källkod, e-postadresser eller hela app-id:n.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANNA, anropa, api, lyckadTur, misslyckadTur, nyApp, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

const HEMLIG_TEXT = 'Elevlista med Kalle Svensson 900101-1234';
const HEMLIG_KOD = 'const hemligKod = "KODHEMLIS";';
const HEMLIG_SAMMANFATTNING = 'Sammanfattning SAMMANFATTNINGSHEMLIS';
const VANNENS_ADRESS = 'vannen.hemlig@example.org';

describe('loggning', () => {
  it('loggar händelser med förkortat app-id, userId, status, tider, tokens och modell — inget innehåll', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Hemligt namn NAMNHEMLIS');
    m.agent.turer.push(lyckadTur({ 'src/App.tsx': HEMLIG_KOD }, HEMLIG_SAMMANFATTNING));
    m.agent.turer.push(misslyckadTur(HEMLIG_SAMMANFATTNING));
    m.agent.turer.push(async () => {
      throw new Error(`Oväntat: ${HEMLIG_TEXT}`);
    });
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, HEMLIG_TEXT));
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, HEMLIG_TEXT));
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, HEMLIG_TEXT));
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: VANNENS_ADRESS } });
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'inte giltig HEMLIS' } });
    m.inbjudningar.invite = async () => {
      throw new Error(`SMTP-fel för ${VANNENS_ADRESS}`);
    };
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: VANNENS_ADRESS } });

    const hela = JSON.stringify(m.logg);
    for (const hemligt of ['900101', 'Kalle', 'KODHEMLIS', 'SAMMANFATTNINGSHEMLIS', 'NAMNHEMLIS', 'vannen', 'HEMLIS', '@example', appId]) {
      expect(hela, hemligt).not.toContain(hemligt);
    }

    const jobbposter = m.logg.filter((post) => post.event === 'job_finished');
    expect(jobbposter).toHaveLength(3);
    expect(jobbposter[0]).toMatchObject({
      appIdPrefix: appId.slice(0, 8),
      userId: 'u-anna',
      status: 'done',
      model: 'testmodell-1',
      inputTokens: 1200,
      outputTokens: 800,
    });
    expect(typeof jobbposter[0]!.durationMs).toBe('number');
    expect(jobbposter[1]).toMatchObject({ status: 'failed', inputTokens: 3000 });
    expect(jobbposter[2]).toMatchObject({ status: 'failed', errorName: 'Error' });
    expect(jobbposter[2]!.stackFrames?.length).toBeGreaterThan(0);

    const handelser = new Set(m.logg.map((post) => post.event));
    for (const event of ['app_created', 'job_queued', 'job_started', 'job_finished', 'app_published', 'app_shared', 'share_failed']) {
      expect(handelser.has(event as never), event).toBe(true);
    }
  });

  it('en logger som kastar påverkar inte svaret', async () => {
    await m.builder.close();
    m.builder = m.starta({
      logger: () => {
        throw new Error('loggen är trasig');
      },
    });
    const appId = await nyApp(m.builder);
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('done');
  });
});
