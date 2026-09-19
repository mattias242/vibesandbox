/**
 * @vibesandbox/build — bygger AI-genererad appkod med den låsta mallen.
 *
 *   const runner = createBuildRunner({ driver: 'docker', templateDirectory });
 *   const result = await runner.build({ 'src/App.tsx': '…', 'src/styles.css': '…' });
 *   if (result.ok) { await control.importVersion(appId, result.outputDirectory); }
 *   await result.dispose();
 *
 * Ordning: policy → typkontroll → Vite → tak på utdatan → kontroll av det byggda. Högst ett
 * bygge åt gången. Se README.md för drivrutiner, gränser och hotbild.
 */
import type { BuildRunner } from '@vibesandbox/contracts';
import { createDockerBuildRunner } from './docker.ts';
import type { BuildLimits } from './limits.ts';
import { resolveLimits } from './limits.ts';
import { createLocalBuildRunner } from './local.ts';

export type { BuildLimits } from './limits.ts';
export { DEFAULT_LIMITS } from './limits.ts';
export { readTemplateKnowledge } from './knowledge.ts';
export type { TemplateKnowledge } from './knowledge.ts';
export { createSpoolBuildRunner, runSpoolWorker } from './spool.ts';
export type { SpoolRunnerOptions, SpoolWorkerOptions } from './spool.ts';
export { runContainerBuild } from './container.ts';

export interface BuildRunnerOptions {
  /**
   * `local`: barnprocesser på den här maskinen — bara utveckling, vägrar NODE_ENV=production.
   * `docker`: en engångscontainer per bygge, utan nät, skrivskyddad, utan rättigheter.
   * (För en plattform utan Docker-socket: `createSpoolBuildRunner`.)
   */
  readonly driver: 'local' | 'docker';
  /** Mallens katalog (`packages/app-template`). För `docker` används mallen i avbilden vid bygget. */
  readonly templateDirectory: string;
  /** Avbilden för `docker`. Standard `vibesandbox/build-worker:dev`. */
  readonly image?: string;
  /** `runsc` = gVisor (måste vara installerat på värden). Standard `runc`. */
  readonly runtime?: 'runc' | 'runsc';
  readonly limits?: Partial<BuildLimits>;
  /** Där arbets- och utdatakataloger skapas. Standard: operativsystemets temp. */
  readonly tempDirectory?: string;
}

export function createBuildRunner(options: BuildRunnerOptions): BuildRunner {
  const limits = resolveLimits(options.limits);
  const common = { templateDirectory: options.templateDirectory, limits, ...(options.tempDirectory === undefined ? {} : { tempDirectory: options.tempDirectory }) };
  switch (options.driver) {
    case 'local':
      return createLocalBuildRunner(common);
    case 'docker':
      return createDockerBuildRunner({
        ...common,
        image: options.image ?? 'vibesandbox/build-worker:dev',
        runtime: options.runtime ?? 'runc',
      });
    default:
      throw new Error(`Okänd byggdrivrutin: ${String((options as { driver: unknown }).driver)}`);
  }
}
