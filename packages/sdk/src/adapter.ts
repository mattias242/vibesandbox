import type {
  CollectionScope,
  DocumentPage,
  JsonObject,
  StoredDocument,
  WhoAmIResponse,
} from '@vibesandbox/contracts';

/**
 * Var data faktiskt lagras. Appkod använder `db` och `whoami` — aldrig adaptern direkt.
 * Gränssnittet följer plattformens HTTP-gränssnitt ett till ett, så att en fristående
 * export kan byta lagring utan att appens kod ändras.
 *
 * Alla fel kastas som `SdkError`.
 */
export interface StorageAdapter {
  whoami(): Promise<WhoAmIResponse>;
  list(
    collection: string,
    scope: CollectionScope,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<DocumentPage>;
  create(collection: string, scope: CollectionScope, data: JsonObject): Promise<StoredDocument>;
  get(collection: string, id: string): Promise<StoredDocument>;
  /** Ersätter HELA dokumentet. */
  replace(collection: string, id: string, data: JsonObject): Promise<StoredDocument>;
  remove(collection: string, id: string): Promise<void>;
}
