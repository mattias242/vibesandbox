/**
 * App-id och versions-id: 26 tecken Crockford-base32 i gemener, HELT slumpade (130 bitar).
 *
 * Till skillnad från dokument-id:n (ULID med tidsprefix, se data-api) får ett app-id inte ha
 * någon förutsägbar del: id:t ingår i värdnamnet och ÄR den hemliga delningslänken. Ett
 * tidsprefix skulle göra tio av de tjugosex tecknen gissningsbara för den som vet ungefär när
 * appen skapades.
 */
import { randomBytes } from 'node:crypto';
import { isAppId } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';

/** Crockfords alfabet utesluter i, l, o och u. Samma teckenuppsättning som `APP_ID_PATTERN`. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LENGTH = 26;

function randomId(): string {
  // En byte per tecken, de fem lägsta bitarna används. 256 är jämnt delbart med 32, så varje
  // tecken är likformigt fördelat — ingen modulo-snedvridning.
  let id = '';
  for (const byte of randomBytes(ID_LENGTH)) id += ALPHABET.charAt(byte & 31);
  return id;
}

export function newAppId(): AppId {
  const id = randomId();
  // Kan inte slå till så länge alfabetet ovan och kontraktets mönster hör ihop. Kontrollen finns
  // för den dag någon ändrar det ena utan det andra: hellre ett stopp här än en app som aldrig nås.
  if (!isAppId(id)) throw new Error('Det genererade app-id:t matchar inte kontraktets mönster.');
  return id;
}

/** Versioner namnges av plattformen på samma sätt; id:t är inte hemligt men ska inte gå att räkna upp. */
export function newVersionId(): string {
  return randomId();
}

export const VERSION_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;
