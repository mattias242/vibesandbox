/**
 * Kontrollrummets rena logik: felmeddelanden i klarspråk och etiketten för en apps läge.
 *
 * 403 är det viktiga fallet. Gränssnittet visar länken till kontrollrummet bara för den som
 * bär rollen, men servern är den som avgör — och den som ändå hamnar här ska få veta varför,
 * inte se en trasig sida.
 */
import { describe, expect, it } from 'vitest';
import type { AdminUser, Role } from '@vibesandbox/contracts';
import { ApiError } from '../src/api.ts';
import {
  ADMIN_CONFLICT,
  ADMIN_EMPTY_EMAIL,
  ADMIN_FORBIDDEN,
  ADMIN_INVALID_EMAIL,
  ADMIN_RATE_LIMITED,
  ADMIN_SELF_REFUSED,
  ADMIN_WRITE_FORBIDDEN,
  ROLES,
  ROLE_TEXTS,
  adminErrorMessage,
  countRoles,
  inviteErrorMessage,
  invitedMessage,
  roleChangedMessage,
  roleErrorMessage,
  roleLabel,
  statusOf,
  validateInviteEmail,
  withUser,
} from '../src/admin.ts';

/** En rad ur kontrollrummets adresslista. `self` är falskt om inget annat sägs. */
function user(userId: string, role: Role, self = false): AdminUser {
  return { userId, email: `${userId}@example.se`, role, createdAt: '2026-09-01T08:00:00Z', self };
}

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

/**
 * Rollernas namn i gränssnittet. `admin`/`builder`/`viewer` är kontraktets ord, inte människors —
 * vyn säger Förvaltare, Byggare och Besökare, och förklarar vad var och en får göra. Skillnaden
 * mellan dem är inte självklar för den som ska välja, så förklaringen hör ihop med namnet.
 */
describe('rollernas namn och förklaringar', () => {
  it('har ett svenskt namn och en förklaring för var och en av kontraktets tre roller', () => {
    expect(ROLES).toEqual(['admin', 'builder', 'viewer']);
    for (const role of ROLES) {
      const text = ROLE_TEXTS[role];
      expect(text.label).toMatch(/^[A-ZÅÄÖ][a-zåäö]+$/);
      expect(text.explanation.length).toBeGreaterThan(20);
      expect(text.explanation).toMatch(/\.$/);
    }
  });

  it('namnen är begripliga svenska ord, inte kontraktets engelska', () => {
    const labels = ROLES.map((role) => roleLabel(role));
    expect(labels).toEqual(['Förvaltare', 'Byggare', 'Besökare']);
    for (const label of labels) expect(label).not.toMatch(/admin|builder|viewer/i);
  });

  it('två roller får aldrig heta samma sak', () => {
    expect(new Set(ROLES.map(roleLabel)).size).toBe(ROLES.length);
  });
});

describe('countRoles', () => {
  it('räknar adresserna per roll', () => {
    expect(countRoles([user('u1', 'admin'), user('u2', 'builder'), user('u3', 'builder')])).toEqual({
      admin: 1,
      builder: 2,
      viewer: 0,
    });
  });

  it('en tom lista är tre nollor, inte ett tomt objekt', () => {
    expect(countRoles([])).toEqual({ admin: 0, builder: 0, viewer: 0 });
  });
});

describe('withUser', () => {
  it('byter ut raden som servern svarade om, på sin plats i listan', () => {
    const before = [user('u1', 'admin'), user('u2', 'viewer'), user('u3', 'builder')];
    const after = withUser(before, { ...user('u2', 'viewer'), role: 'builder' });
    expect(after.map((row) => row.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(after[1]?.role).toBe('builder');
  });

  it('en adress som inte fanns läggs sist', () => {
    const after = withUser([user('u1', 'admin')], user('u9', 'viewer'));
    expect(after.map((row) => row.userId)).toEqual(['u1', 'u9']);
  });

  it('rör inte listan den fick', () => {
    const before = [user('u1', 'admin')];
    withUser(before, user('u2', 'viewer'));
    expect(before).toHaveLength(1);
  });
});

describe('besked efter en ändring', () => {
  it('en ny adress får veta att den är inbjuden, med rollens svenska namn', () => {
    const message = invitedMessage(user('u9', 'builder'), false);
    expect(message).toContain('u9@example.se');
    expect(message).toContain('Byggare');
    expect(message).not.toMatch(/builder/i);
  });

  it('en adress som redan fanns fick en ny roll — inte en inbjudan', () => {
    const message = invitedMessage(user('u2', 'admin'), true);
    expect(message).toContain('Förvaltare');
    expect(message).not.toMatch(/inbjud/i);
  });

  it('en sparad roll säger vilken roll det blev', () => {
    expect(roleChangedMessage(user('u2', 'viewer'))).toContain('Besökare');
  });
});

describe('fel vid en ändring möts med klarspråk', () => {
  it('403 säger att behörigheten är borta, inte "forbidden"', () => {
    for (const message of [inviteErrorMessage(new ApiError(403, 'x')), roleErrorMessage(new ApiError(403, 'x'))]) {
      expect(message).toBe(ADMIN_WRITE_FORBIDDEN);
      expect(message).not.toMatch(/403|forbidden|http/i);
    }
  });

  it('409 säger att någon annan hann före, och vad man gör åt det', () => {
    expect(inviteErrorMessage(new ApiError(409, 'x'))).toBe(ADMIN_CONFLICT);
    expect(roleErrorMessage(new ApiError(409, 'x'))).toBe(ADMIN_CONFLICT);
    expect(ADMIN_CONFLICT).toMatch(/[Ll]adda om/);
  });

  it('429 säger att man gjort många ändringar på kort tid', () => {
    expect(inviteErrorMessage(new ApiError(429, 'x'))).toBe(ADMIN_RATE_LIMITED);
    expect(roleErrorMessage(new ApiError(429, 'x'))).toBe(ADMIN_RATE_LIMITED);
    expect(ADMIN_RATE_LIMITED).not.toMatch(/429|rate/i);
  });

  it('400 betyder olika saker på de två vägarna och sägs därefter', () => {
    expect(inviteErrorMessage(new ApiError(400, 'x'))).toBe(ADMIN_INVALID_EMAIL);
    expect(roleErrorMessage(new ApiError(400, 'x'))).toBe(ADMIN_SELF_REFUSED);
  });

  it('något som inte är ett API-fel blir en vänlig mening utan teknik', () => {
    for (const message of [inviteErrorMessage(new TypeError('x is not a function')), roleErrorMessage(null)]) {
      expect(message).not.toMatch(/TypeError|function|null/);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('validateInviteEmail', () => {
  it('tom ruta ber om adressen — den säger inte att den är felskriven', () => {
    const result = validateInviteEmail('   ');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe(ADMIN_EMPTY_EMAIL);
    expect(ADMIN_EMPTY_EMAIL).not.toBe(ADMIN_INVALID_EMAIL);
  });

  it('en adress som inte är en adress avvisas innan något skickas', () => {
    expect(validateInviteEmail('anna').ok).toBe(false);
  });

  it('en riktig adress normaliseras till gemener utan blanktecken', () => {
    const result = validateInviteEmail('  Anna@Example.SE ');
    expect(result).toEqual({ ok: true, email: 'anna@example.se' });
  });
});
