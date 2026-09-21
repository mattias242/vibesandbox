/**
 * Kontrollrummets användarhantering genom HELA plattformen: riktig gateway, riktig
 * e-postinloggning, riktig identitetsdatabas. Byggverktyget når användarna via bryggan som
 * `createPlatform` kopplar in (`createBuilder({ users })`).
 *
 * Det viktiga här går inte att visa i byggverktygets egna tester, eftersom det handlar om två
 * lager samtidigt: en roll som sänks i identitetsdatabasen gäller DIREKT, även för någon som
 * redan är inloggad — gatewayn läser rollen ur databasen vid varje förfrågan, ingen ny
 * inloggning behövs och ingen session behöver städas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser, Role } from '@vibesandbox/contracts';
import { testLoginPath } from '@vibesandbox/gateway';
import { Webblasare } from './stod/webblasare.ts';
import { BYGG, BYGG_ORIGIN, TESTHEMLIGHET, loggaInMedKod, startaPlattform } from './stod/plattform.ts';
import type { Testplattform } from './stod/plattform.ts';

const ANVANDARE = '/_api/builder/admin/anvandare';
const APPAR = '/_api/builder/apps';

let plattform: Testplattform;
let adam: Webblasare;

/** Loggar in en redan inbjuden adress och ger hennes webbläsare (med sessionskakan). */
async function loggaIn(epost: string): Promise<Webblasare> {
  const webblasare = new Webblasare(plattform.port);
  const svar = await loggaInMedKod(webblasare, plattform, BYGG, epost);
  expect(svar.status).toBe(303);
  return webblasare;
}

function anvandarna(kropp: string): AdminUser[] {
  return (JSON.parse(kropp) as { users: AdminUser[] }).users;
}

beforeEach(async () => {
  plattform = await startaPlattform({ identitet: 'email-otp' });
  await plattform.platform.addUser('adam.admin@example.org', 'admin');
  adam = await loggaIn('adam.admin@example.org');
});

afterEach(async () => {
  await plattform.stang();
});

describe('kontrollrummet ser plattformens användare', () => {
  it('listar adresserna med roll och märker ut den egna raden', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');

    const svar = await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN });
    expect(svar.status).toBe(200);
    const users = anvandarna(svar.body);
    expect(users.map((rad) => rad.email)).toEqual(['adam.admin@example.org', 'anna@example.org']);
    expect(users[0]).toMatchObject({ role: 'admin', self: true });
    expect(users[1]).toMatchObject({ role: 'builder', self: false });
  });

  it('översikten räknar adresserna per roll — inte nollor', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    await plattform.platform.addUser('vera@example.org', 'viewer');

    const svar = await adam.api(BYGG, 'GET', '/_api/builder/admin/oversikt', { origin: BYGG_ORIGIN });
    expect(svar.status).toBe(200);
    expect((JSON.parse(svar.body) as { users: unknown }).users).toEqual({ admin: 1, builder: 1, viewer: 1 });
  });

  it('en byggare kommer inte in i kontrollrummet', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = await loggaIn('anna@example.org');
    expect((await anna.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).status).toBe(403);
  });
});

