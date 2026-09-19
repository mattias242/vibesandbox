/**
 * Plattformstjänsten `search` (`/_api/search`): semantisk sökning i en apps dokument med
 * embeddings från Berget. Slås på med `APP_SERVICES=search`.
 *
 * Inställningar (miljövariabler):
 *   SVC_SEARCH_MODEL                    krävs, t.ex. `intfloat/multilingual-e5-large`
 *   SVC_SEARCH_TOKENS_PER_APP_DAY       standard 1 000 000
 *   SVC_SEARCH_MAX_DOCUMENTS            standard 5000 (per kollektion och sökning)
 *   SVC_SEARCH_QUERIES_PER_USER_MINUTE  standard 30
 *   SVC_SEARCH_MAX_VECTORS_PER_APP      standard 25 000
 * Berget (adress och nyckel) kommer från plattformen (`dependencies.berget`).
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { createBergetEmbedder } from './inbaddning.ts';
import { createSearchService, DEFAULT_SEARCH_LIMITS } from './tjanst.ts';
import type { SearchLimits } from './tjanst.ts';

export { createSearchService, DEFAULT_SEARCH_LIMITS } from './tjanst.ts';
export type { SearchLimits, SearchServiceOptions } from './tjanst.ts';
export { createBergetEmbedder, EmbeddingError } from './inbaddning.ts';
export type { Embedder, EmbeddingResult } from './inbaddning.ts';

const TIMEOUT_MS = 30_000;

function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,9}$/.test(raw.trim())) {
    throw new Error(`Tjänsten search: ${name} ska vara ett positivt heltal (var "${raw.slice(0, 20)}").`);
  }
  return Number(raw.trim());
}

export const factory: AppServiceFactory = (dependencies) => {
  const env = dependencies.env;
  const model = env['SVC_SEARCH_MODEL']?.trim() ?? '';
  if (model === '') {
    throw new Error('Tjänsten search: SVC_SEARCH_MODEL saknas. Ange embeddingmodellen hos Berget, t.ex. intfloat/multilingual-e5-large.');
  }
  if (dependencies.berget === undefined) {
    throw new Error('Tjänsten search behöver Berget för inbäddningar, men ingen nyckel till Berget är inställd (BERGET_API_KEY).');
  }
  const limits: SearchLimits = {
    tokensPerAppDay: positiveInteger(env, 'SVC_SEARCH_TOKENS_PER_APP_DAY', DEFAULT_SEARCH_LIMITS.tokensPerAppDay),
    maxDocuments: positiveInteger(env, 'SVC_SEARCH_MAX_DOCUMENTS', DEFAULT_SEARCH_LIMITS.maxDocuments),
    queriesPerUserMinute: positiveInteger(env, 'SVC_SEARCH_QUERIES_PER_USER_MINUTE', DEFAULT_SEARCH_LIMITS.queriesPerUserMinute),
    maxVectorsPerApp: positiveInteger(env, 'SVC_SEARCH_MAX_VECTORS_PER_APP', DEFAULT_SEARCH_LIMITS.maxVectorsPerApp),
  };
  const embedder = createBergetEmbedder({
    baseUrl: dependencies.berget.baseUrl,
    apiKey: dependencies.berget.apiKey,
    model,
    timeoutMs: TIMEOUT_MS,
  });
  const service = createSearchService({
    store: dependencies.store,
    dataDir: dependencies.dataDir,
    embedder,
    now: dependencies.now,
    log: dependencies.log,
    limits,
  });
  return { service };
};
