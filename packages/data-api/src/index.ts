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
  exportDocuments,
  listDocuments,
  replaceDocument,
} from './dokument.ts';
import { dataApiError, translateError } from './fel.ts';
import { createHandleCache } from './handtag.ts';
import {
  EMPTY_HISTORY,
  createWithHistory,
  decodeHistoryCursor,
  deleteWithHistory,
  parseRetentionDays,
  readCollectionHistory,
  readDocumentHistory,
  replaceWithHistory,
  restoreWithHistory,
  validateIsoTime,
  type HistorySettings,
} from './historik.ts';
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
  /**
   * Ändringshistorik (tjänsten `history`). Saknas valet är historiken AV: inga historikmetoder,
   * ingen historiktabell, och allt beter sig exakt som förut. Se historik.ts.
   */
  readonly history?: {
    /** Dagar historiken sparas. Heltal, eller texten ur `SVC_HISTORY_RETENTION_DAYS`. Standard 365. */
    readonly retentionDays?: number | string | undefined;
  };
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

  const history: HistorySettings | undefined =
    options.history === undefined ? undefined : { retentionDays: parseRetentionDays(options.history.retentionDays) };

  const handles = createHandleCache(limits, maxOpenDatabases, { history: history !== undefined });
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

  const store: TenantStore = {
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
        const request = { collection: name, scope: requestedScope, userId, dataText };
        return history === undefined
          ? createDocument(handle, limits, request)
          : createWithHistory(handle, limits, history, request);
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
        return history === undefined
          ? replaceDocument(handle, request, dataText)
          : replaceWithHistory(handle, history, request, dataText);
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
        if (history === undefined) deleteDocument(handle, request);
        else deleteWithHistory(handle, history, request);
      });
    },

    async exportTenant(tenant: TenantContext, identity: Identity, exportOptions: { readonly maxDocumentsPerCollection: number }) {
      return guarded(() => {
        const userId = validateUserId(identity);
        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) return { collections: {}, documentCount: 0 };
        return exportDocuments(handle, { userId, maxDocumentsPerCollection: exportOptions.maxDocumentsPerCollection });
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

  if (history === undefined) return store;
  const settings = history;

  // Historikmetoderna läggs bara till när historiken är påslagen; tjänsten `history` vägrar
  // starta mot en lagring som saknar dem.
  return {
    ...store,

    async readDocumentHistory(tenant, identity, collection, id, listOptions) {
      return guarded(() => {
        const name = validateCollectionName(collection);
        const documentId = validateDocumentId(id);
        const userId = validateUserId(identity);
        const pageSize = validatePageSize(listOptions?.limit, DEFAULT_PAGE_SIZE, limits.maxPageSize);
        const cursor: unknown = listOptions?.cursor;
        const beforeSeq = cursor === undefined ? undefined : decodeHistoryCursor(cursor, 'd', name, documentId);

        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) throw dataApiError('not_found', 'Dokumentet finns inte.');
        return readDocumentHistory(handle, settings, { collection: name, id: documentId, userId, pageSize, beforeSeq });
      });
    },

    async readCollectionHistory(tenant, identity, collection, listOptions) {
      return guarded(() => {
        const name = validateCollectionName(collection);
        const userId = validateUserId(identity);
        const pageSize = validatePageSize(listOptions?.limit, DEFAULT_PAGE_SIZE, limits.maxPageSize);
        const since: unknown = listOptions?.since;
        const validSince = since === undefined ? undefined : validateIsoTime(since);
        const cursor: unknown = listOptions?.cursor;
        const beforeSeq = cursor === undefined ? undefined : decodeHistoryCursor(cursor, 'c', name, '-');

        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) return EMPTY_HISTORY;
        return readCollectionHistory(handle, settings, { collection: name, userId, pageSize, beforeSeq, since: validSince });
      });
    },

    async restoreDocument(tenant, identity, collection, id, at) {
      return guarded(() => {
        const request = {
          collection: validateCollectionName(collection),
          id: validateDocumentId(id),
          userId: validateUserId(identity),
        };
        const time = validateIsoTime(at);
        const handle = handles.openExisting(tenantPaths(dataDir, tenant));
        if (handle === null) throw dataApiError('not_found', 'Dokumentet finns inte.');
        return restoreWithHistory(handle, settings, request, time);
      });
    },
  };
}
