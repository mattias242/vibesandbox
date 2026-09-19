/**
 * Öppna databashandtag: en SQLite-fil per hyresgäst, högst `maxOpenDatabases` öppna samtidigt.
 *
 * Varför en LRU-cache: att öppna en databas kostar (filöppning, PRAGMA, schemakontroll), men
 * varje öppet handtag håller filbeskrivare och sidcache. Med många appar på en liten server måste
 * antalet vara begränsat; det minst nyligen använda handtaget stängs när taket nås.
 *
 * Varför det är säkert att stänga ett handtag "mitt i trafiken": `node:sqlite` är synkront, och
 * `index.ts` gör aldrig `await` mellan att ett handtag hämtas och att det använts klart. Ingen
 * annan förfrågan kan därför köra — och ingen vräkning ske — medan ett handtag är i bruk.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { TenantLimits } from '@vibesandbox/contracts';
import { dataApiError } from './fel.ts';
import { pageBudget, pageSizeForNewDatabase, type PageBudget } from './kvot.ts';
import { CREATE_HISTORY_SCHEMA, CREATE_SCHEMA, SCHEMA_VERSION } from './sql.ts';
import type { TenantPaths } from './sokvagar.ts';

/** Så länge väntar SQLite på ett lås som en annan process håller, innan det ger upp. */
const BUSY_TIMEOUT_MS = 2000;

/**
 * Sidcache per handtag i KiB (negativt värde = KiB i SQLite). Standardvärdet 2 MiB gånger hundra
 * öppna databaser blir för mycket minne på en liten server.
 */
const CACHE_SIZE_KIB = 512;

export interface TenantHandle {
  /** Förberedd sats för en SQL-konstant ur `sql.ts`; förbereds en gång per handtag. */
  statement(sql: string): StatementSync;
  /** Kör `work` i en skrivtransaktion. Rullar tillbaka vid fel. */
  transaction<T>(work: () => T): T;
  /** Kör `work` med raderingsreserven upplåst (se `kvot.ts`). */
  withDeleteReserve<T>(work: () => T): T;
}

export interface HandleCache {
  /** För läsning: `null` om hyresgästen aldrig har skrivits till. Skapar ALDRIG något på disk. */
  openExisting(paths: TenantPaths): TenantHandle | null;
  /** För skrivning: skapar katalog och databas vid behov. */
  openOrCreate(paths: TenantPaths): TenantHandle;
  /** Stänger hyresgästens handtag och raderar hela dess katalog. */
  destroy(paths: TenantPaths): void;
  closeAll(): void;
}

interface OpenHandle extends TenantHandle {
  close(): void;
}

export interface HandleCacheOptions {
  /** Skapa historiktabellen när en databas öppnas (ändringshistoriken är påslagen). */
  readonly history?: boolean;
}

export function createHandleCache(
  limits: TenantLimits,
  maxOpenDatabases: number,
  options: HandleCacheOptions = {},
): HandleCache {
  // En Map minns insättningsordningen: första nyckeln är alltid den minst nyligen använda.
  const open = new Map<string, OpenHandle>();

  function acquire(paths: TenantPaths): OpenHandle {
    const cached = open.get(paths.key);
    if (cached !== undefined) {
      open.delete(paths.key);
      open.set(paths.key, cached); // flytta sist = senast använd
      return cached;
    }
    while (open.size >= maxOpenDatabases) {
      const oldestKey = open.keys().next().value;
      if (oldestKey === undefined) break;
      open.get(oldestKey)?.close();
      open.delete(oldestKey);
    }
    const handle = openDatabase(paths.databaseFile, limits, options.history === true);
    open.set(paths.key, handle);
    return handle;
  }

  return {
    openExisting(paths) {
      // En läsning av en app som aldrig sparat något får inte lämna spår på disk. Annars kunde
      // vem som helst som når en app-adress fylla disken med tomma databaser.
      if (!open.has(paths.key) && !existsSync(paths.databaseFile)) return null;
      return acquire(paths);
    },

    openOrCreate(paths) {
      if (!open.has(paths.key)) {
        // 0o700: appdata ska inte gå att läsa för andra konton på servern.
        mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
      }
      return acquire(paths);
    },

    destroy(paths) {
      open.get(paths.key)?.close();
      open.delete(paths.key);
      // Synkront med flit: mellan stängning och radering får ingen annan förfrågan hinna öppna
      // databasen igen — då skulle filerna försvinna under ett öppet handtag. Katalogen tillhör
      // hyresgästen i sin helhet (data.sqlite, -wal, -shm); inget utanför den berörs.
      rmSync(paths.directory, { recursive: true, force: true });
    },

    closeAll() {
      for (const handle of open.values()) handle.close();
      open.clear();
    },
  };
}

