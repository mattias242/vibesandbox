/**
 * @vibesandbox/control — appregistret och apparnas byggda filer. Första, minimala versionen:
 * appar, versioner, utkast och publicering. Användare, delningar, registeruppgifter och
 * granskningskö kommer i en senare skiva (nya migreringssteg i databas.ts).
 *
 * Paketet implementerar kontraktets två gränssnitt mot gatewayn:
 *
 *   - `AppRegistry.find`  — finns appen, och har den en publicerad version respektive ett utkast?
 *   - `AppFiles.read`     — slår upp sökvägen som en EXAKT nyckel i versionens manifest och läser
 *                           sedan filen via dess innehållshash. Sökvägen blir aldrig en del av en
 *                           disksökväg och normaliseras aldrig (se kontraktet och lager.ts).
 *
 * Databasarbetet är synkront (`node:sqlite`); filarbetet är asynkront. Allt som ÄNDRAR något går
 * genom en kö, en ändring i taget, så att en städning av oanvända filer aldrig kan köra mitt i
 * en import som just skrivit samma fil.
 */
import { resolve } from 'node:path';
import { APP_ID_PATTERN, isAppId } from '@vibesandbox/contracts';
import type { AppFile, AppFiles, AppId, AppRegistry, RegisteredApp, TenantContext } from '@vibesandbox/contracts';
import { openControlDatabase } from './databas.ts';
import { ControlError } from './fel.ts';
import { VERSION_ID_PATTERN, newAppId, newVersionId } from './id.ts';
import { DEFAULT_IMPORT_LIMITS, scanBuildDirectory } from './import.ts';
import type { ImportLimits } from './import.ts';
import { createBlobStore } from './lager.ts';

export { ControlError } from './fel.ts';
export type { ControlErrorCode } from './fel.ts';
export { DEFAULT_IMPORT_LIMITS } from './import.ts';
export type { ImportLimits } from './import.ts';

export interface ControlOptions {
  /** Plattformens datakatalog. Control använder `control/` och `versions/` under den. */
  readonly dataDir: string;
  readonly importLimits?: ImportLimits;
}

export interface AppSummary extends RegisteredApp {
  readonly createdAt: string;
}

export interface Control {
  readonly registry: AppRegistry;
  readonly files: AppFiles;

  /** Skapar en tom app och ger dess id — som också är den hemliga delen av appens adress. */
  createApp(): Promise<AppId>;
  /** Alla appar, äldst först. */
  listApps(): Promise<readonly AppSummary[]>;
  /** Läser in en byggd katalog som en ny version av appen. Avvisar hela bygget vid minsta tvekan. */
  importVersion(appId: AppId, directory: string): Promise<string>;
  setDraft(appId: AppId, versionId: string): Promise<void>;
  clearDraft(appId: AppId): Promise<void>;
  publish(appId: AppId, versionId: string): Promise<void>;
  unpublish(appId: AppId): Promise<void>;
  /** Tar bort appen ur registret tillsammans med dess versioner och filer. Rör inte appens DATA. */
  deleteApp(appId: AppId): Promise<void>;
  /** Stänger databasen. Går att anropa flera gånger. */
  close(): Promise<void>;
}

/** Gatewayn godtar högst 2048 tecken i hela adressen; allt längre kan inte vara en riktig sökväg. */
const MAX_PATH_LENGTH = 4096;

/**
 * En fast SQL-text per sorts hyresgäst — kolumnnamnet väljs ur den här tabellen och sätts aldrig
 * samman ur indata. En Map i stället för ett objekt, så att `constructor` eller `__proto__` inte
 * kan ge träff via prototypen.
 */
const FILE_LOOKUP_SQL: ReadonlyMap<unknown, string> = new Map([
  [
    'published',
    `SELECT f.hash AS hash, f.size AS size, f.content_type AS content_type
       FROM apps a JOIN version_files f ON f.version_id = a.published_version
      WHERE a.app_id = ? AND f.path = ?`,
  ],
  [
    'draft',
    `SELECT f.hash AS hash, f.size AS size, f.content_type AS content_type
       FROM apps a JOIN version_files f ON f.version_id = a.draft_version
      WHERE a.app_id = ? AND f.path = ?`,
  ],
]);

const POINTER_COLUMNS = { published: 'published_version', draft: 'draft_version' } as const;
type Pointer = keyof typeof POINTER_COLUMNS;

