/**
 * Återkoppling på BYGGVERKTYGET — inte på appen.
 *
 * Tumme ner öppnar ett textfält; texten mejlas till plattformens ägare tillsammans med hela
 * konversationen om appen. Tumme upp räknas bara. Ingenting av detta når språkmodellen, och
 * appens utkast ändras aldrig. Fritexten sparas inte i byggverktygets databas — den mejlas.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FEEDBACK_PER_HOUR } from '../src/index.ts';
import { ANNA, BERTIL, anropa, api, nyApp, skapaMiljo, skicka, slumpatAppId, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

const ONSKEMAL = 'En todo-lista';
const SVARET = 'Klart! Appen är byggd.';
const KLAGOMAL = 'Jag ville att den skulle läsa texten ur en PDF';

async function byggdApp(): Promise<string> {
  const appId = await nyApp(m.builder);
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, ONSKEMAL));
  return appId;
}

function lamna(appId: string, kropp: unknown, vem = ANNA): Promise<{ status: number; json: any; text: string; headers: Readonly<Record<string, string>> }> {
  return anropa(m.builder, vem, 'POST', api(`/apps/${appId}/feedback`), { body: kropp });
}

/** Läser byggverktygets egen databas vid sidan av — det enda sättet att se räknaren utifrån. */
function raknade(helpful: boolean): number {
  const db = new DatabaseSync(join(m.dataDir, 'builder.sqlite'), { readOnly: true });
  try {
    const rad = db.prepare('SELECT count(*) AS antal FROM feedback WHERE helpful = ?').get(helpful ? 1 : 0);
    return Number(rad?.['antal'] ?? 0);
  } finally {
    db.close();
  }
}

describe('tumme ner', () => {
  it('mejlar återkopplingen och hela konversationen till plattformens ägare', async () => {
    const appId = await byggdApp();
    const svar = await lamna(appId, { helpful: false, text: KLAGOMAL });

    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ received: true });
    expect(m.aterkoppling.skickade).toHaveLength(1);
    const mejl = m.aterkoppling.skickade[0];
    expect(mejl?.text).toContain(KLAGOMAL);
    expect(mejl?.text).toContain(ONSKEMAL);
    expect(mejl?.text).toContain(SVARET);
    // Ägaren ska kunna svara den som skrev.
    expect(mejl?.text).toContain(ANNA.email);
    // Ett ämne med radbrytning skulle kunna bli ett extra mejlhuvud hos mottagaren.
    expect(mejl?.subject).not.toMatch(/[\r\n]/);
  });

  it('putsar texten och räknar återkopplingen', async () => {
    const appId = await byggdApp();
    await lamna(appId, { helpful: false, text: `  ${KLAGOMAL}  ` });
    expect(m.aterkoppling.skickade[0]?.text).toContain(`\n${KLAGOMAL}\n`);
    expect(raknade(false)).toBe(1);
    expect(raknade(true)).toBe(0);
  });

  it('når aldrig språkmodellen och ändrar inte utkastet', async () => {
    const appId = await byggdApp();
    const fore = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    await lamna(appId, { helpful: false, text: KLAGOMAL });

    // Ingen ny tur hos agenten, och inget av det som skickades dit bär återkopplingen.
    expect(m.agent.inputs).toHaveLength(1);
    expect(JSON.stringify(m.agent.inputs)).not.toContain(KLAGOMAL);
    const efter = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
    expect(efter.json.messages).toEqual(fore.json.messages);
    expect(efter.json.hasDraft).toBe(true);
    expect(efter.text).not.toContain(KLAGOMAL);
    expect(m.control.importerade).toHaveLength(1);
  });

  it('sparar aldrig fritexten på disk', async () => {
    const appId = await byggdApp();
    await lamna(appId, { helpful: false, text: 'hemligheten-i-fritexten' });
    await m.builder.close();
    const { readdir, readFile } = await import('node:fs/promises');
    for (const fil of await readdir(m.dataDir)) {
      const innehall = await readFile(join(m.dataDir, fil));
      expect(innehall.includes('hemligheten-i-fritexten'), fil).toBe(false);
    }
    m.builder = m.starta();
  });

  it('loggar händelsen men aldrig texten', async () => {
    const appId = await byggdApp();
    await lamna(appId, { helpful: false, text: KLAGOMAL });
    expect(m.logg.map((rad) => rad.event)).toContain('feedback_sent');
    expect(JSON.stringify(m.logg)).not.toContain(KLAGOMAL);
    expect(JSON.stringify(m.logg)).not.toContain(ANNA.email);
  });

  it('går mejlet inte iväg ⇒ 500 utan detaljer, och ingenting räknas', async () => {
    const appId = await byggdApp();
    m.aterkoppling.send = async () => {
      throw new Error(`SMTP 550 ${ANNA.email} rejected`);
    };
    const svar = await lamna(appId, { helpful: false, text: KLAGOMAL });
    expect(svar.status).toBe(500);
    expect(svar.json.error.code).toBe('internal');
    expect(svar.text).not.toContain('SMTP');
    expect(svar.text).not.toContain('anna@');
    expect(raknade(false)).toBe(0);
  });
});

