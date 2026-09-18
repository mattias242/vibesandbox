import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppId, TenantContext } from '@vibesandbox/contracts';
import { createControl } from '../src/index.ts';
import type { Control } from '../src/index.ts';
import { allaFiler, skapaTempKatalog, skrivTrad, tenant, text } from './hjalp.ts';
import type { TempKatalog } from './hjalp.ts';

describe('Appens filer: manifestet avgör vad som finns', () => {
  let data: TempKatalog;
  let bygge: TempKatalog;
  let control: Control;
  let appId: AppId;

  beforeEach(async () => {
    data = await skapaTempKatalog();
    bygge = await skapaTempKatalog('vibesandbox-bygge-');
    await skrivTrad(bygge.katalog, {
      'index.html': '<!doctype html><title>Publicerad</title>',
      'assets/app-abc123.js': 'export const version = "publicerad";',
      'assets/stil.css': 'body { margin: 0 }',
      'bilder/logga.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'data/text.json': '{"a":1}',
    });
    control = createControl({ dataDir: data.katalog });
    appId = await control.createApp();
    await control.publish(appId, await control.importVersion(appId, bygge.katalog));
  });

  afterEach(async () => {
    await control.close();
    await bygge.stada();
    await data.stada();
  });

  it('läser en fil med innehåll och den innehållstyp som bestämdes vid importen', async () => {
    const fil = await control.files.read(tenant(appId), '/index.html');
    expect(fil).not.toBeNull();
    expect(text(fil!.body)).toContain('Publicerad');
    expect(fil!.contentType).toBe('text/html; charset=utf-8');

    expect((await control.files.read(tenant(appId), '/assets/app-abc123.js'))?.contentType).toBe(
      'text/javascript; charset=utf-8',
    );
    expect((await control.files.read(tenant(appId), '/assets/stil.css'))?.contentType).toBe('text/css; charset=utf-8');
    expect((await control.files.read(tenant(appId), '/bilder/logga.svg'))?.contentType).toBe('image/svg+xml');
    expect((await control.files.read(tenant(appId), '/data/text.json'))?.contentType).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('en sökväg som inte finns ORDAGRANT i manifestet ger null', async () => {
    const nul = String.fromCharCode(0);
    const fientliga: unknown[] = [
      '',
      '/',
      'index.html',
      '/index.html/',
      '//index.html',
      '/./index.html',
      '/assets/../index.html',
      '/../index.html',
      '/INDEX.HTML',
      '/index.html ',
      `/index.html${nul}`,
      `/index.html${nul}.png`,
      '/index%2ehtml',
      '\\index.html',
      '/assets\\app-abc123.js',
      '/assets',
      '/assets/',
      // NFKC gör fullbreddspunkter till vanliga punkter; en normalisering här vore en traversering.
      '/assets/．．/index.html',
      '/．．/．．/control/control.sqlite',
      // Fullbreddsbokstäver som NFKC skulle göra om till "index.html".
      '/ｉｎｄｅｘ.html',
      '/../../control/control.sqlite',
      '/__proto__',
      '/constructor',
      '/' + 'a'.repeat(100_000),
      null,
      undefined,
      42,
      ['/index.html'],
      { toString: () => '/index.html' },
    ];
    for (const sokvag of fientliga) {
      expect(await control.files.read(tenant(appId), sokvag as string), JSON.stringify(sokvag)).toBeNull();
    }
  });

  it('filerna lagras under sin innehållshash — aldrig under ett namn som kommer ur bygget', async () => {
    const pa_disk = await allaFiler(data.katalog);
    const versionsfiler = pa_disk.filter((fil) => fil.startsWith('versions/'));

    expect(versionsfiler.length).toBe(5);
    for (const fil of versionsfiler) expect(fil).toMatch(/^versions\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(pa_disk.join('\n')).not.toMatch(/index\.html|app-abc123|logga/);
  });

  it('utkastet och den publicerade versionen är olika versioner med olika innehåll', async () => {
    const utkast = await skapaTempKatalog('vibesandbox-utkast-');
    try {
      await skrivTrad(utkast.katalog, {
        'index.html': '<!doctype html><title>Utkast</title>',
        'bara-i-utkastet.js': 'export {};',
      });
      await control.setDraft(appId, await control.importVersion(appId, utkast.katalog));

      expect(text((await control.files.read(tenant(appId, 'published'), '/index.html'))!.body)).toContain('Publicerad');
      expect(text((await control.files.read(tenant(appId, 'draft'), '/index.html'))!.body)).toContain('Utkast');
      expect(await control.files.read(tenant(appId, 'published'), '/bara-i-utkastet.js')).toBeNull();
      expect(await control.files.read(tenant(appId, 'draft'), '/assets/stil.css')).toBeNull();
    } finally {
      await utkast.stada();
    }
  });

  it('utan utkast finns inga utkastfiler, och efter avpublicering inga publicerade', async () => {
    expect(await control.files.read(tenant(appId, 'draft'), '/index.html')).toBeNull();

    await control.unpublish(appId);

    expect(await control.files.read(tenant(appId, 'published'), '/index.html')).toBeNull();
  });

  it('en app ser aldrig en annan apps filer', async () => {
    const annan = await control.createApp();

    expect(await control.files.read(tenant(annan), '/index.html')).toBeNull();
  });

  it('ett TenantContext som inte ser ut som ett nekas i stället för att tolkas', async () => {
    const forfalskade: unknown[] = [
      null,
      undefined,
      {},
      { appId, kind: 'admin' },
      { appId, kind: 'constructor' },
      { appId: '../control', kind: 'published' },
      { appId: `${appId}' OR '1'='1`, kind: 'published' },
    ];
    for (const kontext of forfalskade) {
      await expect(control.files.read(kontext as TenantContext, '/index.html')).rejects.toMatchObject({
        code: 'invalid_tenant',
      });
    }
  });

  it('en ny publicering ersätter den gamla, och den gamla versionens filer städas bort', async () => {
    const nytt = await skapaTempKatalog('vibesandbox-nytt-');
    try {
      await skrivTrad(nytt.katalog, { 'index.html': '<!doctype html><title>Version två</title>' });
      await control.publish(appId, await control.importVersion(appId, nytt.katalog));

      expect(text((await control.files.read(tenant(appId), '/index.html'))!.body)).toContain('Version två');
      expect(await control.files.read(tenant(appId), '/assets/stil.css')).toBeNull();
      const versionsfiler = (await allaFiler(data.katalog)).filter((fil) => fil.startsWith('versions/'));
      expect(versionsfiler.length).toBe(1);
    } finally {
      await nytt.stada();
    }
  });

  it('samma innehåll i två appar lagras en gång och överlever att den ena appen raderas', async () => {
    const annan = await control.createApp();
    await control.publish(annan, await control.importVersion(annan, bygge.katalog));
    const fore = (await allaFiler(data.katalog)).filter((fil) => fil.startsWith('versions/'));
    expect(fore.length).toBe(5);

    await control.deleteApp(appId);

    expect(text((await control.files.read(tenant(annan), '/index.html'))!.body)).toContain('Publicerad');
    await control.deleteApp(annan);
    const efter = (await allaFiler(data.katalog)).filter((fil) => fil.startsWith('versions/'));
    expect(efter).toEqual([]);
  });
});
