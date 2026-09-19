/**
 * Tjänstens egen databas (`<dataDir>/ocr.sqlite`): cachade resultat och förbrukade sidor.
 *
 * Databasarbetet är synkront (`node:sqlite`), och det utnyttjas: kontrollen av kvoten och
 * reservationen av sidorna sker utan något `await` emellan, så två samtidiga anrop kan inte båda
 * se att det finns en sida kvar och sedan använda den.
 *
 * - Cachen nycklas på app, utkast/publicerad, fil-id, språk OCH filens SHA-256: samma fil-id med
 *   nytt innehåll läses på nytt, och en app ser aldrig en annan apps (eller sitt utkasts) text.
 * - Förbrukningen räknas per APP (utkast och publicerad tillsammans — annars vore gränsen lätt att
 *   dubbla) och per användare. Den är ingen data som appen ser, bara plattformens räkning.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Hur länge ett resultat sparas. Filen finns kvar hos `files`; en ny läsning kostar bara pengar. */
const CACHE_TTL_MS = 30 * DAY_MS;

export interface CacheKey {
  readonly appId: string;
  readonly kind: string;
  readonly fileId: string;
  readonly language: string;
  readonly sha256: string;
}

export interface CachedResult {
  readonly text: string;
  readonly pages?: readonly { readonly number: number; readonly text: string }[];
}

export interface Limits {
  readonly pagesPerAppDay: number;
  readonly pagesPerUserHour: number;
}

export type ReserveResult = { readonly ok: true; readonly reservation: number } | { readonly ok: false; readonly limit: 'app_day' | 'user_hour' };

export interface OcrStore {
  getCached(key: CacheKey, nowMs: number): CachedResult | undefined;
  putCached(key: CacheKey, result: CachedResult, nowMs: number): void;
  /** Reserverar `pages` sidor om båda gränserna tillåter det. */
  reserve(appId: string, userId: string, pages: number, limits: Limits, nowMs: number): ReserveResult;
  /** Sätter det faktiska antalet sidor på en reservation. */
  settle(reservation: number, pages: number): void;
  /** Ett misslyckat anrop kostar ingen kvot. */
  release(reservation: number): void;
  close(): void;
}

export function openStore(dataDir: string): OcrStore {
  const db = new DatabaseSync(join(dataDir, 'ocr.sqlite'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        app_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_id TEXT NOT NULL,
        language TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, kind, file_id, language, sha256)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY,
        app_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        pages INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_app ON usage (app_id, at);
      CREATE INDEX IF NOT EXISTS usage_user ON usage (app_id, user_id, at);
      CREATE INDEX IF NOT EXISTS cache_age ON cache (created_at);
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const getCached = db.prepare(
    'SELECT result FROM cache WHERE app_id = ? AND kind = ? AND file_id = ? AND language = ? AND sha256 = ? AND created_at > ?',
  );
  const putCached = db.prepare(
    'INSERT OR REPLACE INTO cache (app_id, kind, file_id, language, sha256, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const pruneCache = db.prepare('DELETE FROM cache WHERE created_at <= ?');
  const appPages = db.prepare('SELECT COALESCE(SUM(pages), 0) AS pages FROM usage WHERE app_id = ? AND at > ?');
  const userPages = db.prepare('SELECT COALESCE(SUM(pages), 0) AS pages FROM usage WHERE app_id = ? AND user_id = ? AND at > ?');
  const insertUsage = db.prepare('INSERT INTO usage (app_id, user_id, at, pages) VALUES (?, ?, ?, ?)');
  const pruneUsage = db.prepare('DELETE FROM usage WHERE at <= ?');
  const settle = db.prepare('UPDATE usage SET pages = ? WHERE id = ?');
  const release = db.prepare('DELETE FROM usage WHERE id = ?');

  return {
    getCached(key, nowMs) {
      const row = getCached.get(key.appId, key.kind, key.fileId, key.language, key.sha256, nowMs - CACHE_TTL_MS) as { result: string } | undefined;
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.result) as CachedResult;
      } catch {
        return undefined;
      }
    },
    putCached(key, result, nowMs) {
      pruneCache.run(nowMs - CACHE_TTL_MS);
      putCached.run(key.appId, key.kind, key.fileId, key.language, key.sha256, JSON.stringify(result), nowMs);
    },
    reserve(appId, userId, pages, limits, nowMs) {
      pruneUsage.run(nowMs - DAY_MS);
      const usedByApp = Number((appPages.get(appId, nowMs - DAY_MS) as { pages: number }).pages);
      if (usedByApp + pages > limits.pagesPerAppDay) return { ok: false, limit: 'app_day' };
      const usedByUser = Number((userPages.get(appId, userId, nowMs - HOUR_MS) as { pages: number }).pages);
      if (usedByUser + pages > limits.pagesPerUserHour) return { ok: false, limit: 'user_hour' };
      const { lastInsertRowid } = insertUsage.run(appId, userId, nowMs, pages);
      return { ok: true, reservation: Number(lastInsertRowid) };
    },
    settle(reservation, pages) {
      settle.run(pages, reservation);
    },
    release(reservation) {
      release.run(reservation);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
