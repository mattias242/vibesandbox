/**
 * Från validerat värdnamn till `TenantContext`.
 *
 * DETTA ÄR DET ENDA STÄLLET I HELA PLATTFORMEN som anropar `unsafeCreateTenantContext`.
 * Ett kontext skapas först när (1) värdnamnet matchat allowlisten i vardnamn.ts — enda vägen
 * till ett `ParsedHost` — och (2) registret bekräftat att appen finns och har just den version
 * värdnamnet pekar på. Ingenting ur sökväg, fråga, kropp eller andra huvuden når den här filen.
 *
 * Hanteraren anropar detta EFTER autentiseringen: en oinloggad ska varken kunna avgöra om ett
 * app-id finns eller kosta plattformen ett registeruppslag.
 */
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppRegistry, TenantContext } from '@vibesandbox/contracts';
import { appNotFound } from './fel.ts';
import type { ParsedHost } from './vardnamn.ts';

export async function resolveTenant(parsed: ParsedHost, registry: AppRegistry): Promise<TenantContext> {
  const app = await registry.find(parsed.appId);

  // Samma svar för "appen finns inte" och "appen saknar den här versionen", så att svaret inte
  // röjer att ett utkast eller en publicering existerar. Jämförelsen av app-id är ett skydd mot
  // ett register som av misstag svarar med en annan app än den vi frågade efter.
  if (app === null || app.appId !== parsed.appId) throw appNotFound();
  const versionExists = parsed.kind === 'published' ? app.published === true : app.draft === true;
  if (!versionExists) throw appNotFound();

  return unsafeCreateTenantContext(parsed.appId, parsed.kind);
}
