/**
 * Kontrollrummets rena logik: felmeddelanden i klarspråk och etiketten för en apps läge.
 *
 * 403 är det viktiga fallet. Gränssnittet visar länken till kontrollrummet bara för den som
 * bär rollen, men servern är den som avgör — och den som ändå hamnar här ska få veta varför,
 * inte se en trasig sida.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ADMIN_FORBIDDEN, adminErrorMessage, statusOf } from '../src/admin.ts';

describe('adminErrorMessage', () => {
  it('403 blir en mening om behörighet, inte serverns allmänna text', () => {
    expect(adminErrorMessage(new ApiError(403, 'Du har inte behörighet att göra det här.'))).toBe(ADMIN_FORBIDDEN);
    expect(ADMIN_FORBIDDEN).toMatch(/administrerar plattformen/);
    expect(ADMIN_FORBIDDEN).not.toMatch(/403|forbidden|http/i);
  });

  it('andra fel visas som de är', () => {
    expect(adminErrorMessage(new ApiError(0, 'Kunde inte nå servern.'))).toBe('Kunde inte nå servern.');
  });

  it('något som inte är ett API-fel blir en vänlig mening utan teknik', () => {
    const message = adminErrorMessage(new TypeError('x is not a function'));
    expect(message).not.toMatch(/TypeError|function/);
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('statusOf', () => {
  it('publicerad app', () => {
    expect(statusOf({ published: true, hasDraft: false })).toEqual({
      label: 'Publicerad',
      published: true,
      note: null,
    });
  });

  it('publicerad app med ett nyare utkast säger att den ändrats sedan dess', () => {
    const state = statusOf({ published: true, hasDraft: true });
    expect(state.label).toBe('Publicerad');
    expect(state.note).toMatch(/[Ää]ndrad/);
  });

  it('opublicerad app', () => {
    expect(statusOf({ published: false, hasDraft: true })).toEqual({ label: 'Utkast', published: false, note: null });
  });

  it('app som ännu inte byggts', () => {
    expect(statusOf({ published: false, hasDraft: false }).label).toBe('Inte byggd än');
  });
});
