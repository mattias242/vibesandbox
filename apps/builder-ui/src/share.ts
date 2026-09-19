/**
 * "Dela med en kollega". Servern validerar adressen på riktigt; kontrollen här ger bara ett
 * snabbt, vänligt besked innan något skickas.
 */
import { ApiError } from './api.ts';

export const SHARE_SUCCESS_MESSAGE = 'Inbjudan är skickad. Hen loggar in med en kod som kommer till mejlen.';
const INVALID_EMAIL = 'Det ser inte ut som en e-postadress. Kontrollera den och försök igen.';

export type EmailValidation = { readonly ok: true; readonly email: string } | { readonly ok: false; readonly message: string };

// Medvetet enkel: ett @, inga blanktecken eller styrtecken, en domän med minst en punkt och
// inga tomma delar. Riktiga undantagsfall (citattecken m.m.) är inte värda förvirringen.
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function validateEmail(input: string): EmailValidation {
  const email = input.trim().toLowerCase();
  if (email === '') return { ok: false, message: 'Skriv kollegans e-postadress.' };
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { ok: false, message: INVALID_EMAIL };
  return { ok: true, email };
}

export function shareErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Något gick fel. Försök igen om en stund.';
  if (error.status === 400) return INVALID_EMAIL;
  if (error.status === 409) return 'Appen behöver publiceras innan du kan dela den.';
  if (error.status === 429) return 'Du har skickat många inbjudningar på kort tid. Vänta en stund och försök igen.';
  return error.message;
}
