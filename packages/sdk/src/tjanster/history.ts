/**
 * Tjänsten `history` för appar (`/_api/history`): vem ändrade vad och när i appens dokument.
 *
 *   import { history } from '@vibesandbox/sdk';
 *
 *   const { entries } = await history.forDocument('arenden', id);   // nyast först
 *   const senast = entries[0];                                      // { event, at, userId, displayName, data }
 *   await history.restore('arenden', id, entries[1].at);            // ångra: tillbaka till förra versionen
 *
 * Plattformen skriver historiken själv vid varje add/update/remove — appen gör ingenting för
 * att den ska finnas. Personliga dokument: var och en ser bara historiken för sina egna.
 * Dokumentation för byggagenten: packages/sdk/tjanster/history.md.
 */
import type { JsonObject } from '@vibesandbox/contracts';
import { SdkError } from '../errors.ts';
import { assertCollectionName, assertDocumentId } from '../validation.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

/** `create` = sparades (add), `replace` = ändrades (update), `delete` = togs bort, `restore` = återställdes. */
export type HistoryEvent = 'create' | 'replace' | 'delete' | 'restore';

export interface HistoryItem<T = JsonObject> {
  readonly event: HistoryEvent;
  /** ISO 8601. Identifierar versionen — skicka den till `restore`. */
  readonly at: string;
  readonly userId: string;
  /** Namn att visa, t.ex. "anna.andersson". Aldrig en e-postadress. */
  readonly displayName: string;
  /** Innehållet EFTER ändringen. Vid `delete`: innehållet dokumentet hade innan det togs bort. */
  readonly data: T;
}

export interface CollectionHistoryItem<T = JsonObject> extends HistoryItem<T> {
  readonly documentId: string;
}

export interface HistoryPage<I> {
  readonly entries: I[];
  /** Finns när det finns äldre rader: skicka som `cursor` för nästa sida. */
  readonly nextCursor?: string;
}

export interface HistoryOptions {
  /** Högst så många rader (plattformen har ett eget tak). Standard 50. */
  readonly limit?: number;
  readonly cursor?: string;
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

export interface CollectionHistoryOptions extends HistoryOptions {
  /** Bara det som hänt EFTER denna tid (ISO 8601, som `at`). */
  readonly since?: string;
}

/** Ett dokuments historik, nyast först. Någon annans personliga dokument ⇒ SdkError `not_found`. */
export async function forDocument<T = JsonObject>(
  collection: string,
  id: string,
  options: HistoryOptions = {},
): Promise<HistoryPage<HistoryItem<T>>> {
  assertCollectionName(collection);
  assertDocumentId(id);
  const query = buildQuery([
    ['limit', limitText(options.limit)],
    ['cursor', options.cursor],
  ]);
  const body = await callService('history', 'GET', `/collections/${collection}/docs/${id}${query}`, fetchOption(options));
  return asPage<HistoryItem<T>>(body);
}

/** Allt som hänt i en kollektion, nyast först (i en personlig kollektion: bara det egna). */
export async function forCollection<T = JsonObject>(
  collection: string,
  options: CollectionHistoryOptions = {},
): Promise<HistoryPage<CollectionHistoryItem<T>>> {
  assertCollectionName(collection);
  const query = buildQuery([
    ['since', options.since],
    ['limit', limitText(options.limit)],
    ['cursor', options.cursor],
  ]);
  const body = await callService('history', 'GET', `/collections/${collection}${query}`, fetchOption(options));
  return asPage<CollectionHistoryItem<T>>(body);
}

/**
 * Återställer dokumentet till versionen med tiden `at` (ta den ur historiken). Sparas som en ny
 * version, som också syns i historiken. Går även för ett borttaget dokument.
 */
export async function restore<T = JsonObject>(
  collection: string,
  id: string,
  at: string,
  options: { readonly fetch?: ServiceFetch } = {},
): Promise<{ readonly id: string; readonly data: T; readonly createdAt: string; readonly updatedAt: string }> {
  assertCollectionName(collection);
  assertDocumentId(id);
  if (typeof at !== 'string' || at.length === 0) {
    throw new SdkError('invalid_request', 'Ange tiden för versionen, som den står i historiken (at).');
  }
  const body = await callService('history', 'POST', `/collections/${collection}/docs/${id}/restore`, {
    json: { at },
    ...fetchOption(options),
  });
  return body as { readonly id: string; readonly data: T; readonly createdAt: string; readonly updatedAt: string };
}

function fetchOption(options: { readonly fetch?: ServiceFetch }): { readonly fetch?: ServiceFetch } {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}

function limitText(limit: number | undefined): string | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SdkError('invalid_request', 'limit ska vara ett heltal som är minst 1.');
  }
  return String(limit);
}

function buildQuery(parts: ReadonlyArray<readonly [string, string | undefined]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of parts) if (value !== undefined) params.set(name, value);
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

function asPage<I>(body: unknown): HistoryPage<I> {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { entries?: unknown }).entries)) {
    throw new SdkError('internal');
  }
  const { entries, nextCursor } = body as { entries: I[]; nextCursor?: unknown };
  return typeof nextCursor === 'string' ? { entries, nextCursor } : { entries };
}
