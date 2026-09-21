/**
 * Kontrollrummets användarhantering: `GET/POST /_api/builder/admin/anvandare` och
 * `POST /_api/builder/admin/anvandare/:userId`.
 *
 * Det som prövas här är inte främst att rollerna går att ändra, utan att de inte går att ändra på
 * fel sätt: den egna raden går aldrig att röra (en administratör som sänker sig själv låser ut
 * sig), bara `admin` kommer in, och adresserna — som är personuppgifter — finns i svaren men
 * aldrig i en loggrad.
 *
 * Bryggan till identiteten är valfri. Utan den fungerar byggverktyget som förut: `users` blir
 * nollor och användarrutterna svarar `unavailable`. Testerna nedan kopplar in en fejkad brygga
 * som beter sig som identitetspaketets fyra funktioner.
 */
import { ADMIN_APP_ID_PREFIX_LENGTH } from '@vibesandbox/contracts';
import type { Identity } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADAM,
  ANNA,
  BERTIL,
  VERA,
  anropa,
  api,
  fejkAnvandare,
  nyApp,
  skapaMiljo,
  skicka,
  vantaPaJobb,
} from './hjalp.ts';
import type { FejkAnvandare, Miljo } from './hjalp.ts';

let m: Miljo;
let katalog: FejkAnvandare;

beforeEach(async () => {
  katalog = fejkAnvandare();
  m = await skapaMiljo({ users: katalog });
});
afterEach(async () => {
  await m.stada();
});

const ANVANDARE = api('/admin/anvandare');
const OVERSIKT = api('/admin/oversikt');
const APPAR = api('/admin/appar');
const anvandare = (userId: string): string => api(`/admin/anvandare/${userId}`);

/** Ingen roll alls — en inloggad person som ännu inte fått något. */
const INGEN: Identity = { userId: 'u-ingen', email: 'ingen@example.org', roles: [] };

describe('grinden: bara plattformsrollen admin', () => {
  for (const [vem, person] of [
    ['byggaren', ANNA],
    ['den som bara får titta', VERA],
    ['den utan roller', INGEN],
  ] as const) {
    it(`${vem} nekas alla tre rutterna`, async () => {
      const lista = await anropa(m.builder, person, 'GET', ANVANDARE);
      expect(lista.status).toBe(403);
      expect(lista.json.error.code).toBe('forbidden');
      expect(lista.json.users).toBeUndefined();

      const inbjudan = await anropa(m.builder, person, 'POST', ANVANDARE, { body: { email: 'ny@example.org', role: 'builder' } });
      expect(inbjudan.status).toBe(403);

      const rollbyte = await anropa(m.builder, person, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } });
      expect(rollbyte.status).toBe(403);

      // Och ingenting hände: varken en ny adress eller en ändrad roll.
      expect(katalog.list().map((rad) => rad.email)).not.toContain('ny@example.org');
      expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('builder');
    });
  }

  it('administratören släpps in', async () => {
    expect((await anropa(m.builder, ADAM, 'GET', ANVANDARE)).status).toBe(200);
  });
});

describe('rutterna är exakta', () => {
  it('GET mot en enskild användare ger 405 — rollen sätts med POST', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', anvandare(ANNA.userId));
    expect(svar.status).toBe(405);
    expect(svar.json.error.code).toBe('method_not_allowed');
  });

  it('DELETE och PUT ger 405 på båda rutterna', async () => {
    for (const vag of [ANVANDARE, anvandare(ANNA.userId)]) {
      for (const metod of ['DELETE', 'PUT', 'PATCH']) {
        expect((await anropa(m.builder, ADAM, metod, vag)).status).toBe(405);
      }
    }
  });

  for (const vag of ['/admin/anvandare/', '/admin/anvandare/u-anna/extra', '/admin/Anvandare', '/admin/anvandare//u-anna']) {
    it(`${vag} är ingen rutt, inte ens för en administratör`, async () => {
      const svar = await anropa(m.builder, ADAM, 'POST', api(vag), { body: { role: 'viewer' } });
      expect([400, 404]).toContain(svar.status);
      expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('builder');
    });
  }
});

