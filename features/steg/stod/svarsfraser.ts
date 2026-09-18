/**
 * Scenariernas svarsfraser → plattformens felsvar. EN tabell, så att det finns ett enda ställe
 * där verksamhetens språk ("finns inte") möter teknikens (404 `not_found`).
 */
import type { ApiErrorCode } from '@vibesandbox/contracts';

export interface VantatFelsvar {
  readonly status: number;
  readonly kod: ApiErrorCode;
}

const SVARSFRASER: ReadonlyMap<string, VantatFelsvar> = new Map([
  ['finns inte', { status: 404, kod: 'not_found' }],
  ['ogiltig begäran', { status: 400, kod: 'invalid_request' }],
  ['inte inloggad', { status: 401, kod: 'unauthenticated' }],
  ['åtkomst nekad', { status: 403, kod: 'forbidden' }],
  ['för stort', { status: 413, kod: 'too_large' }],
  ['lagringsutrymmet är slut', { status: 507, kod: 'quota_exceeded' }],
  ['kollektionen har en annan synlighet', { status: 409, kod: 'scope_mismatch' }],
]);

export function vantatFelsvar(fras: string): VantatFelsvar {
  const vantat = SVARSFRASER.get(fras);
  if (vantat === undefined) {
    throw new Error(`Okänd svarsfras "${fras}". Kända fraser: ${[...SVARSFRASER.keys()].join(', ')}.`);
  }
  return vantat;
}
