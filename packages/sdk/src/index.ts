/**
 * @vibesandbox/sdk — så lagrar en app sin data.
 *
 *   import { db, whoami } from '@vibesandbox/sdk';
 *
 *   const bokningar = db.collection<Bokning>('bokningar');   // gemensam: alla i appen ser allt
 *   const mina = db.collection<Anteckning>('anteckningar', { personal: true }); // var och en ser bara sitt
 *
 *   const ny = await bokningar.add({ rum: 'Stora salen' });  // → { id, data, createdAt, updatedAt }
 *   const alla = await bokningar.list();                      // → Doc<Bokning>[]
 *   await bokningar.update(ny.id, { rum: 'Lilla salen' });    // ERSÄTTER hela dokumentet
 *   await bokningar.remove(ny.id);
 *   const jag = await whoami();                               // → { userId, displayName }
 *
 * Appen anger aldrig vilken app den är eller någon adress — det sköter plattformen.
 */
import type { CollectionScope, JsonObject, WhoAmIResponse } from '@vibesandbox/contracts';
import type { StorageAdapter } from './adapter.ts';
import { createPlatformAdapter } from './platform-adapter.ts';
import { assertCollectionName, assertDocumentId, toJsonObject } from './validation.ts';

export { SdkError } from './errors.ts';
export type { SdkErrorCode } from './errors.ts';
export type { StorageAdapter } from './adapter.ts';
export { createPlatformAdapter } from './platform-adapter.ts';
export type { FetchLike } from './platform-adapter.ts';
export { createMemoryAdapter } from './memory-adapter.ts';
export type { MemoryAdapter } from './memory-adapter.ts';
export type { WhoAmIResponse } from '@vibesandbox/contracts';

/** Ett sparat dokument. `data` är det appen sparade; resten sätts av plattformen. */
export interface Doc<T> {
  readonly id: string;
  readonly data: T;
  /** ISO 8601, t.ex. "2026-09-18T09:30:00.000Z". */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Collection<T> {
  /** Sparar ett nytt dokument och ger tillbaka det med sitt nya `id`. */
  add(data: T): Promise<Doc<T>>;
  /**
   * Alla dokument i kollektionen (i en personlig kollektion: bara användarens egna).
   * Hämtar högst LIST_MAX_DOCUMENTS stycken. Sortera själv om ordningen spelar roll.
   */
  list(): Promise<Doc<T>[]>;
  /** Ett dokument. Kastar SdkError med code 'not_found' om det inte finns. */
  get(id: string): Promise<Doc<T>>;
  /**
   * ERSÄTTER hela dokumentet med `data`. Fält som inte skickas med försvinner.
   * Ändra ett fält så här: `update(doc.id, { ...doc.data, rum: 'Lilla salen' })`.
   */
  update(id: string, data: T): Promise<Doc<T>>;
  /** Tar bort dokumentet. Kastar SdkError med code 'not_found' om det inte finns. */
  remove(id: string): Promise<void>;
}

export interface CollectionOptions {
  /**
   * `true`: personlig — varje användare ser och ändrar bara sina egna dokument (plattformen
   * ser till det). Utelämnad eller `false`: gemensam — alla som får öppna appen ser allt.
   * Valet görs första gången kollektionen används och kan sedan inte ändras.
   */
  readonly personal?: boolean;
}

/** Så många dokument hämtar `list()` som mest. Skyddar webbläsaren mot en kollektion som vuxit okontrollerat. */
export const LIST_MAX_DOCUMENTS = 1000;
const PAGE_SIZE = 100;

// Skapas direkt men rör inte nätverket förrän första anropet, så importen är alltid ofarlig.
let currentAdapter: StorageAdapter = createPlatformAdapter();

/**
 * Byter var data lagras. Standard är plattformen. Behövs bara i tester, vid lokal utveckling
 * och i en fristående export: `configure({ adapter: createMemoryAdapter() })`.
 */
export function configure(options: { readonly adapter: StorageAdapter }): void {
  currentAdapter = options.adapter;
}

/** Vem som är inloggad. `displayName` går att visa; `userId` är ett stabilt, ogenomskinligt id. */
export function whoami(): Promise<WhoAmIResponse> {
  return currentAdapter.whoami();
}

export const db = {
  /**
   * En namngiven samling dokument. `name`: små bokstäver a–z, siffror, `-` och `_`, börjar
   * med en bokstav, högst 64 tecken. Kastar SdkError direkt om namnet är ogiltigt.
   * `T` är formen på det appen sparar — ett objekt med JSON-värden.
   */
  collection<T extends object = JsonObject>(name: string, options: CollectionOptions = {}): Collection<T> {
    assertCollectionName(name);
    const scope: CollectionScope = options.personal === true ? 'user' : 'app';
    // Adaptern slås upp vid varje anrop: kollektioner skapas ofta överst i en modul, före configure().
    // Omtolkningen till Doc<T> är appens eget löfte om vad den har sparat; SDK:t kontrollerar bara att det är JSON.
    return {
      async add(data) {
        const json = toJsonObject(data);
        return (await currentAdapter.create(name, scope, json)) as Doc<T>;
      },

      async list() {
        const documents: Doc<T>[] = [];
        let cursor: string | undefined;
        // Taket gäller både antal dokument och antal sidor, så att inte ens tomma sidor med
        // markör kan hålla webbläsaren sysselsatt för evigt.
        for (let page = 0; page < LIST_MAX_DOCUMENTS / PAGE_SIZE; page += 1) {
          const result = await currentAdapter.list(name, scope, {
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          documents.push(...(result.documents as readonly Doc<T>[]));
          cursor = result.nextCursor;
          if (cursor === undefined || documents.length >= LIST_MAX_DOCUMENTS) break;
        }
        return documents.slice(0, LIST_MAX_DOCUMENTS);
      },

      async get(id) {
        assertDocumentId(id);
        return (await currentAdapter.get(name, id)) as Doc<T>;
      },

      async update(id, data) {
        assertDocumentId(id);
        const json = toJsonObject(data);
        return (await currentAdapter.replace(name, id, json)) as Doc<T>;
      },

      async remove(id) {
        assertDocumentId(id);
        await currentAdapter.remove(name, id);
      },
    };
  },
};

// Plattformstjänster (`/_api/<namn>`). Varje modul är en tjänst; en avslagen tjänst svarar 404.
export * as files from './tjanster/files.ts';
export * as notify from './tjanster/notify.ts';
export * as roles from './tjanster/roles.ts';
export * as llm from './tjanster/llm.ts';
export * as extract from './tjanster/extract.ts';
export * as ocr from './tjanster/ocr.ts';
export * as history from './tjanster/history.ts';
export * as schedule from './tjanster/schedule.ts';
export * as transcribe from './tjanster/transcribe.ts';
export * as search from './tjanster/search.ts';
