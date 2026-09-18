import { COLLECTION_NAME_PATTERN, DOCUMENT_ID_PATTERN } from '@vibesandbox/contracts';
import type { JsonObject } from '@vibesandbox/contracts';
import { SdkError } from './errors.ts';

/**
 * Kontrolleras i SDK:t och inte bara på servern: ett namn som `../x` ska aldrig ens bli
 * en sökväg, och den som skriver appen får felet direkt i stället för vid första anropet.
 */
export function assertCollectionName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !COLLECTION_NAME_PATTERN.test(name)) {
    throw new SdkError(
      'invalid_request',
      'Ogiltigt kollektionsnamn. Använd bara små bokstäver a–z, siffror, bindestreck och understreck, ' +
        'börja med en bokstav och använd högst 64 tecken – till exempel "bokningar".',
    );
  }
}

export function assertDocumentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)) {
    throw new SdkError('invalid_request', 'Ogiltigt dokument-id. Använd det id som add() eller list() gav tillbaka.');
  }
}

/**
 * Ger en fristående JSON-kopia av `data`. Kopian gör att alla adaptrar lagrar exakt det som
 * skulle ha gått över nätverket (t.ex. försvinner fält som är `undefined`).
 */
export function toJsonObject(data: unknown): JsonObject {
  if (!isPlainObject(data)) {
    throw new SdkError('invalid_request', 'Det som sparas måste vara ett objekt, till exempel { rum: "Stora salen" }.');
  }
  try {
    return JSON.parse(JSON.stringify(data)) as JsonObject;
  } catch {
    throw new SdkError(
      'invalid_request',
      'Det som sparas får bara innehålla text, tal, sant/falskt, listor och objekt.',
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
