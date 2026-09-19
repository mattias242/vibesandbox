/**
 * Rollernas lagring: en SQLite-databas i tjänstens egen katalog.
 *
 * Varje rad nycklas på app-id OCH sort (`published`/`draft`) — en app ser aldrig en annan apps
 * roller, och utkastet har egna roller (se index.ts för varför). Filnamnet sätts här, aldrig av
 * något appen skickat.
 *
 * Medlemskapet lagras INTE här; det är control som vet vilka som hör till appen. Tjänsten sparar
 * bara vilka roller ett användar-id har fått, och den som läser filtrerar alltid mot aktuell
 * medlemslista och aktuella definitioner.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TenantContext } from '@vibesandbox/contracts';
import type { RoleDefinition } from './validering.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS role_definitions (
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
    role_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (app_id, kind, role_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS role_assignments (
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (app_id, kind, user_id, role_id),
    FOREIGN KEY (app_id, kind, role_id) REFERENCES role_definitions (app_id, kind, role_id) ON DELETE CASCADE
  ) STRICT;
`;

export interface RoleStore {
  definitions(tenant: TenantContext): RoleDefinition[];
  /** Ersätter alla definitioner. Tilldelningar av roller som inte längre finns tas bort. */
  replaceDefinitions(tenant: TenantContext, definitions: readonly RoleDefinition[]): void;
  /** Användar-id → roller, i definitionernas ordning. */
  assignments(tenant: TenantContext): Map<string, string[]>;
  replaceAssignment(tenant: TenantContext, userId: string, roles: readonly string[]): void;
  /** Tar bort tilldelningar för den som inte längre är medlem. */
  forgetOthers(tenant: TenantContext, members: ReadonlySet<string>): void;
  close(): void;
}

export function openRoleStore(dataDir: string): RoleStore {
  const db = new DatabaseSync(join(dataDir, 'roles.sqlite'), { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  function transaction(work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    definitions(tenant) {
      const rows = db
        .prepare('SELECT role_id, name FROM role_definitions WHERE app_id = ? AND kind = ? ORDER BY position')
        .all(tenant.appId, tenant.kind);
      return rows.map((row) => ({ id: String(row['role_id']), name: String(row['name']) }));
    },

    replaceDefinitions(tenant, definitions) {
      transaction(() => {
        // Tilldelningarna av en borttagen roll följer med (ON DELETE CASCADE). En roll som införs
        // på nytt senare börjar alltså utan innehavare — den som tog bort den menade det.
        const keep = new Set(definitions.map((d) => d.id));
        const existing = db
          .prepare('SELECT role_id FROM role_definitions WHERE app_id = ? AND kind = ?')
          .all(tenant.appId, tenant.kind)
          .map((row) => String(row['role_id']));
        const remove = db.prepare('DELETE FROM role_definitions WHERE app_id = ? AND kind = ? AND role_id = ?');
        for (const id of existing) if (!keep.has(id)) remove.run(tenant.appId, tenant.kind, id);
        const upsert = db.prepare(
          `INSERT INTO role_definitions (app_id, kind, role_id, name, position) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (app_id, kind, role_id) DO UPDATE SET name = excluded.name, position = excluded.position`,
        );
        definitions.forEach((d, position) => upsert.run(tenant.appId, tenant.kind, d.id, d.name, position));
      });
    },

    assignments(tenant) {
      const rows = db
        .prepare(
          `SELECT a.user_id AS user_id, a.role_id AS role_id
             FROM role_assignments a
             JOIN role_definitions d ON d.app_id = a.app_id AND d.kind = a.kind AND d.role_id = a.role_id
            WHERE a.app_id = ? AND a.kind = ?
            ORDER BY d.position`,
        )
        .all(tenant.appId, tenant.kind);
      const result = new Map<string, string[]>();
      for (const row of rows) {
        const userId = String(row['user_id']);
        const list = result.get(userId) ?? [];
        list.push(String(row['role_id']));
        result.set(userId, list);
      }
      return result;
    },

    replaceAssignment(tenant, userId, roles) {
      transaction(() => {
        db.prepare('DELETE FROM role_assignments WHERE app_id = ? AND kind = ? AND user_id = ?').run(tenant.appId, tenant.kind, userId);
        // Främmande nyckel: en roll som tagits bort mellan kontrollen och skrivningen ger ett fel
        // (och därmed 500) hellre än en tilldelning av något som inte finns.
        const insert = db.prepare('INSERT INTO role_assignments (app_id, kind, user_id, role_id) VALUES (?, ?, ?, ?)');
        for (const role of roles) insert.run(tenant.appId, tenant.kind, userId, role);
      });
    },

    forgetOthers(tenant, members) {
      const users = db
        .prepare('SELECT DISTINCT user_id FROM role_assignments WHERE app_id = ? AND kind = ?')
        .all(tenant.appId, tenant.kind)
        .map((row) => String(row['user_id']));
      const stale = users.filter((userId) => !members.has(userId));
      if (stale.length === 0) return;
      transaction(() => {
        const remove = db.prepare('DELETE FROM role_assignments WHERE app_id = ? AND kind = ? AND user_id = ?');
        for (const userId of stale) remove.run(tenant.appId, tenant.kind, userId);
      });
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}
