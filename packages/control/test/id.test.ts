import { describe, expect, it } from 'vitest';
import { APP_ID_PATTERN, isAppId } from '@vibesandbox/contracts';
import { newAppId } from '../src/id.ts';

describe('App-id: den hemliga delen av delningslänken', () => {
  it('har kontraktets form: 26 tecken Crockford-base32 i gemener', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newAppId();
      expect(id).toMatch(APP_ID_PATTERN);
      expect(isAppId(id)).toBe(true);
    }
  });

  it('är helt slumpat — inget tidsprefix som gör början av länken gissningsbar', () => {
    // Ett ULID skapat samma sekund delar sina första tecken. Här ska även de FÖRSTA tecknen
    // variera: bland 300 id:n skapade i ett svep ska nästan alla inledande fyrteckensföljder
    // vara olika (32^4 ≈ en miljon möjliga).
    const prefix = new Set<string>();
    for (let i = 0; i < 300; i += 1) prefix.add(newAppId().slice(0, 4));
    expect(prefix.size).toBeGreaterThan(290);
  });

  it('använder hela alfabetet i varje position, utan synlig snedvridning', () => {
    const antal = 4000;
    const forekomster = new Map<string, number>();
    for (let i = 0; i < antal; i += 1) {
      for (const tecken of newAppId()) forekomster.set(tecken, (forekomster.get(tecken) ?? 0) + 1);
    }
    expect(forekomster.size).toBe(32);
    // Väntevärdet är antal*26/32 per tecken. En modulo-snedvridning (t.ex. 256 % 30) skulle ge
    // vissa tecken tiotals procent fler träffar; ±10 % rymmer slumpen med mycket god marginal.
    const vantat = (antal * 26) / 32;
    for (const n of forekomster.values()) {
      expect(n).toBeGreaterThan(vantat * 0.9);
      expect(n).toBeLessThan(vantat * 1.1);
    }
  });

  it('ger aldrig samma id två gånger', () => {
    const sedda = new Set<string>();
    for (let i = 0; i < 5000; i += 1) sedda.add(newAppId());
    expect(sedda.size).toBe(5000);
  });
});
