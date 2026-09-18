/**
 * Publicera, öppna och dela.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANNA, anropa, api, misslyckadTur, nyApp, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

async function byggdApp(): Promise<string> {
  const appId = await nyApp(m.builder);
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
  return appId;
}

async function publiceradApp(): Promise<string> {
  const appId = await byggdApp();
  const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
  expect(svar.status).toBe(200);
  return appId;
}

describe('publicera', () => {
  it('409 utan grönt utkast', async () => {
    const appId = await nyApp(m.builder);
    const utan = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    expect(utan.status).toBe(409);
    expect(utan.json.error.message.length).toBeGreaterThan(5);

    m.agent.turer.push(misslyckadTur());
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
    const efterMisslyckande = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    expect(efterMisslyckande.status).toBe(409);
    expect(m.control.anrop).not.toContain('publish');
  });

  it('publicerar senaste gröna revisionen och svarar med den publicerade adressen', async () => {
    const appId = await byggdApp();
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Byt rubrik'));
    m.agent.turer.push(misslyckadTur());
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Mejla svaren till mig'));

    m.tid.ms += 60_000;
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ publishedUrl: `https://${appId}.example.org/` });
    expect(m.control.publicerade.get(appId)).toBe('version-2');

    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.published).toBe(true);
    expect(detalj.json.publishedUrl).toBe(`https://${appId}.example.org/`);
    expect(detalj.json.updatedAt).toBe('2026-09-19T08:01:00.000Z');

    const lista = await anropa(m.builder, ANNA, 'GET', api('/apps'));
    expect(lista.json.apps[0]).toMatchObject({ appId, published: true, hasDraft: true });
    expect(lista.json.apps[0].publishedUrl).toBeUndefined();
  });

  it('publiceringen överlever en omstart', async () => {
    const appId = await publiceradApp();
    await m.builder.close();
    m.builder = m.starta();
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.published).toBe(true);
    expect(detalj.json.publishedUrl).toBe(`https://${appId}.example.org/`);
  });

  it('misslyckas control ⇒ 500 med klarspråk, och appen räknas inte som publicerad', async () => {
    const appId = await byggdApp();
    m.control.publish = async () => {
      throw new Error('/srv/data: disk full');
    };
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    expect(svar.status).toBe(500);
    expect(svar.json.error.code).toBe('internal');
    expect(svar.text).not.toContain('/srv');
    const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(detalj.json.published).toBe(false);
  });
});

describe('öppna', () => {
  it('förhandsvisning: adressen kommer från openUrl med förhandsvisningens adress', async () => {
    const appId = await byggdApp();
    const svar = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query: { target: 'preview' } });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({
      url: `https://login.example.org/test?user=u-anna&next=${encodeURIComponent(`https://p-${appId}.example.org/`)}`,
    });
    expect(svar.headers['Cache-Control']).toBe('no-store');
  });

  it('publicerad: 409 innan publicering, sedan den publicerade adressen', async () => {
    const appId = await byggdApp();
    const fore = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query: { target: 'published' } });
    expect(fore.status).toBe(409);
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/publish`));
    const efter = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query: { target: 'published' } });
    expect(efter.status).toBe(200);
    expect(efter.json.url).toContain(encodeURIComponent(`https://${appId}.example.org/`));
  });

  it('förhandsvisning utan utkast ⇒ 409', async () => {
    const appId = await nyApp(m.builder);
    const svar = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query: { target: 'preview' } });
    expect(svar.status).toBe(409);
  });
});

describe('dela', () => {
  it('409 om appen inte är publicerad', async () => {
    const appId = await byggdApp();
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
    expect(svar.status).toBe(409);
    expect(m.inbjudningar.inbjudna).toEqual([]);
  });

  it('bjuder in som viewer med appens namn och publicerade adress', async () => {
    const appId = await publiceradApp();
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: '  Van@Example.org ' } });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ shared: true });
    expect(m.inbjudningar.inbjudna).toEqual([
      {
        email: 'Van@Example.org',
        role: 'viewer',
        invitedBy: ANNA,
        app: { name: 'En todo-lista', url: `https://${appId}.example.org/` },
      },
    ]);
  });

  it('samma svar för en ny och en redan inbjuden adress', async () => {
    const appId = await publiceradApp();
    const forsta = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
    const andra = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
    expect(andra.status).toBe(forsta.status);
    expect(andra.text).toBe(forsta.text);
    expect(andra.headers).toEqual(forsta.headers);
  });

  it('ogiltig adress ⇒ 400 med klarspråk', async () => {
    const appId = await publiceradApp();
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'inte en adress' } });
    expect(svar.status).toBe(400);
    expect(svar.json).toEqual({
      error: { code: 'invalid_request', message: 'Adressen ser inte ut att vara en e-postadress.' },
    });
  });

  it('andra fel från inbjudningstjänsten ⇒ 500 utan detaljer', async () => {
    const appId = await publiceradApp();
    m.inbjudningar.invite = async () => {
      throw new Error('SMTP 550 van@example.org rejected');
    };
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
    expect(svar.status).toBe(500);
    expect(svar.text).not.toContain('van@');
    expect(svar.text).not.toContain('SMTP');
  });

  it('sparar delningen utan adressen i klartext', async () => {
    const appId = await publiceradApp();
    await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'hemlig.van@example.org' } });
    await m.builder.close();
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    for (const fil of await readdir(m.dataDir)) {
      const innehall = await readFile(join(m.dataDir, fil));
      expect(innehall.includes('hemlig.van'), fil).toBe(false);
    }
    m.builder = m.starta();
  });

  it('högst 20 delningar per ägare och timme ⇒ 429', async () => {
    const appId = await publiceradApp();
    for (let i = 0; i < 20; i++) {
      const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: `van${i}@example.org` } });
      expect(svar.status, String(i)).toBe(200);
    }
    const for_manga = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van20@example.org' } });
    expect(for_manga.status).toBe(429);
    expect(for_manga.json.error.code).toBe('rate_limited');
    expect(m.inbjudningar.inbjudna).toHaveLength(20);

    // Gränsen gäller ägaren, inte appen.
    const annanApp = await publiceradApp();
    const ocksa = await anropa(m.builder, ANNA, 'POST', api(`/apps/${annanApp}/share`), { body: { email: 'x@example.org' } });
    expect(ocksa.status).toBe(429);

    m.tid.ms += 60 * 60 * 1000 + 1;
    const senare = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van20@example.org' } });
    expect(senare.status).toBe(200);
  });

  it('ogiltiga adresser räknas inte mot gränsen', async () => {
    const appId = await publiceradApp();
    for (let i = 0; i < 25; i++) {
      await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: `fel${i}` } });
    }
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
    expect(svar.status).toBe(200);
  });
});
