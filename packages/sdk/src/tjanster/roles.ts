/**
 * Tjänsten `roles` för appar (`/_api/roles`): roller inuti appen, definierade av appen och
 * tilldelade av ägaren. Dokumentationen för byggagenten står i packages/sdk/tjanster/roles.md.
 *
 * En roll styr vad appen VISAR — den skyddar inte data. Plattformen tvingar inte rollerna i
 * data-API:t; det som skyddar data är personliga kollektioner.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';

export type AppAccess = 'owner' | 'user';

export interface RoleDefinition {
  /** Små bokstäver a–z, siffror och bindestreck, högst 32 tecken. T.ex. `handlaggare`. */
  readonly id: string;
  /** Det som visas, 1–60 tecken. T.ex. `Handläggare`. */
  readonly name: string;
}

export interface Member {
  readonly userId: string;
  /** E-postadressens lokala del (samma som `whoami`). Adressen lämnas aldrig ut. */
  readonly displayName: string;
  /** `owner` = den som byggde appen, `user` = den som fått appen delad med sig. */
  readonly access: AppAccess;
  readonly roles: readonly string[];
}

export interface Me {
  readonly userId: string;
  readonly access: AppAccess;
  readonly roles: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAccess(value: unknown): value is AppAccess {
  return value === 'owner' || value === 'user';
}

/** Ett svar med oväntad form stoppas här, så att appen inte kraschar på något obegripligt längre fram. */
function check<T>(value: unknown, valid: (value: unknown) => boolean): T {
  if (!valid(value)) throw new SdkError('internal');
  return value as T;
}

const isDefinitions = (v: unknown): boolean =>
  Array.isArray(v) && v.every((d) => isRecord(d) && typeof d['id'] === 'string' && typeof d['name'] === 'string');
const isMember = (m: unknown): boolean =>
  isRecord(m) && typeof m['userId'] === 'string' && typeof m['displayName'] === 'string' && isAccess(m['access']) && isStringArray(m['roles']);
const isMe = (m: unknown): boolean =>
  isRecord(m) && typeof m['userId'] === 'string' && isAccess(m['access']) && isStringArray(m['roles']);

/** Appens medlemmar med visningsnamn, åtkomst och roller. Alla medlemmar får läsa listan. */
export async function members(): Promise<Member[]> {
  return check(await callService('roles', 'GET', '/members'), (v) => Array.isArray(v) && v.every(isMember));
}

/** Den inloggade: användar-id, åtkomst (`owner`/`user`) och roller. */
export async function me(): Promise<Me> {
  return check(await callService('roles', 'GET', '/me'), isMe);
}

/** Rollerna appen har infört, i den ordning ägaren angav. */
export async function definitions(): Promise<RoleDefinition[]> {
  return check(await callService('roles', 'GET', '/definitions'), isDefinitions);
}

/**
 * Ersätter ALLA appens roller (bara ägaren; andra får `SdkError` med koden `forbidden`). En roll
 * som inte finns med i listan tas bort, och den som hade den förlorar den. Högst 20 roller.
 */
export async function setDefinitions(defs: readonly RoleDefinition[]): Promise<RoleDefinition[]> {
  return check(await callService('roles', 'PUT', '/definitions', { json: defs }), isDefinitions);
}

/**
 * Ersätter en medlems roller (bara ägaren). `[]` tar bort alla. Rollerna måste vara införda
 * (`invalid_request` annars) och personen måste vara medlem (`not_found` annars).
 */
export async function assign(userId: string, roles: readonly string[]): Promise<Member> {
  if (typeof userId !== 'string' || userId.length === 0) throw new SdkError('invalid_request');
  // Kodat, så att ett id aldrig kan bli flera segment. `.` och `..` stoppas av callService.
  const path = `/members/${encodeURIComponent(userId)}`;
  return check(await callService('roles', 'PUT', path, { json: { roles } }), isMember);
}

/**
 * Har den inloggade rollen? Ägaren har INTE automatiskt alla roller — fråga `(await me()).access
 * === 'owner'` om det är ägaren som avses. Frågar plattformen varje gång; behöver appen svaret på
 * flera ställen, hämta `me()` en gång och använd `roles` därifrån.
 */
export async function has(role: string): Promise<boolean> {
  return (await me()).roles.includes(role);
}
