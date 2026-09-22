/**
 * HTTP-gränssnittet: rutter, validering, rollkrav och ägarskap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAM, ANNA, BERTIL, VERA, anropa, api, nyApp, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

function ogiltigtFel(svar: { json: { error?: { code?: string; message?: string } } }): void {
  expect(svar.json.error?.code).toBe('invalid_request');
  expect(typeof svar.json.error?.message).toBe('string');
}

describe('GET /me', () => {
  it('ger visningsnamn ur adressens lokala del och att Anna får bygga', async () => {
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ displayName: 'anna', canBuild: true, isAdmin: false, services: [] });
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(svar.headers['Content-Type']).toBe('application/json; charset=utf-8');
  });

  it('fungerar även för den som bara får titta — men canBuild är falskt', async () => {
    const svar = await anropa(m.builder, VERA, 'GET', api('/me'));
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ displayName: 'vera', canBuild: false, isAdmin: false, services: [] });
  });

  it('admin får bygga', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', api('/me'));
    expect(svar.json.canBuild).toBe(true);
  });

  it('visar aldrig hela adressen', async () => {
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.text).not.toContain('@');
  });
});

describe('GET /me — påslagna tjänster för guiden "Vilka tjänster finns som appen kan använda?"', () => {
  it('givet att inga tjänster är påslagna, så är listan tom', async () => {
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.json.services).toEqual([]);
  });

  it('givet påslagna tjänster, så får byggaren dem i plattformens ordning och utan dubbletter', async () => {
    await m.builder.close();
    m.builder = m.starta({ services: ['search', 'files', 'llm', 'files'] });
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.status).toBe(200);
    expect(svar.json.services).toEqual(['files', 'llm', 'search']);
  });

  it('/me säger vilken version som är driftsatt, när driftsättningen angett en', async () => {
    await m.builder.close();
    m.builder = m.starta({ version: 'a1b2c3d' });
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.json.version).toBe('a1b2c3d');
  });

  it('även den som inte får bygga ser vilka tjänster som finns', async () => {
    await m.builder.close();
    m.builder = m.starta({ services: ['notify'] });
    const svar = await anropa(m.builder, VERA, 'GET', api('/me'));
    expect(svar.json).toEqual({ displayName: 'vera', canBuild: false, isAdmin: false, services: ['notify'] });
  });

  it('listan läses vid start: att ändra den insända listan efteråt ändrar inte svaret', async () => {
    await m.builder.close();
    const tjanster: ('files' | 'notify')[] = ['files'];
    m.builder = m.starta({ services: tjanster });
    tjanster.push('notify');
    const svar = await anropa(m.builder, ANNA, 'GET', api('/me'));
    expect(svar.json.services).toEqual(['files']);
  });

  it('en okänd tjänst är ett programmeringsfel och stoppar starten', async () => {
    await m.builder.close();
    expect(() => m.starta({ services: ['files', 'kaffe'] as never })).toThrow(TypeError);
    m.builder = m.starta();
  });
});

describe('rollkravet', () => {
  it('den som saknar rollen builder/admin får 403 på allt utom /me', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const forsok: [string, string, unknown?][] = [
      ['GET', api('/apps')],
      ['POST', api('/apps'), {}],
      ['GET', api(`/apps/${appId}`)],
      ['POST', api(`/apps/${appId}/messages`), { text: 'hej' }],
      ['POST', api(`/apps/${appId}/publish`), {}],
      ['GET', api(`/apps/${appId}/open`)],
      ['POST', api(`/apps/${appId}/share`), { email: 'x@example.org' }],
      ['GET', api('/jobs/00000000000000000000000000000000')],
    ];
    for (const [method, path, body] of forsok) {
      const svar = await anropa(m.builder, VERA, method, path, body === undefined ? {} : { body });
      expect(svar.status, `${method} ${path}`).toBe(403);
      expect(svar.json.error.code).toBe('forbidden');
    }
    expect(m.control.anrop).toEqual(['createApp']);
  });
});

describe('appar', () => {
  it('en ny app utan namn heter "Namnlös app" och syns i listan', async () => {
    const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body: {} });
    expect(svar.status).toBe(201);
    expect(svar.json.appId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(m.control.anrop).toEqual(['createApp']);

    const lista = await anropa(m.builder, ANNA, 'GET', api('/apps'));
    expect(lista.status).toBe(200);
    expect(lista.json.apps).toEqual([
      { appId: svar.json.appId, name: 'Namnlös app', updatedAt: '2026-09-19T08:00:00.000Z', hasDraft: false, published: false },
    ]);
  });

  it('POST /apps utan kropp går också bra', async () => {
    const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'));
    expect(svar.status).toBe(201);
  });

  it('ett angivet namn sparas, trimmat', async () => {
    const appId = await nyApp(m.builder, ANNA, '  Rumsbokning  ');
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Rumsbokning');
  });

  it('första önskemålet blir namnet när inget namn angavs', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const jobId = await skicka(m.builder, appId, 'En todo-lista där vi skriver upp vad som ska göras hemma och bockar av när det är gjort');
    await vantaPaJobb(m.builder, jobId);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name.length).toBeLessThanOrEqual(61);
    expect(detalj.json.name.startsWith('En todo-lista där vi skriver upp')).toBe(true);
  });

  it('ett angivet namn skrivs inte över av första önskemålet', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Hemmet');
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Hemmet');
  });

  it('ägaren döper sin app, och namnet står i listan', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: '  Bokning av mötesrum  ' } });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ name: 'Bokning av mötesrum' });
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Bokning av mötesrum');
  });

  it('ett namn ägaren valt skrivs inte över av det första önskemålet', async () => {
    const appId = await nyApp(m.builder, ANNA);
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'Bokning av mötesrum' } });
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En lista där vi bokar mötesrum'));
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Bokning av mötesrum');
  });

  it('namnet går att ändra hur många gånger som helst', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Bokning av mötesrum');
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'Rumsbokning' } });
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'Rummen' } });
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Rummen');
  });

  it('ett tomt namn är inget namn — och appen behåller sitt', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Rumsbokning');
    for (const name of ['', '   ', '\t\n']) {
      const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name } });
      expect(svar.status, `namn=${JSON.stringify(name)}`).toBe(400);
      ogiltigtFel(svar);
    }
    const utan = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: {} });
    expect(utan.status).toBe(400);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Rumsbokning');
  });

  it('namnet prövas likadant som vid skapandet: text, längd och styrtecken', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Rumsbokning');
    const ogiltiga: readonly unknown[] = [42, null, ['a'], { a: 1 }, 'x'.repeat(81), 'Rum\u0000bokning', 'Rum\u202ebokning'];
    for (const name of ogiltiga) {
      const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name } });
      expect(svar.status, `namn=${JSON.stringify(name)}`).toBe(400);
      ogiltigtFel(svar);
    }
    // Exakt på gränsen går igenom, och räknas i tecken — inte i UTF-16-enheter.
    const pa_gransen = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'å'.repeat(80) } });
    expect(pa_gransen.status).toBe(200);
  });

  it('den som inte äger appen kan inte döpa om den — och appen "finns inte"', async () => {
    const appId = await nyApp(m.builder, ANNA, 'Rumsbokning');
    const svar = await anropa(m.builder, BERTIL, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'Bertils' } });
    expect(svar.status).toBe(404);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.name).toBe('Rumsbokning');
  });

  it('ett felaktigt namn ger samma svar oavsett om appen finns', async () => {
    const finns = await anropa(m.builder, ANNA, 'POST', api(`/apps/${await nyApp(m.builder, BERTIL)}/namn`), { body: { name: '' } });
    const finns_inte = await anropa(m.builder, ANNA, 'POST', api('/apps/zzzzzzzzzzzzzzzzzzzzzzzzzz/namn'), { body: { name: '' } });
    expect(finns.status).toBe(400);
    expect(finns_inte.status).toBe(400);
  });

  it('namnet hamnar aldrig i driftloggen', async () => {
    const appId = await nyApp(m.builder, ANNA);
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/namn`), { body: { name: 'Sjukfrånvaro Enhet 4' } });
    const loggen = JSON.stringify(m.logg);
    expect(loggen).toContain('app_renamed');
    expect(loggen).not.toContain('Sjukfrånvaro');
  });

  it('bara POST når namnrutten', async () => {
    const appId = await nyApp(m.builder, ANNA);
    for (const metod of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const svar = await anropa(m.builder, ANNA, metod, api(`/apps/${appId}/namn`));
      expect(svar.status, metod).toBe(405);
    }
  });

  it('listan visar bara den egna personens appar, senast ändrad först', async () => {
    const forsta = await nyApp(m.builder, ANNA, 'Första');
    m.tid.ms += 1000;
    const andra = await nyApp(m.builder, ANNA, 'Andra');
    await nyApp(m.builder, BERTIL, 'Bertils');
    const lista = await anropa(m.builder, ANNA, 'GET', api('/apps'));
    expect(lista.json.apps.map((a: { appId: string }) => a.appId)).toEqual([andra, forsta]);
  });

  it('detaljvyn innehåller meddelanden och senaste jobbet', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await vantaPaJobb(m.builder, jobId);
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.status).toBe(200);
    expect(detalj.json.appId).toBe(appId);
    expect(detalj.json.hasDraft).toBe(true);
    expect(detalj.json.published).toBe(false);
    expect(detalj.json.publishedUrl).toBeUndefined();
    expect(detalj.json.messages).toEqual([
      { role: 'user', text: 'En todo-lista', createdAt: '2026-09-19T08:00:00.000Z' },
      { role: 'assistant', text: 'Klart! Appen är byggd.', createdAt: '2026-09-19T08:00:00.000Z' },
    ]);
    expect(detalj.json.job).toEqual({ jobId, status: 'done' });
  });
});

describe('validering', () => {
  it('ogiltig JSON ⇒ 400', async () => {
    const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { rawBody: new TextEncoder().encode('{inte json') });
    expect(svar.status).toBe(400);
    ogiltigtFel(svar);
  });

  it('en kropp som inte är ett objekt ⇒ 400', async () => {
    for (const body of [[], 'text', 12, null]) {
      const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body });
      expect(svar.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('ogiltig UTF-8 ⇒ 400', async () => {
    const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { rawBody: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(svar.status).toBe(400);
  });

  it('namn över 80 tecken eller av fel typ ⇒ 400', async () => {
    for (const name of ['x'.repeat(81), 12, ['a'], 'rad\u0000brytning']) {
      const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body: { name } });
      expect(svar.status, String(name)).toBe(400);
    }
    const precis = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body: { name: 'å'.repeat(80) } });
    expect(precis.status).toBe(201);
  });

  it('meddelandets text måste vara 1–4000 tecken', async () => {
    const appId = await nyApp(m.builder, ANNA);
    for (const text of ['', '   ', 'x'.repeat(4001), 42, undefined, 'nul\u0000tecken']) {
      const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text } });
      expect(svar.status, String(text).slice(0, 20)).toBe(400);
      ogiltigtFel(svar);
    }
    const precis = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'ö'.repeat(4000) } });
    expect(precis.status).toBe(202);
  });

  it('flerradig text är tillåten', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'Rad ett\nRad två\tmed tabb' } });
    expect(svar.status).toBe(202);
  });

  it('after måste vara ett heltal ≥ 0', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await vantaPaJobb(m.builder, jobId);
    for (const after of ['-1', '1.5', 'abc', '', '1e3', '99999999999999999999', ' 1']) {
      const svar = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`), { query: { after } });
      expect(svar.status, after).toBe(400);
    }
  });

  it('okänt eller felformat app-id ⇒ 404', async () => {
    for (const appId of ['finnsinte', '0'.repeat(26), '../../etc', 'A'.repeat(26), '%2e%2e']) {
      const svar = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
      expect(svar.status, appId).toBe(404);
      expect(svar.json.error.code).toBe('not_found');
    }
  });

  it('felformat jobb-id ⇒ 404', async () => {
    for (const jobId of ['1', 'x'.repeat(32), '../apps', '0'.repeat(33)]) {
      const svar = await anropa(m.builder, ANNA, 'GET', api(`/jobs/${jobId}`));
      expect(svar.status, jobId).toBe(404);
    }
  });

  it('okänd API-rutt ⇒ 404 som JSON, fel metod ⇒ 405', async () => {
    const okand = await anropa(m.builder, ANNA, 'GET', api('/finns-inte'));
    expect(okand.status).toBe(404);
    expect(okand.json.error.code).toBe('not_found');

    const annatApi = await anropa(m.builder, ANNA, 'GET', '/_api/whoami');
    expect(annatApi.status).toBe(404);
    expect(annatApi.json.error.code).toBe('not_found');

    const felMetod = await anropa(m.builder, ANNA, 'DELETE', api('/apps'));
    expect(felMetod.status).toBe(405);
    expect(felMetod.json.error.code).toBe('method_not_allowed');

    const felMetodMe = await anropa(m.builder, ANNA, 'POST', api('/me'), { body: {} });
    expect(felMetodMe.status).toBe(405);
  });

  it('open kräver target=preview eller target=published', async () => {
    const appId = await nyApp(m.builder, ANNA);
    for (const query of [{}, { target: 'annat' }, { target: 'PREVIEW' }]) {
      const svar = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query });
      expect(svar.status, JSON.stringify(query)).toBe(400);
    }
  });

  it('e-postadressen måste vara en sträng av rimlig längd', async () => {
    const appId = await nyApp(m.builder, ANNA);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    for (const email of [undefined, 12, '', `${'a'.repeat(250)}@x.se`]) {
      const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email } });
      expect(svar.status, String(email).slice(0, 10)).toBe(400);
    }
    expect(m.inbjudningar.inbjudna).toEqual([]);
  });
});

describe('ägarskap: Bertil ser inte Annas app', () => {
  it('får 404 på varje app- och jobbrutt, och inget händer', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const jobId = await skicka(m.builder, appId, 'En todo-lista');
    await vantaPaJobb(m.builder, jobId);
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    const anropFore = [...m.control.anrop];

    const forsok: [string, string, { body?: unknown; query?: Record<string, string> }][] = [
      ['GET', api(`/apps/${appId}`), {}],
      ['POST', api(`/apps/${appId}/messages`), { body: { text: 'Byt rubrik' } }],
      ['POST', api(`/apps/${appId}/publish`), {}],
      ['GET', api(`/apps/${appId}/open`), { query: { target: 'preview' } }],
      ['GET', api(`/apps/${appId}/open`), { query: { target: 'published' } }],
      ['POST', api(`/apps/${appId}/share`), { body: { email: 'bertils.van@example.org' } }],
      ['GET', api(`/jobs/${jobId}`), {}],
    ];
    const okand = '0123456789abcdefghjkmnpqrs';
    for (const [method, path, options] of forsok) {
      const svar = await anropa(m.builder, BERTIL, method, path, options);
      expect(svar.status, `${method} ${path}`).toBe(404);
      // Svaret ska vara detsamma som för en app som inte finns alls.
      const jamfor = await anropa(m.builder, BERTIL, method, path.replace(appId, okand).replace(jobId, 'f'.repeat(32)), options);
      expect(svar.json, `${method} ${path}`).toEqual(jamfor.json);
    }
    expect(m.control.anrop).toEqual(anropFore);
    expect(m.inbjudningar.inbjudna).toEqual([]);
    expect(m.agent.inputs).toHaveLength(1);

    const lista = await anropa(m.builder, BERTIL, 'GET', api('/apps'));
    expect(lista.json.apps).toEqual([]);
  });

  it('admin ser inte heller andras appar i byggverktyget', async () => {
    const appId = await nyApp(m.builder, ANNA);
    const svar = await anropa(m.builder, ADAM, 'GET', api(`/apps/${appId}`));
    expect(svar.status).toBe(404);
  });
});
