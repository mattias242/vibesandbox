/**
 * Gemensam kontroll av appens skyddsregler (CSP) i ett svar.
 *
 * Varför inte bara `toBe(APP_CONTENT_SECURITY_POLICY)`: gatewayn lägger till `frame-ancestors`
 * per värdsort (förhandsvisningar får ramas in av byggverktyget, inget annat får ramas in alls).
 * Kontraktets konstant saknar det direktivet med avsikt — det beror på värden. Kravet är därför
 * att VARJE direktiv ur konstanten finns ordagrant, att `frame-ancestors` finns exakt en gång med
 * rätt värde, och att inget annat har lagts till. Allt ligger i ETT huvud: två `Content-Security-
 * Policy`-rader skulle webbläsaren tillämpa båda av, men en granskare ska se hela regeln på ett ställe.
 */
import { expect } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY } from '@vibesandbox/contracts';
import { enHuvud } from './hjalp.ts';
import type { AnropSvar } from './hjalp.ts';

/** Direktiven i en CSP, i ordning, utan tomma delar. */
export function cspDirektiv(policy: string): readonly string[] {
  return policy
    .split(';')
    .map((del) => del.trim())
    .filter((del) => del.length > 0);
}

const APPENS_DIREKTIV = cspDirektiv(APP_CONTENT_SECURITY_POLICY);

/** `frame-ancestors` för en publicerad app, ett ogiltigt värdnamn och en förhandsvisning utan byggverktyg. */
export const INGEN_INRAMNING = "'none'";

/** Kräver kontraktets alla direktiv plus exakt `frame-ancestors <varde>` — och inget annat. */
export function forvantaAppensCsp(svar: AnropSvar, frameAncestors: string): void {
  const policy = enHuvud(svar, 'Content-Security-Policy');
  expect(policy, 'svaret saknar Content-Security-Policy').toBeDefined();
  const direktiv = cspDirektiv(policy ?? '');
  for (const krav of APPENS_DIREKTIV) expect(direktiv).toContain(krav);
  expect(direktiv.filter((d) => d.split(/\s+/)[0] === 'frame-ancestors')).toEqual([`frame-ancestors ${frameAncestors}`]);
  expect(direktiv).toHaveLength(APPENS_DIREKTIV.length + 1);
  expect(enHuvud(svar, 'Content-Security-Policy-Report-Only')).toBeUndefined();
}