describe('GET /admin/anvandare', () => {
  it('listar alla adresser med roll, äldst först, och märker ut den egna raden', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', ANVANDARE);
    expect(svar.status).toBe(200);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(svar.json.users.map((rad: { email: string }) => rad.email)).toEqual([
      ANNA.email,
      BERTIL.email,
      ADAM.email,
      VERA.email,
    ]);
    expect(svar.json.users[0]).toEqual({
      userId: ANNA.userId,
      email: ANNA.email,
      role: 'builder',
      createdAt: expect.any(String),
      self: false,
    });
    expect(svar.json.users.find((rad: { userId: string }) => rad.userId === ADAM.userId).self).toBe(true);
  });

  it('en rad utan läsbar tidpunkt ger null — inte en tom sträng och inte en gissning', async () => {
    katalog.lagTill({ userId: 'u-utan-tid', email: 'utan-tid@example.org', roles: ['viewer'] }, null);
    const svar = await anropa(m.builder, ADAM, 'GET', ANVANDARE);
    const rad = svar.json.users.find((kandidat: { userId: string }) => kandidat.userId === 'u-utan-tid');
    // Personen syns ändå: den som inte syns går inte heller att ändra rollen på.
    expect(rad).toMatchObject({ email: 'utan-tid@example.org', role: 'viewer', createdAt: null });
  });
});

describe('POST /admin/anvandare — bjuder in eller höjer', () => {
  it('en ny adress bjuds in och syns i listan', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: 'ny@example.org', role: 'builder' } });
    expect(svar.status).toBe(201);
    expect(svar.json.user).toMatchObject({ email: 'ny@example.org', role: 'builder', self: false });
    expect(typeof svar.json.user.userId).toBe('string');

    const lista = await anropa(m.builder, ADAM, 'GET', ANVANDARE);
    expect(lista.json.users.map((rad: { email: string }) => rad.email)).toContain('ny@example.org');
  });

  it('höjer en befintlig roll', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: VERA.email, role: 'builder' } });
    expect(svar.status).toBe(201);
    expect(svar.json.user).toMatchObject({ userId: VERA.userId, role: 'builder' });
  });

  it('sänker ALDRIG en roll — den vägen går bara över den enskilda användaren', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: ANNA.email, role: 'viewer' } });
    expect(svar.status).toBe(201);
    expect(svar.json.user.role).toBe('builder');
    expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('builder');
  });

  it('adressen normaliseras — samma person, inte en ny rad', async () => {
    const fore = katalog.list().length;
    const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: `  ${ANNA.email.toUpperCase()} `, role: 'builder' } });
    expect(svar.status).toBe(201);
    expect(svar.json.user.userId).toBe(ANNA.userId);
    expect(katalog.list()).toHaveLength(fore);
  });

  for (const [vad, kropp] of [
    ['ingen adress alls', { role: 'builder' }],
    ['adressen är inte text', { email: 42, role: 'builder' }],
    ['tom adress', { email: '   ', role: 'builder' }],
    ['ingen snabel-a', { email: 'inte-en-adress', role: 'builder' }],
    ['överlång adress', { email: `${'a'.repeat(250)}@example.org`, role: 'builder' }],
    ['adress med radbrytning', { email: 'ny@example.org\nBcc: annan@example.org', role: 'builder' }],
  ] as const) {
    it(`avvisar ${vad}`, async () => {
      const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: kropp });
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      expect(typeof svar.json.error.message).toBe('string');
      expect(katalog.list().map((rad) => rad.email)).not.toContain('ny@example.org');
    });
  }

  for (const [vad, roll] of [
    ['okänd roll', 'superuser'],
    ['rollen med fel skiftläge', 'Builder'],
    ['appens roll, inte plattformens', 'owner'],
    ['roll som inte är text', 3],
    ['ingen roll alls', undefined],
    ['ett arvsfält som roll', '__proto__'],
    ['toString som roll', 'toString'],
  ] as const) {
    it(`avvisar ${vad}`, async () => {
      const kropp = roll === undefined ? { email: 'ny@example.org' } : { email: 'ny@example.org', role: roll };
      const svar = await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: kropp });
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      expect(katalog.list().map((rad) => rad.email)).not.toContain('ny@example.org');
    });
  }
});

