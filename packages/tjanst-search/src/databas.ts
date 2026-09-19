/**
 * Sökindexet: `<dataDir>/search.sqlite` (node:sqlite, STRICT-tabeller).
 *
 * En rad per inbäddat dokument, nycklad på app-id + sort (utkast/publicerad) + kollektion + ägare
 * + dokument-id. Ägaren är `app` för en gemensam kollektion och `user:<användar-id>` för en
 * personlig: en persons vektorer ligger i ett eget index som bara läses i hens egna sökningar.
 *
 * `fingerprint` är en SHA-256 över modell och exakt den (maskade) text som bäddades in. Ändras
 * dokumentet, valda fält eller modellen blir avtrycket ett annat och dokumentet bäddas in igen.
 * Själva texten sparas aldrig här.
 *
 * Databasarbetet är synkront — en kontroll och den skrivning den skyddar görs utan `await` emellan.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

const DATABASE_FILE = 'search.sqlite';
const BUSY_TIMEOUT_MS = 5000;
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE vectors (
  app_id      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
  collection  TEXT NOT NULL,
  owner       TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  vector      BLOB NOT NULL,
  PRIMARY KEY (app_id, kind, collection, owner, doc_id)
) STRICT;

CREATE TABLE usage (
  app_id TEXT NOT NULL,
  day    TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK (tokens >= 0),
  PRIMARY KEY (app_id, day)
) STRICT;
`;

/** Vilket index en sökning gäller. Allt kommer från gatewayn eller är redan validerat. */
export interface IndexKey {
  readonly appId: string;
  readonly kind: string;
  readonly collection: string;
  readonly owner: string;
}

export interface SearchDatabase {
  /** doc-id → avtryck för det som finns i indexet. */
  fingerprints(key: IndexKey): Map<string, string>;
  /** Tar bort vektorer för dokument som inte längre finns (eller inte längre har någon text). */
  removeExcept(key: IndexKey, keep: ReadonlySet<string>): number;
  upsert(key: IndexKey, rows: readonly { readonly docId: string; readonly fingerprint: string; readonly vector: Float32Array }[]): void;
  /** Alla vektorer i indexet, en i taget — hela indexet hålls aldrig i minnet samtidigt. */
  vectors(key: IndexKey): IterableIterator<{ readonly docId: string; readonly fingerprint: string; readonly vector: Float32Array }>;
  vectorCount(appId: string): number;
  tokensUsed(appId: string, day: string): number;
  addTokens(appId: string, day: string, tokens: number): void;
  close(): void;
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // Kopia: en Float32Array kräver att början ligger jämnt på fyra byte, vilket SQLite inte lovar.
  return new Float32Array(new Uint8Array(blob).buffer);
}

export function openSearchDatabase(dataDir: string): SearchDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version === 0) {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`Sökindexet har en okänd schemaversion (${String(version)}). Uppgradera plattformen.`);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  const keyParams = (key: IndexKey) => ({ app: key.appId, kind: key.kind, collection: key.collection, owner: key.owner });
  const WHERE_KEY = 'app_id = :app AND kind = :kind AND collection = :collection AND owner = :owner';

  const transaction = (work: () => void): void => {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    fingerprints(key) {
      const rows = statement(`SELECT doc_id, fingerprint FROM vectors WHERE ${WHERE_KEY}`).all(keyParams(key));
      return new Map(rows.map((row) => [String(row['doc_id']), String(row['fingerprint'])]));
    },

    removeExcept(key, keep) {
      const existing = statement(`SELECT doc_id FROM vectors WHERE ${WHERE_KEY}`).all(keyParams(key)).map((row) => String(row['doc_id']));
      const gone = existing.filter((id) => !keep.has(id));
      if (gone.length === 0) return 0;
      transaction(() => {
        const remove = statement(`DELETE FROM vectors WHERE ${WHERE_KEY} AND doc_id = :doc`);
        for (const doc of gone) remove.run({ ...keyParams(key), doc });
      });
      return gone.length;
    },

    upsert(key, rows) {
      if (rows.length === 0) return;
      transaction(() => {
        const insert = statement(
          `INSERT INTO vectors (app_id, kind, collection, owner, doc_id, fingerprint, vector)
           VALUES (:app, :kind, :collection, :owner, :doc, :fingerprint, :vector)
           ON CONFLICT (app_id, kind, collection, owner, doc_id)
           DO UPDATE SET fingerprint = excluded.fingerprint, vector = excluded.vector`,
        );
        for (const row of rows) insert.run({ ...keyParams(key), doc: row.docId, fingerprint: row.fingerprint, vector: toBlob(row.vector) });
      });
    },

    *vectors(key) {
      for (const row of statement(`SELECT doc_id, fingerprint, vector FROM vectors WHERE ${WHERE_KEY}`).iterate(keyParams(key))) {
        const blob = row['vector'];
        if (!(blob instanceof Uint8Array)) continue;
        yield { docId: String(row['doc_id']), fingerprint: String(row['fingerprint']), vector: fromBlob(blob) };
      }
    },

    vectorCount(appId) {
      const row = statement('SELECT COUNT(*) AS n FROM vectors WHERE app_id = :app').get({ app: appId });
      return Number(row?.['n'] ?? 0);
    },

    tokensUsed(appId, day) {
      const row = statement('SELECT tokens FROM usage WHERE app_id = :app AND day = :day').get({ app: appId, day });
      return Number(row?.['tokens'] ?? 0);
    },

    addTokens(appId, day, tokens) {
      transaction(() => {
        // Gamla dygn behövs inte; de städas när appen ändå skriver.
        statement('DELETE FROM usage WHERE app_id = :app AND day <> :day').run({ app: appId, day });
        statement(
          `INSERT INTO usage (app_id, day, tokens) VALUES (:app, :day, :tokens)
           ON CONFLICT (app_id, day) DO UPDATE SET tokens = tokens + excluded.tokens`,
        ).run({ app: appId, day, tokens: Math.max(0, Math.ceil(tokens)) });
      });
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}
