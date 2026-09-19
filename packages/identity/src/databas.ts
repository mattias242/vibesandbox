/**
 * Identitetsdatabasen: `identity.sqlite` i en given katalog, skild från control-databasen och
 * från apparnas data. Ingen app når den genom sitt data-API.
 *
 * Vad som står i klartext och vad som inte gör det:
 * - `users.email` står i klartext — den behövs för att skicka mejl och fylla `Identity.email`.
 * - Utmaningar och sessioner lagrar ENBART HMAC:ar (med serverhemligheten): av utmanings-id,
 *   kod, sessionsvärde och adress. Den som får en kopia av filen kan inte logga in med den.
 * - Händelseloggen har typ, användar-id och tid — aldrig adresser.
 *
 * Alla satser är konstanter med namngivna parametrar; ingen SQL byggs av indata.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
export const DATABASE_FILE = 'identity.sqlite';

/** CLI:t får köras bredvid en server som är igång. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Steg N tar databasen från version N till N+1. Nya steg läggs SIST; ett steg som har körts i
 * drift ändras aldrig. `STRICT`: SQLite vägrar fel datatyp i stället för att tyst omvandla.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    user_id    TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'builder', 'viewer')),
    created_at INTEGER NOT NULL
  ) STRICT;

  -- En utmaning per adress: en ny ersätter den gamla (email_key är UNIK).
  -- user_id är NULL för en adress som inte är inbjuden: raden skrivs ändå, så att arbetet och
  -- svarstiden blir desamma, men den kan aldrig leda till en session.
  CREATE TABLE challenges (
    id_hash    BLOB PRIMARY KEY,
    email_key  BLOB NOT NULL UNIQUE,
    user_id    TEXT REFERENCES users (user_id) ON DELETE CASCADE,
    host       TEXT NOT NULL,
    code_hmac  BLOB NOT NULL,
    next_path  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX challenges_by_expiry ON challenges (expires_at);

  CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    host       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX sessions_by_expiry ON sessions (expires_at);

  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY,
    type     TEXT NOT NULL,
    user_id  TEXT,
    at       INTEGER NOT NULL
  ) STRICT;
  `,
];

// ── Satser ─────────────────────────────────────────────────────────────────────

export const SQL = {
  findUserByEmail: 'SELECT user_id, email, role FROM users WHERE email = :email',
  findUserById: 'SELECT user_id, email, role FROM users WHERE user_id = :user_id',
  insertUser: 'INSERT INTO users (user_id, email, role, created_at) VALUES (:user_id, :email, :role, :created_at)',
  updateUserRole: 'UPDATE users SET role = :role WHERE user_id = :user_id',

  upsertChallenge: `
    INSERT INTO challenges (id_hash, email_key, user_id, host, code_hmac, next_path, attempts, expires_at)
    VALUES (:id_hash, :email_key, :user_id, :host, :code_hmac, :next_path, 0, :expires_at)
    ON CONFLICT (email_key) DO UPDATE SET
      id_hash = excluded.id_hash, user_id = excluded.user_id, host = excluded.host,
      code_hmac = excluded.code_hmac, next_path = excluded.next_path, attempts = 0,
      expires_at = excluded.expires_at`,
  findChallenge: `
    SELECT id_hash, user_id, host, code_hmac, next_path, attempts, expires_at
    FROM challenges WHERE id_hash = :id_hash`,
  countAttempt: 'UPDATE challenges SET attempts = attempts + 1 WHERE id_hash = :id_hash',
  deleteChallenge: 'DELETE FROM challenges WHERE id_hash = :id_hash',

  insertSession: `
    INSERT INTO sessions (token_hash, user_id, host, created_at, expires_at)
    VALUES (:token_hash, :user_id, :host, :created_at, :expires_at)`,
  findSession: `
    SELECT s.user_id, s.host, s.expires_at, u.email, u.role
    FROM sessions s JOIN users u ON u.user_id = s.user_id
    WHERE s.token_hash = :token_hash`,
  deleteSession: 'DELETE FROM sessions WHERE token_hash = :token_hash',

  deleteExpiredChallenges: 'DELETE FROM challenges WHERE expires_at <= :now',
  deleteExpiredSessions: 'DELETE FROM sessions WHERE expires_at <= :now',
  deleteOldEvents: 'DELETE FROM events WHERE at <= :before',

  insertEvent: 'INSERT INTO events (type, user_id, at) VALUES (:type, :user_id, :at)',
} as const;

export interface IdentityDatabase {
  statement(sql: string): StatementSync;
  transaction<T>(work: () => T): T;
  close(): void;
}

function readUserVersion(db: DatabaseSync): number {
  const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
  return typeof version === 'number' ? version : 0;
}

function migrate(db: DatabaseSync): void {
  // Låset FÖRE versionsläsningen: servern och CLI:t kan starta samtidigt mot en tom katalog.
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readUserVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Identitetsdatabasen har schemaversion ${current}, men den här koden känner bara till ${SCHEMA_VERSION}. ` +
          'Uppgradera plattformen innan den startas mot den här datakatalogen.',
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const step = MIGRATIONS[version];
      if (step === undefined) throw new Error(`Migreringssteg ${version} saknas i identitetsdatabasen.`);
      db.exec(step);
      // PRAGMA tar inga parametrar; värdet är ett heltal ur vår egen loop, aldrig indata.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openIdentityDatabase(directory: string): IdentityDatabase {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Raderade sessioner och utmaningar ska inte ligga kvar i fria sidor i filen.
    db.exec('PRAGMA secure_delete = ON');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  let open = true;
  return {
    statement(sql) {
      let prepared = statements.get(sql);
      if (prepared === undefined) {
        prepared = db.prepare(sql);
        statements.set(sql, prepared);
      }
      return prepared;
    },
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      if (!open) return;
      open = false;
      statements.clear();
      db.close();
    },
  };
}
