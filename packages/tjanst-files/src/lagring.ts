/**
 * Filernas lagring i tjänstens katalog:
 *
 *   files.sqlite       metadata (STRICT), nycklad på app-id + hyresgästsort
 *   blobs/<nyckel>     innehållet; nyckeln är 32 slumpade hex-tecken, skapad här
 *   tmp/<nyckel>.tmp   under skrivning; flyttas atomiskt till blobs/ när den är hel
 *
 * Inget namn på disk kommer någonsin från indata. Fil-id:t appen ser och nyckeln på disk är
 * dessutom olika slumpvärden, så att det ena inte avslöjar det andra.
 *
 * Databasarbetet är synkront (`node:sqlite`). Det utnyttjas: kvotkontrollen och raden den skyddar
 * skrivs utan `await` emellan, så två samtidiga uppladdningar kan inte båda rymmas i samma utrymme.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppId, TenantContext, TenantKind } from '@vibesandbox/contracts';

export type FileScope = 'app' | 'user';

export interface StoredFile {
  readonly id: string;
  readonly appId: AppId;
  readonly kind: TenantKind;
  readonly scope: FileScope;
  readonly uploadedBy: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly storageKey: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;
const DATABASE_FILE = 'files.sqlite';
const BUSY_TIMEOUT_MS = 5000;
/** Så många filer ger en listning som mest (nyaste först). */
export const MAX_LISTED_FILES = 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
    scope TEXT NOT NULL CHECK (scope IN ('app', 'user')),
    uploaded_by TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0),
    storage_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS files_by_tenant ON files (app_id, kind, created_at);
`;

export function newRandomId(): string {
  return randomBytes(16).toString('hex');
}

function toStoredFile(row: Record<string, unknown>): StoredFile {
  return {
    id: String(row['id']),
    appId: String(row['app_id']) as AppId,
    kind: row['kind'] === 'draft' ? 'draft' : 'published',
    scope: row['scope'] === 'user' ? 'user' : 'app',
    uploadedBy: String(row['uploaded_by']),
    name: String(row['name']),
    contentType: String(row['content_type']),
    size: Number(row['size']),
    storageKey: String(row['storage_key']),
    sha256: String(row['sha256']),
    createdAt: String(row['created_at']),
  };
}

export interface FileStore {
  usedBytes(tenant: TenantContext): number;
  /** Sparar raden om den ryms i kvoten. Kontroll och skrivning i ett synkront svep. */
  insertWithinQuota(file: StoredFile, quotaBytes: number): 'ok' | 'quota';
  /** En fil i hyresgästen, oavsett synlighet — anroparen avgör vem som får se den. */
  find(tenant: TenantContext, id: string): StoredFile | undefined;
  /** Gemensamma filer och `userId`:s personliga, nyaste först. */
  list(tenant: TenantContext, userId: string): StoredFile[];
  remove(tenant: TenantContext, id: string): StoredFile | undefined;
  /** Skriver innehållet atomiskt (tmp + rename) och ger dess nyckel. */
  writeContent(bytes: Uint8Array): Promise<string>;
  readContent(storageKey: string): Promise<Uint8Array>;
  deleteContent(storageKey: string): Promise<void>;
  close(): void;
}

export function openFileStore(dataDir: string): FileStore {
  const blobs = join(dataDir, 'blobs');
  const tmp = join(dataDir, 'tmp');
  // 0o700/0o600: användarnas filer ska inte gå att läsa för andra konton på servern.
  for (const dir of [dataDir, blobs, tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const usedStatement = db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE app_id = ? AND kind = ?');
  const insertStatement = db.prepare(
    `INSERT INTO files (id, app_id, kind, scope, uploaded_by, name, content_type, size, storage_key, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findStatement = db.prepare('SELECT * FROM files WHERE id = ? AND app_id = ? AND kind = ?');
  const listStatement = db.prepare(
    `SELECT * FROM files WHERE app_id = ? AND kind = ? AND (scope = 'app' OR uploaded_by = ?)
     ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LISTED_FILES}`,
  );
  const deleteStatement = db.prepare('DELETE FROM files WHERE id = ? AND app_id = ? AND kind = ?');

  const usedBytesFor = (appId: AppId, kind: TenantKind): number =>
    Number((usedStatement.get(appId, kind) as { used: number | bigint }).used);

  // Städning efter en krasch: halvskrivna filer, och innehåll vars rad aldrig skrevs (eller togs bort).
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const known = new Set((db.prepare('SELECT storage_key FROM files').all() as { storage_key: string }[]).map((r) => r.storage_key));
  for (const entry of readdirSync(blobs)) {
    if (!known.has(entry)) rmSync(join(blobs, entry), { recursive: true, force: true });
  }

  return {
    usedBytes: (tenant) => usedBytesFor(tenant.appId, tenant.kind),

    insertWithinQuota(file, quotaBytes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (usedBytesFor(file.appId, file.kind) + file.size > quotaBytes) {
          db.exec('ROLLBACK');
          return 'quota';
        }
        insertStatement.run(
          file.id,
          file.appId,
          file.kind,
          file.scope,
          file.uploadedBy,
          file.name,
          file.contentType,
          file.size,
          file.storageKey,
          file.sha256,
          file.createdAt,
        );
        db.exec('COMMIT');
        return 'ok';
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    find(tenant, id) {
      if (!FILE_ID_PATTERN.test(id)) return undefined;
      const row = findStatement.get(id, tenant.appId, tenant.kind);
      return row === undefined ? undefined : toStoredFile(row);
    },

    list(tenant, userId) {
      return listStatement.all(tenant.appId, tenant.kind, userId).map(toStoredFile);
    },

    remove(tenant, id) {
      const file = this.find(tenant, id);
      if (file === undefined) return undefined;
      deleteStatement.run(id, tenant.appId, tenant.kind);
      return file;
    },

    async writeContent(bytes) {
      const key = newRandomId();
      const temporary = join(tmp, `${key}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(temporary, { force: true });
        throw error;
      }
      await handle.close();
      await rename(temporary, join(blobs, key));
      return key;
    },

    async readContent(storageKey) {
      if (!FILE_ID_PATTERN.test(storageKey)) throw new Error('Ogiltig lagringsnyckel.');
      return new Uint8Array(await readFile(join(blobs, storageKey)));
    },

    async deleteContent(storageKey) {
      if (!FILE_ID_PATTERN.test(storageKey)) return;
      await rm(join(blobs, storageKey), { force: true });
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}
