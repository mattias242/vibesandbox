/**
 * Bygget INUTI engångscontainern (drivrutinen `docker`). Anropas av avbildens inträdesskript
 * (`images/build-worker/entrypoint.ts`).
 *
 *   /in/src   appens källfiler (skrivskyddat)
 *   /work     tmpfs: mallen och appen sätts ihop här
 *   /out      här hamnar den byggda katalogen (`/out/dist`)
 *
 * Resultatet (ok + diagnoser) skrivs som EN rad JSON på standard ut; allt annat verktygen skriver
 * fångas av pipelinen. Värden litar inte på något av det: den granskar /out och diagnoserna igen.
 */
import { lstat, mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkSourceFiles, SOURCE_LIMITS } from '@vibesandbox/policy';
import type { BuildLimits } from './limits.ts';
import { copyTreeSafely } from './output.ts';
import { buildInWorkspace } from './pipeline.ts';

export interface ContainerBuildOptions {
  readonly inDirectory: string;
  readonly outDirectory: string;
  readonly workRoot: string;
  readonly templateDirectory: string;
  readonly limits: BuildLimits;
}

export interface ContainerBuildReport {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** Läser `<dir>/src` som SourceFiles. Följer inga länkar och läser inget utöver taken. */
export async function readSourceTree(inDirectory: string): Promise<SourceFiles> {
  const files: Record<string, string> = {};
  let total = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    for (const entry of await readdir(path.join(inDirectory, relative))) {
      const name = `${relative}/${entry}`;
      const info = await lstat(path.join(inDirectory, name));
      if (info.isDirectory() && depth < 6) await walk(name, depth + 1);
      else if (info.isFile()) {
        total += info.size;
        if (Object.keys(files).length >= SOURCE_LIMITS.maxFiles || info.size > SOURCE_LIMITS.maxFileBytes || total > SOURCE_LIMITS.maxTotalBytes) {
          throw new Error('För många eller för stora källfiler.');
        }
        files[name] = await readFile(path.join(inDirectory, name), 'utf8');
      } else throw new Error(`Otillåten fil bland källfilerna: ${name}`);
    }
  }
  await walk('src', 0);
  return files;
}

export async function runContainerBuild(options: ContainerBuildOptions): Promise<ContainerBuildReport> {
  const files = await readSourceTree(options.inDirectory);
  // Värden har redan kontrollerat, men containern litar inte på att den fick samma filer.
  const policy = checkSourceFiles(files);
  if (policy.length > 0) return { ok: false, diagnostics: policy };

  const baseDir = await mkdtemp(path.join(options.workRoot, 'bygge-'));
  const result = await buildInWorkspace({ templateDirectory: options.templateDirectory, files, baseDir, limits: options.limits });
  if (result.distDirectory === undefined) return { ok: false, diagnostics: result.diagnostics };
  await copyTreeSafely(result.distDirectory, path.join(options.outDirectory, 'dist'), options.limits.maxOutputBytes);
  return { ok: true, diagnostics: [] };
}