describe('tumme upp', () => {
  it('räknas utan att mejla', async () => {
    const appId = await byggdApp();
    const svar = await lamna(appId, { helpful: true });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ received: true });
    expect(m.aterkoppling.skickade).toEqual([]);
    expect(raknade(true)).toBe(1);
  });

  it('räknas en gång per tumme', async () => {
    const appId = await byggdApp();
    await lamna(appId, { helpful: true });
    await lamna(appId, { helpful: true });
    expect(raknade(true)).toBe(2);
  });
});

describe('vad som inte går att skicka', () => {
  it('tom text ⇒ 400 i klarspråk, och inget mejl', async () => {
    const appId = await byggdApp();
    for (const text of ['', '   ', '\n\t ']) {
      const svar = await lamna(appId, { helpful: false, text });
      expect(svar.status, JSON.stringify(text)).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      expect(svar.json.error.message).toMatch(/[Ss]kriv/);
    }
    const utanText = await lamna(appId, { helpful: false });
    expect(utanText.status).toBe(400);
    expect(m.aterkoppling.skickade).toEqual([]);
    expect(raknade(false)).toBe(0);
  });

  it('utan besked om tummen ⇒ 400', async () => {
    const appId = await byggdApp();
    for (const kropp of [{}, { helpful: 'nej' }, { helpful: 0 }, { text: KLAGOMAL }]) {
      const svar = await lamna(appId, kropp);
      expect(svar.status, JSON.stringify(kropp)).toBe(400);
    }
    expect(m.aterkoppling.skickade).toEqual([]);
  });

  it('för lång text eller styrtecken ⇒ 400', async () => {
    const appId = await byggdApp();
    const forLang = await lamna(appId, { helpful: false, text: 'å'.repeat(4001) });
    expect(forLang.status).toBe(400);
    const styrtecken = await lamna(appId, { helpful: false, text: 'Hej\u0000då' });
    expect(styrtecken.status).toBe(400);
    expect(m.aterkoppling.skickade).toEqual([]);
  });

  it('precis så lång text som får plats går igenom', async () => {
    const appId = await byggdApp();
    const svar = await lamna(appId, { helpful: false, text: 'å'.repeat(4000) });
    expect(svar.status).toBe(200);
  });

  it('någon annans app ⇒ exakt samma svar som en app som inte finns', async () => {
    const appId = await byggdApp();
    const annans = await lamna(appId, { helpful: false, text: KLAGOMAL }, BERTIL);
    const okand = await lamna(slumpatAppId(), { helpful: false, text: KLAGOMAL }, BERTIL);
    expect(annans.status).toBe(404);
    expect(annans.json).toEqual(okand.json);
    expect(annans.headers).toEqual(okand.headers);
    expect(m.aterkoppling.skickade).toEqual([]);
  });

  it('bara POST', async () => {
    const appId = await byggdApp();
    for (const metod of ['GET', 'DELETE', 'PUT']) {
      const svar = await anropa(m.builder, ANNA, metod, api(`/apps/${appId}/feedback`));
      expect(svar.status, metod).toBe(405);
    }
  });
});

describe('gränsen per timme', () => {
  it(`högst ${MAX_FEEDBACK_PER_HOUR} per person och timme ⇒ 429, och inget mejl om den sista`, async () => {
    const appId = await byggdApp();
    for (let i = 0; i < MAX_FEEDBACK_PER_HOUR; i++) {
      const svar = await lamna(appId, { helpful: false, text: `Återkoppling ${i}` });
      expect(svar.status, String(i)).toBe(200);
    }
    const forManga = await lamna(appId, { helpful: false, text: 'En gång till' });
    expect(forManga.status).toBe(429);
    expect(forManga.json.error.code).toBe('rate_limited');
    expect(forManga.json.error.message).toMatch(/[Vv]änta/);
    expect(m.aterkoppling.skickade).toHaveLength(MAX_FEEDBACK_PER_HOUR);

    // Gränsen gäller personen, inte appen.
    const annanApp = await byggdApp();
    expect((await lamna(annanApp, { helpful: true })).status).toBe(429);

    m.tid.ms += 60 * 60 * 1000 + 1;
    expect((await lamna(appId, { helpful: false, text: 'En gång till' })).status).toBe(200);
  });

  it('avvisad återkoppling räknas inte mot gränsen', async () => {
    const appId = await byggdApp();
    for (let i = 0; i < MAX_FEEDBACK_PER_HOUR + 5; i++) await lamna(appId, { helpful: false, text: '' });
    expect((await lamna(appId, { helpful: false, text: KLAGOMAL })).status).toBe(200);
  });
});
