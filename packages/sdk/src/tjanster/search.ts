/**
 * Tjänsten `search` för appar (`/_api/search`): sök i en kollektion efter INNEBÖRD, inte bara
 * exakta ord. Plattformen söker bara bland dokument den inloggade ändå får se.
 *
 *   import { search } from '@vibesandbox/sdk';
 *   const traffar = await search.search('arenden', 'stulen cykel');          // → [{ id, score }]
 *   const med = await search.searchDocuments<Arende>('arenden', 'stulen cykel'); // → [{ doc, score }]
 *
 * Dokumentationen för byggagenten står i packages/sdk/tjanster/search.md.
 */
import { SdkError } from '../errors.ts';
import { db } from '../index.ts';
import type { Doc } from '../index.ts';
import { assertCollectionName } from '../validation.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

/** Samma gräns som plattformen. */
export const MAX_QUERY_LENGTH = 1000;

export interface SearchOptions {
  /** Högst så många träffar (1–50). Standard: 10. */
  readonly limit?: number;
  /** `true` för en personlig kollektion — samma val som i `db.collection(namn, { personal: true })`. */
  readonly personal?: boolean;
  /** Sök bara i dessa fält (toppnivå). Standard: all text i dokumentet. */
  readonly fields?: readonly string[];
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

export interface SearchHit {
  readonly id: string;
  /** Likhet, högre är mer likt (högst 1). Jämför bara poäng inom samma sökning. */
  readonly score: number;
}

function isHit(value: unknown): value is SearchHit {
  if (typeof value !== 'object' || value === null) return false;
  const { id, score } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof score === 'number' && Number.isFinite(score);
}

/** Id och poäng för de dokument som liknar `query` mest, mest lika först. */
export async function search(collection: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  assertCollectionName(collection);
  if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_LENGTH) {
    throw new SdkError('invalid_request', `Skriv en sökfråga på högst ${MAX_QUERY_LENGTH} tecken.`);
  }
  const body: Record<string, unknown> = { collection, query };
  if (options.limit !== undefined) body['limit'] = options.limit;
  if (options.personal !== undefined) body['personal'] = options.personal;
  if (options.fields !== undefined) body['fields'] = [...options.fields];

  const answer = await callService('search', 'POST', '', { json: body, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || !results.every(isHit)) throw new SdkError('internal');
  return results.map((hit) => ({ id: hit.id, score: hit.score }));
}

/**
 * Som `search`, men hämtar också dokumenten (med `db`), i träffordning. Ett dokument som hunnit
 * raderas mellan sökningen och hämtningen hoppas över.
 */
export async function searchDocuments<T extends object>(
  collection: string,
  query: string,
  options: SearchOptions = {},
): Promise<{ readonly doc: Doc<T>; readonly score: number }[]> {
  const hits = await search(collection, query, options);
  const source = db.collection<T>(collection, { personal: options.personal === true });
  const found = await Promise.all(
    hits.map(async (hit) => {
      try {
        return { doc: await source.get(hit.id), score: hit.score };
      } catch (error) {
        if (error instanceof SdkError && error.code === 'not_found') return undefined;
        throw error;
      }
    }),
  );
  return found.filter((entry): entry is { doc: Doc<T>; score: number } => entry !== undefined);
}
