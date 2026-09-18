/**
 * Bygger mallen på riktigt och granskar det som kom ut. Två egenskaper prövas:
 *
 *  1. Den byggda appen klarar plattformens CSP (APP_CONTENT_SECURITY_POLICY): inga inline-skript,
 *     ingen eval, inga externa adresser.
 *  2. Bygget är låst: bara `src/` kan påverka det. Prövas med fientliga filer bredvid `src/`.
 *
 * Bygget körs som barnprocess med samma kommando som `npm run build`. Inuti vitest är
 * NODE_ENV=test, och då hade Vite byggt en utvecklingsvariant — fel sak att granska.
 *
 * Testet bygger två gånger och tar därför några sekunder. Kör det för sig med
 *   npx vitest run packages/app-template/test/build.test.ts
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY } from '@vibesandbox/contracts';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const templateDir = fileURLToPath(new URL('../', import.meta.url));
// Mallens EGEN, pinnade Vite — inte den version som vitest råkar dra in i roten.
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');

const BUILD_TIMEOUT_MS = 120_000;

/**
 * Adresser som får förekomma i byggda filer. Ingen av dem ANROPAS: de är namnrymder och
 * text i felmeddelanden. Allt annat som ser ut som en extern adress fäller testet, så att ett
 * nytt beroende som ringer hem upptäcks här och inte i produktion.
 */
const ALLOWED_URLS: readonly string[] = [
  // React DOM: XML-namnrymder som skickas till document.createElementNS. Identifierare, inte nätanrop.
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  // React: minifierade fel pekar ut en förklaringssida i felTEXTEN ("visit https://react.dev/errors/418").
  'https://react.dev/errors/',
];

async function viteBuild(cwd: string, outDir: string): Promise<{ seconds: number }> {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  delete env['VITEST'];
  const started = performance.now();
  await run(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts', '--outDir', outDir, '--emptyOutDir'], {
    cwd,
    env,
    timeout: BUILD_TIMEOUT_MS,
  });
  return { seconds: (performance.now() - started) / 1000 };
}

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

/**
 * Träffar som korta utdrag ("fil: …sammanhang…"). Ett fallande test ska peka ut stället,
 * inte skriva ut en hel minifierad bunt.
 */
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

