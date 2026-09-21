/**
 * Kontrollrummets läsningar och den uttryckliga rolländringen.
 *
 *   Givet plattformens användare
 *   När kontrollrummet visar dem
 *   Så listas de äldst först, och antalet per roll har alla tre rollerna — även de som är noll
 *
 *   Givet appar vars ägare bara är kända som id
 *   När kontrollrummet ska visa ägarens adress
 *   Så slås adresserna upp i satser med ett fast antal parametrar, hur lång listan än är
 *
 *   Givet en användare som är admin
 *   När plattformens administratör sätter rollen till viewer
 *   Så SÄNKS rollen — det upsertUser vägrar göra — och den syns i nästa lista
 *
 *   Givet fientliga indata (okänt id, ogiltig roll, `__proto__`, överlånga värden)
 *   Så avvisas de med klarspråk på svenska, och ingen adress hamnar i felet
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataApiError } from '@vibesandbox/contracts';
import { countUsersByRole, emailsByUserIds, listUsers, setUserRole } from '../src/index.ts';
import { upsertUser } from '../src/anvandare.ts';
import { USER_ID_BATCH, openIdentityDatabase } from '../src/databas.ts';
import type { IdentityDatabase } from '../src/databas.ts';

const ANNA = 'anna@example.org';
const BO = 'bo@example.org';
const CECILIA = 'cecilia@example.org';

let katalog: string;
let db: IdentityDatabase;

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-anvandare-'));
  db = openIdentityDatabase(katalog);
});

afterEach(async () => {
  db.close();
  await rm(katalog, { recursive: true, force: true });
});

describe('listUsers', () => {
  it('ger en tom lista när ingen är inbjuden', () => {
    expect(listUsers(db)).toEqual([]);
  });

  it('listar äldst först, och vid samma tid i den ordning de lades till', () => {
    const anna = upsertUser(db, ANNA, 'admin', 2000);
    const bo = upsertUser(db, BO, 'builder', 1000);
    const cecilia = upsertUser(db, CECILIA, 'viewer', 2000);

    expect(listUsers(db)).toEqual([
      { userId: bo.userId, email: BO, role: 'builder', createdAt: 1000 },
      { userId: anna.userId, email: ANNA, role: 'admin', createdAt: 2000 },
      { userId: cecilia.userId, email: CECILIA, role: 'viewer', createdAt: 2000 },
    ]);
  });

  it('hoppar över en trasig rad i stället för att kasta', () => {
    const trasigt = {
      statement: () => ({
        all: () => [
          { user_id: 'ett', email: ANNA, role: 'admin' },
          { user_id: 'tva', email: BO, role: 'kung' },
          { user_id: 42, email: CECILIA, role: 'viewer' },
          { user_id: 'fyra', email: null, role: 'viewer' },
        ],
      }),
      transaction: <T>(work: () => T): T => work(),
      close: () => {},
    } as unknown as IdentityDatabase;

    // Raden saknar created_at: användaren tas ändå med, med `null` som datum. En användare som
    // inte syns i kontrollrummet går inte heller att ändra rollen på.
    expect(listUsers(trasigt)).toEqual([{ userId: 'ett', email: ANNA, role: 'admin', createdAt: null }]);
  });
});

describe('countUsersByRole', () => {
  it('har alla tre rollerna som nycklar även när databasen är tom', () => {
    expect(countUsersByRole(db)).toEqual({ admin: 0, builder: 0, viewer: 0 });
  });

  it('ger noll för en roll som ingen har', () => {
    upsertUser(db, ANNA, 'admin', 1000);
    upsertUser(db, BO, 'viewer', 1000);
    upsertUser(db, CECILIA, 'viewer', 1000);

    expect(countUsersByRole(db)).toEqual({ admin: 1, builder: 0, viewer: 2 });
  });

  it('följer med när en roll ändras', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    setUserRole(db, anna.userId, 'viewer', 2000);

    expect(countUsersByRole(db)).toEqual({ admin: 0, builder: 0, viewer: 1 });
  });
});

describe('emailsByUserIds', () => {
  it('ger en tom karta för en tom lista', () => {
    upsertUser(db, ANNA, 'admin', 1000);
    expect(emailsByUserIds(db, [])).toEqual(new Map());
  });

  it('slår upp adresser för kända id', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    const bo = upsertUser(db, BO, 'builder', 1000);

    const karta = emailsByUserIds(db, [anna.userId, bo.userId]);

    expect(karta.get(anna.userId)).toBe(ANNA);
    expect(karta.get(bo.userId)).toBe(BO);
    expect(karta.size).toBe(2);
  });

  it('utelämnar ett okänt id helt — ingen nyckel med värdet undefined', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);

    const karta = emailsByUserIds(db, [anna.userId, 'okant-id']);

    expect(karta.size).toBe(1);
    expect(karta.has('okant-id')).toBe(false);
    expect([...karta.keys()]).toEqual([anna.userId]);
  });

  it('klarar fler id än satsens gräns för antalet parametrar', () => {
    const antal = 1200;
    const ids: string[] = [];
    for (let i = 0; i < antal; i += 1) ids.push(upsertUser(db, `person${i}@example.org`, 'viewer', 1000 + i).userId);

    const karta = emailsByUserIds(db, ids);

    expect(karta.size).toBe(antal);
    expect(karta.get(ids[0] as string)).toBe('person0@example.org');
    expect(karta.get(ids[antal - 1] as string)).toBe(`person${antal - 1}@example.org`);
  });

  it('är exakt vid gränsen: en under, precis på och en över', () => {
    const ids: string[] = [];
    for (let i = 0; i < USER_ID_BATCH + 1; i += 1) {
      ids.push(upsertUser(db, `granspost${i}@example.org`, 'viewer', 1000 + i).userId);
    }

    for (const antal of [USER_ID_BATCH - 1, USER_ID_BATCH, USER_ID_BATCH + 1]) {
      const karta = emailsByUserIds(db, ids.slice(0, antal));
      expect(karta.size, `${antal} id`).toBe(antal);
    }
  });

  it('räknar ett dubblerat id en gång', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);

    const karta = emailsByUserIds(db, [anna.userId, anna.userId, anna.userId]);

    expect(karta.size).toBe(1);
    expect(karta.get(anna.userId)).toBe(ANNA);
  });

  it('hoppar över fientliga id utan att kasta', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    const fientliga = ['', 'a'.repeat(300), `med\u0000nul`, '__proto__', 'constructor', 'med mellanslag'];

    const karta = emailsByUserIds(db, [...fientliga, anna.userId] as readonly string[]);

    expect(karta.size).toBe(1);
    expect(karta.get(anna.userId)).toBe(ANNA);
    expect(Object.getPrototypeOf({}) as Record<string, unknown>).not.toHaveProperty('email');
  });

  it('hoppar över id som inte ens är strängar', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    const skrap = [null, undefined, 42, {}, [], { toString: () => anna.userId }] as unknown as readonly string[];

    expect(emailsByUserIds(db, skrap)).toEqual(new Map());
  });
});

describe('setUserRole', () => {
  it('SÄNKER en roll — det upsertUser vägrar göra', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    expect(upsertUser(db, ANNA, 'viewer', 1100).role).toBe('admin');

    const efter = setUserRole(db, anna.userId, 'viewer', 1200);

    expect(efter).toEqual({ userId: anna.userId, email: ANNA, role: 'viewer' });
  });

  it('höjer också en roll', () => {
    const bo = upsertUser(db, BO, 'viewer', 1000);

    expect(setUserRole(db, bo.userId, 'admin', 1100).role).toBe('admin');
  });

  // En sänkt behörighet ska gå att se i efterhand. Tidpunkten är den anroparen skickar in, inte
  // en klocka funktionen hittar själv — annars kan ett test aldrig veta vad som skrevs.
  it('skriver en händelse med den tidpunkt anroparen angav', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);

    setUserRole(db, anna.userId, 'viewer', 1234);

    const rader = db.statement(`SELECT type, user_id, at FROM events WHERE type = 'role_changed'`).all();
    expect(rader).toEqual([{ type: 'role_changed', user_id: anna.userId, at: 1234 }]);
  });

  it('en roll som redan gäller skriver varken rad eller händelse', () => {
    const bo = upsertUser(db, BO, 'builder', 1000);

    expect(setUserRole(db, bo.userId, 'builder', 1100).role).toBe('builder');

    expect(db.statement(`SELECT count(*) AS antal FROM events WHERE type = 'role_changed'`).get()).toEqual({ antal: 0 });
  });

  it('både en sänkning och en höjning syns i nästa listUsers', () => {
    const anna = upsertUser(db, ANNA, 'admin', 1000);
    const bo = upsertUser(db, BO, 'viewer', 1100);

    setUserRole(db, anna.userId, 'viewer', 1200);
    setUserRole(db, bo.userId, 'builder', 1300);

    // createdAt är när adressen lades in — ett rollbyte flyttar den inte.
    expect(listUsers(db)).toEqual([
      { userId: anna.userId, email: ANNA, role: 'viewer', createdAt: 1000 },
      { userId: bo.userId, email: BO, role: 'builder', createdAt: 1100 },
    ]);
  });

  it('nekar ett okänt id med not_found', () => {
    upsertUser(db, ANNA, 'admin', 1000);

    try {
      setUserRole(db, 'ett-id-som-inte-finns', 'viewer', 1100);
      expect.unreachable('skulle ha kastat');
    } catch (fel) {
      expect(fel).toBeInstanceOf(DataApiError);
      expect((fel as DataApiError).code).toBe('not_found');
    }
    expect(listUsers(db)[0]?.role).toBe('admin');
  });

  const ogiltigaRoller: ReadonlyArray<readonly [string, unknown]> = [
    ['ett objekt', { role: 'admin' }],
    ['ett tal', 3],
    ['null', null],
    ['undefined', undefined],
    ['fel skiftläge', 'Admin'],
    ['versaler', 'VIEWER'],
    ['tom sträng', ''],
    ['ett namn på prototypen', 'constructor'],
    ['__proto__', '__proto__'],
    ['toString', 'toString'],
    ['hasOwnProperty', 'hasOwnProperty'],
    ['en roll med mellanslag', ' admin'],
  ];

  for (const [namn, roll] of ogiltigaRoller) {
    it(`nekar ${namn} som roll med invalid_request och ändrar ingenting`, () => {
      const anna = upsertUser(db, ANNA, 'builder', 1000);

      expect(() => setUserRole(db, anna.userId, roll, 1100)).toThrow(DataApiError);
      try {
        setUserRole(db, anna.userId, roll, 1100);
      } catch (fel) {
        expect((fel as DataApiError).code).toBe('invalid_request');
      }
      expect(listUsers(db)[0]?.role).toBe('builder');
    });
  }

  const fientligaId: ReadonlyArray<readonly [string, unknown]> = [
    ['inte en sträng', 42],
    ['null', null],
    ['undefined', undefined],
    ['ett objekt', {}],
    ['tom sträng', ''],
    ['överlångt', 'a'.repeat(257)],
    ['med NUL', 'abc\u0000def'],
    ['med radbrytning', 'abc\ndef'],
  ];

  for (const [namn, id] of fientligaId) {
    it(`nekar ett id som är ${namn}`, () => {
      const anna = upsertUser(db, ANNA, 'builder', 1000);

      try {
        setUserRole(db, id as string, 'viewer', 1100);
        expect.unreachable('skulle ha kastat');
      } catch (fel) {
        expect(fel).toBeInstanceOf(DataApiError);
        expect((fel as DataApiError).code).toBe('invalid_request');
      }
      expect(listUsers(db)).toEqual([{ userId: anna.userId, email: ANNA, role: 'builder', createdAt: 1000 }]);
    });
  }

  it('nekar `__proto__` och `constructor` som id utan att röra Object.prototype', () => {
    upsertUser(db, ANNA, 'builder', 1000);

    for (const id of ['__proto__', 'constructor']) {
      expect(() => setUserRole(db, id, 'admin', 1100)).toThrow(DataApiError);
    }
    expect(Object.getPrototypeOf({}) as Record<string, unknown>).not.toHaveProperty('role');
    expect(listUsers(db)[0]?.role).toBe('builder');
  });

  it('röjer aldrig adressen i felet — varken i meddelandet eller i namnet', () => {
    const anna = upsertUser(db, ANNA, 'builder', 1000);

    for (const forsok of [
      () => setUserRole(db, anna.userId, 'kung', 1100),
      () => setUserRole(db, 'ett-id-som-inte-finns', 'viewer', 1100),
      () => setUserRole(db, '', 'viewer', 1100),
    ]) {
      try {
        forsok();
        expect.unreachable('skulle ha kastat');
      } catch (fel) {
        const text = `${(fel as Error).name} ${(fel as Error).message}`;
        expect(text).not.toContain('anna');
        expect(text).not.toContain('example.org');
        expect(text).not.toContain(anna.userId);
        expect((fel as Error).message).toMatch(/^[^<>{}]+$/);
      }
    }
  });
});
