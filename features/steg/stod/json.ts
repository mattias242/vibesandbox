import assert from 'node:assert/strict';
import type { JsonObject } from '@vibesandbox/contracts';

/** Tolkar JSON-objektet som står utskrivet i ett steg, t.ex. `{"svar": "Ja"}`. */
export function somJsonObjekt(text: string): JsonObject {
  const varde: unknown = JSON.parse(text);
  assert.ok(typeof varde === 'object' && varde !== null && !Array.isArray(varde), `Inte ett JSON-objekt: ${text}`);
  return varde as JsonObject;
}
