/**
 * Är förfrågan en sidnavigering — en människa som klickat på en länk — eller ett anrop från kod?
 *
 * EN definition, för att svaret måste vara detsamma på båda ställena det avgörs: omdirigeringen
 * av en oinloggad navigering till inloggningssidan (inloggningssida.ts) och valet mellan en
 * felsida och ett API-svar (felsida.ts). Skulle de två glida isär kunde samma förfrågan räknas
 * som en navigering i det ena steget och som kod i det andra, och besökaren få ett 401 i JSON
 * där hon skulle ha fått en sida.
 *
 * `Sec-Fetch-Mode` avgör ensamt när det finns: `cors`, `no-cors` och `same-origin` är skript och
 * resurser, `navigate` är adressfältet eller en länk. Bara när huvudet saknas helt — äldre
 * webbläsare — faller vi tillbaka på `Accept`. Ordningen är viktig: ett `fetch()` från appens kod
 * kan sätta vilket `Accept` som helst, men kan inte sätta `Sec-Fetch-Mode`, som webbläsaren äger.
 */

/** Bara hämtande metoder kan vara en sidnavigering. En POST är alltid ett anrop. */
const NAVIGATION_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function isPageNavigation(
  method: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  if (!NAVIGATION_METHODS.has(method)) return false;
  const mode = headers['sec-fetch-mode'];
  // Finns Sec-Fetch avgör det ensamt: `cors`, `no-cors`, `same-origin` är skript och resurser.
  if (mode !== undefined) return mode === 'navigate';
  const accept = headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

/**
 * Ska nekandet besvaras med en felsida i stället för ett API-svar?
 *
 * Två villkor, båda nödvändiga. Det ska vara en sidnavigering — en människa, inte kod. Och
 * sökvägen ska ligga UTANFÖR `/_api/` och `/_auth/`: det är gränsen inloggningsvägen redan drar
 * (inloggningssida.ts), och av samma skäl. Data-API:t har ett kontrakt att hålla, och appens kod
 * ska få ett fel den kan hantera även när anropet bär huvuden som ser ut som en navigering.
 * Prövningen sker på de NORMALISERADE segmenten, så `/%5Fapi/` är samma sak som `/_api/`.
 *
 * En ogiltig sökväg ger `false`: vet vi inte vad som frågades efter svarar vi som förut.
 */
export function shouldRenderFailurePage(
  method: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  segments: readonly string[] | undefined,
  reservedSegments: readonly string[],
): boolean {
  if (segments === undefined) return false;
  if (!isPageNavigation(method, headers)) return false;
  const first = segments[0];
  return first === undefined || !reservedSegments.includes(first);
}
