/**
 * Det `main.ts` och `dev.ts` kopplar in utöver konfigurationen: byggkedjan och agentens kunskap.
 * Utan byggverktyg (ingen `LLM_MODEL`) behövs ingetdera.
 */
import { createPlatformBuildRunner } from './byggkedja.ts';
import type { PlatformConfig } from './config.ts';
import { loadAgentKnowledge } from './kunskap.ts';
import type { PlatformDependencies } from './server.ts';

export async function createBuilderDependencies(config: PlatformConfig): Promise<PlatformDependencies> {
  if (config.builder === undefined) return {};
  const [buildRunner, knowledge] = await Promise.all([createPlatformBuildRunner(config), loadAgentKnowledge(undefined, config.appServices?.enabled ?? [])]);
  return { ...(buildRunner === undefined ? {} : { buildRunner }), knowledge };
}
