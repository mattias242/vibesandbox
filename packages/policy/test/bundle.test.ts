/**
 * checkBuiltBundle: det som faktiskt kom ut ur bygget granskas, oavsett hur det kom dit.
 * Fångar det källkodskontrollen missar (t.ex. en adress som sätts ihop av delar) när det
 * syns i den byggda bunten, och skyddar mot en arbetskatalog som manipulerats.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBuiltBundle } from '../src/index.ts';

const HTML = `<!doctype html><html><head><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head><body><div id="root"></div></body></html>`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vibesandbox-bunt-'));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), HTML);
  await writeFile(
    path.join(dir, 'assets', 'index-abc.js'),
    `const ns="http://www.w3.org/2000/svg";function e(n){return "Minified React error #"+n+"; visit https://react.dev/errors/"+n}fetch("/_api/x",{credentials:"same-origin"});`,
  );
  await writeFile(path.join(dir, 'assets', 'index-abc.css'), 'p{color:red}');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function rules(): Promise<string[]> {
  return [...new Set((await checkBuiltBundle(dir)).map((d) => d.rule ?? ''))].sort();
}

describe('checkBuiltBundle', () => {
  it('godkänner ett vanligt bygge: namnrymder, Reacts felsida och SDK:ts egna anrop', async () => {
    expect(await checkBuiltBundle(dir)).toEqual([]);
  });

  it('alla diagnoser är policydiagnoser med fil', async () => {
    await writeFile(path.join(dir, 'assets', 'x.js'), 'eval("1")');
    const diagnostics = await checkBuiltBundle(dir);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.source).toBe('policy');
      expect(diagnostic.file).toBe('assets/x.js');
    }
  });

  it.each([
    ['https://evil.example/x'],
    ['wss://evil.example'],
    ['//evil.example/x'],
    ['https://react.dev.evil.example/'],
  ])('nekar den externa adressen %s i en byggd fil', async (url) => {
    await writeFile(path.join(dir, 'assets', 'x.js'), `const u=${JSON.stringify(url)};`);
    expect(await rules()).toContain('bundle-external-url');
  });

  it('nekar externa adresser även i CSS och HTML', async () => {
    await writeFile(path.join(dir, 'assets', 'index-abc.css'), 'p{background:url(https://evil.example/x.png)}');
    expect(await rules()).toContain('bundle-external-url');
  });

  it.each([`eval("1")`, `new Function("return 1")`, `Function("return 1")`])('nekar %s', async (code) => {
    await writeFile(path.join(dir, 'assets', 'x.js'), code);
    expect(await rules()).toContain('bundle-eval');
  });

  it.each([
    `<script>alert(1)</script>`,
    `<script type="module">import("./x.js")</script>`,
    `<img src="x" onerror="alert(1)">`,
    `<a href="javascript:alert(1)">x</a>`,
    `<meta http-equiv="refresh" content="0;url=/x">`,
  ])('nekar inline-skript och liknande i index.html: %s', async (snippet) => {
    await writeFile(path.join(dir, 'index.html'), HTML.replace('<body>', `<body>${snippet}`));
    expect(await rules()).toContain('bundle-inline-script');
  });

  it.each(['assets/x.map', 'assets/x.svg', 'assets/x.wasm', 'other.html', 'assets/sub/index.html', '.htaccess', 'assets/x.js.gz'])(
    'nekar filtypen %s',
    async (file) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), 'x');
      expect(await rules()).toContain('bundle-file-type');
    },
  );

  it('nekar symboliska länkar, även till filer som annars vore tillåtna', async () => {
    await symlink('/etc/hosts', path.join(dir, 'assets', 'länk.js'));
    expect(await rules()).toContain('bundle-file-type');
  });

  it('nekar en symbolisk länk till en katalog och följer den inte', async () => {
    await symlink('/etc', path.join(dir, 'assets', 'etc'));
    const diagnostics = await checkBuiltBundle(dir);
    expect(diagnostics.map((d) => d.rule)).toContain('bundle-file-type');
    expect(diagnostics.every((d) => !d.file?.includes('passwd'))).toBe(true);
  });

  it('kräver index.html', async () => {
    await rm(path.join(dir, 'index.html'));
    expect(await rules()).toContain('bundle-file-type');
  });

  it('röjer aldrig värdens absoluta sökväg i ett meddelande', async () => {
    await writeFile(path.join(dir, 'assets', 'x.wasm'), 'x');
    for (const diagnostic of await checkBuiltBundle(dir)) {
      expect(diagnostic.message).not.toContain(dir);
      expect(diagnostic.file ?? '').not.toContain(dir);
    }
  });
});
