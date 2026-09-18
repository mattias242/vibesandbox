/**
 * Hastighetsgränser, loggning och sidornas innehåll.
 *
 *   Givet någon som begär kod efter kod
 *   Så stoppas det efter några försök med ett begripligt besked — för både inbjudna och andra
 *
 *   Givet att driften läser loggen
 *   Så står där aldrig någon adress, kod eller något kakvärde
 *
 *   Givet appvärdarnas CSP (bara skript från den egna värden, inga inline-skript)
 *   Så fungerar sidorna helt utan skript och hämtar inget utifrån
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthRequest } from '@vibesandbox/contracts';
import { HEMLIGHET, VARD_A, VARD_B, Webblasare, felKod, kodUrUtkorgen, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';
import type { Svar, Uppsattning } from './hjalp.ts';

const ANNA = 'anna@example.org';
const TIMME = 60 * 60 * 1000;

describe('hastighetsgränser', () => {
  afterEach(stadaAllt);

  it('ger 429 efter 5 koder per adress och timme — lika för inbjuden och ej inbjuden', async () => {
    const u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
    for (const adress of [ANNA, 'okand@example.org']) {
      const w = new Webblasare(u.leverantor);
      const statusar: number[] = [];
      for (let i = 0; i < 6; i += 1) statusar.push((await w.post(VARD_A, '/_auth/login', { email: adress, next: '/' }))?.status ?? 0);
      expect(statusar).toEqual([200, 200, 200, 200, 200, 429]);
    }
    expect(u.utkorg.messages.filter((m) => m.to === ANNA)).toHaveLength(5);

    const w = new Webblasare(u.leverantor);
    const stoppad = await w.post(VARD_A, '/_auth/login', { email: ANNA.toUpperCase(), next: '/' });
    expect(stoppad?.status).toBe(429);
    expect(stoppad?.body).toMatch(/för många/i);
    expect(stoppad?.kakor).toEqual([]);

    u.klocka.flytta(TIMME + 1);
    expect((await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }))?.status).toBe(200);
  });

  it('räknar per adress oavsett värd', async () => {
    const u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
    const w = new Webblasare(u.leverantor);
    for (let i = 0; i < 5; i += 1) await w.post(i % 2 === 0 ? VARD_A : VARD_B, '/_auth/login', { email: ANNA, next: '/' });
    expect((await w.post(VARD_B, '/_auth/login', { email: ANNA, next: '/' }))?.status).toBe(429);
  });

  it('begränsar per klientadress när den är känd', async () => {
    const u = await skapaUppsattning({
      clientAddress: (request: AuthRequest) => request.headers['x-test-klient'],
      limits: { challengesPerClientPerHour: 3 },
    });
    const w = new Webblasare(u.leverantor);
    const skicka = (i: number, klient: string): Promise<Svar | null> =>
      w.post(VARD_A, '/_auth/login', { email: `p${i}@example.org`, next: '/' }, { headers: { 'x-test-klient': klient } });
    expect((await skicka(1, '192.0.2.1'))?.status).toBe(200);
    expect((await skicka(2, '192.0.2.1'))?.status).toBe(200);
    expect((await skicka(3, '192.0.2.1'))?.status).toBe(200);
    expect((await skicka(4, '192.0.2.1'))?.status).toBe(429);
    expect((await skicka(5, '192.0.2.2'))?.status).toBe(200);
  });

  it('begränsar globalt', async () => {
    const u = await skapaUppsattning({ limits: { challengesGlobalPerHour: 4 } });
    const w = new Webblasare(u.leverantor);
    const statusar: number[] = [];
    for (let i = 0; i < 5; i += 1) statusar.push((await w.post(VARD_A, '/_auth/login', { email: `p${i}@example.org`, next: '/' }))?.status ?? 0);
    expect(statusar).toEqual([200, 200, 200, 200, 429]);
  });

  it('begränsar kodförsök per klientadress, över många utmaningar', async () => {
    const u = await skapaUppsattning({
      clientAddress: (request: AuthRequest) => request.headers['x-test-klient'],
      limits: { verifyAttemptsPerClientPerHour: 7 },
    });
    await u.leverantor.addUser(ANNA, 'viewer');
    const w = new Webblasare(u.leverantor);
    const klient = { headers: { 'x-test-klient': '192.0.2.9' } };
    const statusar: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }, klient);
      const ratt = kodUrUtkorgen(u.utkorg, ANNA);
      for (let j = 0; j < 4; j += 1) statusar.push((await w.post(VARD_A, '/_auth/verify', { code: felKod(ratt) }, klient))?.status ?? 0);
    }
    expect(statusar).toEqual([401, 401, 401, 401, 401, 401, 401, 429]);
  });
});

describe('loggen', () => {
  afterEach(stadaAllt);

  it('innehåller aldrig adress, kod, kakvärden eller hemligheten — men väl händelser med userId', async () => {
    const u = await skapaUppsattning();
    const { userId } = await u.leverantor.addUser(ANNA, 'builder');
    const w = new Webblasare(u.leverantor);
    await w.post(VARD_A, '/_auth/login', { email: 'okand@example.org', next: '/' });
    await w.post(VARD_A, '/_auth/verify', { code: '123456' });
    const svar = await loggaIn(w, u.utkorg, VARD_A, ANNA);
    await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }, { origin: 'https://evil.example.org' });
    await u.leverantor.invite({
      email: 'vannen@example.org',
      role: 'viewer',
      invitedBy: { userId, email: ANNA, roles: ['builder'] },
      app: { name: 'Lista', url: `https://${VARD_A}/` },
    });
    await w.post(VARD_A, '/_auth/logout', {});

    const text = JSON.stringify(u.logg);
    const kakvarden = svar?.kakor.map((k) => k.split(';')[0]?.split('=')[1] ?? '').filter((v) => v.length > 0) ?? [];
    expect(kakvarden.length).toBeGreaterThan(0);
    const koder = u.utkorg.messages.flatMap((m) => /\b\d{6}\b/.exec(m.text) ?? []);
    for (const hemligt of [ANNA, 'okand@example.org', 'vannen@example.org', 'example.org', HEMLIGHET, ...kakvarden, ...koder]) {
      expect(text).not.toContain(hemligt);
    }
    const handelser = u.logg.map((p) => p.event);
    expect(handelser).toEqual(
      expect.arrayContaining(['user_added', 'challenge_created', 'login_failed', 'login_succeeded', 'origin_rejected', 'invited', 'logout']),
    );
    expect(u.logg.find((p) => p.event === 'login_succeeded')?.userId).toBe(userId);
  });

  it('överlever en logger som kastar', async () => {
    const u = await skapaUppsattning({
      logger: () => {
        throw new Error('loggen är trasig');
      },
    });
    await u.leverantor.addUser(ANNA, 'viewer');
    const w = new Webblasare(u.leverantor);
    expect((await loggaIn(w, u.utkorg, VARD_A, ANNA))?.status).toBe(303);
  });
});

describe('sidorna', () => {
  let u: Uppsattning;
  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
  });
  afterEach(stadaAllt);

  it('har inga skript, inga händelseattribut och inga externa adresser', async () => {
    const w = new Webblasare(u.leverantor);
    const sidor: Array<Svar | null> = [];
    sidor.push(await w.get(VARD_A, '/_auth/login', { next: '/x' }));
    sidor.push(await w.post(VARD_A, '/_auth/login', { email: 'fel', next: '/' }));
    sidor.push(await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }));
    sidor.push(await w.post(VARD_A, '/_auth/verify', { code: '000000' }));
    sidor.push(await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }, { origin: 'null' }));
    for (let i = 0; i < 5; i += 1) sidor.push(await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }));
    sidor.push(await w.get(VARD_A, '/_auth/verify'));

    const kroppar = sidor.map((s) => s?.body ?? '').filter((b) => b.length > 0);
    expect(kroppar.length).toBeGreaterThanOrEqual(6);
    for (const kropp of kroppar) {
      expect(kropp).not.toMatch(/<script/i);
      expect(kropp).not.toMatch(/\son[a-z]+\s*=/i);
      expect(kropp).not.toMatch(/javascript:/i);
      expect(kropp).not.toMatch(/https?:\/\//i);
      expect(kropp).not.toMatch(/(src|href|action)\s*=\s*"\/\//i);
      expect(kropp).toContain('<html lang="sv">');
    }
  });

  it('ekar aldrig adressen i sidan med koden', async () => {
    const w = new Webblasare(u.leverantor);
    const svar = await w.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    expect(svar?.body).not.toContain(ANNA);
  });
});
