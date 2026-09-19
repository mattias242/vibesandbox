/**
 * Påminnelserna i `node:sqlite`. Allt nycklas på app-id + utkast/publicerat: en app ser aldrig en
 * annan apps påminnelser, och förhandsvisningen delar inte påminnelser med den publicerade appen.
 *
 * En rad = en AKTIV påminnelse. En engångspåminnelse tas bort i samma transaktion som den plockas
 * ut för utskick; en upprepad får sin nästa tid i samma transaktion. Se `claimDue`.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppId, TenantKind } from '@vibesandbox/contracts';
import { nextOccurrence } from './tid.ts';
import type { Repeat } from './tid.ts';

export type Recipients = readonly string[] | 'all' | 'owner';

export interface Reminder {
  readonly id: string;
  readonly appId: AppId;
  readonly kind: TenantKind;
  readonly createdBy: string;
  readonly to: Recipients;
  readonly subject: string;
  readonly text: string;
  readonly repeat: Repeat | null;
  /** Första tillfället (ms). Upprepningar räknas härifrån i Stockholms väggtid. */
  readonly firstAt: number;
  readonly nextAt: number;
}

interface Row {
  id: string;
  app_id: string;
  kind: string;
  created_by: string;
  recipients: string;
  subject: string;
  body: string;
  repeat: string | null;
  first_at: number;
  next_at: number;
}

function toReminder(row: Row): Reminder {
  return {
    id: row.id,
    appId: row.app_id as AppId,
    kind: row.kind as TenantKind,
    createdBy: row.created_by,
    to: JSON.parse(row.recipients) as Recipients,
    subject: row.subject,
    text: row.body,
    repeat: row.repeat as Repeat | null,
    firstAt: row.first_at,
    nextAt: row.next_at,
  };
}

export interface ReminderStore {
  /** Lägger till om gränserna tillåter; annars `false`. Räkning och tillägg i EN transaktion. */
  insert(reminder: Reminder, limits: { readonly perApp: number; readonly perUser: number }): 'ok' | 'app_full' | 'user_full';
  list(appId: AppId, kind: TenantKind, createdBy?: string): Reminder[];
  get(appId: AppId, kind: TenantKind, id: string): Reminder | undefined;
  remove(appId: AppId, kind: TenantKind, id: string): void;
  /**
   * Plockar ut högst `limit` förfallna påminnelser och markerar dem som skickade INNAN de skickas:
   * engångspåminnelser tas bort, upprepade får nästa tid efter `now`. Allt i en transaktion.
   */
  claimDue(now: number, limit: number): Reminder[];
  close(): void;
}

export function openReminderStore(dataDir: string): ReminderStore {
  const db = new DatabaseSync(join(dataDir, 'schedule.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
      created_by TEXT NOT NULL,
      recipients TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      repeat TEXT CHECK (repeat IN ('daily', 'weekly', 'monthly')),
      first_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders (next_at);
    CREATE INDEX IF NOT EXISTS reminders_owner ON reminders (app_id, kind, created_by);
  `);

  const countApp = db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE app_id = ? AND kind = ?');
  const countUser = db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE app_id = ? AND kind = ? AND created_by = ?');
  const insert = db.prepare(
    `INSERT INTO reminders (id, app_id, kind, created_by, recipients, subject, body, repeat, first_at, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listAll = db.prepare('SELECT * FROM reminders WHERE app_id = ? AND kind = ? ORDER BY next_at, id');
  const listMine = db.prepare('SELECT * FROM reminders WHERE app_id = ? AND kind = ? AND created_by = ? ORDER BY next_at, id');
  const getOne = db.prepare('SELECT * FROM reminders WHERE app_id = ? AND kind = ? AND id = ?');
  const removeOne = db.prepare('DELETE FROM reminders WHERE app_id = ? AND kind = ? AND id = ?');
  const due = db.prepare('SELECT * FROM reminders WHERE next_at <= ? ORDER BY next_at, id LIMIT ?');
  const deleteById = db.prepare('DELETE FROM reminders WHERE id = ?');
  const advance = db.prepare('UPDATE reminders SET next_at = ? WHERE id = ?');

  function transaction<T>(work: () => T): T {
    // IMMEDIATE: skrivlåset tas direkt, så att två processer aldrig plockar samma rad.
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const count = (row: unknown): number => Number((row as { n: number }).n);

  return {
    insert(r, limits) {
      return transaction(() => {
        if (count(countApp.get(r.appId, r.kind)) >= limits.perApp) return 'app_full';
        if (count(countUser.get(r.appId, r.kind, r.createdBy)) >= limits.perUser) return 'user_full';
        insert.run(r.id, r.appId, r.kind, r.createdBy, JSON.stringify(r.to), r.subject, r.text, r.repeat, r.firstAt, r.nextAt, Date.now());
        return 'ok';
      });
    },
    list(appId, kind, createdBy) {
      const rows = createdBy === undefined ? listAll.all(appId, kind) : listMine.all(appId, kind, createdBy);
      return (rows as unknown as Row[]).map(toReminder);
    },
    get(appId, kind, id) {
      const row = getOne.get(appId, kind, id) as unknown as Row | undefined;
      return row === undefined ? undefined : toReminder(row);
    },
    remove(appId, kind, id) {
      removeOne.run(appId, kind, id);
    },
    claimDue(now, limit) {
      return transaction(() => {
        const claimed = (due.all(now, limit) as unknown as Row[]).map(toReminder);
        for (const r of claimed) {
          if (r.repeat === null) deleteById.run(r.id);
          else advance.run(nextOccurrence(r.firstAt, r.repeat, now), r.id);
        }
        return claimed;
      });
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
