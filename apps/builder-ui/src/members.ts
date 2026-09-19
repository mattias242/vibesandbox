/**
 * "Vilka har åtkomst": ägaren ser dem hen delat appen med och kan ta bort åtkomsten för var och en.
 * Här finns det som går att testa utan webbläsare — texter, fel och vart fokus ska efter en
 * borttagning. Själva vyn ligger i `MembersList.tsx`.
 */
import type { BuilderAppMember } from '@vibesandbox/contracts';
import { ApiError } from './api.ts';

const UNKNOWN_ERROR = 'Något gick fel. Försök igen om en stund.';

export function memberLabel(member: BuilderAppMember): string {
  return member.role === 'owner' ? `${member.email} — du (ägare)` : member.email;
}

/** Knappens namn innehåller adressen, så att den går att skilja från de andra med skärmläsare. */
export function removeButtonLabel(member: BuilderAppMember, confirming: boolean): string {
  return confirming ? `Ja, ta bort åtkomst för ${member.email}` : `Ta bort åtkomst för ${member.email}`;
}

export function removedMessage(member: BuilderAppMember): string {
  return `${member.email} har inte längre åtkomst till appen.`;
}

export function withoutMember(members: readonly BuilderAppMember[], memberId: string): BuilderAppMember[] {
  return members.filter((member) => member.memberId !== memberId);
}

/**
 * Vart fokus ska när en rad försvinner: nästa persons knapp, annars föregående. Ägaren har ingen
 * knapp. `null` ⇒ ingen knapp finns kvar, och vyn lägger fokus på listans rubrik.
 */
export function focusAfterRemoval(members: readonly BuilderAppMember[], removedId: string): string | null {
  const index = members.findIndex((member) => member.memberId === removedId);
  if (index < 0) return null;
  for (const candidate of [members[index + 1], members[index - 1]]) {
    if (candidate !== undefined && candidate.role !== 'owner') return candidate.memberId;
  }
  return null;
}

export function removeErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return UNKNOWN_ERROR;
  // Servern svarar 400 bara när någon försöker ta bort ägarens egen rad.
  if (error.status === 400) return 'Du äger appen och kan inte ta bort din egen åtkomst.';
  if (error.status === 429) return 'Du har gjort många ändringar på kort tid. Vänta en stund och försök igen.';
  return error.message;
}

export function membersErrorMessage(error: unknown): string {
  return `Det gick inte att visa vilka som har åtkomst. ${error instanceof ApiError ? error.message : UNKNOWN_ERROR}`;
}
