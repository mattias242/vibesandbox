/**
 * @vibesandbox/data-api — appdata i en SQLite-fil per hyresgäst.
 *
 * Den här filen är paketets enda publika yta och håller ihop stegen i varje anrop, alltid i samma
 * ordning:
 *
 *   1. är lagringen öppen?            (annars ett tydligt fel, ingen krasch)
 *   2. validera ALLA indata           (`validering.ts`, `markor.ts`) — före all I/O
 *   3. härled hyresgästens sökväg     (`sokvagar.ts`) — enbart ur TenantContext
 *   4. hämta handtaget                (`handtag.ts`)
 *   5. utför operationen              (`dokument.ts`, med SQL ur `sql.ts`)
 *   6. översätt alla fel              (`fel.ts`) — inget internt läcker ut
 *
 * Metoderna är `async` för att uppfylla kontraktet, men allt arbete sker synkront utan `await`.
 * Det är en förutsättning för att handtagscachen ska vara säker; se `handtag.ts`.
 */
import type {
  CollectionScope,
  Identity,
  JsonObject,
  TenantContext,
  TenantLimits,
  TenantStore,
} from '@vibesandbox/contracts';
import { DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import {
  EMPTY_PAGE,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  replaceDocument,
} from './dokument.ts';
import { dataApiError, translateError } from './fel.ts';
import { createHandleCache } from './handtag.ts';
import { assertValidLimits } from './kvot.ts';
import { decodeCursor } from './markor.ts';
import { tenantPaths } from './sokvagar.ts';
import {
  serializeDocumentData,
  validateCollectionName,
  validateDocumentId,
  validatePageSize,
  validateScope,
  validateUserId,
} from './validering.ts';

export interface TenantStoreOptions {
  /** Rotkatalog för all appdata. Varje hyresgäst får en egen underkatalog som plattformen namnger. */
  readonly dataDir: string;
  readonly limits?: TenantLimits;
  /** Högsta antal samtidigt öppna SQLite-databaser; de minst nyligen använda stängs. */
  readonly maxOpenDatabases?: number;
}

const DEFAULT_MAX_OPEN_DATABASES = 100;
const DEFAULT_PAGE_SIZE = 50;

export function createTenantStore(options: TenantStoreOptions): TenantStore {
  const limits = options.limits ?? DEFAULT_TENANT_LIMITS;
  const maxOpenDatabases = options.maxOpenDatabases ?? DEFAULT_MAX_OPEN_DATABASES;
  const dataDir = options.dataDir;

  // Konfigurationsfel ska stoppa uppstarten, inte upptäckas av den första användaren.
  assertValidLimits(limits);
  if (!Number.isSafeInteger(maxOpenDatabases) || maxOpenDatabases < 1) {
    throw new TypeError('maxOpenDatabases måste vara ett positivt heltal.');
  }
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('dataDir måste anges.');
  }

  const handles = createHandleCache(limits, maxOpenDatabases);
  let closed = false;

  /** Ram runt varje publik metod: stängd-kontroll först, felöversättning sist. */
  function guarded<T>(work: () => T): T {
    try {
      if (closed) throw dataApiError('internal', 'Lagringen är stängd och tar inte emot fler anrop.');
      return work();
    } catch (fel) {
      throw translateError(fel);
    }
  }

  return {
    async listDocuments(
      tenant: TenantContext,
      identity: Identity,
      collection: string,
      scope: CollectionScope,
      listOptions?: { readonly limit?: number; readonly cursor?: string },
    ) {
      return guarded(() => {
        const name = validateCollectionName(collection);
        const requestedScope = validateScope(scope);
        const userId = validateUserId(identity);
        const pageSize = validatePageSize(listOptions?.limit, DEFAULT_PAGE_SIZE, limits.maxPageSize);
        const cursor: unknown = listOptions?.cursor;
        const afterId =
          cursor === undefined ? undefined : decodeCursor(cursor, name, requestedScope);

        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) return EMPTY_PAGE;
        return listDocuments(handle, {
          collection: name,
          scope: requestedScope,
          userId,
          pageSize,
          afterId,
        });
      });
    },

    async createDocument(
      tenant: TenantContext,
      identity: Identity,
      collection: string,
      scope: CollectionScope,
      data: JsonObject,
    ) {
      return guarded(() => {
        const name = validateCollectionName(collection);
        const requestedScope = validateScope(scope);
        const userId = validateUserId(identity);
        const dataText = serializeDocumentData(data, limits.maxDocumentBytes);

        // Den enda operation som får skapa något på disk.
        const handle = handles.openOrCreate(tenantPaths(dataDir, tenant));
        return createDocument(handle, limits, {
          collection: name,
          scope: requestedScope,
          userId,
          dataText,
        });
      });
    },

    async getDocument(tenant: TenantContext, identity: Identity, collection: string, id: string) {
      return guarded(() => {
        const request = {
          collection: validateCollectionName(collection),
          id: validateDocumentId(id),
          userId: validateUserId(identity),
        };
        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) throw dataApiError('not_found', 'Dokumentet finns inte.');
        return getDocument(handle, request);
      });
    },

    async replaceDocument(
      tenant: TenantContext,
      identity: Identity,
      collection: string,
      id: string,
      data: JsonObject,
    ) {
      return guarded(() => {
        const request = {
          collection: validateCollectionName(collection),
          id: validateDocumentId(id),
          userId: validateUserId(identity),
        };
        const dataText = serializeDocumentData(data, limits.maxDocumentBytes);
        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) throw dataApiError('not_found', 'Dokumentet finns inte.');
        return replaceDocument(handle, request, dataText);
      });
    },

    async deleteDocument(tenant: TenantContext, identity: Identity, collection: string, id: string) {
      return guarded(() => {
        const request = {
          collection: validateCollectionName(collection),
          id: validateDocumentId(id),
          userId: validateUserId(identity),
        };
        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) throw dataApiError('not_found', 'Dokumentet finns inte.');
        deleteDocument(handle, request);
      });
    },

    async destroyTenant(tenant: TenantContext) {
      return guarded(() => {
        handles.destroy(tenantPaths(dataDir, tenant));
      });
    },

    async close() {
      // Idempotent: nedstängning ska kunna anropas från flera håll utan att något kastar.
      closed = true;
      handles.closeAll();
    },
  };
}