export function createControl(options: ControlOptions): Control {
  if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
    throw new TypeError('dataDir måste anges.');
  }
  const dataDir = resolve(options.dataDir);
  const importLimits = options.importLimits ?? DEFAULT_IMPORT_LIMITS;

  const db = openControlDatabase(dataDir);
  const blobs = createBlobStore(dataDir);
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new ControlError('closed', 'Appregistret är stängt och tar inte emot fler anrop.');
  }

  // ── Kön för ändringar ────────────────────────────────────────────────────────
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      assertOpen();
      return work();
    });
    // Ett misslyckat arbete får inte stoppa kön för nästa.
    queue = result.catch(() => {});
    return result;
  }

  // ── Uppslag ──────────────────────────────────────────────────────────────────

  function assertAppExists(appId: AppId): void {
    const found =
      typeof appId === 'string' &&
      isAppId(appId) &&
      db.statement('SELECT 1 AS found FROM apps WHERE app_id = ?').get(appId) !== undefined;
    if (!found) throw new ControlError('app_not_found', 'Appen finns inte.');
  }

  /** En version hör till EN app. Samma fel för "finns inte" och "är någon annans". */
  function assertVersionBelongsToApp(appId: AppId, versionId: string): void {
    const found =
      typeof versionId === 'string' &&
      VERSION_ID_PATTERN.test(versionId) &&
      db.statement('SELECT 1 AS found FROM versions WHERE version_id = ? AND app_id = ?').get(versionId, appId) !==
        undefined;
    if (!found) throw new ControlError('version_not_found', 'Versionen finns inte för den här appen.');
  }

  function currentPointer(appId: AppId, pointer: Pointer): string | null {
    const row = db.statement(`SELECT ${POINTER_COLUMNS[pointer]} AS version_id FROM apps WHERE app_id = ?`).get(appId);
    const value = row?.['version_id'];
    return typeof value === 'string' ? value : null;
  }

  // ── Städning ─────────────────────────────────────────────────────────────────

  /** Tar bort filer som inget manifest längre pekar på. Anropas bara inifrån kön. */
  async function removeUnreferencedBlobs(hashes: Iterable<string>): Promise<void> {
    for (const hash of new Set(hashes)) {
      const stillUsed = db.statement('SELECT 1 AS used FROM version_files WHERE hash = ? LIMIT 1').get(hash);
      if (stillUsed === undefined) await blobs.remove(hash);
    }
  }

  function hashesOfVersions(sql: string, key: string): string[] {
    return db
      .statement(sql)
      .all(key)
      .map((row) => row['hash'])
      .filter((hash): hash is string => typeof hash === 'string');
  }

  /**
   * En version som varken är publicerad eller utkast längre tas bort när pekaren flyttas från
   * den. Historik och återställning hör till en senare skiva; tills dess ska gamla byggen inte
   * ligga kvar och ta plats på en liten server.
   */
  async function discardIfUnused(appId: AppId, versionId: string | null): Promise<void> {
    if (versionId === null) return;
    if (currentPointer(appId, 'published') === versionId || currentPointer(appId, 'draft') === versionId) return;
    const hashes = hashesOfVersions('SELECT hash FROM version_files WHERE version_id = ?', versionId);
    db.statement('DELETE FROM versions WHERE version_id = ?').run(versionId);
    await removeUnreferencedBlobs(hashes);
  }

  async function movePointer(appId: AppId, pointer: Pointer, versionId: string | null): Promise<void> {
    assertAppExists(appId);
    if (versionId !== null) assertVersionBelongsToApp(appId, versionId);
    const previous = currentPointer(appId, pointer);
    db.statement(`UPDATE apps SET ${POINTER_COLUMNS[pointer]} = ? WHERE app_id = ?`).run(versionId, appId);
    if (previous !== versionId) await discardIfUnused(appId, previous);
  }

  // ── Kontraktet mot gatewayn ──────────────────────────────────────────────────

  const registry: AppRegistry = {
    async find(appId) {
      assertOpen();
      // Ogiltigt id är inte ett fel utan ett "finns inte": gatewayn svarar 404 på `null`.
      if (typeof appId !== 'string' || !isAppId(appId)) return null;
      const row = db
        .statement('SELECT app_id, published_version, draft_version FROM apps WHERE app_id = ?')
        .get(appId);
      if (row === undefined || row['app_id'] !== appId) return null;
      return { appId, published: row['published_version'] !== null, draft: row['draft_version'] !== null };
    },
  };

  const files: AppFiles = {
    async read(tenant, path): Promise<AppFile | null> {
      assertOpen();

      // Ett TenantContext är bara en TypeScript-typ; i körning är det ett vanligt objekt. Det
      // valideras därför en gång till här, precis som i data-api.
      const appId: unknown = (tenant as TenantContext | null | undefined)?.appId;
      const lookupSql = FILE_LOOKUP_SQL.get((tenant as TenantContext | null | undefined)?.kind);
      if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || lookupSql === undefined) {
        throw new ControlError('invalid_tenant', 'Appens identitet kunde inte fastställas.');
      }

      // `path` används ENBART som ett värde att jämföra med — ordagrant, utan trimning, utan
      // Unicode-normalisering, utan skiftlägesändring. Finns den inte exakt så i manifestet
      // finns filen inte.
      if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
      const row = db.statement(lookupSql).get(appId, path);
      if (row === undefined) return null;

      const hash = row['hash'];
      const size = row['size'];
      const contentType = row['content_type'];
      if (typeof hash !== 'string' || typeof size !== 'number' || typeof contentType !== 'string') {
        throw new ControlError('internal', 'Filregistret är skadat.');
      }

      // Härifrån är det hashen — aldrig sökvägen — som avgör vilken fil på disk som läses.
      const body = await blobs.read(hash);
      if (body === null || body.length !== size) {
        throw new ControlError('internal', 'En av appens filer saknas eller är skadad i lagret.');
      }
      return { body, contentType };
    },
  };

  // ── Administration ───────────────────────────────────────────────────────────

  return {
    registry,
    files,

    createApp() {
      return exclusive(async () => {
        const appId = newAppId();
        // 130 bitar slump krockar inte. Skulle det ändå ske stoppar primärnyckeln det — en
        // befintlig app kan aldrig skrivas över.
        db.statement('INSERT INTO apps (app_id, created_at) VALUES (?, ?)').run(appId, new Date().toISOString());
        return appId;
      });
    },

    async listApps() {
      assertOpen();
      const rows = db
        .statement('SELECT app_id, created_at, published_version, draft_version FROM apps ORDER BY created_at, rowid')
        .all();
      const apps: AppSummary[] = [];
      for (const row of rows) {
        const appId = row['app_id'];
        const createdAt = row['created_at'];
        if (typeof appId !== 'string' || !isAppId(appId) || typeof createdAt !== 'string') continue;
        apps.push({
          appId,
          createdAt,
          published: row['published_version'] !== null,
          draft: row['draft_version'] !== null,
        });
      }
      return apps;
    },

    importVersion(appId, directory) {
      return exclusive(async () => {
        assertAppExists(appId);

        // 1. Läs och kontrollera HELA bygget. Inget har skrivits när detta kastar.
        let scanned;
        try {
          scanned = await scanBuildDirectory(directory, importLimits);
        } catch (error) {
          if (error instanceof ControlError) throw error;
          throw new ControlError('import_rejected', 'Bygget gick inte att läsa.');
        }

        // 2. Filerna först, manifestet sist: en version syns inte förrän alla dess filer finns.
        const written: string[] = [];
        try {
          for (const file of scanned) {
            await blobs.write(file.hash, file.content);
            written.push(file.hash);
          }
          const versionId = newVersionId();
          db.transaction(() => {
            db.statement('INSERT INTO versions (version_id, app_id, created_at) VALUES (?, ?, ?)').run(
              versionId,
              appId,
              new Date().toISOString(),
            );
            const insertFile = db.statement(
              'INSERT INTO version_files (version_id, path, hash, size, content_type) VALUES (?, ?, ?, ?, ?)',
            );
            for (const file of scanned) insertFile.run(versionId, file.path, file.hash, file.size, file.contentType);
          });
          return versionId;
        } catch (error) {
          // Städa det som hann skrivas men som inget manifest pekar på.
          await removeUnreferencedBlobs(written).catch(() => {});
          throw error;
        }
      });
    },

    setDraft: (appId, versionId) => exclusive(() => movePointer(appId, 'draft', versionId)),
    clearDraft: (appId) => exclusive(() => movePointer(appId, 'draft', null)),
    publish: (appId, versionId) => exclusive(() => movePointer(appId, 'published', versionId)),
    unpublish: (appId) => exclusive(() => movePointer(appId, 'published', null)),

    deleteApp(appId) {
      return exclusive(async () => {
        assertAppExists(appId);
        const hashes = hashesOfVersions(
          'SELECT f.hash AS hash FROM version_files f JOIN versions v ON v.version_id = f.version_id WHERE v.app_id = ?',
          appId,
        );
        // Versioner och manifest följer med genom ON DELETE CASCADE.
        db.statement('DELETE FROM apps WHERE app_id = ?').run(appId);
        await removeUnreferencedBlobs(hashes);
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      // Vänta ut en pågående ändring, så att databasen inte stängs under den.
      await queue;
      db.close();
    },
  };
}
