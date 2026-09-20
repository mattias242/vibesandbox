/**
 * E-postinloggning från början till slut, genom den RIKTIGA gatewayn: plattformen startas med
 * `email-otp` och en utkorg på disk, och testet gör det en människa gör i webbläsaren.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuilderMe } from '@vibesandbox/contracts';
import { Webblasare } from './stod/webblasare.ts';
import { BYGG, BYGG_ORIGIN, DOMAN, kodUr, lasUtkorg, loggaInMedKod, startaPlattform, vantaPaMejl } from './stod/plattform.ts';
import type { Testplattform } from './stod/plattform.ts';

describe('E-postinloggning till byggverktyget', () => {
  let plattform: Testplattform;

  beforeEach(async () => {
    plattform = await startaPlattform({ identitet: 'email-otp' });
  });

  afterEach(async () => {
    await plattform.stang();
  });

  it('en inbjuden byggare loggar in med en kod ur mejlet och når byggverktygets API', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = new Webblasare(plattform.port);

    // Oinloggad sidnavigering ⇒ inloggningssidan, med vart hon skulle.
    const start = await anna.oppna(BYGG, '/');
    expect(start.status).toBe(303);
    expect(start.headers.location).toBe('/_auth/login?next=%2F');

    const sida = await anna.oppna(BYGG, '/_auth/login?next=%2F');
    expect(sida.status).toBe(200);
    expect(sida.body).toContain('name="email"');

    // Formuläret med adressen, från sidans egen origin ⇒ en kod i utkorgen.
    const begaran = await anna.skickaFormular(BYGG, '/_auth/login', { email: 'anna@example.org', next: '/' }, BYGG_ORIGIN);
    expect(begaran.status).toBe(200);
    const mejl = await vantaPaMejl(plattform.utkorg, 'anna@example.org');
    expect(mejl.amne).toBe('Din inloggningskod');
    const kod = kodUr(mejl);

    // Koden ⇒ sessionskaka + 303 tillbaka dit hon skulle.
    const verifiering = await anna.skickaFormular(BYGG, '/_auth/verify', { code: kod }, BYGG_ORIGIN);
    expect(verifiering.status).toBe(303);
    expect(verifiering.headers.location).toBe('/');
    const kakor = [verifiering.headers['set-cookie'] ?? []].flat();
    expect(kakor.some((k) => k.startsWith('vs-session=') && k.includes('HttpOnly') && !/domain=/i.test(k))).toBe(true);

    const me = await anna.api(BYGG, 'GET', '/_api/builder/me', { origin: null });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body) as BuilderMe).toEqual({ displayName: 'anna', canBuild: true, services: [] });

    // Webbgränssnittet serveras nu i stället för en omdirigering.
    const ui = await anna.oppna(BYGG, '/');
    expect(ui.status).toBe(200);
    expect(ui.body).toContain('byggverktygets-webbgranssnitt');
  });

  it('samma sessionskaka godtas inte på en annan värd', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = new Webblasare(plattform.port);
    expect((await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org')).status).toBe(303);
    const session = anna.kakor(BYGG).get('vs-session');
    expect(session).toBeDefined();

    // Kakan flyttas för hand till en annan värd — det en syskonapp skulle vilja uppnå.
    const annanApp = `0123456789abcdefghjkmnpqrs.${DOMAN}`;
    for (const host of [annanApp, `p-0123456789abcdefghjkmnpqrs.${DOMAN}`]) {
      const tjuv = new Webblasare(plattform.port);
      tjuv.sattKaka(host, 'vs-session', session ?? '');
      const svar = await tjuv.api(host, 'GET', '/_api/whoami', { origin: null });
      expect(svar.status).toBe(401);
    }
  });

  it('den som inte är inbjuden får ingen kod och kommer inte in', async () => {
    const okand = new Webblasare(plattform.port);
    const begaran = await okand.skickaFormular(BYGG, '/_auth/login', { email: 'okand@example.org', next: '/' }, BYGG_ORIGIN);
    // Samma svar som för en inbjuden: sidan röjer inte vilka adresser som finns.
    expect(begaran.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await lasUtkorg(plattform.utkorg)).toEqual([]);

    const gissning = await okand.skickaFormular(BYGG, '/_auth/verify', { code: '123456' }, BYGG_ORIGIN);
    expect(gissning.status).toBe(401);
    expect((await okand.api(BYGG, 'GET', '/_api/builder/me', { origin: null })).status).toBe(401);
  });

  it('inloggningsformuläret från en annan värd nekas (Origin-kontrollen)', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = new Webblasare(plattform.port);
    const svar = await anna.skickaFormular(
      BYGG,
      '/_auth/login',
      { email: 'anna@example.org', next: '/' },
      `http://0123456789abcdefghjkmnpqrs.${DOMAN}`,
    );
    expect(svar.status).toBe(403);
    expect(await lasUtkorg(plattform.utkorg)).toEqual([]);
  });

  it('identitetsdatabasen ligger där identitetens CLI letar (DATA_DIR/identity)', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    await plattform.platform.addUser('anna@example.org', 'builder');
    expect(existsSync(join(plattform.dataDir, 'identity'))).toBe(true);
  });
});
