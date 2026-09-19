/**
 * Det agenten vet om plattformen, läst från repot EN gång vid start: SDK:ts referens (dess README,
 * ordagrant), exempelappen (appmallens `src/`) och startfilerna en ny app börjar från.
 *
 * Läses från disk i stället för att skrivas in här, så att det modellen får se alltid är samma
 * text som människor läser och samma kod som mallen faktiskt bygger.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isAllowedSourcePath } from '@vibesandbox/contracts';
import type { SourceFiles } from '@vibesandbox/contracts';
import type { AgentKnowledge } from '@vibesandbox/agent';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * Används bara om `packages/app-template/starter/src/` saknas. Byggkedjans agent lägger dit mallens
 * riktiga startfiler; tills dess börjar en ny app från den här minsta möjliga appen, som bara
 * använder det mallen garanterat har (React och en stilmall).
 */
export const BUILT_IN_STARTER_FILES: SourceFiles = {
  'src/App.tsx': 'export function App() {\n  return (\n    <main>\n      <h1>Ny app</h1>\n    </main>\n  );\n}\n',
  'src/styles.css': 'main {\n  max-width: 40rem;\n  margin: 0 auto;\n  padding: 1rem;\n  font-family: system-ui, sans-serif;\n}\n',
};

/** Katalogens källfiler som `src/<sökväg>` → innehåll. Bara det agenten själv får skriva tas med. */
function readSourceDirectory(directory: string): SourceFiles {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = `src/${relative(directory, path).split(sep).join('/')}`;
      // Mallens egna filer (t.ex. `src/main.tsx`) visas aldrig som något modellen får skriva.
      if (isAllowedSourcePath(key)) files[key] = readFileSync(path, 'utf8');
    }
  };
  walk(directory);
  return files;
}

export function loadAgentKnowledge(repoRoot: string = REPO_ROOT): AgentKnowledge {
  const sdkReference = readFileSync(join(repoRoot, 'packages', 'sdk', 'README.md'), 'utf8');
  const exampleFiles = readSourceDirectory(join(repoRoot, 'packages', 'app-template', 'src'));
  if (Object.keys(exampleFiles).length === 0) throw new Error('Appmallen saknar exempelappens källfiler.');

  const starterDirectory = join(repoRoot, 'packages', 'app-template', 'starter', 'src');
  const starterFiles = existsSync(starterDirectory) ? readSourceDirectory(starterDirectory) : BUILT_IN_STARTER_FILES;
  if (Object.keys(starterFiles).length === 0) throw new Error('Appmallens startfiler är tomma.');

  return { sdkReference, exampleFiles, starterFiles };
}