describe('den byggda mallen', () => {
  let workDir: string;
  let outDir: string;
  let files: string[];
  let texts: Map<string, string>;
  let html: string;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'vibesandbox-mall-'));
    outDir = path.join(workDir, 'dist');
    const { seconds } = await viteBuild(templateDir, outDir);

    files = await listFiles(outDir);
    texts = new Map();
    let bytes = 0;
    for (const file of files) {
      bytes += (await stat(path.join(outDir, file))).size;
      if (/\.(?:html|js|css)$/.test(file)) texts.set(file, await readFile(path.join(outDir, file), 'utf8'));
    }
    html = texts.get('index.html') ?? '';
    console.info(`[app-template] byggtid ${seconds.toFixed(2)} s, ${files.length} filer, ${(bytes / 1024).toFixed(1)} kB`);
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('består av index.html samt skript och stilmallar under assets/ — inget annat', () => {
    expect(files).toContain('index.html');
    for (const file of files) {
      expect(file, 'oväntad fil i bygget').toMatch(/^(?:index\.html|assets\/[\w.-]+\.(?:js|css))$/);
    }
    expect(files.some((file) => file.endsWith('.js'))).toBe(true);
    expect(files.some((file) => file.endsWith('.css'))).toBe(true);
  });

  it('har inga källkartor', () => {
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    expect(findIn(texts, /sourceMappingURL/)).toEqual([]);
  });

  it('är ett produktionsbygge, utan utvecklingslägets minnesadapter', () => {
    expect(findIn(texts, /Lokal användare/)).toEqual([]);
    expect(findIn(texts, /react-dom\.development|react\.development/)).toEqual([]);
  });

  describe("under plattformens CSP: script-src 'self'", () => {
    it('policyn är den här testet utgår från', () => {
      // Lättas policyn i contracts måste det här testet tänkas om, inte bara bli grönt.
      expect(APP_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
      expect(APP_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
      expect(APP_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe-(?:inline|eval)/);
    });

    it('index.html har inga inline-skript: varje <script> har src och saknar innehåll', () => {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attributes = '', body = ''] of scripts) {
        expect(attributes).toMatch(/\bsrc=/);
        expect(body.trim()).toBe('');
      }
    });

    it('index.html har inga händelseattribut, javascript:-länkar eller egna skyddsregler', () => {
      expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/http-equiv/i);
    });

    it('index.html pekar bara på egna filer, med relativa sökvägar som finns i bygget', () => {
      const references = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1] ?? '');
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference, 'ska vara relativ (base: "./"), så att appen fungerar oavsett var den serveras').toMatch(/^\.\//);
        expect(files).toContain(reference.slice(2));
      }
    });

    it('index.html har inga ramar, insticksobjekt, <base> eller formulär som skickas någon annanstans', () => {
      expect(html).not.toMatch(/<(?:iframe|frame|object|embed|base|applet)\b/i);
      expect(html).not.toMatch(/<form\b[^>]*\baction=/i);
    });

    it('ingen eval och ingen new Function i något skript', () => {
      expect(findIn(texts, /\beval\s*\(/)).toEqual([]);
      expect(findIn(texts, /\bnew\s+Function\s*\(/)).toEqual([]);
      expect(findIn(texts, /(?<![\w$.])Function\s*\(\s*["'`]/)).toEqual([]);
    });
  });

  describe("under plattformens CSP: connect-src 'self'", () => {
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

    it('listan över tillåtna adresser innehåller inget som inte längre behövs', () => {
      const found = new Set([...texts.values()].flatMap(findUrls));
      const unused = ALLOWED_URLS.filter((allowed) => ![...found].some((url) => url.startsWith(allowed)));
      expect(unused).toEqual([]);
    });

    it('inga protokollrelativa adresser (//värd/…) i strängar', () => {
      expect(findIn(texts, /["'`]\/\/[a-z0-9-]+\.[a-z]/i)).toEqual([]);
    });

    it('inga andra vägar ut: bakgrundsskript, websockets, händelseströmmar, beacons', () => {
      expect(
        findIn(texts, /serviceWorker|new\s+(?:Shared)?Worker\b|\bWebSocket\b|\bEventSource\b|sendBeacon|XMLHttpRequest|importScripts/),
      ).toEqual([]);
    });

    it('SDK:ts anrop går till /_api på appens egen adress', () => {
      expect(findIn(texts, /\/_api/).length).toBeGreaterThan(0);
      expect(findIn(texts, /same-origin/).length).toBeGreaterThan(0);
    });
  });
});

describe('bygget är låst: bara src/ kan påverka det', () => {
  let workDir: string;
  let copyDir: string;
  let outDir: string;
  let markerFile: string;
  let bundle: string;
  let files: string[];

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'vibesandbox-fientlig-'));
    copyDir = path.join(workDir, 'mall');
    outDir = path.join(workDir, 'dist');
    markerFile = path.join(workDir, 'KONFIG-KORDES');

    await cp(templateDir, copyDir, {
      recursive: true,
      filter: (source) => !/^(?:node_modules|dist|test)(?:[\\/]|$)/.test(path.relative(templateDir, source)),
    });
    // Beroendena löses upp som i repot: först mallens egna (den pinnade Vite), sedan rotens
    // (React m.m., som npm har lyft dit). Node letar uppåt, så rotens länk läggs en nivå upp.
    await symlink(path.join(templateDir, 'node_modules'), path.join(copyDir, 'node_modules'), 'dir');
    await symlink(path.resolve(templateDir, '../../node_modules'), path.join(workDir, 'node_modules'), 'dir');

    // ── Fientliga filer UTANFÖR src/ — sådant en genererad app inte ska kunna få verkan av ──
    const marker = `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'x');`;
    // PostCSS- och Tailwind-konfigurationer är JavaScript som körs vid byggtid.
    await writeFile(path.join(copyDir, 'postcss.config.cjs'), `${marker}\nmodule.exports = { plugins: [] };\n`);
    await writeFile(path.join(copyDir, '.postcssrc.cjs'), `${marker}\nmodule.exports = { plugins: [] };\n`);
    await writeFile(path.join(copyDir, 'tailwind.config.cjs'), `${marker}\nmodule.exports = {};\n`);
    // Env-filer kan smuggla in värden (och på en byggserver: läcka hemligheter in i bunten).
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      await writeFile(path.join(copyDir, name), 'VITE_SMUGGLAT=hemligt-fran-env-fil\n');
    }
    // public/ kopieras normalt rakt in i bygget, förbi all granskning av src/.
    await mkdir(path.join(copyDir, 'public'));
    await writeFile(path.join(copyDir, 'public', 'ogranskad.html'), '<script>alert(1)</script>');

    // Appkoden FÅR läsa import.meta.env — men där ska inget från env-filerna finnas.
    const appFile = path.join(copyDir, 'src', 'App.tsx');
    await writeFile(
      appFile,
      `${await readFile(appFile, 'utf8')}\nexport const smugglat = String(import.meta.env['VITE_SMUGGLAT'] ?? 'inget-smugglat');\nconsole.info(smugglat);\n`,
    );

    await viteBuild(copyDir, outDir);
    files = await listFiles(outDir);
    bundle = (await Promise.all(files.map((file) => readFile(path.join(outDir, file), 'utf8')))).join('\n');
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('PostCSS- och Tailwind-konfigurationer bredvid src/ körs inte', async () => {
    await expect(stat(markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('env-filer läses inte in', () => {
    expect(bundle.includes('hemligt-fran-env-fil')).toBe(false);
    // Kontrollen är bara värd något om appkoden verkligen kom med i bunten.
    expect(bundle.includes('inget-smugglat')).toBe(true);
  });

  it('public/ kopieras inte in i bygget', () => {
    expect(files.filter((file) => file.includes('ogranskad'))).toEqual([]);
  });
});
