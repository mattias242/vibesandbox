/**
 * En FÄRSK arbetskatalog per bygge. Mallens låsta filer skrivs först, appens därefter, och varje
 * appfil skrivs med `wx` (misslyckas om filen finns) — en appfil kan alltså aldrig skriva över en
 * mallfil, inte ens om policyn skulle ha släppt igenom den. Sökvägsregeln kontrolleras här igen
 * av samma skäl: den här funktionen ska vara säker även för den som anropar den direkt.
 */
import { access, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAllowedSourcePath, TEMPLATE_OWNED_SOURCE_PATHS } from '@vibesandbox/contracts';
import type { SourceFiles } from '@vibesandbox/contracts';

/** Mallens filer som bygget läser. Allt annat i mallens katalog (test/, dist/, README) används inte. */
export const TEMPLATE_FILES: readonly string[] = ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', ...TEMPLATE_OWNED_SOURCE_PATHS];

export interface WorkspaceOptions {
  readonly templateDirectory: string;
  /** Får inte finnas. Föräldern måste finnas. */
  readonly workDir: string;
  readonly files: SourceFiles;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Alla `node_modules` från mallens katalog och uppåt, närmast först — så som Node letar. */
async function nodeModulesChain(templateDirectory: string): Promise<string[]> {
  const chain: string[] = [];
  let directory = path.resolve(templateDirectory);
  for (;;) {
    const candidate = path.join(directory, 'node_modules');
    if (await exists(candidate)) chain.push(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) return chain;
    directory = parent;
  }
}

/**
 * Bygger `<arbetskatalog>/node_modules` av symboliska länkar till mallens installerade paket
 * (närmaste vinner, som i Nodes egen upplösning). Länka, inte kopiera: det är hundratals
 * megabyte, och paketen ändras aldrig av ett bygge.
 */
export async function linkNodeModules(templateDirectory: string, workDir: string): Promise<void> {
  const target = path.join(workDir, 'node_modules');
  await mkdir(target);
  const taken = new Set<string>();
  for (const source of await nodeModulesChain(templateDirectory)) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        if (!taken.has(entry.name)) {
          await mkdir(path.join(target, entry.name), { recursive: true });
          taken.add(entry.name);
        }
        for (const scoped of await readdir(path.join(source, entry.name))) {
          const name = `${entry.name}/${scoped}`;
          if (taken.has(name)) continue;
          taken.add(name);
          await symlink(path.join(source, name), path.join(target, name), 'dir');
        }
      } else if (!taken.has(entry.name)) {
        taken.add(entry.name);
        await symlink(path.join(source, entry.name), path.join(target, entry.name), 'dir');
      }
    }
  }
}

export async function prepareWorkspace(options: WorkspaceOptions): Promise<void> {
  const workDir = path.resolve(options.workDir);
  await mkdir(workDir);
  await mkdir(path.join(workDir, 'src'));

  // 1. Mallens filer — först.
  for (const file of TEMPLATE_FILES) {
    await writeFile(path.join(workDir, file), await readFile(path.join(options.templateDirectory, file)), { flag: 'wx' });
  }
  await linkNodeModules(options.templateDirectory, workDir);

  // 2. Appens filer — aldrig över något som redan finns.
  for (const [file, content] of Object.entries(options.files)) {
    if (!isAllowedSourcePath(file) || typeof content !== 'string') {
      throw new Error(`Otillåten fil i bygget: ${JSON.stringify(file.slice(0, 100))}`);
    }
    const destination = path.resolve(workDir, file);
    if (!destination.startsWith(`${path.join(workDir, 'src')}${path.sep}`)) {
      throw new Error(`Otillåten fil i bygget: ${JSON.stringify(file.slice(0, 100))}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
  }
}
