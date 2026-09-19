/**
 * Drivrutinen `local`: tsc och Vite som barnprocesser på den här maskinen.
 *
 * BARA FÖR UTVECKLING. Den vägrar starta när NODE_ENV=production. I drift byggs koden i en
 * engångscontainer utan nät (`docker`) eller av en separat byggarbetare (`spool`).
 *
 * Varför den ändå är rimlig lokalt: mallens konfiguration är låst och läser bara `src/`, så
 * appens kod transformeras och buntas men KÖRS inte vid bygget. Processerna får en minimal miljö
 * (inga hemligheter), startas utan skal, dödas vid tidsgränsen och arbetskatalogen städas alltid.
 * Det som saknas jämfört med containern är isoleringen om det antagandet skulle brista.
 */
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildResult, BuildRunner, Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkSourceFiles } from '@vibesandbox/policy';
import { capDiagnostics } from './diagnostics.ts';
import type { BuildLimits } from './limits.ts';
import { buildInWorkspace } from './pipeline.ts';
import { createSerialQueue } from './queue.ts';

export interface LocalRunnerOptions {
  readonly templateDirectory: string;
  readonly limits: BuildLimits;
  /** Där arbets- och utdatakataloger skapas. Standard: operativsystemets temp. */
  readonly tempDirectory?: string;
}

export function failedResult(diagnostics: readonly Diagnostic[], started: number): BuildResult {
  return {
    ok: false,
    diagnostics: capDiagnostics(diagnostics),
    durationMs: Math.max(1, performance.now() - started),
    dispose: async () => {},
  };
}

/** Ett lyckat resultat vars katalog tas bort (en gång) av `dispose`. */
export function succeededResult(outputDirectory: string, ownedDirectory: string, started: number): BuildResult {
  let disposed: Promise<void> | undefined;
  return {
    ok: true,
    outputDirectory,
    diagnostics: [],
    durationMs: Math.max(1, performance.now() - started),
    dispose: () => {
      disposed ??= rm(ownedDirectory, { recursive: true, force: true });
      return disposed;
    },
  };
}

export function assertNotProduction(driver: string): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      `Byggdrivrutinen '${driver}' kör opålitlig kod direkt på värden och får inte användas när NODE_ENV=production. Använd 'docker' eller 'spool'.`,
    );
  }
}

export function createLocalBuildRunner(options: LocalRunnerOptions): BuildRunner {
  assertNotProduction('local');
  const queue = createSerialQueue();
  const tempDirectory = options.tempDirectory ?? tmpdir();

  async function buildOnce(files: SourceFiles, signal?: AbortSignal): Promise<BuildResult> {
    const started = performance.now();
    const policy = checkSourceFiles(files);
    if (policy.length > 0) return failedResult(policy, started);

    const baseDir = await mkdtemp(path.join(tempDirectory, 'vibesandbox-bygge-'));
    try {
      const result = await buildInWorkspace({
        templateDirectory: options.templateDirectory,
        files,
        baseDir,
        limits: options.limits,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.distDirectory === undefined) return failedResult(result.diagnostics, started);
      const owned = await mkdtemp(path.join(tempDirectory, 'vibesandbox-app-'));
      const outputDirectory = path.join(owned, 'dist');
      await rename(result.distDirectory, outputDirectory);
      return succeededResult(outputDirectory, owned, started);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  }

  return {
    build: (files, buildOptions) => queue.run((signal) => buildOnce(files, signal), buildOptions?.signal),
  };
}
