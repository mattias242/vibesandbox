/**
 * Tjänstens egen databas (`<dataDir>/extract.sqlite`): den text som redan hämtats, och hur många
 * anrop som förbrukats.
 *
 * Databasarbetet är synkront (`node:sqlite`), och det utnyttjas: kontrollen av kvoten och
 * reservationen av anropet sker utan något `await` emellan, så två samtidiga anrop kan inte båda
 * se att det finns ett anrop kvar och sedan använda det.
 *
 * - Cachen nycklas på app, utkast/publicerad, fil-id OCH filens SHA-256: samma fil-id med nytt
 *   innehåll läses på nytt, en app ser aldrig en annan apps text, och utkastet delar inte text
 *   med den publicerade appen.
 * - Förbrukningen räknas per APP (utkast och publicerad tillsammans — annars vore gränsen lätt
 *   att dubbla) och per användare. Den är ingen data som appen ser, bara plattformens räkning.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Hur länge en hämtad text sparas. Filen finns kvar hos `files`; en ny läsning kostar bara tid. */
const CACHE_TTL_MS = 30 * DAY_MS;

export interface CacheKey {
  readonly appId: string;
  readonly kind: string;
  readonly fileId: string;
  readonly sha256: string;
}

export interface CachedResult {
  readonly text: string;
  readonly kind: string;
  readonly truncated: boolean;
  readonly pages?: number;
  readonly hasText: boolean;
}

export interface Limits {
  readonly callsPerAppDay: number;
  readonly callsPerUserHour: number;
}

export type ReserveResult = { readonly ok: true; readonly reservation: number } | { readonly ok: false; readonly limit: 'app_day' | 'user_hour' };

export interface ExtractStore {
  getCached(key: CacheKey, nowMs: number): CachedResult | undefined;
  putCached(key: CacheKey, result: CachedResult, nowMs: number): void;
  /** Reserverar ett anrop om båda gränserna tillåter det. */
  reserve(appId: string, userId: string, limits: Limits, nowMs: number): ReserveResult;
  /** Ett misslyckat anrop kostar ingen kvot. */
  release(reservation: number): void;
  close(): void;
}

export function openStore(dataDir: string): ExtractStore {
  const db = new DatabaseSync(join(dataDir, 'extract.sqlite'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        app_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, kind, file_id, sha256)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY,
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_app ON usage (app_id, at);
      CREATE INDEX IF NOT EXISTS usage_user ON usage (app_id, user_id, at);
      CREATE INDEX IF NOT EXISTS cache_age ON cache (created_at);
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const getCached = db.prepare('SELECT result FROM cache WHERE app_id = ? AND kind = ? AND file_id = ? AND sha256 = ? AND created_at > ?');
  const putCached = db.prepare('INSERT OR REPLACE INTO cache (app_id, kind, file_id, sha256, result, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const pruneCache = db.prepare('DELETE FROM cache WHERE created_at <= ?');
  const appCalls = db.prepare('SELECT COUNT(*) AS antal FROM usage WHERE app_id = ? AND at > ?');
  const userCalls = db.prepare('SELECT COUNT(*) AS antal FROM usage WHERE app_id = ? AND user_id = ? AND at > ?');
  const insertUsage = db.prepare('INSERT INTO usage (app_id, user_id, at) VALUES (?, ?, ?)');
  const pruneUsage = db.prepare('DELETE FROM usage WHERE at <= ?');
  const release = db.prepare('DELETE FROM usage WHERE id = ?');

  return {
    getCached(key, nowMs) {
      const row = getCached.get(key.appId, key.kind, key.fileId, key.sha256, nowMs - CACHE_TTL_MS) as { result: string } | undefined;
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.result) as CachedResult;
      } catch {
        return undefined;
      }
    },
    putCached(key, result, nowMs) {
      pruneCache.run(nowMs - CACHE_TTL_MS);
      putCached.run(key.appId, key.kind, key.fileId, key.sha256, JSON.stringify(result), nowMs);
    },
    reserve(appId, userId, limits, nowMs) {
      pruneUsage.run(nowMs - DAY_MS);
      const byApp = Number((appCalls.get(appId, nowMs - DAY_MS) as { antal: number }).antal);
      if (byApp + 1 > limits.callsPerAppDay) return { ok: false, limit: 'app_day' };
      const byUser = Number((userCalls.get(appId, userId, nowMs - HOUR_MS) as { antal: number }).antal);
      if (byUser + 1 > limits.callsPerUserHour) return { ok: false, limit: 'user_hour' };
      const { lastInsertRowid } = insertUsage.run(appId, userId, nowMs);
      return { ok: true, reservation: Number(lastInsertRowid) };
    },
    release(reservation) {
      release.run(reservation);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
