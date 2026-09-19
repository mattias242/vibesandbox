/**
 * checkSourceFiles: det språkmodellen skrev prövas INNAN något byggs. Fientliga indata är
 * huvudsaken — en policy som bara prövats med snälla filer säger ingenting.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkSourceFiles } from '../src/index.ts';

const APP = `import { useState } from 'react';
import { db } from '@vibesandbox/sdk';

const saker = db.collection<{ namn: string }>('saker');

export function App() {
  const [namn, setNamn] = useState('');
  return <p onClick={() => void saker.add({ namn })}>{namn}</p>;
}
`;

function check(files: SourceFiles): Diagnostic[] {
  return [...checkSourceFiles(files)];
}

/** En app med en extra rad i App.tsx. */
function withLine(line: string, file = 'src/App.tsx'): Diagnostic[] {
  return check({ 'src/App.tsx': APP, 'src/styles.css': 'p { color: red; }\n', [file]: `${file === 'src/App.tsx' ? APP : ''}${line}\n` });
}

function rules(diagnostics: readonly Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.rule ?? ''))].sort();
}

describe('checkSourceFiles: en vanlig app', () => {
  it('godkänner mallens egen exempelapp', async () => {
    const template = new URL('../../app-template/src/', import.meta.url);
    expect(
      check({
        'src/App.tsx': await readFile(new URL('App.tsx', template), 'utf8'),
        'src/styles.css': await readFile(new URL('styles.css', template), 'utf8'),
      }),
    ).toEqual([]);
  });

  it('godkänner en app som bara använder React, SDK:t och egna filer', () => {
    expect(
      check({
        'src/App.tsx': `${APP}\nimport { Lista } from './components/Lista.tsx';\nimport './styles.css';\n`,
        'src/components/Lista.tsx': `import type { ReactNode } from 'react';\nimport { createPortal } from 'react-dom';\nimport { helper } from '../lib/helper.ts';\nexport function Lista(p: { children: ReactNode }) { return <ul>{p.children}{helper()}</ul>; }\nvoid createPortal;\n`,
        'src/lib/helper.ts': `export const helper = () => 'hej';\nexport const lazy = () => import('./lazy.ts');\n`,
        'src/lib/lazy.ts': `export default 1;\n`,
        'src/styles.css': `:root { --a: #fff; }\n.bild { background: url("data:image/png;base64,AAAA"); }\n.filter { filter: url(#skugga); }\n`,
      }),
    ).toEqual([]);
  });

  it('godkänner SVG-namnrymden, som React behöver för att rita SVG', () => {
    expect(withLine(`export const Ikon = () => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />;`)).toEqual([]);
  });

  it('godkänner ord som bara liknar förbjudna namn', () => {
    expect(
      withLine(
        `export const fetchData = 1; const refetch = 2; const workerCount = 3; const topMargin = { top: 0 };\nconst toppen = 'Hämta lista'; export const x = [refetch, workerCount, topMargin, toppen];`,
      ),
    ).toEqual([]);
  });

  it('godkänner import.meta.env, som mallen själv använder', () => {
    expect(withLine(`export const dev = import.meta.env.DEV;`)).toEqual([]);
  });

  it('godkänner vanliga fönster-API:er', () => {
    expect(withLine(`window.addEventListener('resize', () => {}); export const w = window.innerWidth; if (typeof window !== 'undefined') window.scrollTo(0, 0);`)).toEqual([]);
  });

  it('har alla diagnoser som policydiagnoser med regel, fil och rad', () => {
    const diagnostics = withLine(`fetch('/x');`);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.source).toBe('policy');
      expect(diagnostic.rule).toMatch(/^[a-z-]+$/);
      expect(diagnostic.file).toBe('src/App.tsx');
      expect(diagnostic.line).toBe(APP.split('\n').length);
    }
  });
});

