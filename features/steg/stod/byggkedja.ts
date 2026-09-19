/**
 * Fejkad byggkedja och inspelad språkmodell för scenarierna om byggverktyget.
 *
 * Byggkedjan "bygger" genom att skriva en katalog med en `index.html` som visar appens
 * `src/App.tsx` (HTML-kodad) — då kan ett scenario se att det som visas är det språkmodellen
 * skrev. Två regler efterliknar den riktiga kedjan:
 *
 *   - en extern adress (`http://` eller `https://`) i koden ⇒ policybrott `external-url`
 *     (koden byggs aldrig, precis som med den riktiga policyn)
 *   - texten `BYGGFEL` i koden ⇒ typfel, som modellen får rätta i nästa varv
 *
 * (Samma regler som plattformens egna tester använder i `apps/platform/test/stod/byggkedja.ts`;
 * scenarierna har en egen kopia så att de inte beror på ett annat pakets testkod.)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildResult, BuildRunner, SourceFiles } from '@vibesandbox/contracts';

export interface FejkadByggkedja extends BuildRunner {
  /** Kataloger som byggts men inte städats bort. */
  readonly kvar: ReadonlySet<string>;
}

function html(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function fejkadByggkedja(): FejkadByggkedja {
  const kvar = new Set<string>();
  return {
    kvar,
    async build(files: SourceFiles): Promise<BuildResult> {
      const start = Date.now();
      const kod = Object.values(files).join('\n');
      const misslyckat = (diagnostics: BuildResult['diagnostics']): BuildResult => ({
        ok: false,
        diagnostics,
        durationMs: Date.now() - start,
        async dispose() {},
      });
      if (/https?:\/\//.test(kod)) {
        return misslyckat([{ source: 'policy', rule: 'external-url', file: 'src/App.tsx', message: 'Extern adress i koden.' }]);
      }
      if (kod.includes('BYGGFEL')) {
        return misslyckat([{ source: 'typecheck', file: 'src/App.tsx', line: 1, message: "Cannot find name 'BYGGFEL'." }]);
      }
      const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bdd-bygge-'));
      kvar.add(katalog);
      await writeFile(
        join(katalog, 'index.html'),
        `<!doctype html>\n<html lang="sv"><head><meta charset="utf-8"><title>Byggd app</title></head>` +
          `<body><pre>${html(files['src/App.tsx'] ?? '')}</pre></body></html>\n`,
      );
      return {
        ok: true,
        outputDirectory: katalog,
        diagnostics: [],
        durationMs: Date.now() - start,
        async dispose() {
          kvar.delete(katalog);
          await rm(katalog, { recursive: true, force: true });
        },
      };
    },
  };
}

/** Ett svar i agentens protokoll: sammanfattning, hela filer, slutmarkör. */
export function modellsvar(sammanfattning: string, appTsx: string): string {
  return `${sammanfattning}\n\n<vs-file path="src/App.tsx">\n${appTsx}\n</vs-file>\n<vs-done/>\n`;
}

/** En giltig app med ett kännetecken i rubriken, så att ett scenario kan känna igen den. */
export function appMedRubrik(rubrik: string): string {
  return modellsvar(`Appen visar rubriken ${rubrik}.`, `export function App() {\n  return <main><h1>${rubrik}</h1></main>;\n}`);
}

/** Kännetecknen i scenariernas appar. */
export const FORSTA_VERSIONEN = 'mötesrum-första-versionen';
export const ANDRADE_VERSIONEN = 'mötesrum-ändrade-versionen';

export const APP_MED_EXTERN_ADRESS = modellsvar(
  'Formuläret skickar svaren vidare.',
  'export function App() {\n  const skicka = () => fetch("https://extern.example.org/svar", { method: "POST" });\n' +
    '  return <main><button onClick={skicka}>Skicka</button></main>;\n}',
);

export const APP_SOM_INTE_BYGGER = modellsvar(
  'Här är appen.',
  'export function App() {\n  return <main><h1>{BYGGFEL}</h1></main>;\n}',
);