function openDatabase(databaseFile: string, limits: TenantLimits, history: boolean): OpenHandle {
  const db = new DatabaseSync(databaseFile, { enableForeignKeyConstraints: true });
  let budget: PageBudget;
  try {
    // Ordningen spelar roll: sidstorleken måste sättas före WAL-läget och före första tabellen.
    // På en databas som redan finns är raden verkningslös.
    db.exec(`PRAGMA page_size = ${pragmaInteger(pageSizeForNewDatabase(limits))}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA busy_timeout = ${pragmaInteger(BUSY_TIMEOUT_MS)}`);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec(`PRAGMA cache_size = -${pragmaInteger(CACHE_SIZE_KIB)}`);

    ensureSchema(db);
    // Före kvoten, som schemat: en full databas ska ändå kunna få historiktabellen.
    if (history) ensureHistorySchema(db);

    // Kvoten sätts EFTER schemat, så att en ny databas alltid går att skapa. Är filen redan
    // större än gränsen (kvoten har sänkts) stannar SQLite på nuvarande storlek: den kan inte
    // växa mer, men inget går förlorat.
    const pageSize = readPragmaInteger(db, 'page_size');
    budget = pageBudget(limits, pageSize);
    db.exec(`PRAGMA wal_autocheckpoint = ${pragmaInteger(budget.walCheckpointPages)}`);
    db.exec(`PRAGMA journal_size_limit = ${pragmaInteger(budget.walCheckpointPages * pageSize)}`);
    // max_page_count gäller per anslutning och sparas inte i filen — därför vid varje öppning.
    db.exec(`PRAGMA max_page_count = ${pragmaInteger(budget.writePages)}`);
  } catch (fel) {
    closeQuietly(db);
    throw fel;
  }

  const statements = new Map<string, StatementSync>();
  const writeLimit = `PRAGMA max_page_count = ${pragmaInteger(budget.writePages)}`;
  const deleteLimit = `PRAGMA max_page_count = ${pragmaInteger(budget.deletePages)}`;

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
      // IMMEDIATE tar skrivlåset direkt, så att kontrollen "finns kollektionen?" och den
      // efterföljande skrivningen inte kan flätas ihop med en annan process.
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (fel) {
        // Vid SQLITE_FULL har SQLite ofta redan rullat tillbaka hela transaktionen själv.
        if (db.isTransaction) db.exec('ROLLBACK');
        throw fel;
      }
    },

    withDeleteReserve(work) {
      db.exec(deleteLimit);
      try {
        return work();
      } finally {
        db.exec(writeLimit);
      }
    },

    close() {
      // Satserna hör till anslutningen; släpp referenserna så att inget kan använda dem efteråt.
      statements.clear();
      closeQuietly(db);
    },
  };
}

function ensureSchema(db: DatabaseSync): void {
  const version = readPragmaInteger(db, 'user_version');
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    // Filen är skriven av en nyare version av plattformen. Rör den inte.
    throw dataApiError('internal', 'Appens data kan inte läsas av den här versionen av plattformen.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(CREATE_SCHEMA);
    db.exec(`PRAGMA user_version = ${pragmaInteger(SCHEMA_VERSION)}`);
    db.exec('COMMIT');
  } catch (fel) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw fel;
  }
}

/** Idempotent. Rör inte `user_version` — se CREATE_HISTORY_SCHEMA i sql.ts. */
function ensureHistorySchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(CREATE_HISTORY_SCHEMA);
    db.exec('COMMIT');
  } catch (fel) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw fel;
  }
}

function readPragmaInteger(db: DatabaseSync, pragma: 'page_size' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (typeof value !== 'number') throw new Error(`PRAGMA ${pragma} gav inget heltal`);
  return value;
}

/**
 * PRAGMA-värden kan inte bindas som parametrar och måste stå i SQL-texten. De kommer alltid ur
 * plattformens konfiguration, aldrig ur en app — och släpps ändå bara igenom som rena heltal.
 */
function pragmaInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('PRAGMA-värdet måste vara ett icke-negativt heltal');
  }
  return String(value);
}

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // En stängning som misslyckas får inte dölja det ursprungliga felet eller stoppa nedstängningen.
  }
}
