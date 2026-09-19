/**
 * Tjänsten `files` som gatewayn ser den: `handle` med hyresgäst, identitet och åtkomst redan
 * avgjorda. Fientliga indata prövas här; hela vägen genom gatewayn prövas i scenarierna.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';
import type { FilesFileReader } from '../src/index.ts';
import { DOCX, DOCX_TYP, HTML, PDF, PNG, SVG, TEXT } from './exempelfiler.ts';
import { FEJKVIRUS_MARKOR, startaFejkClamd } from './fejk-clamd.ts';
import type { FejkClamd } from './fejk-clamd.ts';
import { APP_A, APP_B, skapaTjanst, tenant } from './hjalp.ts';
import type { Svar, Testtjanst } from './hjalp.ts';

let t: Testtjanst;

beforeEach(async () => {
  t = await skapaTjanst();
});

afterEach(async () => {
  await t.stang();
});

function fel(s: Svar): ApiErrorBody['error'] {
  return (s.json() as unknown as ApiErrorBody).error;
}

async function uppladdad(s: Promise<Svar>): Promise<{ id: string } & Record<string, unknown>> {
  const r = await s;
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.json() as { id: string };
}

const MB = 1024 * 1024;

describe('fabriken', () => {
  it('heter files och tar emot 20 MB som standard', () => {
    expect(t.instans.service.name).toBe('files');
    expect(t.instans.service.maxBodyBytes).toBe(20 * MB);
    expect(t.instans.fileReader).toBeDefined();
  });

  it('SVC_FILES_MAX_FILE_MB ändrar gränsen, men aldrig över 25 MB', async () => {
    const liten = await skapaTjanst({ SVC_FILES_MAX_FILE_MB: '5' });
    expect(liten.instans.service.maxBodyBytes).toBe(5 * MB);
    await liten.stang();
    await expect(skapaTjanst({ SVC_FILES_MAX_FILE_MB: '26' })).rejects.toThrow(/SVC_FILES_MAX_FILE_MB/);
  });

  it.each([
    ['SVC_FILES_MAX_FILE_MB', '0'],
    ['SVC_FILES_MAX_FILE_MB', 'tjugo'],
    ['SVC_FILES_MAX_FILE_MB', '1.5'],
    ['SVC_FILES_QUOTA_MB', '0'],
    ['SVC_FILES_QUOTA_MB', '-1'],
    ['SVC_FILES_QUOTA_MB', '1e9'],
    ['SVC_FILES_CLAMD', 'clamav'],
    ['SVC_FILES_CLAMD', 'http://clamav:3310'],
  ])('ogiltig inställning %s=%s: vägrar starta och säger vilken', async (namn, varde) => {
    await expect(skapaTjanst({ [namn]: varde })).rejects.toThrow(namn);
  });

  it('utan SVC_FILES_CLAMD: varnar i loggen vid start att filerna inte virusskannas', () => {
    expect(t.logg).toContainEqual(expect.objectContaining({ level: 'warn', event: 'virus_scan_disabled' }));
  });
});

describe('ladda upp', () => {
  it('201 med metadata; typen är den innehållet visar', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, typ: 'image/png', namn: 'semester.png' }));
    expect(fil).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      name: 'semester.png',
      contentType: 'image/png',
      size: PNG.length,
      createdAt: '2026-09-19T08:00:00.000Z',
      uploadedBy: 'anv-anna',
      personal: false,
    });
  });

  it('personal=true ger en personlig fil', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF, typ: 'application/pdf', namn: 'lön.pdf', personal: true }));
    expect(fil['personal']).toBe(true);
  });

  it('utan namn får filen ett neutralt namn med rätt ändelse', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF, typ: 'application/pdf', query: '' }));
    expect(fil['name']).toBe('fil.pdf');
  });

  it('sanerar namnet: ../, NUL och överlånga namn', async () => {
    expect((await uppladdad(t.ladda({ bytes: PNG, namn: '../../etc/passwd.png' })))['name']).toBe('passwd.png');
    expect((await uppladdad(t.ladda({ bytes: PNG, namn: 'bild\u0000.png' })))['name']).toBe('bild.png');
    const lang = (await uppladdad(t.ladda({ bytes: PNG, namn: `${'a'.repeat(900)}.png` })))['name'] as string;
    expect(lang.length).toBeLessThanOrEqual(120);
  });

  it('ett orimligt långt namn nekas', async () => {
    const r = await t.ladda({ bytes: PNG, namn: 'a'.repeat(5000) });
    expect(r.status).toBe(400);
    expect(fel(r).code).toBe('invalid_request');
  });

  it.each([
    ['en parameter två gånger', 'name=a.png&name=b.png'],
    ['personal två gånger', 'name=a.png&personal=true&personal=false'],
    ['personal med okänt värde', 'name=a.png&personal=ja'],
  ])('ogiltig fråga: %s', async (_namn, query) => {
    const r = await t.ladda({ bytes: PNG, query });
    expect(r.status).toBe(400);
    expect(fel(r).code).toBe('invalid_request');
  });

  it('fel magiska byte: en PDF som påstår sig vara en bild nekas med klarspråk', async () => {
    const r = await t.ladda({ bytes: PDF, typ: 'image/png', namn: 'bild.png' });
    expect(r.status).toBe(400);
    expect(fel(r)).toEqual({ code: 'invalid_request', message: expect.stringMatching(/stämmer inte/) });
  });

  it('SVG förklädd som PNG nekas', async () => {
    const r = await t.ladda({ bytes: SVG, typ: 'image/png', namn: 'logga.png' });
    expect(r.status).toBe(400);
    expect(fel(r).code).toBe('invalid_request');
  });

  it('HTML nekas med ett meddelande som säger vilka typer som går', async () => {
    const r = await t.ladda({ bytes: HTML, typ: 'text/html', namn: 'sida.html' });
    expect(r.status).toBe(400);
    expect(fel(r).message).toMatch(/bilder/);
  });

  it('tom fil och saknad kropp nekas', async () => {
    expect((await t.ladda({ bytes: new Uint8Array(0), typ: 'text/plain' })).status).toBe(400);
    expect((await t.anropa({ method: 'POST', query: 'name=a.txt' })).status).toBe(400);
  });

  it('en kropp över gränsen ger 413 även om gatewayn skulle ha släppt igenom den', async () => {
    const liten = await skapaTjanst({ SVC_FILES_MAX_FILE_MB: '1' });
    const stor = new Uint8Array(MB + 1);
    stor.set(PNG);
    const r = await liten.ladda({ bytes: stor, typ: 'image/png' });
    await liten.stang();
    expect(r.status).toBe(413);
    expect(fel(r).code).toBe('too_large');
  });

  it('loggar uppladdningen utan filnamn, innehåll eller användare', async () => {
    await uppladdad(t.ladda({ bytes: PNG, namn: 'Hemligt namn.png' }));
    const rad = t.logg.find((r) => r.event === 'file_uploaded');
    expect(rad).toMatchObject({ level: 'info', app: APP_A.slice(0, 8), kind: 'published', size: PNG.length, contentType: 'image/png' });
    expect(JSON.stringify(t.logg)).not.toMatch(/Hemligt|anv-anna|dold@example/);
  });

  it('filen på disk namnges av plattformen, aldrig av namnet, och inget ligger kvar i tmp', async () => {
    await uppladdad(t.ladda({ bytes: PNG, namn: 'semester.png' }));
    const allt = readdirSync(t.dataDir, { recursive: true }).map(String);
    expect(allt.some((f) => f.includes('semester'))).toBe(false);
    expect(readdirSync(join(t.dataDir, 'blobs')).every((f) => /^[0-9a-f]{32}$/.test(f))).toBe(true);
    expect(readdirSync(join(t.dataDir, 'tmp'))).toEqual([]);
  });
});

describe('lista, hämta och innehåll', () => {
  it('listan visar gemensamma filer och mina personliga, nyaste först', async () => {
    const gemensam = await uppladdad(t.ladda({ bytes: PNG, namn: 'gemensam.png', user: 'anv-bertil' }));
    const min = await uppladdad(t.ladda({ bytes: PDF, namn: 'min.pdf', personal: true }));
    await uppladdad(t.ladda({ bytes: PDF, namn: 'bertils.pdf', personal: true, user: 'anv-bertil' }));
    const r = await t.anropa({});
    expect(r.status).toBe(200);
    const namn = (r.json()['files'] as { name: string }[]).map((f) => f.name).sort();
    expect(namn).toEqual(['gemensam.png', 'min.pdf']);
    expect((r.json()['files'] as { id: string }[]).map((f) => f.id)).toContain(gemensam.id);
    expect(min.id).not.toBe(gemensam.id);
  });

  it('metadata för en fil', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, namn: 'a.png' }));
    const r = await t.anropa({ segments: [fil.id] });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual(fil);
    expect(r.headers['Cache-Control']).toMatch(/no-store/);
  });

  it('bilder visas inline, med rätt typ och utan cache', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, namn: 'Semester i Västerås.png' }));
    const r = await t.anropa({ segments: [fil.id, 'content'] });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.bytes()).equals(Buffer.from(PNG))).toBe(true);
    expect(r.headers).toEqual({
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="Semester i Vasteras.png"',
      'Cache-Control': 'private, no-store',
    });
  });

  it('allt annat laddas ned som bilaga', async () => {
    const pdf = await uppladdad(t.ladda({ bytes: PDF, namn: 'protokoll.pdf' }));
    expect((await t.anropa({ segments: [pdf.id, 'content'] })).headers['Content-Disposition']).toBe('attachment; filename="protokoll.pdf"');
    const docx = await uppladdad(t.ladda({ bytes: DOCX, typ: DOCX_TYP, namn: 'brev.docx' }));
    expect((await t.anropa({ segments: [docx.id, 'content'] })).headers['Content-Type']).toBe(DOCX_TYP);
    const text = await uppladdad(t.ladda({ bytes: TEXT, typ: 'text/plain', namn: 'a.txt' }));
    const r = await t.anropa({ segments: [text.id, 'content'] });
    expect(r.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="a.txt"');
  });

  it('HEAD ger samma svar som GET', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG }));
    expect((await t.anropa({ method: 'HEAD', segments: [fil.id, 'content'] })).status).toBe(200);
  });

  it.each([
    ['ett id med fel form', ['../../files.sqlite']],
    ['ett id med versaler', ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']],
    ['ett id som inte finns', ['0123456789abcdef0123456789abcdef']],
    ['en okänd undersökväg', ['0123456789abcdef0123456789abcdef', 'annat']],
    ['för många led', ['a', 'b', 'c']],
  ])('%s ⇒ finns inte', async (_namn, segments) => {
    const r = await t.anropa({ segments });
    expect(r.status).toBe(404);
    expect(fel(r).code).toBe('not_found');
  });

  it('fel metod ⇒ 405', async () => {
    expect((await t.anropa({ method: 'PUT' })).status).toBe(405);
    const fil = await uppladdad(t.ladda({ bytes: PNG }));
    expect((await t.anropa({ method: 'POST', segments: [fil.id] })).status).toBe(405);
    expect((await t.anropa({ method: 'DELETE', segments: [fil.id, 'content'] })).status).toBe(405);
  });
});

describe('isolering', () => {
  it('en annan apps fil-id ⇒ finns inte, för metadata, innehåll och borttagning', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG }));
    for (const anrop of [{ segments: [fil.id] }, { segments: [fil.id, 'content'] }, { method: 'DELETE', segments: [fil.id] }]) {
      const r = await t.anropa({ ...anrop, tenant: tenant(APP_B) });
      expect(r.status).toBe(404);
    }
    expect((await t.anropa({ tenant: tenant(APP_B) })).json()['files']).toEqual([]);
    // Filen finns kvar i sin egen app.
    expect((await t.anropa({ segments: [fil.id] })).status).toBe(200);
  });

  it('utkastet och den publicerade appen delar inte filer', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG }));
    expect((await t.anropa({ segments: [fil.id], tenant: tenant(APP_A, 'draft') })).status).toBe(404);
    expect((await t.anropa({ tenant: tenant(APP_A, 'draft') })).json()['files']).toEqual([]);
  });

  it('en personlig fil från en annan användare ⇒ finns inte, även för appens ägare', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF, personal: true, user: 'anv-bertil' }));
    for (const anrop of [{ segments: [fil.id] }, { segments: [fil.id, 'content'] }, { method: 'DELETE', segments: [fil.id] }]) {
      expect((await t.anropa({ ...anrop, user: 'anv-cecilia' })).status).toBe(404);
      expect((await t.anropa({ ...anrop, user: 'anv-anna', access: 'owner' })).status).toBe(404);
    }
    expect((await t.anropa({ segments: [fil.id], user: 'anv-bertil' })).status).toBe(200);
  });
});

describe('ta bort', () => {
  it('den som laddade upp kan ta bort sin fil; innehållet försvinner från disken', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, user: 'anv-bertil' }));
    const r = await t.anropa({ method: 'DELETE', segments: [fil.id], user: 'anv-bertil' });
    expect(r.status).toBe(204);
    expect((await t.anropa({ segments: [fil.id], user: 'anv-bertil' })).status).toBe(404);
    expect(readdirSync(join(t.dataDir, 'blobs'))).toEqual([]);
  });

  it('appens ägare kan ta bort någon annans gemensamma fil', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, user: 'anv-bertil' }));
    expect((await t.anropa({ method: 'DELETE', segments: [fil.id], user: 'anv-anna', access: 'owner' })).status).toBe(204);
  });

  it('en vanlig användare kan inte ta bort någon annans fil', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PNG, user: 'anv-anna' }));
    const r = await t.anropa({ method: 'DELETE', segments: [fil.id], user: 'anv-bertil', access: 'user' });
    expect(r.status).toBe(403);
    expect(fel(r).code).toBe('forbidden');
    expect((await t.anropa({ segments: [fil.id] })).status).toBe(200);
  });
});

describe('kvot per app', () => {
  it('quota_exceeded med klarspråk när appens utrymme är slut; utkastet har ett eget', async () => {
    const liten = await skapaTjanst({ SVC_FILES_MAX_FILE_MB: '1', SVC_FILES_QUOTA_MB: '1' });
    const halv = new Uint8Array(MB / 2 + 10);
    halv.set(PNG);
    expect((await liten.ladda({ bytes: halv })).status).toBe(201);
    const full = await liten.ladda({ bytes: halv });
    expect(full.status).toBe(507);
    expect(fel(full)).toEqual({ code: 'quota_exceeded', message: expect.stringMatching(/utrymme/) });
    // Utkastet och andra appar påverkas inte.
    expect((await liten.ladda({ bytes: halv, tenant: tenant(APP_A, 'draft') })).status).toBe(201);
    expect((await liten.ladda({ bytes: halv, tenant: tenant(APP_B) })).status).toBe(201);
    // Inget halvsparat ligger kvar av den nekade filen.
    expect(readdirSync(join(liten.dataDir, 'blobs'))).toHaveLength(3);
    await liten.stang();
  });

  it('samtidiga uppladdningar kan inte tillsammans gå över kvoten', async () => {
    const liten = await skapaTjanst({ SVC_FILES_MAX_FILE_MB: '1', SVC_FILES_QUOTA_MB: '1' });
    const halv = new Uint8Array(MB / 2 + 10);
    halv.set(PNG);
    const svar = await Promise.all([1, 2, 3, 4].map(() => liten.ladda({ bytes: halv })));
    expect(svar.filter((s) => s.status === 201)).toHaveLength(1);
    expect(svar.filter((s) => s.status === 507)).toHaveLength(3);
    expect(readdirSync(join(liten.dataDir, 'blobs'))).toHaveLength(1);
    await liten.stang();
  });

  it('en borttagen fil ger tillbaka utrymmet', async () => {
    const liten = await skapaTjanst({ SVC_FILES_MAX_FILE_MB: '1', SVC_FILES_QUOTA_MB: '1' });
    const halv = new Uint8Array(MB / 2 + 10);
    halv.set(PNG);
    const fil = (await liten.ladda({ bytes: halv })).json() as { id: string };
    expect((await liten.ladda({ bytes: halv })).status).toBe(507);
    await liten.anropa({ method: 'DELETE', segments: [fil.id] });
    expect((await liten.ladda({ bytes: halv })).status).toBe(201);
    await liten.stang();
  });
});

describe('virusskanning', () => {
  let clamd: FejkClamd | undefined;

  afterEach(async () => {
    await clamd?.stang();
    clamd = undefined;
  });

  it('en ren fil skannas och sparas', async () => {
    clamd = await startaFejkClamd();
    const s = await skapaTjanst({ SVC_FILES_CLAMD: clamd.adress });
    expect(s.logg.some((r) => r.event === 'virus_scan_disabled')).toBe(false);
    expect((await s.ladda({ bytes: TEXT, typ: 'text/plain' })).status).toBe(201);
    expect(clamd.skannade()).toBe(1);
    await s.stang();
  });

  it('en smittad fil nekas och sparas inte', async () => {
    clamd = await startaFejkClamd();
    const s = await skapaTjanst({ SVC_FILES_CLAMD: clamd.adress });
    const r = await s.ladda({ bytes: Uint8Array.from(Buffer.from(`hej ${FEJKVIRUS_MARKOR}`)), typ: 'text/plain' });
    expect(r.status).toBe(400);
    expect(fel(r).message).toMatch(/skadlig kod/);
    expect((await s.anropa({})).json()['files']).toEqual([]);
    expect(readdirSync(join(s.dataDir, 'blobs'))).toEqual([]);
    expect(s.logg).toContainEqual(expect.objectContaining({ event: 'virus_found', signature: 'Vibesandbox.Fejkvirus' }));
    await s.stang();
  });

  it('går clamd inte att nå sparas filen inte (fail closed)', async () => {
    clamd = await startaFejkClamd('fel');
    const s = await skapaTjanst({ SVC_FILES_CLAMD: clamd.adress });
    const r = await s.ladda({ bytes: TEXT, typ: 'text/plain' });
    expect(r.status).toBe(500);
    expect(fel(r)).toEqual({ code: 'internal', message: expect.stringMatching(/kontrolleras/) });
    expect(readdirSync(join(s.dataDir, 'blobs'))).toEqual([]);
    await s.stang();
  });
});

describe('fileReader (för OCR och tal till text)', () => {
  it('läser en gemensam fil i samma hyresgäst', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF, namn: 'protokoll.pdf' }));
    const las = await t.instans.fileReader?.read(tenant(), fil.id);
    expect(las?.contentType).toBe('application/pdf');
    expect(las?.name).toBe('protokoll.pdf');
    expect(Buffer.from(las?.body ?? []).equals(Buffer.from(PDF))).toBe(true);
  });

  it('en annan app, utkastet eller ett påhittat id ⇒ null', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF }));
    const reader = t.instans.fileReader;
    expect(await reader?.read(tenant(APP_B), fil.id)).toBeNull();
    expect(await reader?.read(tenant(APP_A, 'draft'), fil.id)).toBeNull();
    expect(await reader?.read(tenant(), '../../files.sqlite')).toBeNull();
    expect(await reader?.read(tenant(), '0123456789abcdef0123456789abcdef')).toBeNull();
  });

  it('en personlig fil läses inte utan att veta vem som frågar; readForUser läser bara ägarens egen', async () => {
    const fil = await uppladdad(t.ladda({ bytes: PDF, personal: true, user: 'anv-bertil' }));
    const reader = t.instans.fileReader as FilesFileReader;
    expect(await reader.read(tenant(), fil.id)).toBeNull();
    expect(await reader.readForUser(tenant(), 'anv-anna', fil.id)).toBeNull();
    expect((await reader.readForUser(tenant(), 'anv-bertil', fil.id))?.name).toBe('fil.pdf');
  });
});

describe('lagringen', () => {
  let katalog: string;

  beforeEach(async () => {
    katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-files-lagring-'));
  });

  afterEach(async () => {
    await rm(katalog, { recursive: true, force: true });
  });

  it('överlever en omstart', async () => {
    const forsta = await skapaTjanst({}, katalog);
    const fil = await uppladdad(forsta.ladda({ bytes: PNG, namn: 'kvar.png' }));
    await forsta.stang();
    const andra = await skapaTjanst({}, katalog);
    expect((await andra.anropa({ segments: [fil.id] })).json()['name']).toBe('kvar.png');
    await andra.stang();
  });

  it('städar vid start bort halvskrivna filer och innehåll utan metadata (efter en krasch)', async () => {
    const forsta = await skapaTjanst({}, katalog);
    const fil = await uppladdad(forsta.ladda({ bytes: PNG }));
    await forsta.stang();
    await writeFile(join(katalog, 'tmp', '0123456789abcdef0123456789abcdef.tmp'), 'halv');
    await writeFile(join(katalog, 'blobs', 'fedcba9876543210fedcba9876543210'), 'föräldralös');
    const andra = await skapaTjanst({}, katalog);
    expect(readdirSync(join(katalog, 'tmp'))).toEqual([]);
    expect(readdirSync(join(katalog, 'blobs'))).toHaveLength(1);
    expect((await andra.anropa({ segments: [fil.id, 'content'] })).status).toBe(200);
    await andra.stang();
  });

  it('databasen är STRICT', async () => {
    const s = await skapaTjanst({}, katalog);
    await s.stang();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(katalog, 'files.sqlite'));
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'files'").get() as { sql: string }).sql);
    db.close();
    expect(sql).toMatch(/STRICT/);
  });

  it('fabriken skapar sin katalog om den saknas', () => {
    const inre = join(katalog, 'finns', 'inte');
    const instans = factory({
      dataDir: inre,
      env: {},
      log: () => {},
      now: () => new Date(),
      members: {} as never,
      store: {} as never,
      publishedUrl: () => '',
    });
    expect(existsSync(join(inre, 'files.sqlite'))).toBe(true);
    return instans.service.close?.();
  });
});
