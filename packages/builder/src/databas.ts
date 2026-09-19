/**
 * Byggverktygets egen SQLite-fil: `<dataDir>/builder.sqlite`. Skild från control-databasen och från
 * apparnas data, så att varken en app eller control når samtal, källkod eller delningar.
 *
 * Databasarbetet är synkront (`node:sqlite`). Det utnyttjas medvetet: en kontroll och den skrivning
 * den skyddar (t.ex. "pågår redan ett jobb?" följt av "skapa jobbet") görs utan `await` emellan och
 * kan därför inte flätas ihop med en annan förfrågan i samma process.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './sql.ts';

const DATABASE_FILE = 'builder.sqlite';

/** Så länge väntar SQLite på ett lås som en annan process håller innan det ger upp. */
const BUSY_TIMEOUT_MS = 5000;

export type Parameters = Record<string, SQLInputValue>;
export type Row = Record<string, SQLInputValue>;

export interface BuilderDatabase {
  get(sql: string, parameters?: Parameters): Row | undefined;
  all(sql: string, parameters?: Parameters): Row[];
  run(sql: string, parameters?: Parameters): { changes: number };
  /** Kör `work` i en skrivtransaktion; rullar tillbaka om den kastar. */
  transaction<T>(work: () => T): T;
  close(): void;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const version = row?.['user_version'];
  return typeof version === 'number' ? version : 0;
}

function migrate(db: DatabaseSync): void {
  // Låset tas FÖRE versionsläsningen, så att två processer mot en tom katalog inte båda migrerar.
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readUserVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Byggverktygets databas har schemaversion ${current}, men den här koden känner bara till ` +
          `${SCHEMA_VERSION}. Uppgradera plattformen innan den startas mot den här datakatalogen.`,
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const step = MIGRATIONS[version];
      if (step === undefined) throw new Error(`Migreringssteg ${version} saknas i byggverktygets databas.`);
      db.exec(step);
      // PRAGMA tar inga parametrar; värdet är ett heltal ur vår egen loop, aldrig indata.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function openBuilderDatabase(dataDir: string): BuilderDatabase {
  // 0o700: samtal och källkod ska inte gå att läsa för andra konton på servern.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // Av som standard i SQLite; utan den vore REFERENCES och ON DELETE CASCADE bara kommentarer.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA trusted_schema = OFF');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  let open = true;

  function prepared(sql: string): StatementSync {
    if (!open) throw new Error('Byggverktygets databas är stängd.');
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  return {
    get(sql, parameters = {}) {
      return prepared(sql).get(parameters) as Row | undefined;
    },
    all(sql, parameters = {}) {
      return prepared(sql).all(parameters) as Row[];
    },
    run(sql, parameters = {}) {
      const result = prepared(sql).run(parameters);
      return { changes: Number(result.changes) };
    },
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
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
