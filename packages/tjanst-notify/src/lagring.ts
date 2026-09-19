/**
 * Tjänstens egen SQLite-fil (`<dataDir>/notify.sqlite`): vem som stängt av aviseringar och hur
 * många mejl som skickats (för hastighetsgränserna). Inga adresser, ämnen eller texter sparas.
 *
 * Databasarbetet är synkront. Det utnyttjas medvetet: kontrollen av gränsen och bokföringen av
 * utskicket görs utan `await` emellan, så två samtidiga anrop kan inte båda slinka under gränsen.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TenantKind } from '@vibesandbox/contracts';

const DATABASE_FILE = 'notify.sqlite';
const BUSY_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mutes (
    app_id  TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
    user_id TEXT NOT NULL,
    PRIMARY KEY (app_id, kind, user_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sends (
    app_id  TEXT NOT NULL,
    sender  TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    count   INTEGER NOT NULL CHECK (count > 0)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sends_by_app ON sends (app_id, sent_at);
  CREATE INDEX IF NOT EXISTS sends_by_sender ON sends (sender, sent_at);
`;

export interface Limits {
  readonly perUserHour: number;
  readonly perUserDay: number;
  readonly perAppHour: number;
  readonly perAppDay: number;
}

export type LimitHit = 'user_hour' | 'user_day' | 'app_hour' | 'app_day';

export interface NotifyStore {
  isMuted(appId: string, kind: TenantKind, userId: string): boolean;
  setMuted(appId: string, kind: TenantKind, userId: string, muted: boolean): void;
  /**
   * Bokför `count` mejl om det ryms under alla gränser; annars ingenting och vilken gräns som nåddes.
   * `sender` är `null` för utskick utan avsändare (påminnelser via schedule) — då gäller bara appens gräns.
   */
  reserve(appId: string, sender: string | null, count: number, now: number, limits: Limits): LimitHit | null;
  close(): void;
}

export function openNotifyStore(dataDir: string): NotifyStore {
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const muted = db.prepare('SELECT 1 AS found FROM mutes WHERE app_id = ? AND kind = ? AND user_id = ?');
  const mute = db.prepare('INSERT OR IGNORE INTO mutes (app_id, kind, user_id) VALUES (?, ?, ?)');
  const unmute = db.prepare('DELETE FROM mutes WHERE app_id = ? AND kind = ? AND user_id = ?');
  const byApp = db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM sends WHERE app_id = ? AND sent_at > ?');
  // Per avsändare räknas över ALLA appar: den som äger flera appar kan inte mångdubbla sin gräns.
  const bySender = db.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM sends WHERE sender = ? AND sender <> '' AND sent_at > ?");
  const insert = db.prepare('INSERT INTO sends (app_id, sender, sent_at, count) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM sends WHERE sent_at <= ?');
  let open = true;

  const total = (statement: ReturnType<DatabaseSync['prepare']>, key: string, since: number): number => {
    const value = statement.get(key, since)?.['total'];
    return typeof value === 'number' ? value : Number(value ?? 0);
  };

  return {
    isMuted(appId, kind, userId) {
      return muted.get(appId, kind, userId) !== undefined;
    },
    setMuted(appId, kind, userId, value) {
      (value ? mute : unmute).run(appId, kind, userId);
    },
    reserve(appId, sender, count, now, limits) {
      const hourAgo = now - 60 * 60 * 1000;
      const dayAgo = now - DAY_MS;
      if (sender !== null) {
        if (total(bySender, sender, hourAgo) + count > limits.perUserHour) return 'user_hour';
        if (total(bySender, sender, dayAgo) + count > limits.perUserDay) return 'user_day';
      }
      if (total(byApp, appId, hourAgo) + count > limits.perAppHour) return 'app_hour';
      if (total(byApp, appId, dayAgo) + count > limits.perAppDay) return 'app_day';
      insert.run(appId, sender ?? '', now, count);
      prune.run(dayAgo);
      return null;
    },
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}
