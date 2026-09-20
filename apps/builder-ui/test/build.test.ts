/**
 * Bygger gränssnittet på riktigt och granskar det som kom ut, mot byggverktygets CSP
 * (`builderContentSecurityPolicy`): inga inline-skript, ingen eval, inga externa adresser — och
 * ingenting av låtsas-API:t från `dev/`.
 *
 * Bygget körs som barnprocess (inuti vitest är NODE_ENV=test, och då hade Vite byggt en
 * utvecklingsvariant). Kör det för sig med
 *   npx vitest run apps/builder-ui/test/build.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDER_API_PREFIX, builderContentSecurityPolicy } from '@vibesandbox/contracts';
import { MOCK_MARKER } from '../dev/mock.ts';
import config from '../vite.config.ts';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const uiDir = fileURLToPath(new URL('../', import.meta.url));
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const BUILD_TIMEOUT_MS = 120_000;

/** Samma lista som mallens: namnrymder och felTEXT i React — inget av det anropas. */
const ALLOWED_URLS: readonly string[] = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'https://react.dev/errors/',
];

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

function findUrls(text: string): string[] {
  return text.match(/\b(?:https?|wss?|ftp):\/\/[^\s"'`<>\\)]*/g) ?? [];
}

function findIn(texts: ReadonlyMap<string, string>, pattern: RegExp): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits: string[] = [];
  for (const [file, text] of texts) {
    for (const match of text.matchAll(global)) {
      const start = Math.max(0, match.index - 40);
      hits.push(`${file}: …${text.slice(start, match.index + match[0].length + 40)}…`);
    }
  }
  return hits;
}

describe('konfigurationen är låst som mallens', () => {
  it('base "/", ingen public/, inga env-filer, ingen postcss-sökning, inga källkartor', () => {
    expect(config.base).toBe('/');
    expect(config.publicDir).toBe(false);
    expect(config.envDir).toBe(false);
    expect(config.css?.postcss).toEqual({ plugins: [] });
    expect(config.build?.sourcemap).toBe(false);
    expect(config.build?.assetsInlineLimit).toBe(0);
  });

  it('låtsas-API:t gäller bara utvecklingsservern', () => {
    const plugins = (config.plugins ?? []).flat() as Array<{ name?: string; apply?: unknown }>;
    const mock = plugins.find((plugin) => plugin?.name === 'vibesandbox-builder-api-mock');
    expect(mock?.apply).toBe('serve');
  });
});

describe('det byggda gränssnittet', () => {
  let workDir: string;
  let files: string[];
  let texts: Map<string, string>;
  let html: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'vibesandbox-builder-ui-'));
    const outDir = path.join(workDir, 'dist');
    const env = { ...process.env };
    delete env['NODE_ENV'];
    delete env['VITEST'];
    const started = performance.now();
    await run(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts', '--outDir', outDir, '--emptyOutDir'], {
      cwd: uiDir,
      env,
      timeout: BUILD_TIMEOUT_MS,
    });
    const seconds = (performance.now() - started) / 1000;

    files = await listFiles(outDir);
    texts = new Map();
    let bytes = 0;
    for (const file of files) {
      bytes += (await stat(path.join(outDir, file))).size;
      if (/\.(?:html|js|css)$/.test(file)) texts.set(file, await readFile(path.join(outDir, file), 'utf8'));
    }
    html = texts.get('index.html') ?? '';
    console.info(`[builder-ui] byggtid ${seconds.toFixed(2)} s, ${files.length} filer, ${(bytes / 1024).toFixed(1)} kB`);
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('består av index.html samt skript och stilmallar under assets/ — inga källkartor', () => {
    expect(files).toContain('index.html');
    for (const file of files) expect(file).toMatch(/^(?:index\.html|assets\/[\w.-]+\.(?:js|css))$/);
    expect(findIn(texts, /sourceMappingURL/)).toEqual([]);
  });

  it('är ett produktionsbygge', () => {
    expect(findIn(texts, /react-dom\.development|react\.development/)).toEqual([]);
  });

  describe("under byggverktygets CSP: script-src 'self'", () => {
    it('policyn är den här testet utgår från', () => {
      const policy = builderContentSecurityPolicy('https://*.example.se');
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).not.toMatch(/script-src[^;]*unsafe-(?:inline|eval)/);
    });

    it('index.html visar något även om skriptet aldrig startar — en vit sida ska vara omöjlig', () => {
      const root = /<div id="root"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
      expect(root.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(20);
      expect(root).toMatch(/Ladda om/i);
      // Reservinnehållet får inte i sin tur kräva ett skript.
      expect(root).not.toMatch(/<script/i);
    });

    it('index.html har inga inline-skript: varje <script> har src och saknar innehåll', () => {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attributes = '', body = ''] of scripts) {
        expect(attributes).toMatch(/\bsrc=/);
        expect(body.trim()).toBe('');
      }
    });

    it('index.html har inga händelseattribut, javascript:-länkar, egna skyddsregler, ramar eller <base>', () => {
      expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/http-equiv/i);
      expect(html).not.toMatch(/<(?:iframe|frame|object|embed|base|applet)\b/i);
    });

    it('index.html pekar bara på egna filer under roten, som finns i bygget', () => {
      // Länkar i reservinnehållet (<a href>) är navigering, inte filer: de pekar på egna sidor
      // under roten. Allt som HÄMTAS ska ligga i bygget under /assets/.
      const links = [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((match) => match[1] ?? '');
      for (const link of links) expect(link).toMatch(/^\/[^/\\]*$/);

      const references = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)]
        .map((match) => match[1] ?? '')
        .filter((reference) => !links.includes(reference));
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference).toMatch(/^\/assets\//);
        expect(files).toContain(reference.slice(1));
      }
    });

    it('ingen eval och ingen new Function i något skript', () => {
      expect(findIn(texts, /\beval\s*\(/)).toEqual([]);
      expect(findIn(texts, /\bnew\s+Function\s*\(/)).toEqual([]);
      expect(findIn(texts, /(?<![\w$.])Function\s*\(\s*["'`]/)).toEqual([]);
    });
  });

  describe("under byggverktygets CSP: connect-src 'self'", () => {
    it('inga externa adresser i någon byggd fil, utöver den uttryckliga listan', () => {
      const unexpected: string[] = [];
      for (const [file, text] of texts) {
        for (const url of findUrls(text)) {
          if (!ALLOWED_URLS.some((allowed) => url === allowed || (allowed.endsWith('/') && url.startsWith(allowed)))) {
            unexpected.push(`${file}: ${url}`);
          }
        }
      }
      expect(unexpected).toEqual([]);
    });

    it('inga protokollrelativa adresser, inga @import eller url() utåt i stilmallen', () => {
      expect(findIn(texts, /["'`]\/\/[a-z0-9-]+\.[a-z]/i)).toEqual([]);
      expect(findIn(texts, /@import/)).toEqual([]);
      expect(findIn(texts, /url\(\s*["']?(?!data:|\/)/)).toEqual([]);
    });

    it('inga andra vägar ut: bakgrundsskript, websockets, händelseströmmar, beacons', () => {
      expect(
        findIn(texts, /serviceWorker|new\s+(?:Shared)?Worker\b|\bWebSocket\b|\bEventSource\b|sendBeacon|XMLHttpRequest|importScripts/),
      ).toEqual([]);
    });

    it('API-anropen går till byggverktygets egen origin', () => {
      expect(findIn(texts, new RegExp(BUILDER_API_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))).length).toBeGreaterThan(0);
      expect(findIn(texts, /same-origin/).length).toBeGreaterThan(0);
    });
  });

  it('inget av låtsas-API:t följer med', () => {
    expect(findIn(texts, new RegExp(MOCK_MARKER))).toEqual([]);
    expect(findIn(texts, /_mock\/|låtsas|builderApiMock/i)).toEqual([]);
  });

  it('förhandsvisningens ram får aldrig öppna fönster eller styra fliken', () => {
    const sandbox = findIn(texts, /allow-scripts allow-forms allow-same-origin allow-downloads/);
    expect(sandbox.length).toBe(1);
    expect(findIn(texts, /allow-popups|allow-top-navigation|allow-modals/)).toEqual([]);
  });
});
