/**
 * Dokumentoperationerna mot EN hyresgästs databas.
 *
 * Allt här arbetar med redan validerade värden och ett redan utvalt handtag — vilken hyresgäst
 * det gäller är avgjort innan koden nås. Funktionerna är synkrona med flit (se `handtag.ts`).
 *
 * Reglerna för scope (ur kontraktet):
 * - Endast `createDocument` skapar en kollektion och låser dess scope. En läsning låser aldrig
 *   något — annars kunde en användare hinna före appen och låsa en tänkt personlig kollektion
 *   som gemensam.
 * - `list`/`create` med annat scope än det låsta ⇒ `scope_mismatch`.
 * - `get`/`replace`/`delete` tar inget scope; ägarregeln står i SQL (se `sql.ts`).
 */
import type {
  CollectionScope,
  DocumentPage,
  JsonObject,
  StoredDocument,
  TenantLimits,
} from '@vibesandbox/contracts';
import { dataApiError } from './fel.ts';
import type { TenantHandle } from './handtag.ts';
import { newDocumentId } from './id.ts';
import { encodeCursor } from './markor.ts';
import {
  COUNT_COLLECTIONS,
  DELETE_DOCUMENT,
  INSERT_COLLECTION,
  INSERT_DOCUMENT,
  LIST_APP_DOCUMENTS,
  LIST_USER_DOCUMENTS,
  SELECT_COLLECTION_SCOPE,
  SELECT_DOCUMENT,
  UPDATE_DOCUMENT,
} from './sql.ts';

export const EMPTY_PAGE: DocumentPage = Object.freeze({ documents: Object.freeze([]) });

type Row = Record<string, unknown>;

export interface ListRequest {
  readonly collection: string;
  readonly scope: CollectionScope;
  readonly userId: string;
  readonly pageSize: number;
  /** Id:t markören pekar på, eller `undefined` för första sidan. */
  readonly afterId: string | undefined;
}

export function listDocuments(handle: TenantHandle, request: ListRequest): DocumentPage {
  const lockedScope = readLockedScope(handle, request.collection);
  if (lockedScope === undefined) return EMPTY_PAGE;
  assertSameScope(lockedScope, request.scope);

  // En rad mer än sidstorleken: finns den, finns det en sida till. Tom sträng sorterar före
  // alla giltiga id:n och betyder därför "från början".
  const parameters = {
    collection: request.collection,
    after: request.afterId ?? '',
    limit: request.pageSize + 1,
  };
  const rows: Row[] =
    lockedScope === 'user'
      ? handle.statement(LIST_USER_DOCUMENTS).all({ ...parameters, user: request.userId })
      : handle.statement(LIST_APP_DOCUMENTS).all(parameters);

  const documents = rows.slice(0, request.pageSize).map(toStoredDocument);
  const last = documents.at(-1);
  if (rows.length > request.pageSize && last !== undefined) {
    return { documents, nextCursor: encodeCursor(request.collection, lockedScope, last.id) };
  }
  return { documents };
}

export interface CreateRequest {
  readonly collection: string;
  readonly scope: CollectionScope;
  readonly userId: string;
  /** Redan validerad och serialiserad JSON-text. */
  readonly dataText: string;
}

export function createDocument(
  handle: TenantHandle,
  limits: TenantLimits,
  request: CreateRequest,
): StoredDocument {
  const id = newDocumentId();
  const now = new Date().toISOString();

  // En transaktion: kollektionen får inte bli kvar om dokumentet inte fick plats, och två
  // samtidiga "första dokumentet" får inte låsa samma kollektion med olika scope.
  handle.transaction(() => {
    const lockedScope = readLockedScope(handle, request.collection);
    if (lockedScope === undefined) {
      const row: Row | undefined = handle.statement(COUNT_COLLECTIONS).get();
      const count = row?.['antal'];
      if (typeof count !== 'number' || count >= limits.maxCollections) {
        throw dataApiError(
          'quota_exceeded',
          'Appen har nått sitt högsta antal samlingar och kan inte skapa fler.',
        );
      }
      handle
        .statement(INSERT_COLLECTION)
        .run({ collection: request.collection, scope: request.scope, now });
    } else {
      assertSameScope(lockedScope, request.scope);
    }

    handle.statement(INSERT_DOCUMENT).run({
      collection: request.collection,
      id,
      owner: request.userId,
      data: request.dataText,
      now,
    });
  });

  return { id, data: parseData(request.dataText), createdAt: now, updatedAt: now };
}

export interface DocumentRequest {
  readonly collection: string;
  readonly id: string;
  readonly userId: string;
}

export function getDocument(handle: TenantHandle, request: DocumentRequest): StoredDocument {
  const row: Row | undefined = handle.statement(SELECT_DOCUMENT).get({
    collection: request.collection,
    id: request.id,
    user: request.userId,
  });
  if (row === undefined) throw notFound();
  return toStoredDocument(row);
}

export function replaceDocument(
  handle: TenantHandle,
  request: DocumentRequest,
  dataText: string,
): StoredDocument {
  const row: Row | undefined = handle.statement(UPDATE_DOCUMENT).get({
    collection: request.collection,
    id: request.id,
    user: request.userId,
    data: dataText,
    now: new Date().toISOString(),
  });
  if (row === undefined) throw notFound();
  return toStoredDocument(row);
}

export function deleteDocument(handle: TenantHandle, request: DocumentRequest): void {
  // Radering måste fungera även när kvoten är förbrukad — det är enda vägen ur en full databas.
  const result = handle.withDeleteReserve(() =>
    handle.statement(DELETE_DOCUMENT).run({
      collection: request.collection,
      id: request.id,
      user: request.userId,
    }),
  );
  if (Number(result.changes) === 0) throw notFound();
}

function readLockedScope(handle: TenantHandle, collection: string): CollectionScope | undefined {
  const row: Row | undefined = handle.statement(SELECT_COLLECTION_SCOPE).get({ collection });
  if (row === undefined) return undefined;
  const scope = row['scope'];
  if (scope !== 'app' && scope !== 'user') throw new Error('okänt scope i databasen');
  return scope;
}

function assertSameScope(locked: CollectionScope, requested: CollectionScope): void {
  if (locked !== requested) {
    throw dataApiError(
      'scope_mismatch',
      'Samlingen finns redan med en annan synlighet, och den går inte att ändra i efterhand.',
    );
  }
}

/**
 * "Finns inte" och "är någon annans" ger avsiktligt exakt samma fel och samma text: den som
 * gissar id:n ska inte kunna skilja fallen åt.
 */
function notFound(): Error {
  return dataApiError('not_found', 'Dokumentet finns inte.');
}

function toStoredDocument(row: Row): StoredDocument {
  const { id, data, created_at: createdAt, updated_at: updatedAt } = row;
  if (
    typeof id !== 'string' ||
    typeof data !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    throw new Error('oväntad radform i documents');
  }
  return { id, data: parseData(data), createdAt, updatedAt };
}

function parseData(text: string): JsonObject {
  // Texten validerades som ett JSON-objekt innan den sparades; tabellen är STRICT.
  return JSON.parse(text) as JsonObject;
}
