/**
 * Tokenkvoter i en egen SQLite-databas: per app och dygn, och per användare och timme.
 *
 * Före anropet RESERVERAS en uppskattning (indata + hela `maxTokens`), så att samtidiga anrop inte
 * tillsammans kan gå över gränsen. Efter anropet ersätts uppskattningen med den faktiska åtgången.
 * Reservera-och-kontrollera sker synkront i en transaktion; Node kör det aldrig samtidigt.
 *
 * Allt nycklas på app-id OCH `kind`: utkastet och den publicerade versionen har var sin kvot, så
 * att ägarens provkörningar i förhandsvisningen aldrig tar slut på kvoten för appens användare
 * (och tvärtom). Tidsfönstren är UTC-dygn och UTC-timmar — enkla att förklara och att räkna om.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TenantContext } from '@vibesandbox/contracts';

const DATABASE_FILE = 'kvot.sqlite';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  app_id  TEXT    NOT NULL,
  kind    TEXT    NOT NULL CHECK (kind IN ('published', 'draft')),
  -- '' för appens dygnskvot, annars användarens id (för timkvoten).
  subject TEXT    NOT NULL,
  -- Fönstrets början i ms sedan epoken; fönstrets längd följer av subject.
  window_start INTEGER NOT NULL,
  tokens  INTEGER NOT NULL CHECK (tokens >= 0),
  PRIMARY KEY (app_id, kind, subject, window_start)
) STRICT, WITHOUT ROWID;
`;

export interface QuotaLimits {
  readonly tokensPerAppDay: number;
  readonly tokensPerUserHour: number;
}

export interface Reservation {
  readonly appId: string;
  readonly kind: string;
  readonly userId: string;
  readonly dayWindow: number;
  readonly hourWindow: number;
  readonly tokens: number;
}

export type ReserveResult = { readonly ok: true; readonly reservation: Reservation } | { readonly ok: false; readonly limit: 'user-hour' | 'app-day' };

export interface QuotaLedger {
  reserve(tenant: TenantContext, userId: string, estimate: number, now: Date): ReserveResult;
  /** Ersätter reservationen med den faktiska åtgången. Anropas exakt en gång per reservation. */
  settle(reservation: Reservation, actual: number): void;
  close(): void;
}

/** Tomt användar-id är appens rad; ett riktigt id får ett prefix så att de aldrig kan krocka. */
const userSubject = (userId: string): string => `u:${userId}`;
const APP_SUBJECT = '';

export function openQuotaLedger(dataDir: string, limits: QuotaLimits): QuotaLedger {
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const read = db.prepare('SELECT tokens FROM usage WHERE app_id = ? AND kind = ? AND subject = ? AND window_start = ?');
  const add = db.prepare(
    `INSERT INTO usage (app_id, kind, subject, window_start, tokens) VALUES (?, ?, ?, ?, MAX(?, 0))
     ON CONFLICT (app_id, kind, subject, window_start) DO UPDATE SET tokens = MAX(tokens + excluded.tokens, 0)`,
  );
  // Samma uttryck som ovan, men för en negativ justering: aldrig under noll.
  const adjust = db.prepare('UPDATE usage SET tokens = MAX(tokens + ?, 0) WHERE app_id = ? AND kind = ? AND subject = ? AND window_start = ?');
  const prune = db.prepare('DELETE FROM usage WHERE window_start < ?');
  let lastPrune = 0;
  let closed = false;

  const used = (appId: string, kind: string, subject: string, windowStart: number): number => {
    const row = read.get(appId, kind, subject, windowStart) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  };

  function transaction<T>(work: () => T): T {
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

  return {
    reserve(tenant, userId, estimate, now) {
      const time = now.getTime();
      const dayWindow = Math.floor(time / DAY_MS) * DAY_MS;
      const hourWindow = Math.floor(time / HOUR_MS) * HOUR_MS;
      const { appId, kind } = tenant;
      return transaction((): ReserveResult => {
        // Gamla fönster behövs inte; städas högst en gång i timmen.
        if (time - lastPrune > HOUR_MS) {
          prune.run(dayWindow - DAY_MS);
          lastPrune = time;
        }
        if (used(appId, kind, userSubject(userId), hourWindow) + estimate > limits.tokensPerUserHour) return { ok: false, limit: 'user-hour' };
        if (used(appId, kind, APP_SUBJECT, dayWindow) + estimate > limits.tokensPerAppDay) return { ok: false, limit: 'app-day' };
        add.run(appId, kind, userSubject(userId), hourWindow, estimate);
        add.run(appId, kind, APP_SUBJECT, dayWindow, estimate);
        return { ok: true, reservation: { appId, kind, userId, dayWindow, hourWindow, tokens: estimate } };
      });
    },

    settle(reservation, actual) {
      // Ett anrop som pågick när tjänsten stängdes har inget att justera i.
      if (closed) return;
      const delta = Math.max(0, Math.round(actual)) - reservation.tokens;
      if (delta === 0) return;
      const { appId, kind, userId, dayWindow, hourWindow } = reservation;
      transaction(() => {
        if (delta > 0) {
          add.run(appId, kind, userSubject(userId), hourWindow, delta);
          add.run(appId, kind, APP_SUBJECT, dayWindow, delta);
        } else {
          adjust.run(delta, appId, kind, userSubject(userId), hourWindow);
          adjust.run(delta, appId, kind, APP_SUBJECT, dayWindow);
        }
      });
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
