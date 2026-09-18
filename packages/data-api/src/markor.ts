/**
 * Markören (`cursor`) för sidindelning.
 *
 * Säkerhetsmodellen i en mening: markören bär ENBART en position — aldrig en behörighet.
 * Vilken kollektion och vilken ägare en listning gäller kommer alltid ur anropet (och därmed ur
 * gatewayns TenantContext och identitet) och står som villkor i SQL-frågan. En manipulerad markör
 * kan därför som värst flytta läsaren till en annan plats i den lista hen redan får se.
 * Det är också skälet till att markören inte är signerad: det finns inget att förfalska sig till,
 * och en signeringsnyckel skulle behöva överleva omstarter och delas mellan processer.
 *
 * Formatet är en intern angelägenhet och får ändras (byt då versionsprefix). Klienten ska bara
 * skicka tillbaka strängen oförändrad. Base64url-kodningen döljer ingenting och behöver inte göra
 * det — den finns för att markören ska vara URL-säker och inte se ut som ett fält att bygga på.
 * Kollektion och scope ingår för att fånga ärliga misstag — en markör som återanvänds mot fel
 * lista ger ett tydligt fel i stället för en förbryllande sida.
 */
import type { CollectionScope } from '@vibesandbox/contracts';
import { dataApiError } from './fel.ts';

const VERSION = 'v1';

/** Längsta tänkbara giltiga markör är runt 130 tecken; allt över taket är skräp och avkodas inte. */
const MAX_CURSOR_LENGTH = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Samma teckenregler som COLLECTION_NAME_PATTERN och DOCUMENT_ID_PATTERN, i ett enda uttryck. */
const PAYLOAD_PATTERN = /^v1:(app|user):([a-z][a-z0-9_-]{0,63}):([0-9a-hjkmnp-tv-z]{26})$/;

export function encodeCursor(
  collection: string,
  scope: CollectionScope,
  lastDocumentId: string,
): string {
  const payload = `${VERSION}:${scope}:${collection}:${lastDocumentId}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Ger id:t för det sista dokumentet på föregående sida. Allt som inte är exakt rätt avvisas. */
export function decodeCursor(
  cursor: unknown,
  collection: string,
  scope: CollectionScope,
): string {
  if (
    typeof cursor !== 'string' ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(cursor)
  ) {
    throw invalidCursor();
  }

  const payload = Buffer.from(cursor, 'base64url').toString('utf8');
  // Nodes base64-avkodare är förlåtande. Kräv att strängen är exakt den vi själva skulle ha
  // skapat, så att det bara finns EN giltig markör per position.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== cursor) throw invalidCursor();

  const match = PAYLOAD_PATTERN.exec(payload);
  if (match === null) throw invalidCursor();
  const [, cursorScope, cursorCollection, lastDocumentId] = match;
  if (cursorScope !== scope || cursorCollection !== collection || lastDocumentId === undefined) {
    throw invalidCursor();
  }
  return lastDocumentId;
}

function invalidCursor(): Error {
  return dataApiError('invalid_request', 'Ogiltig markör för sidindelning. Börja om från första sidan.');
}
