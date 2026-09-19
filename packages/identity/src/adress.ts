/**
 * E-postadresser: normalisering och validering. Ren funktion, ingen I/O.
 *
 * Mönstret är medvetet STRÄNGARE än RFC 5322. En adress här blir både en nyckel i databasen och
 * en mottagare i ett HTTP-anrop till Mailgun, och varje exotisk form (citerad lokal del,
 * IP-literal, kommentarer, IDN) är ett ställe där två tolkningar kan skilja sig åt — eller där en
 * radbrytning eller ett kommatecken smyger in en extra mottagare. Den som har en sådan adress får
 * be om en vanlig.
 *
 * Normaliseringen gör gemener av HELA adressen. Tekniskt får den lokala delen vara
 * skiftlägeskänslig, men i praktiken är den aldrig det, och två konton för `Anna@` och `anna@`
 * vore värre. Ingen `+`-hantering: `anna+x@` är en egen adress, precis som den ser ut.
 */

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** Punktseparerade atomer ur RFC 5322 `dot-atom`, utan citattecken och bara ASCII. */
const LOCAL_PART = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
/** DNS-etiketter, minst två, med en toppdomän av bokstäver. Ingen avslutande punkt. */
const DOMAIN_PART = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}';
const ADDRESS_PATTERN = new RegExp(`^(${LOCAL_PART})@(${DOMAIN_PART})$`);

/**
 * Trimmar och gör till gemener, och returnerar adressen om den är giltig — annars `null`.
 * Kastar aldrig, oavsett indata.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // Längden prövas FÖRE regexen, så att skräp aldrig ens når den.
  if (input.length > MAX_ADDRESS_LENGTH * 2) return null;
  // Bara ASCII redan FÖRE gemenerna: `toLowerCase` gör t.ex. Kelvin-tecknet (U+212A) till ett
  // vanligt `k`, och en adress ska inte kunna stavas på två sätt som blir samma.
  if (!/^[\x20-\x7e\t]*$/.test(input)) return null;
  const address = input.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  const match = ADDRESS_PATTERN.exec(address);
  if (match === null) return null;
  if ((match[1] ?? '').length > MAX_LOCAL_LENGTH) return null;
  return address;
}