describe('checkSourceFiles: sökvägar (EN regel, ur contracts)', () => {
  it.each([
    'src/tsconfig.json',
    'src/vite.config.ts.json',
    'src/.env',
    'src/.env.production',
    'src/postcss.config.js',
    'src/tailwind.config.js',
    'src/package.json',
    'src/index.html',
    'src/data.json',
    'src/åäö.tsx',
    'src/../vite.config.ts',
    '../x.ts',
    '/etc/passwd',
    'vite.config.ts',
    'index.html',
    'package.json',
    'src\\App.tsx',
    'src/App.tsx\u0000.css',
    'src/a/b/c/d/e/f.ts',
    '__proto__',
  ])('nekar %j', (path) => {
    const diagnostics = check({ 'src/App.tsx': APP, [path]: 'export {};\n' });
    expect(diagnostics.map((d) => d.rule)).toContain('path-not-allowed');
  });

  it('nekar src/main.tsx: den ägs av mallen', () => {
    const [diagnostic] = check({ 'src/App.tsx': APP, 'src/main.tsx': 'fetch("/x");' });
    expect(diagnostic?.rule).toBe('path-not-allowed');
    expect(diagnostic?.message).toMatch(/mallen/);
  });

  it('nekar konfigurationsfiler i src/ redan på namnet: punkt i namnet är inte tillåten', () => {
    for (const path of ['src/vite.config.ts', 'src/tailwind.config.ts', 'src/env.d.ts', 'src/x.module.css']) {
      expect(check({ 'src/App.tsx': APP, [path]: 'export default {};\n' }).map((d) => d.rule)).toContain('path-not-allowed');
    }
  });

  it('ett felaktigt filnamn i beskedet innehåller aldrig styrtecken', () => {
    const [diagnostic] = check({ 'src/App.tsx': APP, 'src/\u001b[31mx.ts': 'export {};' });
    expect(diagnostic?.message).not.toMatch(/[\u0000-\u001f]/);
    expect(diagnostic?.file ?? '').not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('checkSourceFiles: storlek och innehåll', () => {
  it('nekar för många filer', () => {
    const files: Record<string, string> = { 'src/App.tsx': APP };
    for (let i = 0; i < 100; i += 1) files[`src/f${i}.ts`] = 'export {};\n';
    expect(rules(check(files))).toContain('too-many-files');
  });

  it('nekar en för stor fil', () => {
    expect(rules(check({ 'src/App.tsx': APP, 'src/stor.ts': `export const s = '${'a'.repeat(300_000)}';\n` }))).toContain('file-too-large');
  });

  it('nekar för mycket kod sammanlagt', () => {
    const files: Record<string, string> = { 'src/App.tsx': APP };
    for (let i = 0; i < 8; i += 1) files[`src/f${i}.ts`] = `export const s = '${'a'.repeat(190_000)}';\n`;
    expect(rules(check(files))).toContain('total-too-large');
  });

  it('nekar NUL-tecken och andra styrtecken', () => {
    expect(rules(check({ 'src/App.tsx': `${APP}\u0000` }))).toContain('invalid-content');
    expect(rules(check({ 'src/App.tsx': `${APP}\u001b[2J` }))).toContain('invalid-content');
  });

  it('nekar innehåll som inte är text', () => {
    expect(rules(check({ 'src/App.tsx': 42 as unknown as string }))).toContain('invalid-content');
  });
});

describe('checkSourceFiles: importer', () => {
  it.each([
    [`import fs from 'node:fs';`, 'forbidden-import'],
    [`import { readFile } from "fs";`, 'forbidden-import'],
    [`import _ from 'lodash';`, 'forbidden-import'],
    [`import 'some-polyfill';`, 'forbidden-import'],
    [`export * from 'scheduler';`, 'forbidden-import'],
    [`import { x } from 'react-dom/server';`, 'forbidden-import'],
    [`import { jsxDEV } from 'react/jsx-dev-runtime';`, 'forbidden-import'],
    [`import { c } from '@vibesandbox/contracts';`, 'forbidden-import'],
    [`import v from 'vite';`, 'forbidden-import'],
    [`import x from '/src/lib/helper.ts';`, 'forbidden-import'],
    [`import x from '../vite.config.ts';`, 'forbidden-import'],
    [`import x from '../../../../etc/passwd';`, 'forbidden-import'],
    [`import x from './styles.css?inline';`, 'forbidden-import'],
    [`import x from './App.tsx?raw';`, 'forbidden-import'],
    [`import W from './w.ts?worker';`, 'forbidden-import'],
    [`import x from 'data:text/javascript,alert(1)';`, 'forbidden-import'],
    [`import x from 'https://esm.sh/lodash';`, 'forbidden-import'],
    [`import {\n  a,\n  b,\n} from 'lodash';`, 'forbidden-import'],
    [`import type { Plugin } from 'vite';`, 'forbidden-import'],
    [`import x = require('fs');`, 'require'],
    [`const fs = require('fs');`, 'require'],
    [`const m = await import('lodash');`, 'dynamic-import'],
    [`const name = 'x'; const m = await import(name);`, 'dynamic-import'],
    [`const m = await import(\`./\${'x'}.ts\`);`, 'dynamic-import'],
    [`const m = await import('../../node_modules/vite/index.js');`, 'dynamic-import'],
    [`const g = import.meta.glob('../**/*');`, 'import-meta'],
    [`/// <reference path="../../../../etc/passwd" />`, 'triple-slash'],
    [`/// <reference types="node" />`, 'triple-slash'],
    [`const u = new URL('../../package.json', import.meta.url);`, 'import-meta'],
  ])('%s ⇒ %s', (line, rule) => {
    expect(rules(withLine(line))).toContain(rule);
  });

  it('pekar ut node: särskilt, med vad som gäller i stället', () => {
    const diagnostic = withLine(`import fs from 'node:fs';`).find((d) => d.rule === 'forbidden-import');
    expect(diagnostic?.message).toMatch(/node:fs/);
    expect(diagnostic?.message).toMatch(/webbläsaren/);
  });

  it('räknar upp de tillåtna paketen när ett paket nekas', () => {
    const diagnostic = withLine(`import _ from 'lodash';`).find((d) => d.rule === 'forbidden-import');
    expect(diagnostic?.message).toMatch(/lodash/);
    expect(diagnostic?.message).toMatch(/react/);
    expect(diagnostic?.message).toMatch(/@vibesandbox\/sdk/);
  });
});

describe('checkSourceFiles: förbjudna API:er', () => {
  it.each([
    [`fetch('/x');`, 'network-api'],
    [`window.fetch('/x');`, 'network-api'],
    [`globalThis.fetch('/x');`, 'network-api'],
    [`self.fetch('/x');`, 'network-api'],
    [`window['fetch']('/x');`, 'network-api'],
    [`window["fetch"]('/x');`, 'network-api'],
    [`window[\`fetch\`]('/x');`, 'network-api'],
    [`globalThis [ 'fetch' ] ('/x');`, 'network-api'],
    [`const f = fetch; f('/x');`, 'network-api'],
    [`new XMLHttpRequest();`, 'network-api'],
    [`new WebSocket('wss://x');`, 'network-api'],
    [`new EventSource('/x');`, 'network-api'],
    [`new RTCPeerConnection();`, 'network-api'],
    [`const c: RTCDataChannel | null = null;`, 'network-api'],
    [`new WebTransport('/x');`, 'network-api'],
    [`navigator.sendBeacon('/x', 'd');`, 'network-api'],
    [`window.open('/x');`, 'window-open'],
    [`open('/x');`, 'window-open'],
    [`eval('1');`, 'dynamic-code'],
    [`new Function('return 1')();`, 'dynamic-code'],
    [`Function('return 1')();`, 'dynamic-code'],
    [`(() => {}).constructor('return 1')();`, 'dynamic-code'],
    [`setTimeout('alert(1)', 1);`, 'dynamic-code'],
    [`setInterval(\`alert(1)\`, 1);`, 'dynamic-code'],
    [`localStorage.setItem('a', 'b');`, 'browser-storage'],
    [`window.sessionStorage.clear();`, 'browser-storage'],
    [`indexedDB.open('x');`, 'browser-storage'],
    [`document.cookie = 'a=b';`, 'browser-storage'],
    [`window['localStorage'].getItem('a');`, 'browser-storage'],
    [`document.domain = 'x';`, 'document-domain'],
    [`navigator.serviceWorker.register('/sw.js');`, 'service-worker'],
    [`importScripts('/x.js');`, 'service-worker'],
    [`new Worker('/w.js');`, 'service-worker'],
    [`new SharedWorker('/w.js');`, 'service-worker'],
    [`window.parent.postMessage('x', '*');`, 'frame-escape'],
    [`window.top.location.href;`, 'frame-escape'],
    [`window.opener.focus();`, 'frame-escape'],
    [`top.location.reload();`, 'frame-escape'],
    [`parent.postMessage('x', '*');`, 'frame-escape'],
    [`location.href = '/ny';`, 'navigation'],
    [`window.location.href = '/ny';`, 'navigation'],
    [`location.assign('/ny');`, 'navigation'],
    [`location.replace('/ny');`, 'navigation'],
    [`location = '/ny';`, 'navigation'],
    [`window.location = '/ny';`, 'navigation'],
    [`document.location.href += '?x';`, 'navigation'],
    [`const a = <a href="javascript:alert(1)">x</a>;`, 'javascript-url'],
    [`const u = 'JavaScript:alert(1)';`, 'javascript-url'],
    [`const u = 'data:text/html,<script>alert(1)</script>';`, 'data-html-url'],
    [`const w = window; w.fetch('/x');`, 'global-access'],
    [`const g = globalThis;`, 'global-access'],
    [`window['fe' + 'tch']('/x');`, 'global-access'],
    [`globalThis[name];`, 'global-access'],
    [`const \\u0066etch2 = 1;`, 'escape-sequence'],
  ])('%s ⇒ %s', (line, rule) => {
    expect(rules(withLine(line))).toContain(rule);
  });

  it('godkänner att location läses och att hash sätts', () => {
    expect(withLine(`export const p = location.pathname; if (location.href === '/') location.hash = '#topp';`)).toEqual([]);
  });

  it('föreslår SDK:t i stället för fetch och localStorage', () => {
    const fetchDiagnostic = withLine(`fetch('/x');`).find((d) => d.rule === 'network-api');
    const storageDiagnostic = withLine(`localStorage.getItem('a');`).find((d) => d.rule === 'browser-storage');
    for (const diagnostic of [fetchDiagnostic, storageDiagnostic]) {
      expect(diagnostic?.message).toMatch(/db\.collection\(\.\.\.\) ur @vibesandbox\/sdk/);
    }
  });

  describe('kommentarer skalas bort före kontrollen', () => {
    it('en kommentar som nämner ett förbjudet namn är ingen överträdelse', () => {
      expect(withLine(`// Vi använder inte localStorage eller Worker här.\n/* sessionStorage och WebSocket\n   behövs inte */ export const a = 1;`)).toEqual([]);
    });

    it('förbjudna namn i vanlig text i strängar är ingen överträdelse', () => {
      expect(withLine(`export const t = 'Worker och top är vanliga ord';`)).toEqual([]);
    });

    it('rätt radnummer efter en kommentar över flera rader', () => {
      const diagnostics = withLine(`/*\n\n*/\nfetch('/x');`);
      expect(diagnostics[0]?.line).toBe(APP.split('\n').length + 3);
    });

    it('men ett anrop gömt i det som ser ut som en kommentar eller sträng fångas ändå (skannern kan ta fel på JSX-text)', () => {
      expect(rules(withLine(`export const A = () => <p>//</p>; fetch('/x');`))).toContain('network-api');
      expect(rules(withLine(`export const B = () => <p>Don't {fetch('/x')}</p>;`))).toContain('network-api');
      expect(rules(withLine(`if (a) /'/.test(s); fetch('/x');`))).toContain('network-api');
    });

    it('kod i ${…} i en mallsträng granskas', () => {
      expect(rules(withLine('export const t = `a ${localStorage.getItem("x")} b`;'))).toContain('browser-storage');
    });
  });
});

describe('checkSourceFiles: adresser', () => {
  it.each([
    `const u = 'https://evil.example/x';`,
    `const u = "http://evil.example";`,
    'const u = `https://${host}/x`;',
    `const u = 'wss://evil.example';`,
    `const u = 'ws://evil.example';`,
    `const a = <a href="https://evil.example">x</a>;`,
    `const i = <img src="//evil.example/p.png" />;`,
    `const u = '//evil.example/x';`,
    `const u = 'HTTPS://EVIL.EXAMPLE';`,
    `const u = '\\x68ttps://evil.example';`,
    `const u = 'https:\\/\\/evil.example';`,
    `const u = 'https:\\u002f\\u002fevil.example';`,
    `const s = { backgroundImage: 'url(//evil.example/x.png)' };`,
  ])('%s ⇒ external-url', (line) => {
    expect(rules(withLine(line))).toContain('external-url');
  });

  it('en adress i en kommentar är ett eget, lindrigare regelbrott (url-in-comment), inte external-url', () => {
    const found = rules(withLine(`// se https://evil.example\n/* och http://evil.example */`));
    expect(found).toContain('url-in-comment');
    expect(found).not.toContain('external-url');
  });

  it('agentens regel-id för säkerhetsbrott används (packages/agent/src/klarsprak.ts)', () => {
    expect(rules(withLine(`fetch('/x'); eval('1'); localStorage.x; window.open('/'); new Worker('/w.js'); const u = 'https://evil.example';`))).toEqual(
      expect.arrayContaining(['network-api', 'dynamic-code', 'browser-storage', 'window-open', 'service-worker', 'external-url']),
    );
    expect(rules(withLine(`import _ from 'lodash';`))).toContain('forbidden-import');
  });

  it.each(['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML', 'http://www.w3.org/1999/xlink'])(
    'godkänner namnrymden %s',
    (url) => {
      expect(withLine(`export const ns = '${url}';`)).toEqual([]);
    },
  );

  it('godkänner inte en adress som bara börjar som en namnrymd', () => {
    expect(rules(withLine(`export const ns = 'http://www.w3.org/2000/svg.evil.example/x';`))).toContain('external-url');
  });

  it('godkänner relativa adresser och vanliga snedstreck i text', () => {
    expect(withLine(`export const a = <a href="/_api/x">x</a>; export const t = 'a // b'; export const d = 'a/b';`)).toEqual([]);
  });
});

describe('checkSourceFiles: CSS', () => {
  function css(text: string): string[] {
    return rules(check({ 'src/App.tsx': APP, 'src/styles.css': text }));
  }

  it.each([
    [`@import url(https://fonts.example/x.css);`, 'css-import'],
    [`@import 'other.css';`, 'css-import'],
    [`@IMPORT "x.css";`, 'css-import'],
    [`@plugin "tailwind-plugin";`, 'css-plugin'],
    [`@config "./tailwind.config.js";`, 'css-plugin'],
    [`a { background: url(https://evil.example/x.png); }`, 'css-url'],
    [`a { background: url("//evil.example/x.png"); }`, 'css-url'],
    [`a { background: url(/etc/passwd); }`, 'css-url'],
    [`a { background: url(../../../vite.config.ts); }`, 'css-url'],
    [`a { background: url(./bild.png); }`, 'css-url'],
    [`a { background: url( 'data:text/html,<b>x</b>' ); }`, 'data-html-url'],
    [`a { background: image-set("x.png" 1x); }`, 'css-url'],
    [`@font-face { font-family: x; src: url(x.woff2); }`, 'css-url'],
    [`a { width: expression(alert(1)); }`, 'css-expression'],
    [`a { behavior: url(x.htc); }`, 'css-behavior'],
    [`a { -moz-binding: url(x.xml#b); }`, 'css-binding'],
    [`a { background: \\75 rl(https://evil.example); }`, 'css-escape'],
    [`@\\69mport "x.css";`, 'css-escape'],
  ])('%s ⇒ %s', (text, rule) => {
    expect(css(text)).toContain(rule);
  });

  it('godkänner vanlig CSS, data:-bilder, #-referenser och kommentarer som nämner @import', () => {
    expect(
      css(
        `/* @import är förbjudet, liksom url(https://x) */\n:root { --a: 1px; }\na::before { content: "\\201C"; }\n.b { background: url(data:image/svg+xml;base64,AAAA); }\n.c { filter: url('#f'); }\n`,
      ),
    ).toEqual([]);
  });

  it('pekar ut rätt rad i CSS', () => {
    const diagnostic = check({ 'src/App.tsx': APP, 'src/styles.css': `a {}\n\n@import 'x.css';\n` }).find((d) => d.rule === 'css-import');
    expect(diagnostic?.line).toBe(3);
    expect(diagnostic?.file).toBe('src/styles.css');
  });
});