describe('POST /admin/anvandare/:userId — sätter rollen rakt av', () => {
  it('sänker en byggare till att bara få titta', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } });
    expect(svar.status).toBe(200);
    expect(svar.json.user).toMatchObject({ userId: ANNA.userId, email: ANNA.email, role: 'viewer', self: false });
    expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('viewer');
  });

  it('höjer också — samma rutt, rollen sätts rakt av', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', anvandare(VERA.userId), { body: { role: 'admin' } });
    expect(svar.status).toBe(200);
    expect(svar.json.user.role).toBe('admin');
  });

  it('en sänkt roll gäller direkt: nästa förfrågan från samma person nekas', async () => {
    // Anna bygger just nu — hon har en app och en pågående, inloggad session.
    const appId = await nyApp(m.builder, ANNA);
    expect((await anropa(m.builder, ANNA, 'GET', api('/apps'))).status).toBe(200);

    expect((await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } })).status).toBe(200);

    // Byggverktyget läser rollen ur identiteten vid varje förfrågan (gatewayn sätter
    // `request.identity`), så hennes nästa anrop kommer in som `viewer`.
    const efterat: Identity = { ...ANNA, roles: ['viewer'] };
    const appar = await anropa(m.builder, efterat, 'GET', api('/apps'));
    expect(appar.status).toBe(403);
    expect((await anropa(m.builder, efterat, 'GET', api(`/apps/${appId}`))).status).toBe(403);
    expect((await anropa(m.builder, efterat, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'Bygg vidare' } })).status).toBe(403);
  });

  describe('den egna raden', () => {
    it('går inte att sänka — det skulle låsa ut administratören', async () => {
      const svar = await anropa(m.builder, ADAM, 'POST', anvandare(ADAM.userId), { body: { role: 'viewer' } });
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      expect(typeof svar.json.error.message).toBe('string');
      expect(svar.json.error.message.length).toBeGreaterThan(0);
      expect(katalog.list().find((rad) => rad.userId === ADAM.userId)?.role).toBe('admin');

      // Och hon är fortfarande inne.
      expect((await anropa(m.builder, ADAM, 'GET', ANVANDARE)).status).toBe(200);
    });

    it('går inte att röra alls, inte ens till samma roll', async () => {
      for (const roll of ['admin', 'builder', 'viewer']) {
        const svar = await anropa(m.builder, ADAM, 'POST', anvandare(ADAM.userId), { body: { role: roll } });
        expect(svar.status).toBe(400);
        expect(svar.json.error.code).toBe('invalid_request');
      }
      expect(katalog.list().find((rad) => rad.userId === ADAM.userId)?.role).toBe('admin');
    });

    it('avvisas före rollen ens läses — beskedet ska handla om den egna raden', async () => {
      const svar = await anropa(m.builder, ADAM, 'POST', anvandare(ADAM.userId), { body: { role: 'superuser' } });
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
    });

    it('en ANNAN administratör går däremot att sänka', async () => {
      katalog.lagTill({ userId: 'u-berit', email: 'berit.admin@example.org', roles: ['admin'] });
      const svar = await anropa(m.builder, ADAM, 'POST', anvandare('u-berit'), { body: { role: 'builder' } });
      expect(svar.status).toBe(200);
      expect(svar.json.user.role).toBe('builder');
    });
  });

  for (const [vad, userId] of [
    ['ett arvsfält', '__proto__'],
    ['constructor', 'constructor'],
    ['ett överlångt id', 'u'.repeat(65)],
    ['ett id med NUL', 'u-anna\u0000'],
    ['ett id med snedstreck', 'u-anna%2Fx'],
    ['ett id med punkter', '..'],
  ] as const) {
    it(`avvisar ${vad} som användar-id, utan att röra någon`, async () => {
      const svar = await anropa(m.builder, ADAM, 'POST', anvandare(userId), { body: { role: 'viewer' } });
      expect([400, 404]).toContain(svar.status);
      expect(svar.json.error.code === 'invalid_request' || svar.json.error.code === 'not_found').toBe(true);
      expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('builder');
      // Och inget arvsfält har satts på vägen: ett nytt, tomt objekt har fortfarande ingen roll.
      expect(({} as Record<string, unknown>)['role']).toBeUndefined();
    });
  }

  it('ett välformat men okänt id ger 404', async () => {
    const svar = await anropa(m.builder, ADAM, 'POST', anvandare('u-finns-inte'), { body: { role: 'viewer' } });
    expect(svar.status).toBe(404);
    expect(svar.json.error.code).toBe('not_found');
  });

  it('avvisar en okänd roll utan att röra personen', async () => {
    for (const roll of ['superuser', 'Admin', 'owner', 7, null]) {
      const svar = await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: roll } });
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
    }
    expect((await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: {} })).status).toBe(400);
    expect(katalog.list().find((rad) => rad.userId === ANNA.userId)?.role).toBe('builder');
  });
});

describe('siffrorna i översikten', () => {
  it('räknar adresserna per roll', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.json.users).toEqual({ admin: 1, builder: 2, viewer: 1 });
  });

  it('följer med när en roll ändras', async () => {
    await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } });
    await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: 'ny@example.org', role: 'builder' } });

    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.json.users).toEqual({ admin: 1, builder: 2, viewer: 2 });
  });

  it('översikten röjer ingen adress', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', OVERSIKT);
    expect(svar.text).not.toContain('@');
  });
});

