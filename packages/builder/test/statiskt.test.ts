/**
 * Byggverktygets egna statiska filer: ett manifest som läses in vid start och slås upp exakt.
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANNA, UI_FILER, VERA, anropa, skapaMiljo, skrivTrad, tempKatalog } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

describe('statiska filer', () => {
  it('/ och /index.html ger index.html med no-store', async () => {
    for (const path of ['/', '/index.html']) {
      const svar = await anropa(m.builder, ANNA, 'GET', path);
      expect(svar.status, path).toBe(200);
      expect(svar.text).toBe(UI_FILER['index.html']);
      expect(svar.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(svar.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('serverar filer med typ ur ändelsen', async () => {
    const js = await anropa(m.builder, ANNA, 'GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.text).toBe(UI_FILER['assets/app.js']);
    expect(js.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    const css = await anropa(m.builder, ANNA, 'GET', '/assets/app.css');
    expect(css.headers['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('SPA-fallback för sökvägar utan filändelse', async () => {
    for (const path of ['/appar', '/appar/0123456789abcdefghjkmnpqrs', '/installningar/konto']) {
      const svar = await anropa(m.builder, ANNA, 'GET', path);
      expect(svar.status, path).toBe(200);
      expect(svar.text).toBe(UI_FILER['index.html']);
      expect(svar.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('en saknad fil med ändelse ⇒ 404, aldrig index.html', async () => {
    for (const path of ['/saknas.js', '/assets/bild.png', '/assets/app.js.map', '/INDEX.HTML', '/assets/APP.JS']) {
      const svar = await anropa(m.builder, ANNA, 'GET', path);
      expect(svar.status, path).toBe(404);
      expect(svar.text).not.toContain('<title>Bygg');
    }
  });

  it('webbgränssnittet kräver inte rollen builder — den som bara får titta ser sidan', async () => {
    const svar = await anropa(m.builder, VERA, 'GET', '/');
    expect(svar.status).toBe(200);
  });

  it('andra metoder än GET/HEAD ⇒ 405', async () => {
    const svar = await anropa(m.builder, ANNA, 'POST', '/index.html');
    expect(svar.status).toBe(405);
    const head = await anropa(m.builder, ANNA, 'HEAD', '/index.html');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
  });

  it('fientliga sökvägar ger aldrig något utanför katalogen', async () => {
    for (const path of ['/../../etc/passwd', '/assets/../index.html', '/%2e%2e/x.js', '/assets//app.js', '/assets\\app.js', '/．．/x.js', '/index.html\u0000.js']) {
      const svar = await anropa(m.builder, ANNA, 'GET', path);
      expect([200, 404], path).toContain(svar.status);
      if (svar.status === 200) expect(svar.text, path).toBe(UI_FILER['index.html']);
    }
  });

  it('manifestet läses vid start: senare ändringar på disk syns inte', async () => {
    await writeFile(join(m.uiDir, 'ny.js'), 'ny');
    const svar = await anropa(m.builder, ANNA, 'GET', '/ny.js');
    expect(svar.status).toBe(404);
  });
});

describe('manifestet läser aldrig utanför ui.directory', () => {
  let utanfor: string;
  beforeEach(async () => {
    utanfor = await tempKatalog('vibesandbox-builder-hemligt-');
    await skrivTrad(utanfor, { 'hemlig.js': 'HEMLIGT', 'katalog/annan.js': 'HEMLIGT2' });
    await symlink(join(utanfor, 'hemlig.js'), join(m.uiDir, 'lank.js'));
    await symlink(join(utanfor, 'katalog'), join(m.uiDir, 'lankkatalog'));
    await symlink(join(m.uiDir, 'index.html'), join(m.uiDir, 'inre-lank.js'));
    await writeFile(join(m.uiDir, 'okand.exe'), 'MZ');
    await writeFile(join(m.uiDir, '.env'), 'NYCKEL=1');
    await m.builder.close();
    m.builder = m.starta();
  });
  afterEach(async () => {
    await rm(utanfor, { recursive: true, force: true });
  });

  it('symlänkar, okända ändelser och punktfiler hamnar inte i manifestet', async () => {
    for (const path of ['/lank.js', '/lankkatalog/annan.js', '/inre-lank.js', '/okand.exe', '/.env']) {
      const svar = await anropa(m.builder, ANNA, 'GET', path);
      expect(svar.status, path).toBe(404);
      expect(svar.text).not.toContain('HEMLIGT');
    }
    // De vanliga filerna finns kvar.
    expect((await anropa(m.builder, ANNA, 'GET', '/assets/app.js')).status).toBe(200);
  });

  it('en ui-katalog som själv är en symlänk godtas inte', async () => {
    const lank = join(utanfor, 'ui-lank');
    await symlink(m.uiDir, lank);
    await m.builder.close();
    m.builder = m.starta({ ui: { directory: lank } });
    const svar = await anropa(m.builder, ANNA, 'GET', '/');
    expect(svar.status).toBe(503);
  });
});

describe('saknad ui-katalog', () => {
  it('ger ett klarspråkssvar i stället för att krascha, och API:t fungerar ändå', async () => {
    await m.builder.close();
    const tom = join(m.dataDir, 'finns-inte');
    m.builder = m.starta({ ui: { directory: tom } });
    const svar = await anropa(m.builder, ANNA, 'GET', '/');
    expect(svar.status).toBe(503);
    expect(svar.text).toMatch(/webbgränssnitt/);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    const me = await anropa(m.builder, ANNA, 'GET', '/_api/builder/me');
    expect(me.status).toBe(200);
  });

  it('en tom katalog utan index.html ger samma svar', async () => {
    await m.builder.close();
    const tom = join(m.dataDir, 'tom-ui');
    await mkdir(tom);
    m.builder = m.starta({ ui: { directory: tom } });
    const svar = await anropa(m.builder, ANNA, 'GET', '/appar');
    expect(svar.status).toBe(503);
  });
});
