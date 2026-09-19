/**
 * checkBuiltBundle — granskar det som faktiskt kom ut ur bygget.
 *
 * Källkodskontrollen ser bara det modellen skrev; här syns resultatet efter att allt satts ihop.
 * Samma principer som mallens test/build.test.ts, som visar att en ren mall klarar alla regler.
 * Katalogen behandlas som opålitlig: symboliska länkar följs aldrig (en länk till värdens filer
 * får inte bli en del av appen) och bara förväntade filtyper godtas.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic } from '@vibesandbox/contracts';
import { ALLOWED_BUNDLE_URLS, findExternalUrls, JAVASCRIPT_URL } from './urls.ts';

/**
 * Filer som ett bygge av mallen får innehålla: `index.html` i roten och skript/stilmallar under
 * `assets/`. Mallen bäddar inte in bilder eller typsnitt (appens källfiler kan bara vara
 * .ts/.tsx/.css). SVG är medvetet INTE med: en SVG som öppnas direkt kör sina skript på appens origin.
 */
const ALLOWED_FILE = /^(?:index\.html|assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/;
const MAX_DEPTH = 4;
const MAX_READ_BYTES = 16 * 1024 * 1024;

function diagnostic(rule: string, file: string, message: string): Diagnostic {
  return { source: 'policy', rule, file, message };
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  return JSON.stringify(text.slice(start, index + length + 30));
}

async function listFiles(root: string, relative: string, depth: number, out: Diagnostic[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
    // lstat: en symbolisk länk räknas som länk, aldrig som det den pekar på.
    const info = await lstat(path.join(root, name));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (depth >= MAX_DEPTH) out.push(diagnostic('bundle-file-type', name, 'Bygget har för djupa kataloger.'));
      else files.push(...(await listFiles(root, name, depth + 1, out)));
    } else if (info.isFile()) {
      if (!ALLOWED_FILE.test(name)) out.push(diagnostic('bundle-file-type', name, `Bygget innehåller en fil som inte är tillåten (${name}). Bara index.html och assets/*.js, assets/*.css godtas.`));
      else if (info.size > MAX_READ_BYTES) out.push(diagnostic('bundle-file-type', name, 'En fil i bygget är för stor.'));
      else files.push(name);
    } else {
      out.push(diagnostic('bundle-file-type', name, `Bygget innehåller en symbolisk länk eller specialfil (${name}), vilket aldrig är tillåtet.`));
    }
  }
  return files;
}

function checkHtml(file: string, html: string, out: Diagnostic[]): void {
  const inline = (what: string): void => {
    out.push(diagnostic('bundle-inline-script', file, `index.html innehåller ${what}; plattformens CSP tillåter bara skript från egna filer.`));
  };
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== (html.match(/<script\b/gi) ?? []).length) inline('en ofullständig <script>-tagg');
  for (const [, attributes = '', body = ''] of scripts) {
    if (!/\bsrc\s*=/.test(attributes) || body.trim() !== '') inline('ett inline-skript');
  }
  if (/<[^>]+\son[a-z]+\s*=/i.test(html)) inline('ett händelseattribut (on…=)');
  if (JAVASCRIPT_URL.test(html)) inline('en javascript:-adress');
  if (/http-equiv/i.test(html)) inline('en http-equiv-tagg');
}

/** Granskar en byggd app. Tom lista ⇒ inget att invända. Katalogen läses men ändras aldrig. */
export async function checkBuiltBundle(directory: string): Promise<readonly Diagnostic[]> {
  const out: Diagnostic[] = [];
  const files = await listFiles(directory, '', 0, out);
  if (!files.includes('index.html')) out.push(diagnostic('bundle-file-type', 'index.html', 'Bygget saknar index.html.'));

  for (const file of files) {
    const text = await readFile(path.join(directory, file), 'utf8');
    if (file === 'index.html') checkHtml(file, text, out);

    const urls = findExternalUrls(text, ALLOWED_BUNDLE_URLS);
    const relative = /["'`(]\/\/[a-z0-9-]+\.[a-z]/i.exec(text);
    if (urls.length > 0 || relative !== null) {
      const first = urls[0];
      const shown = first !== undefined ? excerpt(text, first.index, first.url.length) : excerpt(text, relative?.index ?? 0, 10);
      out.push(diagnostic('bundle-external-url', file, `Det byggda innehåller en extern adress: ${shown.slice(0, 200)}. Appen får inte peka ut något utanför sig själv.`));
    }

    const evalLike = /\beval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*["'`]/.exec(text);
    if (evalLike !== null) {
      out.push(diagnostic('bundle-eval', file, `Det byggda innehåller ${evalLike[0].trim()}; kod får inte skapas ur text.`));
    }
  }
  return out;
}