describe('ägarens adress i applistan', () => {
  /** En app från före åtkomstlistan: ägaren finns i control, men utan adress. */
  async function appUtanAdressIControl(agare: Identity): Promise<string> {
    const appId = await nyApp(m.builder, agare, 'Gammal app');
    const rader = m.control.atkomst.get(appId) ?? [];
    for (const rad of rader) rad.email = null;
    return appId;
  }

  it('fylls i från identiteten när control saknar den', async () => {
    const appId = await appUtanAdressIControl(ANNA);
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0]).toMatchObject({
      appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      ownerEmail: ANNA.email,
    });
  });

  it('förblir null när adressen saknas i BÅDA — aldrig en gissning', async () => {
    const okand: Identity = { userId: 'u-okand', email: 'okand@example.org', roles: ['builder'] };
    await appUtanAdressIControl(okand);
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0].ownerEmail).toBeNull();
    expect(svar.text).not.toContain(okand.email);
  });

  it('control går före: en adress som redan finns där slås inte upp igen', async () => {
    await nyApp(m.builder, ANNA);
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0].ownerEmail).toBe(ANNA.email);
  });

  it('slår upp alla id i EN vändning för hela listan', async () => {
    for (const agare of [ANNA, BERTIL, ADAM]) {
      await appUtanAdressIControl(agare);
      m.tid.ms += 1000;
    }
    katalog.uppslagningar = 0;
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps).toHaveLength(3);
    expect(svar.json.apps.map((app: { ownerEmail: string | null }) => app.ownerEmail).sort()).toEqual(
      [ANNA.email, BERTIL.email, ADAM.email].sort(),
    );
    expect(katalog.uppslagningar).toBe(1);
  });

  it('en app som control inte känner alls ger fortfarande en rad', async () => {
    const appId = await nyApp(m.builder, ANNA);
    m.control.appar.delete(appId);
    const svar = await anropa(m.builder, ADAM, 'GET', APPAR);
    expect(svar.json.apps[0]).toMatchObject({ ownerEmail: ANNA.email, members: 0 });
  });
});

describe('adresserna är personuppgifter', () => {
  it('ingen loggrad i hela körningen innehåller en adress', async () => {
    const appId = await nyApp(m.builder, ANNA);
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista', ANNA), ANNA);
    await anropa(m.builder, ADAM, 'GET', ANVANDARE);
    await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: 'ny@example.org', role: 'builder' } });
    await anropa(m.builder, ADAM, 'POST', ANVANDARE, { body: { email: 'trasig-adress', role: 'builder' } });
    await anropa(m.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } });
    await anropa(m.builder, ADAM, 'POST', anvandare(ADAM.userId), { body: { role: 'viewer' } });
    await anropa(m.builder, ADAM, 'GET', APPAR);

    expect(JSON.stringify(m.logg)).not.toContain('@');
    expect(m.logg.length).toBeGreaterThan(0);
  });

  it('svaren däremot bär adresserna — det är kontrollrummets uppgift', async () => {
    const svar = await anropa(m.builder, ADAM, 'GET', ANVANDARE);
    expect(svar.text).toContain(ANNA.email);
  });
});

describe('utan bryggan till identiteten', () => {
  let utan: Miljo;

  beforeEach(async () => {
    utan = await skapaMiljo();
  });
  afterEach(async () => {
    await utan.stada();
  });

  it('svarar att användarhanteringen inte är inkopplad, i stället för att gissa', async () => {
    for (const svar of [
      await anropa(utan.builder, ADAM, 'GET', ANVANDARE),
      await anropa(utan.builder, ADAM, 'POST', ANVANDARE, { body: { email: 'ny@example.org', role: 'builder' } }),
      await anropa(utan.builder, ADAM, 'POST', anvandare(ANNA.userId), { body: { role: 'viewer' } }),
    ]) {
      expect(svar.status).toBe(503);
      expect(svar.json.error.code).toBe('unavailable');
    }
  });

  it('resten av kontrollrummet fungerar: nollor, inte fel', async () => {
    const appId = await nyApp(utan.builder, ANNA);
    const oversikt = await anropa(utan.builder, ADAM, 'GET', OVERSIKT);
    expect(oversikt.status).toBe(200);
    expect(oversikt.json.users).toEqual({ admin: 0, builder: 0, viewer: 0 });

    const appar = await anropa(utan.builder, ADAM, 'GET', APPAR);
    expect(appar.status).toBe(200);
    expect(appar.json.apps[0]).toMatchObject({ appIdPrefix: appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH), ownerEmail: ANNA.email });
  });

  it('en byggare nekas fortfarande — 403 före beskedet om att bryggan saknas', async () => {
    const svar = await anropa(utan.builder, ANNA, 'GET', ANVANDARE);
    expect(svar.status).toBe(403);
  });
});
