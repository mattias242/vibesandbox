/**
 * Control-databasen: vilka appar som finns, vilka versioner de har och varje versions manifest.
 *
 * Ligger i en egen SQLite-fil under `<dataDir>/control/` — skild från apparnas data, som ligger i
 * en fil per hyresgäst (data-api). En app kan därmed aldrig nå registret genom sitt data-API.
 *
 * Manifestet ligger i databasen och inte i en fil bredvid bygget: uppslaget `(version, sökväg)`
 * blir då en exakt, binär jämförelse mot en primärnyckel. SQLite normaliserar inte text och
 * jämför med BINARY-kollationering, så `/INDEX.HTML`, `/ｉndex.html` och `/index.html` är tre olika
 * nycklar — precis det kontraktet för `AppFiles` kräver.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

/** Höjs vid varje schemaändring, tillsammans med ett nytt steg i `MIGRATIONS`. */
export const SCHEMA_VERSION = 2;

/** CLI:t får köras bredvid en server som är igång; så länge väntar vi på den andras lås. */
const BUSY_TIMEOUT_MS = 5000;

const DATABASE_DIRECTORY = 'control';
const DATABASE_FILE = 'control.sqlite';

/**
 * Steg N tar databasen från schemaversion N till N+1. Nya steg läggs SIST; ett steg som har
 * körts i drift ändras aldrig. Granskningskö m.m. kommer som senare steg.
 *
 * `STRICT` gör att SQLite vägrar fel datatyp i stället för att tyst omvandla den.
 * `published_version`/`draft_version` är två skilda pekare: utkastet är ogranskad kod och får
 * aldrig bli det som serveras som publicerat av misstag.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE apps (
    app_id            TEXT PRIMARY KEY,
    created_at        TEXT NOT NULL,
    published_version TEXT REFERENCES versions (version_id),
    draft_version     TEXT REFERENCES versions (version_id)
  ) STRICT;

  CREATE TABLE versions (
    version_id TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX versions_by_app ON versions (app_id);

  CREATE TABLE version_files (
    version_id   TEXT NOT NULL REFERENCES versions (version_id) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    PRIMARY KEY (version_id, path)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX version_files_by_hash ON version_files (hash);
  `,

  // Steg 1 → 2: vem som får använda en app. En rad per (app, användare). `owner` är den som
  // byggde appen och når både utkast och publicerat; `user` har fått appen delad med sig och når
  // bara det publicerade. Plattformens roller finns medvetet inte här — de ger ingen genväg.
  //
  // ON DELETE CASCADE: en borttagen app får inte lämna kvar åtkomst som skulle gälla om samma id
  // någonsin återkom. `email` är till för ägarens åtkomstlista och får aldrig loggas.
  //
  // Det partiella unika indexet gör "högst en ägare per app" till en egenskap hos databasen och
  // inte bara hos koden: två samtidiga processer (servern och CLI:t) kan inte båda lyckas.
  `
  CREATE TABLE app_access (
    app_id   TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN ('owner', 'user')),
    email    TEXT,
    added_at TEXT NOT NULL,
    PRIMARY KEY (app_id, user_id)
  ) STRICT;

  CREATE UNIQUE INDEX app_access_one_owner ON app_access (app_id) WHERE role = 'owner';
  `,
];

export interface ControlDatabase {
  /** Förberedd sats, förberedd en gång per SQL-text. */
  statement(sql: string): StatementSync;
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
  // Låset tas FÖRE versionsläsningen: två processer som startar samtidigt mot en tom katalog
  // (servern och CLI:t) får då inte båda för sig att de ska skapa schemat.
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readUserVersion(db);
    if (current > SCHEMA_VERSION) {
      // En äldre kod mot ett nyare schema kan förstöra data den inte förstår. Hellre stopp.
      throw new Error(
        `Control-databasen har schemaversion ${current}, men den här koden känner bara till ` +
          `${SCHEMA_VERSION}. Uppgradera plattformen innan den startas mot den här datakatalogen.`,
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const step = MIGRATIONS[version];
      if (step === undefined) throw new Error(`Migreringssteg ${version} saknas i control-databasen.`);
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

export function openControlDatabase(dataDir: string): ControlDatabase {
  const directory = join(dataDir, DATABASE_DIRECTORY);
  mkdirSync(directory, { recursive: true });

  const db = new DatabaseSync(join(directory, DATABASE_FILE), { timeout: BUSY_TIMEOUT_MS });
  try {
    // WAL: läsare (servern) blockeras inte av en skrivare (CLI:t) och tvärtom.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // Av som standard i SQLite; utan den vore REFERENCES och ON DELETE CASCADE bara kommentarer.
    db.exec('PRAGMA foreign_keys = ON');
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
