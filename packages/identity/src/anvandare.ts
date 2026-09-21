/**
 * Användare: vilka adresser som får logga in, och med vilken roll. Används av både leverantören
 * (inbjudningar) och CLI:t (den första byggaren).
 */
import { randomBytes } from 'node:crypto';
import { DataApiError } from '@vibesandbox/contracts';
import type { Role } from '@vibesandbox/contracts';
import { normalizeEmail } from './adress.ts';
import { SQL, USER_ID_BATCH } from './databas.ts';
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
 * Ett användar-id är plattformens eget: synligt tecken, aldrig tomt och aldrig längre än så här.
 * Kontrollen är till för att skräp (NUL, radbrytningar, överlånga strängar) ska stoppas här i
 * stället för att gå vidare till databasen eller till ett svar.
 */
const USER_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

/**
 * En användare som kontrollrummet listar. Bär också när adressen lades in — "sedan när får den
 * här personen logga in" är en styrningsfråga, och ett fält som alltid är tomt vore en lögn.
 * Bara listningen behöver det; `upsertUser` och `setUserRole` svarar om EN rad de just rört.
 */
export interface UserListing extends UserRecord {
  /**
   * Millisekunder sedan epoken, som kolumnen lagrar dem — eller `null` om värdet inte går att
   * läsa. Kolumnen är `NOT NULL` i ett STRICT-schema, så `null` betyder i praktiken en skadad
   * databas. Användaren tas ändå med: den som inte syns i kontrollrummet går inte heller att
   * ändra rollen på, och en osynlig behörighet är farligare än ett saknat datum.
   */
  readonly createdAt: number | null;
}

/**
 * Alla användare, äldst först. En trasig rad hoppas över i stället för att fälla hela listan —
 * kontrollrummet ska kunna visa de övriga. Raden loggas inte: den bär en adress.
 */
export function listUsers(db: IdentityDatabase): UserListing[] {
  const users: UserListing[] = [];
  for (const row of db.statement(SQL.listUsers).all()) {
    const user = rowToUser(row);
    if (user === null) continue;
    const createdAt = row['created_at'];
    users.push({ ...user, createdAt: typeof createdAt === 'number' ? createdAt : null });
  }
  return users;
}

/**
 * Antal användare per roll. ALLA tre rollerna finns som nycklar, även de som är noll — annars
 * måste varje anropare komma ihåg att en saknad nyckel betyder noll.
 */
export function countUsersByRole(db: IdentityDatabase): Record<Role, number> {
  const counts: Record<Role, number> = { admin: 0, builder: 0, viewer: 0 };
  for (const row of db.statement(SQL.countUsersByRole).all()) {
    const { role, total } = row;
    if (isRole(role) && typeof total === 'number') counts[role] = total;
  }
  return counts;
}

/**
 * Adresserna för en lista användar-id, för att fylla i ägare som control bara känner som id.
 * Ett id som inte finns (eller inte ens ser ut som ett id) saknas i resultatet — det får aldrig
 * bli en nyckel med värdet `undefined`, som en anropare kan råka visa.
 *
 * En `Map` och inte ett objekt: ett id som `__proto__` är en vanlig nyckel i en Map.
 */
export function emailsByUserIds(db: IdentityDatabase, userIds: readonly string[]): Map<string, string> {
  const emails = new Map<string, string>();
  const wanted = [...new Set(userIds.filter(isUserId))];

  for (let start = 0; start < wanted.length; start += USER_ID_BATCH) {
    const chunk = wanted.slice(start, start + USER_ID_BATCH);
    // Utfyllnaden upprepar ett id ur omgången: frågan gäller medlemskap, så en dubblett ger inga
    // extra rader — och satsen behåller sitt fasta antal parametrar.
    const padding = chunk[chunk.length - 1];
    if (padding === undefined) break;
    while (chunk.length < USER_ID_BATCH) chunk.push(padding);

    for (const row of db.statement(SQL.emailsByUserIds).all(...chunk)) {
      const { user_id: userId, email } = row;
      if (typeof userId === 'string' && typeof email === 'string') emails.set(userId, email);
    }
  }
  return emails;
}

/**
 * Sätter rollen rakt av — den ENDA vägen att sänka en roll, eftersom `upsertUser` medvetet bara
 * höjer. Ogiltigt id eller ogiltig roll ⇒ `invalid_request`; ett id som inte finns ⇒ `not_found`.
 * Felen nämner varken adressen eller id:t.
 *
 * `now` tas emot för symmetri med `upsertUser` och för att anroparen ska använda plattformens
 * klocka: dagens schema har ingen kolumn för när rollen senast ändrades, och en migrering hör
 * inte hemma här.
 */
export function setUserRole(db: IdentityDatabase, userId: string, role: unknown, now: number): UserRecord {
  if (!isUserId(userId)) throw new DataApiError('invalid_request', 'Ogiltigt användar-id.');
  if (!isRole(role)) throw new DataApiError('invalid_request', 'Okänd roll.');

  // Transaktion, precis som upsertUser: uppslagningen och skrivningen ska se samma rad.
  return db.transaction(() => {
    const existing = rowToUser(db.statement(SQL.findUserById).get({ user_id: userId }));
    if (existing === null) throw new DataApiError('not_found', 'Användaren finns inte.');
    if (existing.role === role) return existing;
    db.statement(SQL.updateUserRole).run({ role, user_id: existing.userId });
    // En sänkt behörighet ska gå att se i efterhand — vem som blev av med vad, och när. Raden
    // bär bara användar-id och tidpunkt; den nya rollen står inte här, eftersom events-tabellen
    // inte har något fält för den och ett hopklistrat `type` vore data förklädd till kod.
    db.statement(SQL.insertEvent).run({ type: 'role_changed', user_id: existing.userId, at: now });
    return { ...existing, role };
  });
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
