/**
 * Tjänsten `transcribe` från gatewayns sida: förfrågningar in, svar ut — med en fejkad Berget på
 * en lokal port (riktig multipart över HTTP) och en fejkad filtjänst. Fientliga fall först.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppService, AppServiceDependencies, AppServiceResponse } from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';
import { BERGET_MAX_FILE_BYTES } from '../src/konfig.ts';
import {
  APP_B,
  BERGET_TEXT,
  felkod,
  forfragan,
  json,
  miljo,
  mp3,
  tenant,
  vantaTills,
  wav,
} from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
const oppna: AppService[] = [];

function skapa(env: Record<string, string> = {}, andra: Partial<AppServiceDependencies> = {}): AppService {
  if (factory === undefined) throw new Error('Fabriken saknas.');
  const service = factory({ ...m.beroenden(env), ...andra }).service;
  oppna.push(service);
  return service;
}

async function starta(service: AppService, fileId = 'fil-1', extra: Record<string, unknown> = {}, userId = 'anv-bertil'): Promise<AppServiceResponse> {
  return service.handle(forfragan({ method: 'POST', json: { fileId, ...extra }, userId }));
}

async function jobb(service: AppService, jobId: string, userId = 'anv-bertil', access: 'owner' | 'user' = 'user') {
  return service.handle(forfragan({ segments: [jobId], userId, access }));
}

async function tillSlut(service: AppService, jobId: string): Promise<Record<string, unknown>> {
  let senast: Record<string, unknown> = {};
  await vantaTills(async () => {
    senast = json(await jobb(service, jobId));
    return senast['status'] === 'done' || senast['status'] === 'failed';
  });
  return senast;
}

beforeEach(async () => {
  m = await miljo();
  m.filer.lagg(tenant(), 'fil-1', { body: wav(5), contentType: 'audio/wav' });
});

afterEach(async () => {
  for (const s of oppna.splice(0)) await s.close?.();
  await m.stada();
});

describe('fabriken', () => {
  it('kastar med klarspråk när files saknas', () => {
    const { files: _files, ...utan } = m.beroenden();
    expect(() => factory?.(utan)).toThrow(/files/);
  });

  it('kastar med klarspråk när Berget saknas', () => {
    const { berget: _berget, ...utan } = m.beroenden();
    expect(() => factory?.(utan)).toThrow(/Berget/);
  });

  it('heter transcribe och tar bara emot små kroppar (ljudet kommer från files)', () => {
    const s = skapa();
    expect(s.name).toBe('transcribe');
    expect(s.maxBodyBytes).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('en utskrift', () => {
  it('POST ger 202 och ett jobb; jobbet blir klart med text och tidsangivelser', async () => {
    const s = skapa();
    const svar = await starta(s, 'fil-1', { language: 'sv' });
    expect(svar.status).toBe(202);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    const { jobId } = json(svar) as { jobId: string };
    expect(jobId).toMatch(/^[0-9a-f]{32}$/);

    const klart = await tillSlut(s, jobId);
    expect(klart).toEqual({
      status: 'done',
      text: BERGET_TEXT,
      segments: [
        { start: 0, end: 2.5, text: 'Välkomna till mötet.' },
        { start: 2.5, end: 5, text: 'Första punkten är budgeten.' },
      ],
    });
  });

  it('skickar ljudet som multipart till /audio/transcriptions med modell, språk och nyckel — men aldrig filnamnet', async () => {
    m.filer.lagg(tenant(), 'fil-1', { body: wav(5), contentType: 'audio/wav', name: 'Anna Svensson intervju.wav' });
    const s = skapa({ SVC_TRANSCRIBE_MODEL: 'KBLab/kb-whisper-large' });
    const { jobId } = json(await starta(s, 'fil-1', { language: 'sv' })) as { jobId: string };
    await tillSlut(s, jobId);

    const [anrop] = m.berget.anrop;
    expect(anrop?.path).toBe('/v1/audio/transcriptions');
    expect(anrop?.authorization).toBe(`Bearer ${m.berget.apiKey}`);
    expect(anrop?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(anrop?.falt).toMatchObject({ model: 'KBLab/kb-whisper-large', language: 'sv', response_format: 'verbose_json' });
    expect(anrop?.fil).toEqual({ name: 'ljud.wav', type: 'audio/wav', bytes: wav(5).byteLength });
  });

  it('utan språk skickas inget språk (Berget känner igen det själv)', async () => {
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    expect(m.berget.anrop[0]?.falt['language']).toBeUndefined();
  });

  it('kopian av ljudet tas bort när jobbet är klart', async () => {
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    expect(await readdir(join(m.dataDir, 'ljud'))).toEqual([]);
  });

  it('konstiga segment från Berget filtreras bort i stället för att nå appen', async () => {
    m.berget.svar = {
      typ: 'ok',
      segments: [{ start: 0, end: 1, text: ' ok ' }, { start: 'x', end: 1, text: 'fel' }, null, { start: 1, end: Infinity, text: 'y' }, 'skräp'],
    };
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    const klart = await tillSlut(s, jobId);
    expect(klart['segments']).toEqual([{ start: 0, end: 1, text: 'ok' }]);
  });
});

describe('fientliga förfrågningar', () => {
  it('en fil från en annan app finns inte — och ingenting skickas till Berget', async () => {
    m.filer.lagg(tenant(APP_B), 'fil-b', { body: wav(5), contentType: 'audio/wav' });
    const s = skapa();
    const svar = await starta(s, 'fil-b');
    expect(svar.status).toBe(404);
    expect(felkod(svar)).toBe('not_found');
    expect(m.berget.anrop).toHaveLength(0);
  });

  it('en fil i den publicerade appen finns inte för utkastet', async () => {
    const s = skapa();
    const svar = await s.handle(forfragan({ method: 'POST', json: { fileId: 'fil-1' }, tenant: tenant(undefined, 'draft') }));
    expect(svar.status).toBe(404);
  });

  it.each([
    ['en pdf', new Uint8Array(Buffer.from('%PDF-1.7')), 'application/pdf'],
    ['en pdf som påstår sig vara ljud', new Uint8Array(Buffer.from('%PDF-1.7 ........')), 'audio/mpeg'],
    ['en bild', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
    ['en tom fil', new Uint8Array(0), 'audio/wav'],
  ])('%s avvisas med klarspråk', async (_namn, body, contentType) => {
    m.filer.lagg(tenant(), 'fil-x', { body, contentType });
    const s = skapa();
    const svar = await starta(s, 'fil-x');
    expect(svar.status).toBe(400);
    expect(felkod(svar)).toBe('invalid_request');
    expect((json(svar)['error'] as { message: string }).message).toMatch(/ljudfiler/);
    expect(m.berget.anrop).toHaveLength(0);
  });

  it('en fil större än Bergets gräns avvisas innan något skickas', async () => {
    m.filer.lagg(tenant(), 'stor', { body: mp3(BERGET_MAX_FILE_BYTES + 1), contentType: 'audio/mpeg' });
    const s = skapa();
    const svar = await starta(s, 'stor');
    expect(svar.status).toBe(413);
    expect(felkod(svar)).toBe('too_large');
    expect(m.berget.anrop).toHaveLength(0);
  });

  it.each([
    ['saknat fileId', {}],
    ['fileId som tal', { fileId: 1 }],
    ['tomt fileId', { fileId: '' }],
    ['fileId med ../', { fileId: '../fil-1' }],
    ['fileId med NUL', { fileId: 'fil\u00001' }],
    ['överlångt fileId', { fileId: 'a'.repeat(1000) }],
    ['okänt språk', { fileId: 'fil-1', language: 'de' }],
    ['språk i fel skiftläge', { fileId: 'fil-1', language: 'SV' }],
    ['okänt fält', { fileId: 'fil-1', appId: APP_B }],
    ['en lista', ['fil-1']],
    ['null', null],
  ])('%s ⇒ invalid_request', async (_namn, kropp) => {
    const s = skapa();
    const svar = await s.handle(forfragan({ method: 'POST', json: kropp }));
    expect(svar.status).toBe(400);
    expect(felkod(svar)).toBe('invalid_request');
  });

  it('en kropp som inte är JSON ⇒ invalid_request', async () => {
    const s = skapa();
    const svar = await s.handle(forfragan({ method: 'POST', body: new Uint8Array([0xff, 0xfe, 0x7b]) }));
    expect(felkod(svar)).toBe('invalid_request');
  });

  it('fel metod ⇒ 405, okänd väg ⇒ 404', async () => {
    const s = skapa();
    expect((await s.handle(forfragan({ method: 'GET' }))).status).toBe(405);
    expect((await s.handle(forfragan({ method: 'DELETE', segments: ['a'.repeat(32)] }))).status).toBe(405);
    expect((await s.handle(forfragan({ segments: ['a', 'b'] }))).status).toBe(404);
  });

  it('ett jobb-id i fel form eller som inte finns ⇒ 404', async () => {
    const s = skapa();
    for (const id of ['../x', 'A'.repeat(32), '0'.repeat(32), 'x']) {
      const svar = await jobb(s, id);
      expect(svar.status).toBe(404);
    }
  });
});

describe('vem som kan läsa resultatet', () => {
  it('den som startade och appens ägare kan läsa; en annan användare får samma svar som för ett okänt jobb', async () => {
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);

    expect((await jobb(s, jobId, 'anv-anna', 'owner')).status).toBe(200);
    const cecilia = await jobb(s, jobId, 'anv-cecilia', 'user');
    const okant = await jobb(s, 'f'.repeat(32), 'anv-cecilia', 'user');
    expect(cecilia.status).toBe(404);
    expect(cecilia.body).toEqual(okant.body);
  });

  it('en annan app — eller utkastet — ser inte jobbet, inte ens som ägare', async () => {
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    for (const t of [tenant(APP_B), tenant(undefined, 'draft')]) {
      const svar = await s.handle(forfragan({ segments: [jobId], tenant: t, userId: 'anv-bertil', access: 'owner' }));
      expect(svar.status).toBe(404);
    }
  });
});

describe('leverantörsfel', () => {
  it('ett fel från Berget ⇒ failed med klarspråk, aldrig Bergets text', async () => {
    m.berget.svar = { typ: 'fel', status: 500, kropp: 'Traceback: CUDA out of memory at node gpu-7 HEMLIGT' };
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    const klart = await tillSlut(s, jobId);
    expect(klart['status']).toBe('failed');
    expect(klart['error']).toMatch(/gick inte/);
    expect(JSON.stringify(klart)).not.toMatch(/CUDA|HEMLIGT|Traceback/);
    expect(JSON.stringify(m.logg)).not.toMatch(/CUDA|HEMLIGT|Traceback/);
  });

  it('ett svar som inte är JSON ⇒ failed', async () => {
    m.berget.svar = { typ: 'skrap', kropp: '<html>bad gateway</html>' };
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    expect((await tillSlut(s, jobId))['status']).toBe('failed');
  });

  it('en timeout ⇒ failed med klarspråk om att det tog för lång tid', async () => {
    m.berget.svar = { typ: 'hang' };
    const s = skapa({ SVC_TRANSCRIBE_TIMEOUT_SECONDS: '1' });
    const { jobId } = json(await starta(s)) as { jobId: string };
    const klart = await tillSlut(s, jobId);
    expect(klart['status']).toBe('failed');
    expect(klart['error']).toMatch(/för lång tid/);
  });
});

describe('kön', () => {
  it('kör högst SVC_TRANSCRIBE_CONCURRENCY jobb samtidigt', async () => {
    m.berget.svar = { typ: 'hang' };
    for (const id of ['a', 'b', 'c']) m.filer.lagg(tenant(), id, { body: wav(1), contentType: 'audio/wav' });
    const s = skapa({ SVC_TRANSCRIBE_CONCURRENCY: '2' });
    const idn: string[] = [];
    for (const id of ['a', 'b', 'c']) idn.push((json(await starta(s, id)) as { jobId: string }).jobId);
    await m.berget.vantaPaAnrop(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.berget.anrop).toHaveLength(2);
    const statusar = await Promise.all(idn.map(async (id) => json(await jobb(s, id))['status']));
    expect(statusar).toEqual(['running', 'running', 'queued']);

    m.berget.svar = { typ: 'ok' };
    m.berget.slapp();
    for (const id of idn) expect((await tillSlut(s, id))['status']).toBe('done');
  });

  it('close() avbryter pågående jobb och väntar in dem; efter omstart görs jobbet klart', async () => {
    m.berget.svar = { typ: 'hang' };
    const forsta = skapa();
    const { jobId } = json(await starta(forsta)) as { jobId: string };
    await m.berget.vantaPaAnrop(1);
    await forsta.close?.();
    oppna.splice(oppna.indexOf(forsta), 1);

    m.berget.svar = { typ: 'ok' };
    const andra = skapa();
    const klart = await tillSlut(andra, jobId);
    expect(klart['status']).toBe('done');
    expect(klart['text']).toBe(BERGET_TEXT);
  });

  it('efter en krasch mitt i ett jobb körs det om en gång; kraschar det igen blir det failed', async () => {
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    await s.close?.();
    oppna.splice(oppna.indexOf(s), 1);

    // Som om processen dog mitt i: jobbet står som pågående, ljudet finns kvar.
    const db = new DatabaseSync(join(m.dataDir, 'transcribe.sqlite'));
    db.prepare("UPDATE jobs SET status = 'running', attempts = 1, text = NULL, segments = NULL, finished_at = NULL WHERE job_id = ?").run(jobId);
    db.close();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(m.dataDir, 'ljud', jobId), wav(5));

    const efterKrasch = skapa();
    expect((await tillSlut(efterKrasch, jobId))['status']).toBe('done');
    await efterKrasch.close?.();
    oppna.splice(oppna.indexOf(efterKrasch), 1);

    const db2 = new DatabaseSync(join(m.dataDir, 'transcribe.sqlite'));
    db2.prepare("UPDATE jobs SET status = 'running', attempts = 2, text = NULL, segments = NULL, finished_at = NULL WHERE job_id = ?").run(jobId);
    db2.close();
    await writeFile(join(m.dataDir, 'ljud', jobId), wav(5));
    const igen = skapa();
    const klart = await tillSlut(igen, jobId);
    expect(klart['status']).toBe('failed');
    expect(klart['error']).toMatch(/avbröts/);
    expect(await readdir(join(m.dataDir, 'ljud'))).toEqual([]);
  });
});

describe('kvot per app och dygn', () => {
  it('räknar ljudminuter per app; över gränsen ⇒ 429 med klarspråk', async () => {
    m.filer.lagg(tenant(), 'atta', { body: wav(8 * 60), contentType: 'audio/wav' });
    m.filer.lagg(tenant(), 'fem', { body: wav(5 * 60), contentType: 'audio/wav' });
    m.filer.lagg(tenant(), 'en', { body: wav(60), contentType: 'audio/wav' });
    m.berget.svar = { typ: 'ok', duration: 8 * 60 };
    const s = skapa({ SVC_TRANSCRIBE_MINUTES_PER_APP_DAY: '10' });
    const { jobId } = json(await starta(s, 'atta')) as { jobId: string };
    await tillSlut(s, jobId);

    const svar = await starta(s, 'fem');
    expect(svar.status).toBe(429);
    expect(felkod(svar)).toBe('rate_limited');
    expect((json(svar)['error'] as { message: string }).message).toMatch(/ljudminuter/);
    expect(m.berget.anrop).toHaveLength(1);
    // En minut ryms fortfarande.
    expect((await starta(s, 'en')).status).toBe(202);
  });

  it('kvoten gäller hela appen, oavsett användare, men inte andra appar', async () => {
    m.filer.lagg(tenant(), 'fem', { body: wav(5 * 60), contentType: 'audio/wav' });
    m.filer.lagg(tenant(APP_B), 'fem', { body: wav(5 * 60), contentType: 'audio/wav' });
    const s = skapa({ SVC_TRANSCRIBE_MINUTES_PER_APP_DAY: '6' });
    expect((await starta(s, 'fem', {}, 'anv-anna')).status).toBe(202);
    expect((await starta(s, 'fem', {}, 'anv-bertil')).status).toBe(429);
    const annan = await s.handle(forfragan({ method: 'POST', json: { fileId: 'fem' }, tenant: tenant(APP_B) }));
    expect(annan.status).toBe(202);
  });

  it('räknas om efter ett dygn', async () => {
    m.filer.lagg(tenant(), 'fem', { body: wav(5 * 60), contentType: 'audio/wav' });
    const s = skapa({ SVC_TRANSCRIBE_MINUTES_PER_APP_DAY: '6' });
    expect((await starta(s, 'fem')).status).toBe(202);
    expect((await starta(s, 'fem')).status).toBe(429);
    m.nu = new Date(m.nu.getTime() + 24 * 3600_000 + 1000);
    expect((await starta(s, 'fem')).status).toBe(202);
  });

  it('en app kan inte köa hur många jobb som helst', async () => {
    m.berget.svar = { typ: 'hang' };
    const s = skapa({ SVC_TRANSCRIBE_CONCURRENCY: '1' });
    const statusar: number[] = [];
    for (let i = 0; i < 12; i += 1) statusar.push((await starta(s)).status);
    expect(statusar.filter((x) => x === 202).length).toBeLessThan(12);
    expect(statusar.at(-1)).toBe(429);
  });
});

describe('gallring', () => {
  it('ett färdigt resultat finns inte kvar efter SVC_TRANSCRIBE_RETENTION_DAYS', async () => {
    const s = skapa({ SVC_TRANSCRIBE_RETENTION_DAYS: '2' });
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    m.nu = new Date(m.nu.getTime() + 24 * 3600_000);
    expect((await jobb(s, jobId)).status).toBe(200);
    m.nu = new Date(m.nu.getTime() + 24 * 3600_000 + 1000);
    expect((await jobb(s, jobId)).status).toBe(404);
  });
});

describe('loggar', () => {
  it('innehåller aldrig text, filnamn, användar-id eller hela app-id:t', async () => {
    m.filer.lagg(tenant(), 'fil-1', { body: wav(5), contentType: 'audio/wav', name: 'Hemlig intervju.wav' });
    const s = skapa();
    const { jobId } = json(await starta(s)) as { jobId: string };
    await tillSlut(s, jobId);
    const logg = JSON.stringify(m.logg);
    expect(m.logg.length).toBeGreaterThan(0);
    expect(logg).not.toContain('Välkomna');
    expect(logg).not.toContain('Hemlig');
    expect(logg).not.toContain('anv-bertil');
    expect(logg).not.toContain(tenant().appId);
    expect(logg).toContain(tenant().appId.slice(0, 8));
  });
});
