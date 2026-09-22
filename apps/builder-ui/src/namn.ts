/**
 * Prövningen av ett appnamn, skild från vyn så att den går att pröva utan webbläsare — samma
 * upplägg som `share.ts` har för e-postadresser.
 *
 * Prövningen här är en vänlighet, inte en spärr. Servern gör samma kontroll igen och är den som
 * avgör; det här sparar bara ägaren ett anrop för att få veta något hon redan vet. Den är därför
 * med flit SLAPPARE än serverns: den säger ifrån om tomt och för långt, men letar inte efter
 * styrtecken. Ett fält som avvisar tecken ägaren inte kan se hade varit en gåta, och det fallet
 * hör hemma hos servern som kan svara i klarspråk.
 */
import { APP_NAME_LIMITS } from '@vibesandbox/contracts';
import { RENAME_EMPTY, renameTooLong } from './texts.ts';

export type NameValidation = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/** Antal tecken (kodpunkter), inte UTF-16-enheter — samma räkning som servern gör. */
function characterCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function validateAppName(raw: string): NameValidation {
  const name = raw.trim();
  if (name === '') return { ok: false, message: RENAME_EMPTY };
  if (characterCount(name) > APP_NAME_LIMITS.maxChars) return { ok: false, message: renameTooLong() };
  return { ok: true, name };
}
