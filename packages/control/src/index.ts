/**
 * @vibesandbox/control — appregistret och apparnas byggda filer. Första, minimala versionen:
 * appar, versioner, utkast, publicering och vem som har åtkomst till varje app (ägare och
 * användare). Registeruppgifter och granskningskö kommer i en senare skiva (nya migreringssteg i
 * databas.ts).
 *
 * Paketet implementerar kontraktets två gränssnitt mot gatewayn:
 *
 *   - `AppRegistry.find`  — finns appen, och har den en publicerad version respektive ett utkast?
 *   - `AppRegistry.accessFor` — användarens roll i appen (`owner`/`user`), eller `null`.
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
import type { AppAccessRole, AppFile, AppFiles, AppId, AppRegistry, RegisteredApp, TenantContext } from '@vibesandbox/contracts';
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
export type { AppAccessRole } from '@vibesandbox/contracts';

export interface ControlOptions {
  /** Plattformens datakatalog. Control använder `control/` och `versions/` under den. */
  readonly dataDir: string;
  readonly importLimits?: ImportLimits;
}

export interface AppSummary extends RegisteredApp {
  readonly createdAt: string;
}

/** En rad i appens åtkomstlista. `email` saknas för en ägare som lagts in utan adress. */
export interface AppMember {
  readonly userId: string;
  readonly role: AppAccessRole;
  readonly email: string | null;
  readonly addedAt: string;
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
  /**
   * Ger en användare åtkomst till appen. Idempotent. En ägare nedgraderas aldrig till användare;
   * en app har högst en ägare (en andra ägare ⇒ `ControlError('access_rejected')`). Okänd app ⇒
   * `ControlError('app_not_found')`. `email` sparas för åtkomstlistan och loggas aldrig.
   */
  grantAccess(appId: AppId, userId: string, role: AppAccessRole, email: string | null): Promise<void>;
  /** Tar bort en användares åtkomst. Ägarens åtkomst går inte att ta bort (`ControlError('access_rejected')`). Okänd rad ⇒ inget händer. */
  revokeAccess(appId: AppId, userId: string): Promise<void>;
  /** Appens åtkomstlista: ägaren först, sedan användarna i den ordning de lades till. */
  listAccess(appId: AppId): Promise<readonly AppMember[]>;
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

/** Samma gräns som data-api sätter för användar-id. Id:t är ogenomskinligt och jämförs ordagrant. */
const MAX_USER_ID_LENGTH = 256;
/** RFC 5321 tillåter högst 320 tecken i en adress; allt längre är inte en adress. */
const MAX_EMAIL_LENGTH = 320;
/** Rollerna som en Map, så att `constructor` eller `__proto__` aldrig ger träff via prototypen. */
const ACCESS_ROLES: ReadonlyMap<unknown, AppAccessRole> = new Map([
  ['owner', 'owner'],
  ['user', 'user'],
]);

function isUserId(value: unknown): value is string {
  // NUL avvisas: ett id som skiljer sig från ett annat bara efter en NUL är ett förfalskningsförsök.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_USER_ID_LENGTH && !value.includes('\0');
}

/**
 * Meddelandena i felen nämner varken adress eller id: ett ControlError kan hamna i en logg, och
 * driftloggar får aldrig innehålla e-postadresser.
 */
function rejectAccess(message: string): never {
  throw new ControlError('access_rejected', message);
}
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

    async accessFor(appId, userId) {
      assertOpen();
      // Allt som inte är ett giltigt id är ett "ingen åtkomst" — aldrig ett fel, aldrig en träff.
      if (typeof appId !== 'string' || !isAppId(appId) || !isUserId(userId)) return null;
      // Frågan går mot databasen varje gång: en borttagen åtkomst ska gälla direkt.
      const row = db.statement('SELECT role FROM app_access WHERE app_id = ? AND user_id = ?').get(appId, userId);
      return ACCESS_ROLES.get(row?.['role']) ?? null;
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
        // Versioner, manifest och åtkomstlistan följer med genom ON DELETE CASCADE.
        db.statement('DELETE FROM apps WHERE app_id = ?').run(appId);
        await removeUnreferencedBlobs(hashes);
      });
    },

    grantAccess(appId, userId, role, email) {
      return exclusive(async () => {
        assertAppExists(appId);
        if (!isUserId(userId)) rejectAccess('Användaren är ogiltig.');
        const wanted = ACCESS_ROLES.get(role);
        if (wanted === undefined) rejectAccess('Rollen finns inte.');
        if (
          email !== null &&
          (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LENGTH || email.includes('\0'))
        ) {
          rejectAccess('Adressen är ogiltig.');
        }

        db.transaction(() => {
          const existing = ACCESS_ROLES.get(
            db.statement('SELECT role FROM app_access WHERE app_id = ? AND user_id = ?').get(appId, userId)?.['role'],
          );
          if (wanted === 'owner' && existing !== 'owner') {
            // Högst en ägare. Indexet i databasen stoppar det också, men då som ett allmänt fel.
            const owner = db.statement("SELECT 1 AS found FROM app_access WHERE app_id = ? AND role = 'owner'").get(appId);
            if (owner !== undefined) rejectAccess('Appen har redan en ägare.');
          }

          if (existing === undefined) {
            db.statement('INSERT INTO app_access (app_id, user_id, role, email, added_at) VALUES (?, ?, ?, ?, ?)').run(
              appId,
              userId,
              wanted,
              email,
              new Date().toISOString(),
            );
            return;
          }
          // Idempotent. En ägare nedgraderas aldrig; en användare kan bli ägare om appen saknar en.
          // En ny adress ersätter den gamla, men ett anrop utan adress suddar inte ut en känd.
          const role: AppAccessRole = existing === 'owner' ? 'owner' : wanted;
          db.statement(
            'UPDATE app_access SET role = ?, email = COALESCE(?, email) WHERE app_id = ? AND user_id = ?',
          ).run(role, email, appId, userId);
        });
      });
    },

    revokeAccess(appId, userId) {
      return exclusive(async () => {
        assertAppExists(appId);
        if (!isUserId(userId)) rejectAccess('Användaren är ogiltig.');
        const row = db.statement('SELECT role FROM app_access WHERE app_id = ? AND user_id = ?').get(appId, userId);
        // Utan ägare skulle ingen kunna förvalta appen längre.
        if (row?.['role'] === 'owner') rejectAccess('Ägarens åtkomst går inte att ta bort.');
        db.statement("DELETE FROM app_access WHERE app_id = ? AND user_id = ? AND role = 'user'").run(appId, userId);
      });
    },

    async listAccess(appId) {
      assertOpen();
      assertAppExists(appId);
      const rows = db
        .statement(
          `SELECT user_id, role, email, added_at FROM app_access
            WHERE app_id = ?
            ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, added_at, rowid`,
        )
        .all(appId);
      const members: AppMember[] = [];
      for (const row of rows) {
        const userId = row['user_id'];
        const role = ACCESS_ROLES.get(row['role']);
        const email = row['email'];
        const addedAt = row['added_at'];
        if (typeof userId !== 'string' || role === undefined || typeof addedAt !== 'string') continue;
        if (email !== null && typeof email !== 'string') continue;
        members.push({ userId, role, email, addedAt });
      }
      return members;
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
