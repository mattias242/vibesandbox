/**
 * Det agenten behöver veta om mallen: startfiler för en ny app och ett fullständigt exempel att
 * visa modellen. Läses från mallens katalog, så att det alltid stämmer med den mall som bygger.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceFiles } from '@vibesandbox/contracts';

export interface TemplateKnowledge {
  /** En minimal giltig app: utgångsläget för en ny app (`starter/src/…` i mallen). */
  readonly starterFiles: SourceFiles;
  /** Mallens exempelapp (`src/App.tsx` + `src/styles.css`): visar hur SDK:t används. */
  readonly exampleFiles: SourceFiles;
}

const FILES = ['src/App.tsx', 'src/styles.css'] as const;

async function read(directory: string): Promise<SourceFiles> {
  const files: Record<string, string> = {};
  for (const file of FILES) files[file] = await readFile(path.join(directory, file), 'utf8');
  return files;
}

export async function readTemplateKnowledge(templateDirectory: string): Promise<TemplateKnowledge> {
  return {
    starterFiles: await read(path.join(templateDirectory, 'starter')),
    exampleFiles: await read(templateDirectory),
  };
}
