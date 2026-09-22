/**
 * Kontrollrummets rena logik: felmeddelanden i klarspråk och etiketten för en apps läge.
 *
 * 403 är det viktiga fallet. Gränssnittet visar länken till kontrollrummet bara för den som
 * bär rollen, men servern är den som avgör — och den som ändå hamnar här ska få veta varför,
 * inte se en trasig sida.
 */
import { describe, expect, it } from 'vitest';
import {
  REDLINE_CATEGORIES,
  type AdminStop,
  type AdminUser,
  type RedlineCategory,
  type Role,
} from '@vibesandbox/contracts';
import { ApiError } from '../src/api.ts';
import {
  ADMIN_CONFLICT,
  ADMIN_EMPTY_EMAIL,
  ADMIN_FORBIDDEN,
  ADMIN_INVALID_EMAIL,
  ADMIN_RATE_LIMITED,
  ADMIN_SELF_REFUSED,
  ADMIN_STOPS_EMPTY,
  ADMIN_STOPS_PATTERN_NOTE,
  ADMIN_STOPS_PRIVACY_NOTE,
  ADMIN_WRITE_FORBIDDEN,
  REDLINE_TEXTS,
  ROLES,
  ROLE_TEXTS,
  adminErrorMessage,
  countRoles,
  countStops,
  inviteErrorMessage,
  invitedMessage,
  roleChangedMessage,
  roleErrorMessage,
  roleLabel,
  statusOf,
  validateInviteEmail,
  withUser,
  type RedlineText,
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

/**
 * Kontrollrummets fjärde del: önskemål som stoppats av en röd linje.
 *
 * Kategorikoderna i kontraktet är maskintext. Här låses att var och en av dem har en begriplig
 * svensk rubrik och en mening om vad den betyder — en ny kategori i kontraktet fäller testet
 * tills den fått sin text, i stället för att tyst visas som `kansloigenkanning` för en förvaltare.
 */
describe('röda linjer i kontrollrummet', () => {
  it('varje kategori i kontraktet har en rubrik och en förklaring', () => {
    for (const category of REDLINE_CATEGORIES) {
      const text = REDLINE_TEXTS[category] as RedlineText | undefined;
      expect(text, `kategorin ${category} saknar text`).toBeDefined();
      expect(text!.label.length, `${category}: rubriken är för kort`).toBeGreaterThan(5);
      expect(text!.explanation.length, `${category}: förklaringen är för kort`).toBeGreaterThan(30);
    }
  });

  it('rubriken är svenska ord, aldrig kontraktets maskintext', () => {
    for (const category of REDLINE_CATEGORIES) {
      const { label, explanation } = REDLINE_TEXTS[category];
      expect(label, 'maskintexten hör inte hemma i vyn').not.toContain(category);
      expect(explanation).not.toContain(category);
      expect(label, 'en rubrik med bindestreck ser ut som en kod').not.toMatch(/-[a-z]/);
    }
  });

  it('ingen kategori delar rubrik eller förklaring med en annan', () => {
    const labels = REDLINE_CATEGORIES.map((category) => REDLINE_TEXTS[category].label);
    const explanations = REDLINE_CATEGORIES.map((category) => REDLINE_TEXTS[category].explanation);
    expect(new Set(labels).size).toBe(REDLINE_CATEGORIES.length);
    expect(new Set(explanations).size).toBe(REDLINE_CATEGORIES.length);
  });

  it('ingen förklaring hänvisar till en paragraf i stället för att förklara', () => {
    for (const category of REDLINE_CATEGORIES) {
      const { explanation } = REDLINE_TEXTS[category];
      expect(explanation, `${category}: en paragraf är ingen förklaring`).not.toMatch(
        /artikel \d|§|förordning|AI-akten|EU 20/i,
      );
    }
  });

  it('panelen säger varför önskemålets text inte står där', () => {
    expect(ADMIN_STOPS_PRIVACY_NOTE).toMatch(/personuppgift/i);
    expect(ADMIN_STOPS_PRIVACY_NOTE, 'säg att texten inte visas, inte bara varför').toMatch(
      /vad någon skrev|önskemålets text|texten/i,
    );
  });

  it('panelen säger att en kategori som återkommer kan vara en för bred regel', () => {
    expect(ADMIN_STOPS_PATTERN_NOTE).toMatch(/för bred/);
    expect(ADMIN_STOPS_PATTERN_NOTE, 'slutsatsen gäller regeln, inte personerna').toMatch(/regeln/i);
  });

  it('tomt läge är en god nyhet, inte ett tomt resultat', () => {
    expect(ADMIN_STOPS_EMPTY).toMatch(/[Ii]ngen har/);
    expect(ADMIN_STOPS_EMPTY, 'ingenting är trasigt eller saknas').not.toMatch(/tom|saknas|fel|ännu inga/i);
  });
});

describe('countStops', () => {
  const stop = (category: RedlineCategory, at: string): AdminStop => ({ appIdPrefix: 'a01f3c7d', category, at });

  it('räknar per kategori, den vanligaste först — det är mönstret som är poängen', () => {
    const counts = countStops([
      stop('biometri', '2026-09-20T12:00:00Z'),
      stop('manipulation', '2026-09-19T12:00:00Z'),
      stop('biometri', '2026-09-18T12:00:00Z'),
      stop('biometri', '2026-09-17T12:00:00Z'),
      stop('manipulation', '2026-09-16T12:00:00Z'),
    ]);
    expect(counts).toEqual([
      { category: 'biometri', count: 3 },
      { category: 'manipulation', count: 2 },
    ]);
  });

  it('en kategori som aldrig träffats tas inte med — den säger ingenting', () => {
    const counts = countStops([stop('biometri', '2026-09-20T12:00:00Z')]);
    expect(counts).toHaveLength(1);
    expect(counts[0]?.category).toBe('biometri');
  });

  it('lika många träffar ger kontraktets ordning, så att listan inte hoppar runt', () => {
    const counts = countStops([stop('manipulation', '2026-09-20T12:00:00Z'), stop('biometri', '2026-09-19T12:00:00Z')]);
    expect(counts.map((row) => row.category)).toEqual(['biometri', 'manipulation']);
  });

  it('inga stopp ger en tom lista, inte sex nollor', () => {
    expect(countStops([])).toEqual([]);
  });
});
