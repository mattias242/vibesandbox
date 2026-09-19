/**
 * Jobbkön: ett jobb åt gången för hela plattformen, händelser, utfall och omstart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTurnResult } from '@vibesandbox/contracts';
import {
  ANNA,
  BERTIL,
  STARTFILER,
  anropa,
  api,
  fejkBygge,
  lyckadTur,
  misslyckadTur,
  nyApp,
  skapaMiljo,
  skicka,
  snurra,
  uppskjuten,
  vantaPaJobb,
} from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

const TODO = { 'src/App.tsx': 'export function App() { return <ul />; }' };

describe('meddelande ⇒ jobb', () => {
  it('svarar 202 med ett slumpat jobb-id på 128 bitar', async () => {
    const appId = await nyApp(m.builder);
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'En todo-lista' } });
    expect(svar.status).toBe(202);
    expect(svar.json.jobId).toMatch(/^[0-9a-f]{32}$/);
    const annat = await skicka(m.builder, await nyApp(m.builder), 'En annan');
    expect(annat).not.toBe(svar.json.jobId);
  });

  it('agenten får önskemålet, historiken och startfilerna för en ny app', async () => {
    const appId = await nyApp(m.builder);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    const input = m.agent.inputs[0]!;
    expect(input.request).toBe('En todo-lista');
    expect(input.history).toEqual([]);
    expect(input.currentFiles).toEqual(STARTFILER);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it('nästa tur bygger vidare på senaste gröna revisionen och ser hela samtalet', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(lyckadTur(TODO, 'Jag byggde en lista.'));
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Lägg till en kolumn för antal'));
    const andra = m.agent.inputs[1]!;
    expect(andra.request).toBe('Lägg till en kolumn för antal');
    expect(andra.currentFiles).toEqual(TODO);
    expect(andra.history).toEqual([
      { role: 'user', text: 'En todo-lista' },
      { role: 'assistant', text: 'Jag byggde en lista.' },
    ]);
  });

  it('ett grönt bygge importeras, blir utkast och ger en ny revision', async () => {
    const appId = await nyApp(m.builder);
    const bygge = fejkBygge('/tmp/bygge-1');
    m.agent.turer.push(lyckadTur(TODO, 'Klart.', bygge));
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('done');
    expect(m.control.importerade).toEqual([{ appId, directory: '/tmp/bygge-1', versionId: 'version-1' }]);
    expect(m.control.utkast.get(appId)).toBe('version-1');
    expect(m.control.anrop).toEqual(['createApp', 'importVersion', 'setDraft']);
    expect(bygge.disposed).toBe(1);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.hasDraft).toBe(true);
  });

  it('409 när ett jobb redan köar eller pågår för appen', async () => {
    const appId = await nyApp(m.builder);
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      await vakt.promise;
      return lyckadTur(TODO)(input);
    });
    await skicka(m.builder, appId, 'En todo-lista');
    const igen = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'Och en till' } });
    expect(igen.status).toBe(409);
    expect(igen.json.error.message).toMatch(/pågår/);
    vakt.resolve();
  });

  it('409-meddelandet sparas inte i samtalet', async () => {
    const appId = await nyApp(m.builder);
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      await vakt.promise;
      return lyckadTur(TODO)(input);
    });
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'Hemligt andra' } });
    vakt.resolve();
    await vantaPaJobb(m.builder, jobId);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.messages.map((x: { text: string }) => x.text)).not.toContain('Hemligt andra');
  });
});

describe('kön', () => {
  it('kör ETT jobb åt gången för hela plattformen, i den ordning de kom', async () => {
    const vakter = [uppskjuten<void>(), uppskjuten<void>(), uppskjuten<void>()];
    const ordning: string[] = [];
    for (const vakt of vakter) {
      m.agent.turer.push(async (input) => {
        ordning.push(`start ${input.request}`);
        await vakt.promise;
        ordning.push(`slut ${input.request}`);
        return lyckadTur(TODO)(input);
      });
    }
    const a = await nyApp(m.builder, ANNA);
    const b = await nyApp(m.builder, BERTIL);
    const c = await nyApp(m.builder, ANNA);
    const jobbA = await skicka(m.builder, a, 'A', ANNA);
    const jobbB = await skicka(m.builder, b, 'B', BERTIL);
    const jobbC = await skicka(m.builder, c, 'C', ANNA);

    await snurra();
    expect((await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobbA}`))).json.status).toBe('running');
    expect((await anropa(m.builder, BERTIL, 'GET', api(`/jobs/${jobbB}`))).json.status).toBe('queued');
    expect((await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobbC}`))).json.status).toBe('queued');

    // Släpp dem i omvänd ordning: B och C får ändå inte börja före A är klar.
    vakter[2]!.resolve();
    vakter[1]!.resolve();
    await snurra();
    expect(ordning).toEqual(['start A']);
    vakter[0]!.resolve();

    await vantaPaJobb(m.builder, jobbC);
    expect(ordning).toEqual(['start A', 'slut A', 'start B', 'slut B', 'start C', 'slut C']);
    expect(m.agent.hogstaSamtidiga).toBe(1);
  });

  it('ett jobb som köas medan ett annat redan körs får vänta', async () => {
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      await vakt.promise;
      return lyckadTur(TODO)(input);
    });
    const a = await nyApp(m.builder);
    const b = await nyApp(m.builder);
    const jobbA = await skicka(m.builder, a, 'A');
    await snurra();
    const jobbB = await skicka(m.builder, b, 'B');
    await snurra();
    expect((await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobbB}`))).json.status).toBe('queued');
    expect(m.agent.inputs).toHaveLength(1);
    vakt.resolve();
    await vantaPaJobb(m.builder, jobbA);
    expect((await vantaPaJobb(m.builder, jobbB)).json.status).toBe('done');
    expect(m.agent.hogstaSamtidiga).toBe(1);
  });

  it('ett jobb som kastar stoppar inte kön', async () => {
    m.agent.turer.push(async () => {
      throw new Error('modellen svarade inte');
    });
    const a = await nyApp(m.builder);
    const b = await nyApp(m.builder);
    const jobbA = await skicka(m.builder, a, 'A');
    const jobbB = await skicka(m.builder, b, 'B');
    expect((await vantaPaJobb(m.builder, jobbA)).json.status).toBe('failed');
    expect((await vantaPaJobb(m.builder, jobbB)).json.status).toBe('done');
  });
});

describe('händelser', () => {
  it('sparas löpande och kan hämtas från ett index med after', async () => {
    const appId = await nyApp(m.builder);
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      input.onEvent?.({ type: 'status', message: 'Skriver koden' });
      input.onEvent?.({ type: 'progress', outputChars: 120 });
      await vakt.promise;
      input.onEvent?.({ type: 'check', ok: true, problems: 0 });
      input.onEvent?.({ type: 'done', ok: true, message: 'Klart' });
      return lyckadTur(TODO)({ ...input, onEvent: () => {} });
    });
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await snurra();

    const forst = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`));
    expect(forst.json).toEqual({
      jobId,
      appId,
      status: 'running',
      events: [
        { type: 'status', message: 'Skriver koden' },
        { type: 'progress', outputChars: 120 },
      ],
      next: 2,
    });

    vakt.resolve();
    const klar = await vantaPaJobb(m.builder, jobId);
    const efter = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`), { query: { after: String(klar.json.next - 2) } });
    expect(efter.json.events).toEqual([
      { type: 'check', ok: true, problems: 0 },
      { type: 'done', ok: true, message: 'Klart' },
    ]);
    expect(efter.json.next).toBe(4);

    const bortom = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`), { query: { after: '999' } });
    expect(bortom.json.events).toEqual([]);
    expect(bortom.json.next).toBe(4);
  });

  it('har ett tak, men det avslutande done-beskedet får alltid plats', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(async (input) => {
      for (let i = 0; i < 2000; i++) input.onEvent?.({ type: 'progress', outputChars: i });
      input.onEvent?.({ type: 'done', ok: true, message: 'Klart' });
      return lyckadTur(TODO)({ ...input, onEvent: () => {} });
    });
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    const klar = await vantaPaJobb(m.builder, jobId);
    expect(klar.json.events.length).toBeLessThanOrEqual(500);
    expect(klar.json.events.length).toBeGreaterThanOrEqual(400);
    expect(klar.json.events.at(-1)).toEqual({ type: 'done', ok: true, message: 'Klart' });
  });

  it('taket gäller även done-händelser', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(async (input) => {
      for (let i = 0; i < 700; i++) input.onEvent?.({ type: 'done', ok: true, message: `Klart ${i}` });
      return lyckadTur(TODO)({ ...input, onEvent: () => {} });
    });
    const klar = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(klar.json.events).toHaveLength(500);
  });

  it('bara kontraktets fält sparas, och långa texter kapas', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(async (input) => {
      input.onEvent?.({ type: 'status', message: 'x'.repeat(5000), extra: 'bort' } as never);
      input.onEvent?.({ type: 'okänd', message: 'bort' } as never);
      input.onEvent?.(null as never);
      return lyckadTur(TODO)({ ...input, onEvent: () => {} });
    });
    const klar = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(klar.json.events).toHaveLength(1);
    expect(Object.keys(klar.json.events[0])).toEqual(['type', 'message']);
    expect(klar.json.events[0].message.length).toBeLessThanOrEqual(1000);
  });

  it('en onEvent som anropas efter att jobbet är klart ignoreras', async () => {
    const appId = await nyApp(m.builder);
    let sen: ((e: never) => void) | undefined;
    m.agent.turer.push(async (input) => {
      sen = input.onEvent as never;
      return lyckadTur(TODO)({ ...input, onEvent: () => {} });
    });
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await vantaPaJobb(m.builder, jobId);
    sen?.({ type: 'status', message: 'för sent' } as never);
    const efter = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`));
    expect(efter.json.events).toEqual([]);
  });
});

describe('misslyckanden', () => {
  it('misslyckad tur ⇒ assistentmeddelande med förklaringen, ingen revision, utkastet oförändrat', async () => {
    const appId = await nyApp(m.builder);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(m.control.utkast.get(appId)).toBe('version-1');

    m.agent.turer.push(misslyckadTur('Koden försökte skicka data till en extern adress, så den byggdes inte.'));
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Mejla svaren till mig'));
    expect(jobb.json.status).toBe('failed');
    expect(m.control.importerade).toHaveLength(1);
    expect(m.control.utkast.get(appId)).toBe('version-1');

    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.messages.at(-1)).toEqual({
      role: 'assistant',
      text: 'Koden försökte skicka data till en extern adress, så den byggdes inte.',
      createdAt: '2026-09-19T08:00:00.000Z',
    });

    // Nästa tur utgår fortfarande från den senaste GRÖNA revisionen.
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Byt rubrik'));
    expect(m.agent.inputs[2]!.currentFiles).toEqual(m.agent.inputs[1]!.currentFiles);
  });

  it('ett misslyckat första jobb lämnar appen utan utkast', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(misslyckadTur());
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.hasDraft).toBe(false);
    expect(m.control.anrop).toEqual(['createApp']);
  });

  it('dispose anropas även när importen misslyckas, och jobbet blir failed utan revision', async () => {
    const appId = await nyApp(m.builder);
    const bygge = fejkBygge();
    m.agent.turer.push(lyckadTur(TODO, 'Klart', bygge));
    m.control.importFel = new Error('/srv/hemlig/sokvag: för stor fil');
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('failed');
    expect(bygge.disposed).toBe(1);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.hasDraft).toBe(false);
    const sista = detalj.json.messages.at(-1);
    expect(sista.role).toBe('assistant');
    expect(sista.text).not.toContain('/srv');
    expect(JSON.stringify(jobb.json)).not.toContain('/srv');
  });

  it('dispose anropas även när setDraft misslyckas', async () => {
    const appId = await nyApp(m.builder);
    const bygge = fejkBygge();
    m.agent.turer.push(lyckadTur(TODO, 'Klart', bygge));
    m.control.setDraft = async () => {
      throw new Error('databasen är låst');
    };
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('failed');
    expect(bygge.disposed).toBe(1);
  });

  it('ok utan bygge räknas som misslyckat — inget kan importeras', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(async (input): Promise<AgentTurnResult> => ({
      ok: true,
      files: TODO,
      summary: 'Klart',
      rounds: 1,
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('failed');
    expect(m.control.anrop).toEqual(['createApp']);
  });

  it('oväntat fel ⇒ failed med klarspråk i samtalet och ett avslutande done-besked', async () => {
    const appId = await nyApp(m.builder);
    m.agent.turer.push(async () => {
      throw new Error('ECONNRESET 10.0.0.7:443 hemlig-nyckel');
    });
    const jobb = await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    expect(jobb.json.status).toBe('failed');
    expect(jobb.json.events.at(-1)).toMatchObject({ type: 'done', ok: false });
    expect(JSON.stringify(jobb.json)).not.toContain('ECONNRESET');
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    const sista = detalj.json.messages.at(-1);
    expect(sista.role).toBe('assistant');
    expect(sista.text).not.toContain('ECONNRESET');
    expect(sista.text.length).toBeGreaterThan(10);
  });

  it('ett jobb som aldrig blir klart släpper kön efter tidsgränsen', async () => {
    await m.builder.close();
    m.builder = m.starta({ jobTimeoutMs: 30 });
    const aldrig = uppskjuten<AgentTurnResult>();
    let signal: AbortSignal | undefined;
    const bygge = fejkBygge();
    m.agent.turer.push(async (input) => {
      signal = input.signal;
      return aldrig.promise;
    });
    const a = await nyApp(m.builder);
    const b = await nyApp(m.builder);
    const jobbA = await skicka(m.builder, a, 'A');
    const jobbB = await skicka(m.builder, b, 'B');
    expect((await vantaPaJobb(m.builder, jobbA)).json.status).toBe('failed');
    expect(signal?.aborted).toBe(true);
    expect((await vantaPaJobb(m.builder, jobbB)).json.status).toBe('done');

    // Blir den ändå klar senare: bygget städas och ingenting importeras.
    const importerade = m.control.importerade.length;
    aldrig.resolve({ ok: true, files: TODO, build: bygge, summary: 'sent', rounds: 1, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } });
    await snurra();
    expect(bygge.disposed).toBe(1);
    expect(m.control.importerade).toHaveLength(importerade);
  });
});

describe('omladdning och omstart', () => {
  it('detaljvyn visar det pågående jobbet efter en omladdning', async () => {
    const appId = await nyApp(m.builder);
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      await vakt.promise;
      return lyckadTur(TODO)(input);
    });
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await snurra();
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.job).toEqual({ jobId, status: 'running' });
    vakt.resolve();
  });

  it('en app utan jobb har inget job-fält', async () => {
    const appId = await nyApp(m.builder);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.job).toBeUndefined();
    expect(detalj.json.messages).toEqual([]);
  });

  it('allt finns kvar efter en omstart', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Hemmet');
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await vantaPaJobb(m.builder, jobId);
    await m.builder.close();
    m.builder = m.starta();
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Hemmet');
    expect(detalj.json.messages).toHaveLength(2);
    expect(detalj.json.job).toEqual({ jobId, status: 'done' });
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Byt rubrik'));
    expect(m.agent.inputs[1]!.currentFiles).toEqual({ 'src/App.tsx': 'export function App() { return <h1>Todo</h1>; }' });
  });

  it('jobb som pågick eller köade när plattformen stannade blir failed med förklaring', async () => {
    const vakt = uppskjuten<void>();
    let signal: AbortSignal | undefined;
    m.agent.turer.push(async (input) => {
      signal = input.signal;
      await vakt.promise;
      throw new Error('avbruten');
    });
    const a = await nyApp(m.builder);
    const b = await nyApp(m.builder);
    const jobbA = await skicka(m.builder, a, 'A');
    const jobbB = await skicka(m.builder, b, 'B');
    await snurra();

    const stangning = m.builder.close();
    await snurra();
    expect(signal?.aborted).toBe(true);
    vakt.resolve();
    await stangning;

    m.builder = m.starta();
    for (const [appId, jobId] of [[a, jobbA], [b, jobbB]] as const) {
      const jobb = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`));
      expect(jobb.json.status, jobId).toBe('failed');
      const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
      expect(detalj.json.messages.at(-1).text).toBe('Plattformen startades om under arbetet — försök igen.');
    }
    // B startades aldrig.
    expect(m.agent.inputs.map((i) => i.request)).toEqual(['A']);
    // Appen går att använda igen.
    expect((await vantaPaJobb(m.builder, await skicka(m.builder, b, 'B igen'))).json.status).toBe('done');
  });

  it('efter en krasch (ingen close) blir pågående jobb failed vid nästa start', async () => {
    const vakt = uppskjuten<void>();
    m.agent.turer.push(async (input) => {
      await vakt.promise;
      return lyckadTur(TODO)(input);
    });
    const appId = await nyApp(m.builder);
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await snurra();
    // En andra instans mot samma katalog motsvarar en ny process efter en krasch.
    const ny = m.starta();
    try {
      const jobb = await anropa(ny, ANNA, 'GET', api(`/jobs/${jobId}`));
      expect(jobb.json.status).toBe('failed');
      expect(jobb.json.events.at(-1)).toEqual({
        type: 'done',
        ok: false,
        message: 'Plattformen startades om under arbetet — försök igen.',
      });
    } finally {
      await ny.close();
      vakt.resolve();
    }
  });
});