describe('en inbjudan från kontrollrummet', () => {
  it('ger en ny adress rätt att logga in — och hon kommer in', async () => {
    const inbjudan = await adam.api(BYGG, 'POST', ANVANDARE, {
      origin: BYGG_ORIGIN,
      json: { email: 'nyfiken@example.org', role: 'builder' },
    });
    expect(inbjudan.status).toBe(201);

    // Hela vägen: hon begär en kod, får mejlet och når byggverktyget.
    const nyfiken = await loggaIn('nyfiken@example.org');
    expect((await nyfiken.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(200);
  });

  it('höjer en befintlig adress, men sänker aldrig', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const sankning = await adam.api(BYGG, 'POST', ANVANDARE, { origin: BYGG_ORIGIN, json: { email: 'anna@example.org', role: 'viewer' } });
    expect(sankning.status).toBe(201);
    expect((JSON.parse(sankning.body) as { user: AdminUser }).user.role).toBe('builder');
  });
});

describe('en sänkt roll gäller direkt', () => {
  it('för en session som redan är inloggad — utan ny inloggning och utan omstart', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = await loggaIn('anna@example.org');

    // Anna bygger: hennes session fungerar just nu.
    const app = await anna.api(BYGG, 'POST', APPAR, { origin: BYGG_ORIGIN, json: { name: 'Annas app' } });
    expect(app.status).toBe(201);
    expect((await anna.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(200);

    const anna_id = anvandarna((await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).body).find(
      (rad) => rad.email === 'anna@example.org',
    )?.userId;
    expect(anna_id).toBeDefined();

    const sankning = await adam.api(BYGG, 'POST', `${ANVANDARE}/${anna_id ?? ''}`, { origin: BYGG_ORIGIN, json: { role: 'viewer' } });
    expect(sankning.status).toBe(200);
    expect((JSON.parse(sankning.body) as { user: AdminUser }).user.role).toBe('viewer');

    // SAMMA sessionskaka, nästa förfrågan: gatewayn läser rollen ur databasen varje gång.
    expect((await anna.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(403);
    expect((await anna.api(BYGG, 'POST', APPAR, { origin: BYGG_ORIGIN, json: { name: 'En till' } })).status).toBe(403);
    // Hon är fortfarande inloggad — hon har bara inte längre rätt att bygga.
    const me = await anna.api(BYGG, 'GET', '/_api/builder/me', { origin: BYGG_ORIGIN });
    expect(me.status).toBe(200);
    expect((JSON.parse(me.body) as { canBuild: boolean }).canBuild).toBe(false);
  });
});

describe('den egna raden', () => {
  it('går inte att sänka — administratören skulle låsa ut sig', async () => {
    const users = anvandarna((await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).body);
    const jag = users.find((rad) => rad.self);
    expect(jag).toBeDefined();

    const svar = await adam.api(BYGG, 'POST', `${ANVANDARE}/${jag?.userId ?? ''}`, { origin: BYGG_ORIGIN, json: { role: 'viewer' } });
    expect(svar.status).toBe(400);
    expect((JSON.parse(svar.body) as { error: { code: string } }).error.code).toBe('invalid_request');

    // Och han är kvar som administratör, med kontrollrummet öppet.
    expect((await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).status).toBe(200);
  });
});

describe('adresserna är personuppgifter', () => {
  it('ingen loggrad från hela körningen innehåller en adress', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = await loggaIn('anna@example.org');
    await anna.api(BYGG, 'POST', APPAR, { origin: BYGG_ORIGIN, json: { name: 'Annas app' } });

    await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN });
    await adam.api(BYGG, 'POST', ANVANDARE, { origin: BYGG_ORIGIN, json: { email: 'nyfiken@example.org', role: 'builder' } });
    await adam.api(BYGG, 'POST', ANVANDARE, { origin: BYGG_ORIGIN, json: { email: 'trasig-adress', role: 'builder' } });
    await adam.api(BYGG, 'GET', '/_api/builder/admin/appar', { origin: BYGG_ORIGIN });

    expect(plattform.logg.length).toBeGreaterThan(0);
    expect(JSON.stringify(plattform.logg)).not.toContain('@');
  });
});

describe('testinloggningen: registret är auktoritativt för rollen', () => {
  /**
   * Testinloggningen bär rollen i en signerad token. Registret finns ändå — rollerna bor i ETT
   * register oavsett hur man loggade in — och det är registret som avgör vad man får göra när
   * det känner användaren. Den som registret inte känner behåller tokenens roller; i drift kan
   * det inte inträffa, eftersom varje session där slås upp mot en användarrad.
   */
  let testplattform: Testplattform;

  /** En webbläsare med en signerad testinloggning för den här identiteten. */
  async function loggaInMedToken(who: { userId: string; email: string; roles: Role[] }): Promise<Webblasare> {
    const webblasare = new Webblasare(testplattform.port);
    const svar = await webblasare.oppna(BYGG, testLoginPath(who, TESTHEMLIGHET));
    expect(svar.status).toBe(303);
    return webblasare;
  }

  beforeEach(async () => {
    await plattform.stang();
    testplattform = await startaPlattform({ identitet: 'test' });
    plattform = testplattform;
  });

  it('en sänkt roll gäller direkt, också för en testinloggning som redan är inne', async () => {
    const anna = await testplattform.platform.addUser('anna@example.org', 'builder');
    const webblasare = await loggaInMedToken({ userId: anna.userId, email: 'anna@example.org', roles: ['builder'] });
    expect((await webblasare.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(200);

    // Administratören står inte i registret: hon behåller tokenens roller och kommer in.
    const adam = await loggaInMedToken({ userId: 'u-adam', email: 'adam.admin@example.org', roles: ['admin'] });
    const sankning = await adam.api(BYGG, 'POST', `${ANVANDARE}/${anna.userId}`, { origin: BYGG_ORIGIN, json: { role: 'viewer' } });
    expect(sankning.status).toBe(200);

    // Samma token, nästa förfrågan: rollen kommer ur registret, inte ur tokenen.
    expect((await webblasare.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(403);
  });

  it('en token som säger admin men en registerrad som säger byggare ⇒ byggare', async () => {
    const anna = await testplattform.platform.addUser('anna@example.org', 'builder');
    const webblasare = await loggaInMedToken({ userId: anna.userId, email: 'anna@example.org', roles: ['admin'] });
    expect((await webblasare.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).status).toBe(403);
    expect((await webblasare.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(200);
  });

  it('den som registret inte känner behåller inloggningens roller', async () => {
    const okand = await loggaInMedToken({ userId: 'u-okand', email: 'okand@example.org', roles: ['builder'] });
    expect((await okand.api(BYGG, 'GET', APPAR, { origin: BYGG_ORIGIN })).status).toBe(200);
  });

  it('en administratör som står i registret kan inte sänka sin egen roll', async () => {
    const adam = await testplattform.platform.addUser('adam.admin@example.org', 'admin');
    const webblasare = await loggaInMedToken({ userId: adam.userId, email: 'adam.admin@example.org', roles: ['admin'] });

    const lista = await webblasare.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN });
    expect(anvandarna(lista.body).find((rad) => rad.self)?.userId).toBe(adam.userId);

    const svar = await webblasare.api(BYGG, 'POST', `${ANVANDARE}/${adam.userId}`, { origin: BYGG_ORIGIN, json: { role: 'viewer' } });
    expect(svar.status).toBe(400);
    expect((JSON.parse(svar.body) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await webblasare.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN })).status).toBe(200);
  });

  it('kontrollrummet listar och räknar användarna också här', async () => {
    await testplattform.platform.addUser('anna@example.org', 'builder');
    const adam = await loggaInMedToken({ userId: 'u-adam', email: 'adam.admin@example.org', roles: ['admin'] });

    const lista = await adam.api(BYGG, 'GET', ANVANDARE, { origin: BYGG_ORIGIN });
    expect(anvandarna(lista.body).map((rad) => rad.email)).toEqual(['anna@example.org']);
    const oversikt = await adam.api(BYGG, 'GET', '/_api/builder/admin/oversikt', { origin: BYGG_ORIGIN });
    expect((JSON.parse(oversikt.body) as { users: unknown }).users).toEqual({ admin: 0, builder: 1, viewer: 0 });
  });
});
