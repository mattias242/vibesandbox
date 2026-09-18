import { DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import type { CollectionScope, JsonObject, StoredDocument, WhoAmIResponse } from '@vibesandbox/contracts';
import type { StorageAdapter } from './adapter.ts';
import { SdkError } from './errors.ts';
import { assertCollectionName, toJsonObject } from './validation.ts';

export interface MemoryAdapter extends StorageAdapter {
  /** En adapter som agerar som en annan användare mot SAMMA data. För tester av personliga kollektioner. */
  asUser(user: WhoAmIResponse): MemoryAdapter;
}

interface Entry {
  /** Stigande löpnummer; markören vid sidindelning. Tål att dokument tas bort mellan sidor. */
  readonly seq: number;
  readonly owner: string;
  doc: StoredDocument;
}

interface CollectionState {
  readonly scope: CollectionScope;
  /** En Map behåller insättningsordningen, så listor kommer i den ordning dokumenten skapades. */
  readonly entries: Map<string, Entry>;
}

interface Store {
  readonly collections: Map<string, CollectionState>;
  nextSeq: number;
}

const DEFAULT_USER: WhoAmIResponse = { userId: 'lokal-anvandare', displayName: 'Lokal användare' };

/**
 * Lagrar allt i minnet, med samma regler som plattformen: gemensamt/personligt, låst
 * synlighet, sidindelning och storleksgräns. Används i tester och vid `npm run dev`, och är
 * grunden för den fristående adaptern. Inget sparas när sidan laddas om.
 */
export function createMemoryAdapter(options: { readonly user?: WhoAmIResponse } = {}): MemoryAdapter {
  return createView({ collections: new Map(), nextSeq: 1 }, options.user ?? DEFAULT_USER);
}

function createView(store: Store, user: WhoAmIResponse): MemoryAdapter {
  /** Dokumentet, men bara om den här användaren får se det. Annars "finns inte" — aldrig "förbjudet". */
  function findEntry(collection: string, id: string): { state: CollectionState; entry: Entry } {
    assertCollectionName(collection);
    const state = store.collections.get(collection);
    const entry = state?.entries.get(id);
    if (state === undefined || entry === undefined || !isVisible(state, entry)) {
      throw new SdkError('not_found');
    }
    return { state, entry };
  }

  function isVisible(state: CollectionState, entry: Entry): boolean {
    return state.scope === 'app' || entry.owner === user.userId;
  }

  function assertScope(state: CollectionState | undefined, scope: CollectionScope): void {
    if (state !== undefined && state.scope !== scope) throw new SdkError('scope_mismatch');
  }

  return {
    asUser: (other) => createView(store, other),

    async whoami() {
      return { ...user };
    },

    async list(collection, scope, options = {}) {
      assertCollectionName(collection);
      const state = store.collections.get(collection);
      assertScope(state, scope);

      const after = options.cursor === undefined ? 0 : Number(options.cursor);
      if (!Number.isSafeInteger(after) || after < 0) throw new SdkError('invalid_request');
      const limit = clampLimit(options.limit);

      const visible = [...(state?.entries.values() ?? [])].filter(
        (entry) => entry.seq > after && state !== undefined && isVisible(state, entry),
      );
      const page = visible.slice(0, limit);
      const last = page.at(-1);
      return {
        documents: page.map((entry) => structuredClone(entry.doc)),
        ...(visible.length > page.length && last !== undefined ? { nextCursor: String(last.seq) } : {}),
      };
    },

    async create(collection, scope, data) {
      assertCollectionName(collection);
      let state = store.collections.get(collection);
      assertScope(state, scope);
      const stored = prepare(data);

      if (state === undefined) {
        // Synligheten låses här, vid första skrivningen, och ändras aldrig därefter.
        state = { scope, entries: new Map() };
        store.collections.set(collection, state);
      }
      const now = new Date().toISOString();
      const doc: StoredDocument = { id: createDocumentId(), data: stored, createdAt: now, updatedAt: now };
      state.entries.set(doc.id, { seq: store.nextSeq, owner: user.userId, doc });
      store.nextSeq += 1;
      return structuredClone(doc);
    },

    async get(collection, id) {
      // Kopior ut, precis som kopior in: anroparen ska aldrig kunna ändra lagret genom ett svar.
      return structuredClone(findEntry(collection, id).entry.doc);
    },

    async replace(collection, id, data) {
      const { entry } = findEntry(collection, id);
      entry.doc = { ...entry.doc, data: prepare(data), updatedAt: new Date().toISOString() };
      return structuredClone(entry.doc);
    },

    async remove(collection, id) {
      const { state } = findEntry(collection, id);
      state.entries.delete(id);
    },
  };
}

function prepare(data: JsonObject): JsonObject {
  const copy = toJsonObject(data);
  const bytes = new TextEncoder().encode(JSON.stringify(copy)).length;
  if (bytes > DEFAULT_TENANT_LIMITS.maxDocumentBytes) throw new SdkError('too_large');
  return copy;
}

function clampLimit(limit: number | undefined): number {
  const max = DEFAULT_TENANT_LIMITS.maxPageSize;
  if (limit === undefined) return max;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new SdkError('invalid_request');
  return Math.min(limit, max);
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Samma form som plattformens id:n (26 tecken Crockford-base32), så att DOCUMENT_ID_PATTERN gäller överallt. */
function createDocumentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  // 32 tecken i alfabetet ⇒ de fem lägsta bitarna ger en jämn fördelning.
  return Array.from(bytes, (byte) => ID_ALPHABET[byte & 31]).join('');
}
