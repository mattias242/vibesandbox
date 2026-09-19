/**
 * checkSourceFiles — vad appens källfiler får innehålla, innan något byggs.
 *
 * ÄRLIGT OM VAD DET HÄR ÄR: mönstermatchning på text, inte en analys av vad koden gör. Den går
 * att kringgå — `const w = window; const k = 'fe' + 'tch'; w[k]('…')` i någon variant som
 * mönstren inte känner igen. Den är FÖRSVAR PÅ DJUPET. Det bärande skyddet är webbläsarens CSP
 * som plattformen sätter på varje app (`connect-src 'self'`, `script-src 'self'`, inga ramar,
 * inga workers). Policyn finns för att:
 *   1. modellen ska få ett begripligt besked om VAD som är fel och vad den ska göra i stället,
 *      i stället för en app som tyst inte fungerar under CSP:n;
 *   2. de vanligaste omskrivningarna (`window['fetch']`, `globalThis.fetch`, alias för `window`,
 *      escape-sekvenser) ska fastna även om modellen "försöker";
 *   3. bygget aldrig ska se filer eller importer utanför det mallen tillåter (det är skarpt:
 *      sökvägar och importer är exakta regler, inte heuristik).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { isAllowedSourcePath, TEMPLATE_OWNED_SOURCE_PATHS } from '@vibesandbox/contracts';
import type { Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { lineFinder, scanScript, scanStyle } from './scan.ts';
import type { TextSegment } from './scan.ts';
import { ALLOWED_SOURCE_URLS, DATA_HTML_URL, findExternalUrls, JAVASCRIPT_URL, PROTOCOL_RELATIVE } from './urls.ts';

export const SOURCE_LIMITS = {
  maxFiles: 60,
  maxFileBytes: 200_000,
  maxTotalBytes: 1_000_000,
  /** Fler diagnoser än så hjälper inte modellen; de första räcker för att rätta. */
  maxDiagnostics: 50,
} as const;

// ── Tillåtna importer ─────────────────────────────────────────────────────────

interface Catalogue {
  readonly platformPackages: readonly string[];
  readonly packages: readonly { readonly name: string; readonly kind: 'dependency' | 'devDependency' }[];
}

const require = createRequire(import.meta.url);
const catalogue = require('@vibesandbox/app-template/approved-packages.json') as Catalogue;

/**
 * Undersökvägar som får importeras ur ett godkänt paket. Allt annat i paketet (t.ex.
 * `react-dom/server`, `react/jsx-dev-runtime`) är stängt.
 */
const ALLOWED_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  react: ['jsx-runtime'],
  'react-dom': ['client'],
};

/**
 * Paketen appens kod får importera: mallens körtidsberoenden (kind `dependency` i
 * approved-packages.json) och plattformens SDK. Byggverktyg (vite, typescript, @types/…) är
 * `devDependency` och kan aldrig importeras. Härleds ur katalogen så att listan aldrig glider isär.
 */
export const ALLOWED_IMPORTS: readonly string[] = [
  ...catalogue.packages.filter((entry) => entry.kind === 'dependency').map((entry) => entry.name),
  ...catalogue.platformPackages,
].flatMap((name) => [name, ...(ALLOWED_SUBPATHS[name] ?? []).map((sub) => `${name}/${sub}`)]);

/** Relativ sökväg till en annan fil i `src/`: bara vanliga tecken, ingen `?raw`/`?worker`/`#…`. */
const RELATIVE_SPECIFIER = /^\.\.?\/[A-Za-z0-9_\-./]*$/;

