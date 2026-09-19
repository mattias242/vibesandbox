/**
 * "Vilka har åtkomst": texterna, bekräftelsen i två steg och vart fokus går efter en borttagning.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderAppMember } from '@vibesandbox/contracts';
import { ApiError } from '../src/api.ts';
import {
  focusAfterRemoval,
  memberLabel,
  membersErrorMessage,
  removeButtonLabel,
  removeErrorMessage,
  removedMessage,
  withoutMember,
} from '../src/members.ts';

const owner: BuilderAppMember = { memberId: 'owner1', email: 'anna@example.se', role: 'owner' };
const bertil: BuilderAppMember = { memberId: 'bertil1', email: 'bertil@example.se', role: 'user' };
const cecilia: BuilderAppMember = { memberId: 'cecilia1', email: 'cecilia@example.se', role: 'user' };
const david: BuilderAppMember = { memberId: 'david1', email: 'david@example.se', role: 'user' };

describe('raderna', () => {
  it('ägarraden säger att det är du', () => {
    expect(memberLabel(owner)).toBe('anna@example.se — du (ägare)');
  });

  it('en användarrad är bara adressen', () => {
    expect(memberLabel(bertil)).toBe('bertil@example.se');
  });
});

describe('knappen i två steg', () => {
  it('första steget nämner adressen, så att skärmläsare vet vems åtkomst det gäller', () => {
    expect(removeButtonLabel(bertil, false)).toBe('Ta bort åtkomst för bertil@example.se');
  });

  it('andra steget ber om bekräftelse, också med adressen', () => {
    expect(removeButtonLabel(bertil, true)).toBe('Ja, ta bort åtkomst för bertil@example.se');
  });

  it('bekräftelsen efteråt är klarspråk', () => {
    expect(removedMessage(bertil)).toBe('bertil@example.se har inte längre åtkomst till appen.');
  });
});

describe('efter en borttagning', () => {
  const list = [owner, bertil, cecilia, david];

  it('raden försvinner, resten står kvar i samma ordning', () => {
    expect(withoutMember(list, 'cecilia1')).toEqual([owner, bertil, david]);
  });

  it('fokus går till nästa persons knapp', () => {
    expect(focusAfterRemoval(list, 'bertil1')).toBe('cecilia1');
  });

  it('var det den sista i listan går fokus till den före', () => {
    expect(focusAfterRemoval(list, 'david1')).toBe('cecilia1');
  });

  it('ägaren har ingen knapp, så fokus går aldrig dit', () => {
    expect(focusAfterRemoval([owner, bertil], 'bertil1')).toBeNull();
  });

  it('en okänd rad ger inget fokusmål', () => {
    expect(focusAfterRemoval(list, 'okand')).toBeNull();
  });
});

describe('fel', () => {
  it('ägaren kan inte ta bort sig själv', () => {
    expect(removeErrorMessage(new ApiError(400, 'x', 'invalid_request'))).toBe(
      'Du äger appen och kan inte ta bort din egen åtkomst.',
    );
  });

  it('för många försök', () => {
    expect(removeErrorMessage(new ApiError(429, 'x', 'rate_limited'))).toBe(
      'Du har gjort många ändringar på kort tid. Vänta en stund och försök igen.',
    );
  });

  it('andra fel visar klientens klarspråk, okända fel ett allmänt besked', () => {
    expect(removeErrorMessage(new ApiError(0, 'Kunde inte nå servern.'))).toBe('Kunde inte nå servern.');
    expect(removeErrorMessage(new Error('intern detalj'))).toBe('Något gick fel. Försök igen om en stund.');
  });

  it('listan gick inte att hämta', () => {
    expect(membersErrorMessage(new ApiError(500, 'Något gick fel hos oss.'))).toBe(
      'Det gick inte att visa vilka som har åtkomst. Något gick fel hos oss.',
    );
    expect(membersErrorMessage(new Error('intern'))).toBe(
      'Det gick inte att visa vilka som har åtkomst. Något gick fel. Försök igen om en stund.',
    );
  });
});
