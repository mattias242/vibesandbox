/**
 * Validering av allt som kommer utifrån — körs FÖRE all I/O.
 *
 * Typerna i `TenantStore` är ett löfte från anroparen, inte en garanti: värdena har färdats över
 * nätverket. Varje funktion här tar därför `unknown` och litar inte på TypeScript.
 */
import {
  COLLECTION_NAME_PATTERN,
  DOCUMENT_ID_PATTERN,
  type CollectionScope,
  type Identity,
} from '@vibesandbox/contracts';
import { dataApiError } from './fel.ts';

/**
 * Djupare nästling än så här avvisas. Utan gräns kan ett dokument som `[[[[…]]]]` få den
 * rekursiva kontrollen att slå i stackgränsen, och då blir ett klientfel ett serverfel.
 */
const MAX_NESTING_DEPTH = 64;

/** Rimlig övre gräns för ett användar-id; skyddar index och loggar mot orimliga värden. */
const MAX_USER_ID_LENGTH = 256;

export function validateCollectionName(name: unknown): string {
  if (typeof name !== 'string' || !COLLECTION_NAME_PATTERN.test(name)) {
    throw dataApiError(
      'invalid_request',
      'Ogiltigt namn på samlingen. Använd små bokstäver, siffror, bindestreck och understreck.',
    );
  }
  return name;
}

export function validateDocumentId(id: unknown): string {
  if (typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)) {
    throw dataApiError('invalid_request', 'Ogiltigt dokument-id.');
  }
  return id;
}

export function validateScope(scope: unknown): CollectionScope {
  if (scope !== 'app' && scope !== 'user') {
    throw dataApiError('invalid_request', 'Ogiltigt scope. Tillåtna värden är "app" och "user".');
  }
  return scope;
}

/**
 * Ägaren till personliga dokument. Ett tomt eller saknat användar-id får aldrig bli ett giltigt
 * ägarvärde — då skulle alla "okända" användare dela dokument. Osäkerhet ⇒ neka.
 */
export function validateUserId(identity: Identity): string {
  const userId: unknown = identity?.userId;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
    throw dataApiError('unauthenticated', 'Du behöver logga in.');
  }
  return userId;
}

/** Sidstorlek: ett heltal ≥ 1 som kläms till plattformens tak. Saknas den används standardvärdet. */
export function validatePageSize(limit: unknown, defaultSize: number, maxPageSize: number): number {
  if (limit === undefined) return Math.min(defaultSize, maxPageSize);
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw dataApiError('invalid_request', 'Ogiltig sidstorlek. Ange ett heltal som är minst 1.');
  }
  return Math.min(limit, maxPageSize);
}

/**
 * Kontrollerar att `data` är ett vanligt JSON-objekt och ger tillbaka den serialiserade texten.
 *
 * Varför inte bara `JSON.stringify`: den är tyst förlåtande. `undefined` och funktioner försvinner,
 * `NaN` blir `null`, ett `Date` blir en sträng. Appen skulle då få tillbaka något annat än den
 * sparade — så allt som inte överlever en JSON-rundtur oförändrat avvisas i stället.
 *
 * Storleken mäts i BYTES av UTF-8-texten. Tecken räcker inte: "å" är två bytes och en emoji fyra,
 * och det är bytes som tar plats på disken.
 */
export function serializeDocumentData(data: unknown, maxDocumentBytes: number): string {
  if (!isPlainObject(data)) {
    throw dataApiError('invalid_request', 'Dokumentets innehåll måste vara ett JSON-objekt.');
  }
  assertJsonValue(data, 0, new Set());

  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > maxDocumentBytes) {
    throw dataApiError('too_large', 'Dokumentet är för stort för att sparas.');
  }
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `ancestors` håller vägen från roten hit, så att cirkulära strukturer upptäcks. */
function assertJsonValue(value: unknown, depth: number, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw notJson();
    return;
  }
  if (typeof value !== 'object') throw notJson(); // undefined, funktion, symbol, bigint

  if (depth >= MAX_NESTING_DEPTH || ancestors.has(value)) throw notJson();
  ancestors.add(value);
  if (Array.isArray(value)) {
    // Indexloop i stället för for…of: hål i en gles array ska synas som `undefined` och avvisas.
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], depth + 1, ancestors);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) assertJsonValue(value[key], depth + 1, ancestors);
  } else {
    throw notJson(); // Date, Map, klassinstanser …
  }
  ancestors.delete(value);
}

function notJson(): Error {
  return dataApiError(
    'invalid_request',
    'Dokumentets innehåll får bara bestå av text, tal, sant/falskt, null, listor och objekt.',
  );
}