function resolvesInsideSrc(file: string, specifier: string): boolean {
  if (!RELATIVE_SPECIFIER.test(specifier)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved.startsWith('src/') && !resolved.split('/').includes('..');
}

// ── Förbjudna API:er ───────────────────────────────────────────────────────────

const USE_SDK = 'Spara och hämta data med db.collection(...) ur @vibesandbox/sdk — plattformen sköter resten.';

interface ApiRule {
  readonly rule: string;
  /** Mönster i kod (kommentarer och strängar borttagna). */
  readonly code: RegExp;
  /** Mönster i det skannern lade undan som text — formade som anrop, så att prosa inte fastnar. */
  readonly text?: RegExp;
  /** Mönster som behöver se strängarna (t.ex. `setTimeout('kod')`). Körs på kod med strängar kvar. */
  readonly withStrings?: RegExp;
  readonly what: string;
  readonly instead: string;
}

const GLOBAL = String.raw`(?:window|globalThis|self|document)`;

const API_RULES: readonly ApiRule[] = [
  {
    rule: 'network-api',
    code: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|webkitRTCPeerConnection|RTCDataChannel|WebTransport|sendBeacon)\b/,
    text: /\b(?:fetch|sendBeacon)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|WebTransport)\b/,
    what: 'appen får inte tala med nätet direkt',
    instead: USE_SDK,
  },
  {
    rule: 'window-open',
    code: new RegExp(String.raw`\b${GLOBAL}\s*\??\.\s*open\b|(?<![\w$.])open\s*\(`),
    text: /\bwindow\.open\s*\(/,
    what: 'appen får inte öppna nya fönster',
    instead: 'Visa innehållet i appen själv, t.ex. i en dialog (<dialog>) eller en egen vy.',
  },
  {
    rule: 'dynamic-code',
    code: /\beval\b|\bnew\s+Function\b|(?<![\w$.])Function\s*\(|\.constructor\s*\(/,
    text: /\beval\s*\(|\bnew\s+Function\s*\(/,
    withStrings: /\b(?:setTimeout|setInterval)\s*\(\s*['"`]/,
    what: 'kod får inte skapas ur text (eval, new Function, setTimeout med en sträng)',
    instead: 'Skriv koden som vanliga funktioner. Ge setTimeout en funktion: setTimeout(() => { ... }, 1000).',
  },
  {
    rule: 'browser-storage',
    code: /\b(?:localStorage|sessionStorage|indexedDB|cookieStore|caches)\b|\bdocument\s*\??\.\s*cookie\b/,
    text: /\b(?:localStorage|sessionStorage|indexedDB)\s*\.|\bdocument\.cookie\b/,
    what: 'appen får inte lagra data i webbläsaren',
    instead: `${USE_SDK} Då delas datan mellan användarna och finns kvar.`,
  },
  {
    rule: 'document-domain',
    code: /\bdocument\s*\??\.\s*domain\b/,
    what: 'document.domain får inte användas',
    instead: 'Ta bort koden; appen behöver inte veta sin domän.',
  },
  {
    rule: 'service-worker',
    code: /\b(?:serviceWorker|importScripts|SharedWorker|Worker|Worklet|audioWorklet|paintWorklet)\b/,
    text: /\bnew\s+(?:Shared)?Worker\s*\(|\bserviceWorker\s*\.|\bimportScripts\s*\(/,
    what: 'appen får inte starta bakgrundsskript (Worker, service worker)',
    instead: 'Kör koden direkt i komponenten.',
  },
  {
    rule: 'frame-escape',
    code: new RegExp(
      String.raw`\b${GLOBAL}\s*\??\.\s*(?:parent|top|opener|frames|defaultView)\b|(?<![\w$.])(?:top|parent|opener|frames)\s*\??\.\s*(?:postMessage|location|document|window|opener|parent|top|frames)\b|\bpostMessage\b`,
    ),
    text: /\bpostMessage\s*\(|\bwindow\.(?:parent|top|opener)\b/,
    what: 'appen får inte nå andra fönster eller den sida den visas i (parent, top, opener, postMessage)',
    instead: 'Håll allt inom appen.',
  },
  {
    rule: 'navigation',
    code: /\blocation\s*\+?=(?!=)|\blocation\s*\??\.\s*(?:href|host|hostname|origin|protocol|port|pathname|search)\s*\+?=(?!=)|\blocation\s*\??\.\s*(?:assign|replace)\b/,
    text: /\blocation\.(?:assign|replace)\s*\(|\blocation(?:\.href)?\s*=[^=]/,
    what: 'appen får inte navigera webbläsaren till en annan sida',
    instead: 'Visa olika vyer med React-tillstånd (useState) i stället för att byta sida. location.hash får sättas.',
  },
  {
    rule: 'global-access',
    code: /(?<![\w$.])(?:window|globalThis|self|frames)\s*(?:\?\.)?\s*\[|(?<![\w$.])(?<!\btypeof\s+)(?:window|globalThis|self|frames)\b(?!\s*\??\.)/,
    what: 'window, globalThis och self får bara användas med punkt och ett utskrivet namn, inte med hakparentes eller som värde (policyn måste kunna se vad som används)',
    instead: 'Skriv ut namnet: window.innerWidth, window.addEventListener(...).',
  },
  {
    rule: 'escape-sequence',
    code: /\\u[0-9a-fA-F{]/,
    what: 'escape-sekvenser (\\u…) i namn utanför strängar är inte tillåtna',
    instead: 'Skriv namnet med vanliga bokstäver.',
  },
  {
    rule: 'import-meta',
    code: /\bimport\s*\.\s*meta\b(?!\s*\.\s*env\b)/,
    what: 'import.meta får bara användas som import.meta.env (import.meta.glob och import.meta.url kan läsa filer utanför appen)',
    instead: 'Importera appens egna filer med vanliga relativa importer: import { X } from \'./X.tsx\'.',
  },
  {
    rule: 'require',
    code: /\brequire\s*\(/,
    text: /\brequire\s*\(\s*['"]/,
    what: 'require finns inte i webbläsaren',
    instead: 'Använd import. Tillåtna paket: ' + ALLOWED_IMPORTS.join(', ') + ', samt appens egna filer.',
  },
];

// ── CSS ──────────────────────────────────────────────────────────────────────

interface CssRule {
  readonly rule: string;
  readonly pattern: RegExp;
  /** Kör på vyn där även strängarnas innehåll är blankat. */
  readonly bare?: boolean;
  readonly message: string;
}

const CSS_RULES: readonly CssRule[] = [
  {
    rule: 'css-import',
    pattern: /@import\b/i,
    message: '@import är inte tillåtet i CSS. Skriv all CSS i appens egna .css-filer och importera dem från koden: import \'./styles.css\'.',
  },
  {
    rule: 'css-plugin',
    pattern: /@(?:plugin|config)\b/i,
    message: '@plugin och @config är inte tillåtna: de laddar JavaScript när appen byggs. Mallen har ingen Tailwind — skriv vanlig CSS.',
  },
  {
    rule: 'css-expression',
    pattern: /expression\s*\(/i,
    message: 'expression() är inte tillåtet i CSS. Använd vanliga värden eller calc().',
  },
  {
    rule: 'css-behavior',
    pattern: /(?<![\w-])behavior\s*:/i,
    message: 'behavior: är inte tillåtet i CSS. Ta bort raden.',
  },
  {
    rule: 'css-binding',
    pattern: /-moz-binding/i,
    message: '-moz-binding är inte tillåtet i CSS. Ta bort raden.',
  },
  {
    rule: 'css-escape',
    pattern: /\\/,
    bare: true,
    message: 'Omvänt snedstreck (\\) utanför citattecken är inte tillåtet i CSS: det kan dölja t.ex. url( eller @import. Skriv ut tecknen som de är.',
  },
];

const CSS_URL_MESSAGE =
  'CSS får inte hämta filer: url(), image-set() och src() får bara innehålla data:-adresser eller #-referenser. Rita med CSS (färger, gradienter, ramar) eller lägg in bilden som en SVG i JSX.';

// ── Kontrollen ───────────────────────────────────────────────────────────────

class Collector {
  private readonly seen = new Set<string>();
  readonly diagnostics: Diagnostic[] = [];

  add(rule: string, file: string | undefined, line: number | undefined, message: string): void {
    const key = `${rule}\u0000${file ?? ''}\u0000${line ?? ''}`;
    if (this.seen.has(key) || this.diagnostics.length >= SOURCE_LIMITS.maxDiagnostics) return;
    this.seen.add(key);
    this.diagnostics.push({
      source: 'policy',
      rule,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      message,
    });
  }
}

function describePath(file: string): string {
  // Filnamnet kommer från modellen: visa det begränsat och utan styrtecken.
  return JSON.stringify(file.length > 120 ? `${file.slice(0, 120)}…` : file).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function pathMessage(file: string): string {
  if (TEMPLATE_OWNED_SOURCE_PATHS.includes(file)) {
    return `${file} ägs av mallen och kan inte ändras. Lägg appens kod i src/App.tsx (som exporterar App) och i egna filer under src/.`;
  }
  return (
    `Filen ${describePath(file)} får inte finnas. Appens filer ligger under src/ (högst fyra mappar djupt), ` +
    'slutar på .tsx, .ts eller .css och har namn med bara A–Z, a–z, 0–9, - och _ — t.ex. src/App.tsx, ' +
    'src/components/Lista.tsx, src/styles.css. Konfigurationsfiler (tsconfig, vite, postcss, .env, package.json) ägs av mallen.'
  );
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function checkImports(file: string, code: string, lineOf: (index: number) => number, out: Collector): void {
  const allowedList = ALLOWED_IMPORTS.join(', ');
  const report = (specifier: string, index: number): void => {
    const shown = describePath(specifier);
    let message: string;
    if (specifier.startsWith('node:') || /^(?:fs|path|child_process|os|http|https|net|crypto)$/.test(specifier)) {
      message = `Importen ${shown} är inte tillåten: appen körs i webbläsaren, där Nodes moduler inte finns. ${USE_SDK}`;
    } else if (specifier.startsWith('.') || specifier.startsWith('/')) {
      message = `Importen ${shown} är inte tillåten. Egna filer importeras relativt och inom src/, utan ?-tillägg: import { X } from './components/X.tsx'.`;
    } else {
      message = `Paketet ${shown} är inte tillåtet. Appen får importera ${allowedList} och sina egna filer under src/. Skriv det som behövs själv.`;
    }
    out.add('forbidden-import', file, lineOf(index), message);
  };

  const staticForms = [
    /(?<![\w$.])(?:import|export)\b[^;'"`()]*?\bfrom\s*(['"])([^'"\n]*)\1/g,
    /(?<![\w$.])import\s*(['"])([^'"\n]*)\1/g,
  ];
  for (const form of staticForms) {
    for (const match of code.matchAll(form)) {
      const specifier = match[2] ?? '';
      const ok = ALLOWED_IMPORTS.includes(specifier) || resolvesInsideSrc(file, specifier);
      if (!ok) report(specifier, match.index);
    }
  }

  for (const match of code.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const rest = code.slice(match.index);
    const literal = /^import\s*\(\s*(['"])([^'"\n]*)\1\s*\)/.exec(rest);
    const specifier = literal?.[2];
    if (specifier === undefined || !resolvesInsideSrc(file, specifier)) {
      out.add(
        'dynamic-import',
        file,
        lineOf(match.index),
        "import() får bara ladda appens egna filer med en fast relativ sökväg: import('./Vy.tsx'). Inga variabler, paket eller sökvägar utanför src/.",
      );
    }
  }
}

function checkUrlsInText(file: string, text: string, offset: number, lineOf: (index: number) => number, out: Collector): void {
  for (const hit of findExternalUrls(text, ALLOWED_SOURCE_URLS)) {
    out.add(
      'external-url',
      file,
      lineOf(offset + hit.index),
      `Adressen ${describePath(hit.url.slice(0, 100))} är inte tillåten (inte heller i kommentarer): appen får inte hämta eller länka till något utanför sig själv. Använd relativa adresser och ${USE_SDK.charAt(0).toLowerCase()}${USE_SDK.slice(1)}`,
    );
  }
  if (JAVASCRIPT_URL.test(text)) {
    out.add('javascript-url', file, lineOf(offset + (text.search(JAVASCRIPT_URL) ?? 0)), 'javascript:-adresser är inte tillåtna. Använd onClick={() => ...} på en <button>.');
  }
  if (DATA_HTML_URL.test(text)) {
    out.add('data-html-url', file, lineOf(offset + text.search(DATA_HTML_URL)), 'data:text/html-adresser är inte tillåtna. Visa innehållet med JSX i appen.');
  }
}

function protocolRelative(file: string, segment: TextSegment, lineOf: (index: number) => number, out: Collector): void {
  if (PROTOCOL_RELATIVE.test(segment.decoded)) {
    out.add(
      'external-url',
      file,
      lineOf(segment.start),
      'En adress som börjar med // pekar på en annan webbplats och är inte tillåten. Använd en relativ adress som börjar med / eller ./.',
    );
  }
}

function checkScript(file: string, source: string, out: Collector): void {
  const lineOf = lineFinder(source);
  // `x['fetch']` → `x.fetch   ` (samma längd, så index och rader stämmer), så att samma mönster
  // fångar båda skrivsätten. Görs före skanningen; en sådan ersättning inuti en sträng är ofarlig.
  const normalized = source.replace(/\[[ \t]*(['"`])([A-Za-z_$][\w$]*)\1[ \t]*\]/g, (all, _quote, name: string) =>
    `.${name}`.padEnd(all.length, ' '),
  );
  const { code, bare, texts } = scanScript(normalized);

  if (/^[ \t]*\/\/\/[ \t]*</m.test(source)) {
    const index = source.search(/^[ \t]*\/\/\/[ \t]*</m);
    out.add(
      'triple-slash',
      file,
      lineOf(index),
      '/// <reference …/>-direktiv är inte tillåtna: de får typkontrollen att läsa filer utanför appen. Ta bort raden.',
    );
  }

  checkImports(file, code, lineOf, out);

  for (const rule of API_RULES) {
    const message = (name: string, inText: boolean): string =>
      `${name} är inte tillåtet: ${rule.what}. ${rule.instead}${inText ? ' (Det står i en sträng eller kommentar som ser ut som kod — skriv om den.)' : ''}`;
    for (const match of bare.matchAll(new RegExp(rule.code.source, 'g'))) {
      out.add(rule.rule, file, lineOf(match.index), message(match[0].trim().replace(/\s+/g, ' '), false));
    }
    if (rule.withStrings !== undefined) {
      for (const match of code.matchAll(new RegExp(rule.withStrings.source, 'g'))) {
        out.add(rule.rule, file, lineOf(match.index), message(match[0].replace(/\s+/g, ' '), false));
      }
    }
    if (rule.text !== undefined) {
      const textPattern = new RegExp(rule.text.source, 'g');
      for (const segment of texts) {
        for (const match of segment.decoded.matchAll(textPattern)) {
          const at = segment.kind === 'comment' || segment.kind === 'regex' ? segment.start + match.index : segment.start;
          out.add(rule.rule, file, lineOf(at), message(match[0].replace(/\s+/g, ' '), true));
        }
      }
    }
  }

  // Adresser i kod och strängar är ett säkerhetsbrott (`external-url`, som avbryter agentens tur).
  // Strängarnas avkodade värden granskas också, så att `'\x68ttps://'` och `'https:\/\/'` inte
  // slinker igenom. En adress i det som ser ut som en kommentar är ett LINDRIGARE brott
  // (`url-in-comment`): modellen får ta bort den och försöka igen. Den nekas ändå, eftersom
  // skannern kan ta JSX-text eller kod för en kommentar — men en ofarlig kommentar ska inte
  // stoppa hela turen.
  checkUrlsInText(file, code, 0, lineOf, out);
  for (const segment of texts) {
    if (segment.kind === 'comment') {
      for (const hit of findExternalUrls(segment.raw, ALLOWED_SOURCE_URLS)) {
        out.add(
          'url-in-comment',
          file,
          lineOf(segment.start + hit.index),
          'En extern adress står i en kommentar. Ta bort den — appen får inte peka ut något utanför sig själv, inte heller i kommentarer.',
        );
      }
      continue;
    }
    if (segment.kind === 'regex') continue;
    if (segment.decoded !== segment.raw) checkUrlsInText(file, segment.decoded, 0, () => lineOf(segment.start), out);
    protocolRelative(file, segment, lineOf, out);
  }
}

function checkStyle(file: string, source: string, out: Collector): void {
  const lineOf = lineFinder(source);
  const { code, bare } = scanStyle(source);

  for (const rule of CSS_RULES) {
    const view = rule.bare === true ? bare : code;
    for (const match of view.matchAll(new RegExp(rule.pattern.source, `g${rule.pattern.flags.replace('g', '')}`))) {
      out.add(rule.rule, file, lineOf(match.index), rule.message);
    }
  }

  // url(…): bara data: (utom data:text/html, som har en egen regel) och #-referenser.
  for (const match of bare.matchAll(/(?<![\w-])url\s*\(/gi)) {
    const after = code.slice(match.index + match[0].length);
    const quoted = /^\s*(['"])(.*?)\1/.exec(after);
    const value = (quoted?.[2] ?? /^([^)]*)/.exec(after)?.[1] ?? '').trim();
    if (!/^data:/i.test(value) && !/^#[\w-]*$/.test(value)) out.add('css-url', file, lineOf(match.index), CSS_URL_MESSAGE);
  }
  for (const match of bare.matchAll(/(?<![\w-])(?:-webkit-)?(?:image-set|src)\s*\(/gi)) {
    out.add('css-url', file, lineOf(match.index), CSS_URL_MESSAGE);
  }

  // Adresser utanför kommentarer (CSS-kommentarer är entydiga, till skillnad från JSX).
  checkUrlsInText(file, code, 0, lineOf, out);
  for (const match of code.matchAll(/(['"(]\s*)\/\/[A-Za-z0-9[]/g)) {
    out.add('external-url', file, lineOf(match.index), 'En adress som börjar med // pekar på en annan webbplats och är inte tillåten.');
  }
}

/**
 * Granskar appens källfiler. Tom lista ⇒ inget att invända. Ingenting här läser disk eller
 * startar processer; funktionen kan anropas på opålitlig indata.
 */
export function checkSourceFiles(files: SourceFiles): readonly Diagnostic[] {
  const out = new Collector();
  const entries = Object.entries(files);

  if (entries.length > SOURCE_LIMITS.maxFiles) {
    out.add('too-many-files', undefined, undefined, `Appen har ${entries.length} filer; högst ${SOURCE_LIMITS.maxFiles} är tillåtet. Slå ihop små filer.`);
  }

  let total = 0;
  for (const [file, content] of entries) {
    if (!isAllowedSourcePath(file)) {
      out.add('path-not-allowed', describePath(file).slice(1, -1), undefined, pathMessage(file));
      continue;
    }
    if (typeof content !== 'string') {
      out.add('invalid-content', file, undefined, 'Filens innehåll måste vara text.');
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    total += bytes;
    if (bytes > SOURCE_LIMITS.maxFileBytes) {
      out.add(
        'file-too-large',
        file,
        undefined,
        `Filen är ${Math.ceil(bytes / 1000)} kB; högst ${SOURCE_LIMITS.maxFileBytes / 1000} kB per fil är tillåtet. Dela upp den, och lägg inte stora datamängder i koden — spara dem med db.collection(...).`,
      );
      continue;
    }
    if (CONTROL_CHARACTERS.test(content) || !content.isWellFormed()) {
      const index = content.search(CONTROL_CHARACTERS);
      out.add('invalid-content', file, index < 0 ? undefined : lineFinder(content)(index), 'Filen innehåller styrtecken eller ogiltiga tecken. Skriv vanlig text (UTF-8).');
      continue;
    }
    if (file.endsWith('.css')) checkStyle(file, content, out);
    else checkScript(file, content, out);
  }

  if (total > SOURCE_LIMITS.maxTotalBytes) {
    out.add('total-too-large', undefined, undefined, `Appens kod är sammanlagt ${Math.ceil(total / 1000)} kB; högst ${SOURCE_LIMITS.maxTotalBytes / 1000} kB är tillåtet.`);
  }

  return out.diagnostics;
}
