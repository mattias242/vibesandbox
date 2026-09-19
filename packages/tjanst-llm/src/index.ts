/**
 * Plattformstjänsten `llm` (`/_api/llm`): språkmodell för appar via Berget, med maskning av
 * personuppgifter och tokenkvot per app och användare. Slås på med `APP_SERVICES=llm`.
 *
 * Inställningar (miljön):
 * - `SVC_LLM_MODEL` (krävs) — modellens fullständiga id hos Berget.
 * - `SVC_LLM_TOKENS_PER_APP_DAY` (standard 200 000), `SVC_LLM_TOKENS_PER_USER_HOUR` (20 000).
 * - `SVC_LLM_TIMEOUT_MS` (60 000, 1 000–300 000), `SVC_LLM_REASONING_EFFORT` (low).
 * Nyckel och adress till Berget kommer från plattformen (`dependencies.berget`).
 */
import type { AppServiceDependencies, AppServiceFactory, AppServiceInstance } from '@vibesandbox/contracts';
import { readSettings } from './installningar.ts';
import { createService } from './tjanst.ts';
import type { LlmServiceOptions } from './tjanst.ts';

export type { LlmServiceOptions } from './tjanst.ts';
export type { LlmSettings } from './installningar.ts';

/** Som fabriken, men med testernas möjligheter (inspelad språkmodell, kort tidsgräns). */
export function createLlmService(dependencies: AppServiceDependencies, options: LlmServiceOptions = {}): AppServiceInstance {
  return { service: createService(dependencies, readSettings(dependencies.env), options) };
}

export const factory: AppServiceFactory = (dependencies) => createLlmService(dependencies);
