/**
 * `readSingleCookie`: strikt läsning av EN namngiven kaka ur `Cookie`-huvudet. Ren funktion.
 *
 * Beteendet, i domänens språk:
 *
 *   Givet att en syskonapp har planterat en kaka med samma namn för hela domänen (ADR 0002,
 *   "Mätt i spik S1": det GÅR) — när webbläsaren då skickar kaknamnet två gånger — så nekas
 *   inloggningen, i stället för att vi gissar vilken av de två som är vår.
 *
 *   Givet kakor vi inte känner igen — så ignoreras de helt (ADR 0002, villkor 4).
 *
 *   Givet skräp — så kastar läsningen aldrig, och svaret är "saknas".
 */
import { describe, expect, it } from 'vitest';
import { MAX_COOKIE_HEADER_LENGTH, readSingleCookie } from '../src/kakor.ts';

const NAMN = 'vs-test-session';
const TOKEN = 'eyJ1c2VySWQiOiJhIn0.c2lnbmF0dXJfMTIzLV8';

describe('readSingleCookie', () => {
  describe('hittar kakan', () => {
    it('ensam kaka', () => {
      expect(readSingleCookie(`${NAMN}=${TOKEN}`, NAMN)).toEqual({ outcome: 'found', value: TOKEN });
    });

    it.each([
      ['först', `${NAMN}=${TOKEN}; tema=mork; sprak=sv`],
      ['i mitten', `tema=mork; ${NAMN}=${TOKEN}; sprak=sv`],
      ['sist', `tema=mork; sprak=sv; ${NAMN}=${TOKEN}`],
      ['utan blanktecken efter semikolon', `tema=mork;${NAMN}=${TOKEN};sprak=sv`],
      ['med extra blanktecken', `tema=mork;    ${NAMN}=${TOKEN}   ;  sprak=sv`],
      ['med tomma par runt om', `;; ;${NAMN}=${TOKEN};;`],
    ])('bland okända kakor, %s', (_beskrivning, huvud) => {
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'found', value: TOKEN });
    });

    it('likhetstecken i värdet hör till värdet — bara det FÖRSTA delar namn från värde', () => {
      expect(readSingleCookie(`${NAMN}=a=b==c`, NAMN)).toEqual({ outcome: 'found', value: 'a=b==c' });
    });

    it('värdet procentavkodas INTE', () => {
      expect(readSingleCookie(`${NAMN}=a%2Eb%3Bc`, NAMN)).toEqual({ outcome: 'found', value: 'a%2Eb%3Bc' });
    });

    it('citattecken tas INTE bort — vi sätter aldrig kakan med citattecken, så de hör inte till vårt värde', () => {
      expect(readSingleCookie(`${NAMN}="${TOKEN}"`, NAMN)).toEqual({ outcome: 'found', value: `"${TOKEN}"` });
    });

    it('tomt värde är en förekomst (med tomt värde), inte "saknas"', () => {
      expect(readSingleCookie(`${NAMN}=`, NAMN)).toEqual({ outcome: 'found', value: '' });
    });
  });

  describe('kaknamnet förekommer mer än en gång ⇒ tvetydigt', () => {
    it.each([
      ['samma värde två gånger', `${NAMN}=${TOKEN}; ${NAMN}=${TOKEN}`],
      ['vår först, planterad sedan', `${NAMN}=${TOKEN}; ${NAMN}=planterad`],
      ['planterad först, vår sedan', `${NAMN}=planterad; ${NAMN}=${TOKEN}`],
      ['en tom och en riktig', `${NAMN}=; ${NAMN}=${TOKEN}`],
      ['med okända kakor emellan', `${NAMN}=${TOKEN}; tema=mork; ${NAMN}=x`],
      ['utan blanktecken', `${NAMN}=${TOKEN};${NAMN}=x`],
      ['tre gånger', `${NAMN}=a; ${NAMN}=b; ${NAMN}=c`],
      ['blanktecken runt namnet räknas också som en förekomst', `${NAMN}=${TOKEN}; ${NAMN} =x`],
      // Node slår ihop flera `Cookie`-huvuden med "; " — samma sak på tråden som en enda rad.
      ['två Cookie-huvuden hopslagna av Node', [`${NAMN}=${TOKEN}`, `${NAMN}=x`].join('; ')],
    ])('%s', (_beskrivning, huvud) => {
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'ambiguous' });
    });
  });

  describe('okända kakor ignoreras helt', () => {
    it.each([
      ['annat namn', 'session=abc'],
      ['vårt namn som PREFIX till ett längre namn', `${NAMN}-2=${TOKEN}`],
      ['vårt namn som SUFFIX', `x${NAMN}=${TOKEN}`],
      ['annat skiftläge — kaknamn är skiftlägeskänsliga', `VS-TEST-SESSION=${TOKEN}`],
      ['vårt namn som VÄRDE i en annan kaka', `annan=${NAMN}`],
      ['vårt namn utan likhetstecken (en namnlös kaka)', NAMN],
      ['namnlös kaka vars värde börjar med likhetstecken', `=${NAMN}=${TOKEN}`],
      ['objektprototypens namn', '__proto__=x; constructor=y; toString=z; hasOwnProperty=w'],
    ])('%s ⇒ saknas', (_beskrivning, huvud) => {
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'missing' });
    });

    it('okända kakor — även dubbletter av DEM — hindrar inte att vår hittas', () => {
      const huvud = `a=1; a=2; __proto__=x; ${NAMN}=${TOKEN}; a=3`;
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'found', value: TOKEN });
    });
  });

  describe('skräp ⇒ saknas, och kastar aldrig', () => {
    const NUL = String.fromCharCode(0);

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['tal', 42],
      ['lista', [`${NAMN}=${TOKEN}`]],
      ['objekt', { cookie: `${NAMN}=${TOKEN}` }],
      ['tom sträng', ''],
      ['bara semikolon', ';;;;'],
      ['bara likhetstecken', '==='],
      ['bara blanktecken', '   \t  '],
      ['par utan namn', '=x; =y'],
      ['NUL-tecken', `a${NUL}b=${NUL}`],
      ['radbrytningar', 'a=1\r\nSet-Cookie: x=y'],
      ['icke-ASCII', 'å=ä; 🍪=🍪'],
    ])('%s', (_beskrivning, huvud) => {
      expect(() => readSingleCookie(huvud, NAMN)).not.toThrow();
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'missing' });
    });
  });

  describe('överlångt huvud', () => {
    it('nekas utan att tolkas — även om en giltig kaka finns med', () => {
      const utfyllnad = `fyllnad=${'x'.repeat(MAX_COOKIE_HEADER_LENGTH)}`;
      expect(readSingleCookie(`${NAMN}=${TOKEN}; ${utfyllnad}`, NAMN)).toEqual({ outcome: 'oversized' });
    });

    it('precis på gränsen tolkas som vanligt', () => {
      const bas = `${NAMN}=${TOKEN}; f=`;
      const huvud = bas + 'x'.repeat(MAX_COOKIE_HEADER_LENGTH - bas.length);
      expect(huvud.length).toBe(MAX_COOKIE_HEADER_LENGTH);
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'found', value: TOKEN });
    });

    it('ett tecken över gränsen nekas', () => {
      const bas = `${NAMN}=${TOKEN}; f=`;
      const huvud = bas + 'x'.repeat(MAX_COOKIE_HEADER_LENGTH - bas.length + 1);
      expect(readSingleCookie(huvud, NAMN)).toEqual({ outcome: 'oversized' });
    });

    it('tusentals par tolkas utan att kasta', () => {
      const huvud = Array.from({ length: 1500 }, (_, i) => `k${i}=v`).join(';');
      expect(huvud.length).toBeLessThanOrEqual(MAX_COOKIE_HEADER_LENGTH * 2);
      expect(() => readSingleCookie(huvud, NAMN)).not.toThrow();
    });
  });
});
