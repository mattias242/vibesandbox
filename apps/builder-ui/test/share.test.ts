/**
 * "Dela med en kollega": adressen kontrolleras innan den skickas, och svaret blir klarspråk.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { SHARE_SUCCESS_MESSAGE, shareErrorMessage, validateEmail } from '../src/share.ts';

describe('validateEmail', () => {
  it.each([
    ['kollega@molndal.se', 'kollega@molndal.se'],
    ['  Anna.Andersson@Example.SE  ', 'anna.andersson@example.se'],
    ['a+b@sub.example.se', 'a+b@sub.example.se'],
  ])('godtar %j som %j', (input, email) => {
    expect(validateEmail(input)).toEqual({ ok: true, email });
  });

  it('en tom ruta ber om en adress', () => {
    expect(validateEmail('   ')).toEqual({ ok: false, message: 'Skriv kollegans e-postadress.' });
  });

  it.each([
    'kollega',
    'kollega@',
    '@molndal.se',
    'kollega@molndal',
    'kol lega@molndal.se',
    'a@b@c.se',
    'kollega@molndal..se',
    'kollega@.molndal.se',
    'kollega@molndal.se.',
    'Anna <anna@molndal.se>',
    'anna@molndal.se\u0000',
    'anna@molndal.se\nBcc: x@y.se',
    `${'a'.repeat(250)}@b.se`,
  ])('avvisar %j med ett vänligt meddelande', (input) => {
    const result = validateEmail(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('Det ser inte ut som en e-postadress. Kontrollera den och försök igen.');
  });
});

describe('svaret', () => {
  it('bekräftelsen är klarspråk', () => {
    expect(SHARE_SUCCESS_MESSAGE).toBe('Inbjudan är skickad. Hen loggar in med en kod som kommer till mejlen.');
  });

  it('ogiltig adress enligt servern', () => {
    expect(shareErrorMessage(new ApiError(400, 'x', 'invalid_request'))).toBe(
      'Det ser inte ut som en e-postadress. Kontrollera den och försök igen.',
    );
  });

  it('för många inbjudningar', () => {
    expect(shareErrorMessage(new ApiError(429, 'x', 'rate_limited'))).toBe(
      'Du har skickat många inbjudningar på kort tid. Vänta en stund och försök igen.',
    );
  });

  it('appen är inte publicerad', () => {
    expect(shareErrorMessage(new ApiError(409, 'x'))).toBe('Appen behöver publiceras innan du kan dela den.');
  });

  it('andra fel visar klientens klarspråk', () => {
    expect(shareErrorMessage(new ApiError(500, 'Något gick fel hos oss.'))).toBe('Något gick fel hos oss.');
    expect(shareErrorMessage(new Error('intern detalj'))).toBe('Något gick fel. Försök igen om en stund.');
  });
});
