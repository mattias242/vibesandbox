/**
 * Nätfiskeskyddet: ämne och text rensas och prövas innan något mejlas från plattformens betrodda
 * adress. Testerna är medvetet fientliga — förklädda adresser, osynliga tecken, huvudinjektion.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SUBJECT_LENGTH, MAX_TEXT_LENGTH, checkContent, containsWebAddress } from '../src/innehall.ts';

const EGEN = 'https://01h8xgk3m2abcdefghjkmnpqrs.appar.example/';

function ok(subject: unknown, text: unknown) {
  const resultat = checkContent({ subject, text }, EGEN);
  if (!resultat.ok) throw new Error(`Avvisades: ${resultat.message}`);
  return resultat;
}

function avvisad(subject: unknown, text: unknown): string {
  const resultat = checkContent({ subject, text }, EGEN);
  if (resultat.ok) throw new Error(`Godtogs: ${JSON.stringify(resultat)}`);
  return resultat.message;
}

describe('webbadresser', () => {
  it.each([
    'https://evil.example/login',
    'http://evil.example',
    'HTTPS://EVIL.EXAMPLE',
    'hxxp://evil[.]example',
    'hxxps://evil(.)example',
    'h**p://evil.example',
    'evil[.]com',
    'evil(dot)com',
    'www.evil.example',
    'WWW2.evil',
    'klubbens-inloggning.se',
    'Logga in på bankid-support.nu nu',
    'bänkid-inloggning.se',
    'xn--bnkid-inloggning-9kb.se',
    'пример.рф',
    'пример.com',
    'ｅｖｉｌ\uff0eｃｏｍ',
    'evil\u3002com',
    'evil\u200b.com',
    'ev\u00adil.com',
    'anna@evil.example',
    'mailto:anna',
    'javascript:alert(1)',
    'http:/\\/evil',
    '//evil.example',
    '192.168.1.1',
    'faktura.zip',
    'https://01h8xgk3m2abcdefghjkmnpqrs.appar.example.evil.com/',
    'https://01h8xgk3m2abcdefghjkmnpqrs.appar.example@evil.com/',
    'https://01h8xgk3m2abcdefghjkmnpqrs.appar.example:8443/',
    'http://01h8xgk3m2abcdefghjkmnpqrs.appar.example/',
  ])('hittar %j', (text) => {
    expect(containsWebAddress(text, EGEN)).toBe(true);
  });

  it.each([
    'Vi ses på torsdag kl. 18.30 i stora salen.',
    'Ta med t.ex. kaffe, bl.a. till mötet m.m.',
    'Det kostar 12.50 kr, dvs. inte så mycket o.s.v.',
    'Slut. Nu kör vi. Se protokollet i appen.',
    'Version 2 är klar!',
    `Titta här: ${EGEN}`,
    `Titta här: ${EGEN}kalender?vecka=38 eller ${EGEN.toUpperCase()}.`,
    'https://01h8xgk3m2abcdefghjkmnpqrs.appar.example (utan snedstreck)',
  ])('godtar %j', (text) => {
    expect(containsWebAddress(text, EGEN)).toBe(false);
  });
});

describe('ämne och text', () => {
  it('godtar ett vanligt meddelande oförändrat', () => {
    expect(ok('Mötet är flyttat', 'Vi ses på torsdag.\nHälsningar')).toEqual({
      ok: true,
      subject: 'Mötet är flyttat',
      text: 'Vi ses på torsdag.\nHälsningar',
    });
  });

  it('en radbrytning i ämnet kan aldrig bli ett eget mejlhuvud', () => {
    const { subject } = ok('Hej\r\nBcc: någon\r\n\r\nkropp', 'Text');
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe('Hej Bcc: någon kropp');
  });

  it('kontrolltecken, NUL och osynliga tecken tas bort', () => {
    const { subject, text } = ok('A\u0000B\u0007C\u202eD\u2028E', 'rad1\r\nrad2\u0000\u001b[31m\u200b\u2029rad3\ttab');
    expect(subject).toBe('ABCD E');
    expect(text).toBe('rad1\nrad2[31m\nrad3 tab');
  });

  it('många tomrader slås ihop', () => {
    expect(ok('Ämne', 'a\n\n\n\n\nb').text).toBe('a\n\nb');
  });

  it.each([
    [undefined, 'text'],
    ['ämne', undefined],
    [1, 'text'],
    ['ämne', ['text']],
    ['', 'text'],
    ['   ', 'text'],
    ['ämne', '\u0000\u200b '],
    ['x'.repeat(MAX_SUBJECT_LENGTH + 1), 'text'],
    ['ämne', 'x'.repeat(MAX_TEXT_LENGTH + 1)],
  ])('avvisar ämne %j och text %j', (subject, text) => {
    expect(avvisad(subject, text).length).toBeGreaterThan(0);
  });

  it('en webbadress i ämnet eller texten avvisas med klarspråk', () => {
    expect(avvisad('Se evil.com', 'text')).toMatch(/webbadress/);
    expect(avvisad('Ämne', 'Se https://evil.example')).toMatch(/webbadress/);
  });

  it('en adress som bara syns efter rensning avvisas också', () => {
    expect(avvisad('Ämne', 'e\u0000vil.com')).toMatch(/webbadress/);
  });
});
