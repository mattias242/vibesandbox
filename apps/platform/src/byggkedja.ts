/**
 * Byggkedjan som plattformen kör: det ENDA stället `main.ts` och `dev.ts` hämtar den ifrån.
 *
 * `@vibesandbox/build` är inte sammanslaget än. När det är det kopplas det in HÄR, med några rader:
 *
 *   import { createBuildRunner as createRunner } from '@vibesandbox/build';
 *   ...
 *   return createRunner({ driver: builder.build.driver, jobsDir: builder.build.jobsDir, ... });
 *
 * Tills dess ger funktionen `undefined`. Är byggverktyget då påslaget (LLM_MODEL satt) vägrar
 * `createPlatform` starta med ett tydligt fel — hellre det än ett byggverktyg där varje önskemål
 * misslyckas.
 */
import type { BuildRunner } from '@vibesandbox/contracts';
import type { PlatformConfig } from './config.ts';

export async function createBuildRunner(config: PlatformConfig): Promise<BuildRunner | undefined> {
  if (config.builder === undefined) return undefined;
  return undefined;
}
