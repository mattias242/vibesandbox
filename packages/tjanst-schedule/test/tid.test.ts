/**
 * Tider i Europe/Stockholm: tolkning av ISO-tider med tidszon och upprepning över sommartid.
 */
import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseInstant, stockholmWallTime } from '../src/tid.ts';

const ms = (iso: string): number => Date.parse(iso);

describe('parseInstant', () => {
  it('tar ISO-tider med Z eller förskjutning', () => {
    expect(parseInstant('2026-10-02T09:00:00Z')).toBe(ms('2026-10-02T09:00:00Z'));
    expect(parseInstant('2026-10-02T09:00+02:00')).toBe(ms('2026-10-02T07:00:00Z'));
    expect(parseInstant('2026-10-02T09:00:00.250-05:30')).toBe(ms('2026-10-02T14:30:00.250Z'));
  });

  it.each([
    ['utan tidszon', '2026-10-02T09:00:00'],
    ['bara datum', '2026-10-02'],
    ['tidszon med namn', '2026-10-02T09:00:00[Europe/Stockholm]'],
    ['namn i stället för förskjutning', '2026-10-02T09:00:00 CET'],
    ['för stor förskjutning', '2026-10-02T09:00:00+25:00'],
    ['förskjutning med ogiltiga minuter', '2026-10-02T09:00:00+01:75'],
    ['30 februari', '2026-02-30T09:00:00Z'],
    ['månad 13', '2026-13-01T09:00:00Z'],
    ['timme 24', '2026-10-02T24:00:00Z'],
    ['NUL', '2026-10-02T09:00:00Z\u0000'],
    ['blanktecken', ' 2026-10-02T09:00:00Z'],
    ['femsiffrigt år', '+02026-10-02T09:00:00Z'],
    ['tom', ''],
    ['överlång', `2026-10-02T09:00:00${'0'.repeat(500)}Z`],
  ])('nekar %s', (_namn, varde) => {
    expect(parseInstant(varde)).toBeNull();
  });

  it('nekar annat än text', () => {
    expect(parseInstant(1_790_000_000_000)).toBeNull();
    expect(parseInstant(null)).toBeNull();
    expect(parseInstant({ at: '2026-10-02T09:00:00Z' })).toBeNull();
  });
});

describe('stockholmWallTime', () => {
  it('ger väggtiden i Stockholm, vinter som sommar', () => {
    expect(stockholmWallTime(ms('2026-01-15T08:00:00Z'))).toMatchObject({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 });
    expect(stockholmWallTime(ms('2026-07-15T08:00:00Z'))).toMatchObject({ year: 2026, month: 7, day: 15, hour: 10, minute: 0 });
  });
});

describe('nextOccurrence', () => {
  it('dagligen kl 9 behåller klockslaget över vårens sommartidsövergång', () => {
    const forsta = ms('2026-03-28T08:00:00Z'); // lördag 09:00 vintertid
    expect(nextOccurrence(forsta, 'daily', forsta)).toBe(ms('2026-03-29T07:00:00Z')); // söndag 09:00 sommartid
  });

  it('dagligen kl 9 behåller klockslaget över höstens övergång', () => {
    const forsta = ms('2026-10-24T07:00:00Z'); // lördag 09:00 sommartid
    expect(nextOccurrence(forsta, 'daily', forsta)).toBe(ms('2026-10-25T08:00:00Z')); // söndag 09:00 vintertid
  });

  it('ett klockslag som inte finns (02:30 när klockan ställs fram) flyttas fram, och nästa dag är det 02:30 igen', () => {
    const forsta = ms('2026-03-28T01:30:00Z'); // lördag 02:30 vintertid
    const sondag = nextOccurrence(forsta, 'daily', forsta);
    expect(sondag).toBe(ms('2026-03-29T01:30:00Z')); // 03:30 sommartid
    expect(nextOccurrence(forsta, 'daily', sondag)).toBe(ms('2026-03-30T00:30:00Z')); // måndag 02:30 sommartid
  });

  it('ett klockslag som finns två gånger (02:30 när klockan ställs tillbaka) blir det första, och bara ett', () => {
    const forsta = ms('2026-10-24T00:30:00Z'); // lördag 02:30 sommartid
    const sondag = nextOccurrence(forsta, 'daily', forsta);
    expect(sondag).toBe(ms('2026-10-25T00:30:00Z')); // 02:30 sommartid, första gången
    expect(nextOccurrence(forsta, 'daily', sondag)).toBe(ms('2026-10-26T01:30:00Z')); // måndag 02:30 vintertid
  });

  it('varje vecka: fredag kl 9 blir fredag kl 9', () => {
    const fredag = ms('2026-10-23T07:00:00Z'); // fredag 09:00 sommartid
    const nasta = nextOccurrence(fredag, 'weekly', fredag);
    expect(nasta).toBe(ms('2026-10-30T08:00:00Z')); // fredag 09:00 vintertid
    expect(new Date(nasta).getUTCDay()).toBe(5);
  });

  it('varje månad den 31:a: sista dagen i korta månader, sedan den 31:a igen', () => {
    const jan = ms('2027-01-31T08:00:00Z');
    const feb = nextOccurrence(jan, 'monthly', jan);
    expect(feb).toBe(ms('2027-02-28T08:00:00Z'));
    const mar = nextOccurrence(jan, 'monthly', feb);
    expect(mar).toBe(ms('2027-03-31T07:00:00Z')); // sommartid från 28 mars 2027
  });

  it('efter ett långt uppehåll (klockan hoppar fram) blir det nästa tillfälle efter nu — inte alla missade', () => {
    const forsta = ms('2026-10-01T07:00:00Z'); // 09:00
    const nu = ms('2027-02-10T12:00:00Z');
    expect(nextOccurrence(forsta, 'daily', nu)).toBe(ms('2027-02-11T08:00:00Z'));
    expect(nextOccurrence(forsta, 'weekly', nu)).toBe(ms('2027-02-11T08:00:00Z')); // torsdag som 1 okt 2026
    expect(nextOccurrence(forsta, 'monthly', nu)).toBe(ms('2027-03-01T08:00:00Z'));
  });

  it('ger alltid en tid efter "efter", även när "efter" ligger precis på ett tillfälle', () => {
    const forsta = ms('2026-10-01T07:00:00Z');
    const andra = ms('2026-10-02T07:00:00Z');
    expect(nextOccurrence(forsta, 'daily', andra)).toBe(ms('2026-10-03T07:00:00Z'));
  });
});
