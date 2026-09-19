/**
 * Fejkad byggkedja för plattformens tester: "bygger" genom att skriva en liten katalog med en
 * `index.html` som visar appens `src/App.tsx` (HTML-kodad), så att ett test kan se att det
 * språkmodellen skrev är det som visas. Två enkla regler efterliknar den riktiga kedjan:
 *
 *   - en extern adress (`http://` eller `https://`) i koden ⇒ policybrott `external-url`
 *   - texten `BYGGFEL` i koden ⇒ typfel, som modellen får rätta
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildResult, BuildRunner, SourceFiles } from '@vibesandbox/contracts';

export interface FejkadByggkedja extends BuildRunner {
  readonly byggen: SourceFiles[];
  /** Kataloger som skapats men inte städats bort. Ska vara tom när plattformen är klar med dem. */
  readonly kvar: ReadonlySet<string>;
}

function html(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function fejkadByggkedja(): FejkadByggkedja {
  const byggen: SourceFiles[] = [];
  const kvar = new Set<string>();
  return {
    byggen,
    kvar,
    async build(files) {
      byggen.push({ ...files });
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
      const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-fejkbygge-'));
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
export function modellsvar(sammanfattning: string, filer: Readonly<Record<string, string>>): string {
  const block = Object.entries(filer).map(([sokvag, innehall]) => `<vs-file path="${sokvag}">\n${innehall}\n</vs-file>`);
  return `${sammanfattning}\n\n${block.join('\n')}\n<vs-done/>\n`;
}

export function todoApp(rubrik: string): string {
  return modellsvar('En todo-lista där man kan lägga till och bocka av uppgifter.', {
    'src/App.tsx': `export function App() {\n  return <main><h1>${rubrik}</h1></main>;\n}`,
  });
}
