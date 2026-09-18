/**
 * Huvuden: de skyddsregler som sätts på VARJE svar, och läsningen av inkommande huvuden.
 */
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { APP_CONTENT_SECURITY_POLICY } from '@vibesandbox/contracts';

/**
 * Skyddsreglerna som data, så att de går att sätta även där det inte finns något
 * `ServerResponse` — nämligen i svaret på en förfrågan som Nodes HTTP-tolk själv vägrat
 * (se server.ts). Det finns EN lista; inget svar från en app-origin får sakna något ur den.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [name: string, value: string]> = [
  // Exakt kontraktets värde. `connect-src 'self'` är det som hindrar appkod från att ringa hem.
  ['Content-Security-Policy', APP_CONTENT_SECURITY_POLICY],
  // Webbläsaren får inte gissa innehållstyp — annars kan en uppladdad "bild" köras som skript.
  ['X-Content-Type-Options', 'nosniff'],
  // Appens adress ÄR den hemliga delningslänken; den får aldrig följa med till en annan webbplats.
  ['Referrer-Policy', 'no-referrer'],
  // Alla appar ligger under samma site (ADR 0002) och kan därmed hamna i samma webbläsarprocess.
  // Med detta vägrar webbläsaren ladda in den här appens svar som bild/skript hos en annan app.
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  // Allt ligger bakom inloggning. Ingen cache får spara det; finare cachning av byggda filer med
  // hashade namn är en senare optimering.
  ['Cache-Control', 'no-store'],
];

/**
 * Sätts allra först i hanteraren, innan något kan gå fel, så att även 400/401/404/500 bär dem.
 * Appens kod kan inte påverka dem: en `<meta http-equiv>` kan bara skärpa en CSP från
 * svarshuvudet, aldrig lätta den.
 */
export function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of SECURITY_HEADERS) response.setHeader(name, value);
}

/**
 * Huvuden som gatewayn fattar beslut på och som därför bara får förekomma EN gång.
 * Node behåller tyst det första värdet för bl.a. `host` och `authorization`; en proxy framför oss
 * kan lika gärna välja det sista. Två tolkningar av samma förfrågan är precis den sortens glapp
 * som angrepp byggs på — så dubbletter nekas i stället för att tolkas.
 */
const SINGLE_VALUE_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'authorization',
  'content-type',
  'content-length',
  'origin',
]);

/** `rawHeaders` är Nodes platta lista [namn, värde, namn, värde, …] med ALLA förekomster. */
export function hasDuplicateOfSingleValueHeader(rawHeaders: readonly string[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase();
    if (!SINGLE_VALUE_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * Huvudena i den form kontraktets `AuthRequest` beskriver: gemena nycklar, ett strängvärde.
 * Hela uppsättningen lämnas till identitetsleverantören (även `cookie`), men gatewayn själv
 * fattar inga beslut på kakor och sätter aldrig någon.
 */
export function toAuthHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name] = value;
    // Listvärden ger Node bara för `set-cookie`, som inte hör hemma i en förfrågan. Utelämnas.
  }
  return result;
}
