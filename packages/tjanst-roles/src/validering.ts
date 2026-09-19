/**
 * Validering av det en app skickar till `roles`. Rena funktioner.
 *
 * Allt som kommer in är fientligt tills motsatsen är visad: fel typ, okända fält, `__proto__`,
 * kontrolltecken och överlånga värden avvisas hellre än "rättas". Inget värde används någonsin
 * som nyckel i ett vanligt objekt — rolluppslag görs i `Set`/`Map` och i databasen — så ett
 * roll-id som `constructor` är ett vanligt id och ger ingen särbehandling.
 */

/** Små bokstäver a–z, siffror och bindestreck; börjar med bokstav eller siffra. Aldrig `/`, `.` eller `_`. */
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_ROLE_NAME_LENGTH = 60;
/** Fler roller än så blir svårt för en människa att dela ut rätt, och det håller lagringen liten. */
export const MAX_ROLES = 20;

export interface RoleDefinition {
  readonly id: string;
  readonly name: string;
}

export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInput';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exakt de här fälten, inga andra — ett okänt fält är hellre ett fel än något som tyst ignoreras. */
function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InvalidInput(message);
  }
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true;
  }
  return false;
}

export function isRoleId(value: unknown): value is string {
  return typeof value === 'string' && ROLE_ID_PATTERN.test(value);
}

export function parseDefinitions(value: unknown): RoleDefinition[] {
  if (!Array.isArray(value)) throw new InvalidInput('Rollerna ska anges som en lista.');
  if (value.length > MAX_ROLES) throw new InvalidInput(`En app kan ha högst ${MAX_ROLES} roller.`);
  const seen = new Set<string>();
  const definitions: RoleDefinition[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) throw new InvalidInput('Varje roll ska ha ett id och ett namn.');
    assertOnlyKeys(item, ['id', 'name'], 'Varje roll ska ha ett id och ett namn, och inget annat.');
    const { id, name } = item;
    if (!isRoleId(id)) {
      throw new InvalidInput('Ett roll-id får bara innehålla små bokstäver a–z, siffror och bindestreck, högst 32 tecken.');
    }
    if (seen.has(id)) throw new InvalidInput('Samma roll-id finns två gånger.');
    if (typeof name !== 'string') throw new InvalidInput('Varje roll ska ha ett namn.');
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ROLE_NAME_LENGTH || hasControlCharacter(trimmed)) {
      throw new InvalidInput(`En rolls namn ska vara 1–${MAX_ROLE_NAME_LENGTH} tecken, utan kontrolltecken.`);
    }
    seen.add(id);
    definitions.push({ id, name: trimmed });
  }
  return definitions;
}

/** `{ roles: [...] }`, där varje roll finns bland `defined`. Ger rollerna utan dubbletter. */
export function parseAssignment(value: unknown, defined: ReadonlySet<string>): string[] {
  if (!isPlainObject(value)) throw new InvalidInput('Ange rollerna som { "roles": [...] }.');
  assertOnlyKeys(value, ['roles'], 'Ange rollerna som { "roles": [...] }, och inget annat.');
  const { roles } = value;
  if (!Array.isArray(roles)) throw new InvalidInput('Ange rollerna som en lista.');
  if (roles.length > MAX_ROLES) throw new InvalidInput(`En medlem kan ha högst ${MAX_ROLES} roller.`);
  const seen = new Set<string>();
  for (const role of roles) {
    // `defined.has` och inte ett objektuppslag: `constructor` eller `__proto__` finns aldrig av sig själv.
    if (!isRoleId(role) || !defined.has(role)) throw new InvalidInput('Rollen finns inte i appen. Inför den först.');
    if (seen.has(role)) throw new InvalidInput('Samma roll finns två gånger.');
    seen.add(role);
  }
  return [...seen];
}
