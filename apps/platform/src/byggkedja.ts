/**
 * Byggkedjan som plattformen kör — det ENDA stället `main.ts` och `dev.ts` hämtar den ifrån.
 *
 *   local  tsc och Vite som barnprocesser på den här maskinen. Utveckling: appkoden transformeras
 *          men körs inte vid bygget. Vägras i produktion (av konfigurationen och av byggkedjan).
 *   docker en engångscontainer per bygge, utan nät. Kräver att plattformen får tala med Docker.
 *   spool  drift: plattformen saknar Docker-socket och lämnar jobb i BUILD_JOBS_DIR, där en
 *          separat byggarbetare utan nät (tjänsten `build-worker` i deploy/compose.yml) bygger dem.
 */
import { resolve } from 'node:path';
import { createBuildRunner, createSpoolBuildRunner } from '@vibesandbox/build';
import type { BuildRunner } from '@vibesandbox/contracts';
import type { PlatformConfig } from './config.ts';

/** Mallen som bygger apparna. För `docker` och `spool` används mallen i byggavbilden. */
export const TEMPLATE_DIRECTORY = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'app-template');

/**
 * Hur länge plattformen väntar på ett jobb hos byggarbetaren, INKLUSIVE kötid. Byggarbetarens
 * egen gräns är 120 s per bygge; resten är marginal för ett jobb som väntar på ett annat.
 */
export const SPOOL_TIMEOUT_MS = 180_000;

export async function createPlatformBuildRunner(config: PlatformConfig): Promise<BuildRunner | undefined> {
  const build = config.builder?.build;
  if (build === undefined) return undefined;
  switch (build.driver) {
    case 'spool':
      if (build.jobsDir === undefined) throw new Error('BUILD_JOBS_DIR saknas för spool.');
      return createSpoolBuildRunner({ jobsDirectory: build.jobsDir, timeoutMs: SPOOL_TIMEOUT_MS });
    case 'local':
    case 'docker':
      return createBuildRunner({ driver: build.driver, templateDirectory: TEMPLATE_DIRECTORY });
  }
}
