/**
 * Användare: vilka adresser som får logga in, och med vilken roll. Används av både leverantören
 * (inbjudningar) och CLI:t (den första byggaren).
 */
import { randomBytes } from 'node:crypto';
import { DataApiError } from '@vibesandbox/contracts';
import type { Role } from '@vibesandbox/contracts';
import { normalizeEmail } from './adress.ts';
import { SQL } from './databas.ts';
import type { IdentityDatabase } from './databas.ts';

/** Högre tal = mer behörighet. En inbjudan kan höja en roll, aldrig sänka den. */
export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, builder: 2, admin: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value);
}

export interface UserRecord {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
}

export interface UpsertResult extends UserRecord {
  /** `true` om adressen inte fanns sedan tidigare. */
  readonly created: boolean;
}

/**
 * Stabilt, slumpat id: 128 bitar, base64url. Aldrig adressen och aldrig en hash av den — en hash
 * av en adress går att räkna fram för den som gissar adressen, och id:t syns i appars data.
 */
function newUserId(): string {
  return randomBytes(16).toString('base64url');
}

export function rowToUser(row: Record<string, unknown> | undefined): UserRecord | null {
  if (row === undefined) return null;
  const { user_id: userId, email, role } = row;
  if (typeof userId !== 'string' || typeof email !== 'string' || !isRole(role)) return null;
  return { userId, email, role };
}

export function findUserByEmail(db: IdentityDatabase, email: string): UserRecord | null {
  return rowToUser(db.statement(SQL.findUserByEmail).get({ email }));
}

/**
 * Lägger till adressen, eller höjer rollen om den nya är högre. Ogiltig adress eller roll ⇒
 * `DataApiError('invalid_request')`.
 */
export function upsertUser(db: IdentityDatabase, rawEmail: unknown, role: unknown, now: number): UpsertResult {
  const email = normalizeEmail(rawEmail);
  if (email === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');
  if (!isRole(role)) throw new DataApiError('invalid_request', 'Okänd roll.');

  return db.transaction(() => {
    const existing = findUserByEmail(db, email);
    if (existing === null) {
      const userId = newUserId();
      db.statement(SQL.insertUser).run({ user_id: userId, email, role, created_at: now });
      return { userId, email, role, created: true };
    }
    if (ROLE_RANK[role] > ROLE_RANK[existing.role]) {
      db.statement(SQL.updateUserRole).run({ role, user_id: existing.userId });
      return { ...existing, role, created: false };
    }
    return { ...existing, created: false };
  });
}
