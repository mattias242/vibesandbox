/**
 * Inloggning med engångskod, per värd.
 *
 *   Givet en inbjuden vän som öppnar länken till en app
 *   När hen skriver sin adress, får en kod till mejlen och skriver in den
 *   Så är hen inloggad på just den appens värd — och ingen annanstans
 *
 *   Givet en adress som INTE är inbjuden
 *   När någon begär en kod till den
 *   Så ser svaret exakt likadant ut, men inget mejl skickas
 *
 *   Givet en kod som har gått ut, redan använts, gissats fel för många gånger,
 *     ersatts av en nyare, eller skrivs in i en annan webbläsare
 *   Så släpps ingen in
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEMLIGHET,
  VARD_A,
  VARD_B,
  Webblasare,
  felKod,
  kodUrUtkorgen,
  loggaIn,
  skapaUppsattning,
  stadaAllt,
} from './hjalp.ts';
import type { Uppsattning } from './hjalp.ts';

const ANNA = 'anna@example.org';
const OKAND = 'okand@example.org';

describe('inloggning med engångskod', () => {
  let u: Uppsattning;
  let webblasare: Webblasare;

  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
    webblasare = new Webblasare(u.leverantor);
  });
  afterEach(stadaAllt);

  it('har inloggningssidan /_auth/login', () => {
    expect(u.leverantor.loginPath).toBe('/_auth/login');
    expect(u.leverantor.name).toBe('email-otp');
  });

  it('visar ett formulär för e-postadressen, med next i ett dolt fält', async () => {
    const svar = await webblasare.get(VARD_A, '/_auth/login', { next: '/lista?x=1' });
    expect(svar?.status).toBe(200);
    expect(svar?.body).toContain('<form method="post" action="/_auth/login"');
    expect(svar?.body).toContain('name="email"');
    expect(svar?.body).toContain('name="next" value="/lista?x=1"');
    expect(svar?.kakor).toEqual([]);
  });

  it('släpper in en inbjuden adress och skickar vidare till next', async () => {
    const begaran = await webblasare.post(VARD_A, '/_auth/login', { email: `  ${ANNA.toUpperCase()} `, next: '/lista' });
    expect(begaran?.status).toBe(200);
    expect(begaran?.body).toContain('name="code"');
    expect(u.utkorg.messages).toHaveLength(1);
    const mejl = u.utkorg.messages[0];
    expect(mejl?.to).toBe(ANNA);
    expect(mejl?.text).not.toMatch(/https?:\/\//);

    const svar = await webblasare.post(VARD_A, '/_auth/verify', { code: kodUrUtkorgen(u.utkorg, ANNA) });
    expect(svar?.status).toBe(303);
    expect(svar?.headers['Location']).toBe('/lista');

    const vem = await webblasare.vem(VARD_A);
    expect(vem?.email).toBe(ANNA);
    expect(vem?.roles).toEqual(['viewer']);
    expect(vem?.userId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(vem?.userId).not.toContain('anna');
  });

  it('sätter en __Host-kaka med Secure över https', async () => {
    const svar = await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    const session = svar?.kakor.find((k) => k.startsWith('__Host-vs-session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/; Path=\/;/);
    expect(session).toContain('; HttpOnly');
    expect(session).toContain('; Secure');
    expect(session).toContain('; SameSite=Lax');
    expect(session).toMatch(/; Max-Age=\d+/);
    // Utmaningskakan städas bort när den har gjort sitt.
    expect(webblasare.burk(VARD_A).has('__Host-vs-challenge')).toBe(false);
  });

  it('använder vs-session utan Secure över http — valt av inställningen, inte av förfrågan', async () => {
    const lokal = await skapaUppsattning({ publicScheme: 'http' });
    await lokal.leverantor.addUser(ANNA, 'builder');
    const b = new Webblasare(lokal.leverantor, 'http');
    const svar = await loggaIn(b, lokal.utkorg, VARD_A, ANNA);
    const session = svar?.kakor.find((k) => k.startsWith('vs-session='));
    expect(session).toBeDefined();
    expect(session).not.toContain('Secure');
    expect(svar?.kakor.join('\n')).not.toContain('__Host-');
    expect((await b.vem(VARD_A))?.roles).toEqual(['builder']);

    // En https-leverantör läser aldrig http-namnet, hur förfrågan än ser ut.
    const https = new Webblasare(u.leverantor);
    https.burk(VARD_A).set('vs-session', b.burk(VARD_A).get('vs-session') ?? '');
    expect(await https.vem(VARD_A)).toBeNull();
  });

  it('ger en ej inbjuden adress exakt samma sida och samma kaka — men skickar inget mejl', async () => {
    const annan = new Webblasare(u.leverantor);
    const inbjuden = await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ej = await annan.post(VARD_A, '/_auth/login', { email: OKAND, next: '/' });
    expect(ej?.status).toBe(inbjuden?.status);
    expect(ej?.body).toBe(inbjuden?.body);
    expect(ej?.kakor.map((k) => k.replace(/=[^;]*/, '=X'))).toEqual(inbjuden?.kakor.map((k) => k.replace(/=[^;]*/, '=X')));
    expect(u.utkorg.messages.map((m) => m.to)).toEqual([ANNA]);

    // Och ingen kod släpper in den ej inbjudna — inte ens en gissning som råkar vara rätt.
    for (let i = 0; i < 5; i += 1) {
      const svar = await annan.post(VARD_A, '/_auth/verify', { code: String(100000 + i) });
      expect(svar?.status).toBe(401);
    }
    expect(await annan.vem(VARD_A)).toBeNull();
  });

  it('ger en ogiltig adress 400 och skickar inget', async () => {
    const svar = await webblasare.post(VARD_A, '/_auth/login', { email: 'inte en adress', next: '/' });
    expect(svar?.status).toBe(400);
    expect(svar?.body).toContain('name="email"');
    expect(svar?.kakor).toEqual([]);
    expect(u.utkorg.messages).toHaveLength(0);
  });

  it('förbrukar utmaningen efter 5 felaktiga försök — även rätt kod nekas sedan', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    for (let i = 0; i < 5; i += 1) {
      const svar = await webblasare.post(VARD_A, '/_auth/verify', { code: felKod(ratt) });
      expect(svar?.status).toBe(401);
    }
    const sista = await webblasare.post(VARD_A, '/_auth/verify', { code: ratt });
    expect(sista?.status).toBe(401);
    expect(await webblasare.vem(VARD_A)).toBeNull();
  });

  it('släpper in efter 4 felaktiga försök och ett rätt', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    for (let i = 0; i < 4; i += 1) await webblasare.post(VARD_A, '/_auth/verify', { code: felKod(ratt) });
    const svar = await webblasare.post(VARD_A, '/_auth/verify', { code: ratt });
    expect(svar?.status).toBe(303);
  });

  it('nekar en kod som har gått ut (10 minuter)', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    u.klocka.flytta(10 * 60 * 1000 + 1);
    const svar = await webblasare.post(VARD_A, '/_auth/verify', { code: ratt });
    expect(svar?.status).toBe(401);
    expect(await webblasare.vem(VARD_A)).toBeNull();
  });

  it('godtar en kod strax före utgången', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    u.klocka.flytta(10 * 60 * 1000 - 1000);
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(303);
  });

  it('nekar en kod som redan har använts', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    const utmaning = webblasare.burk(VARD_A).get('__Host-vs-challenge');
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(303);

    // Samma utmaningskaka och samma kod en gång till, i en annan flik.
    const igen = new Webblasare(u.leverantor);
    igen.burk(VARD_A).set('__Host-vs-challenge', utmaning ?? '');
    expect((await igen.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(401);
    expect(await igen.vem(VARD_A)).toBeNull();
  });

  it('nekar koden i en annan webbläsare — utan utmaningskaka eller med en annan', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);

    const utan = new Webblasare(u.leverantor);
    expect((await utan.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(401);

    const angripare = new Webblasare(u.leverantor);
    await angripare.post(VARD_A, '/_auth/login', { email: OKAND, next: '/' });
    expect((await angripare.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(401);
    expect(await angripare.vem(VARD_A)).toBeNull();

    // Den rätta webbläsaren kommer fortfarande in.
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(303);
  });

  it('nekar en utmaning som skapades på en annan värd', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    webblasare.burk(VARD_B).set('__Host-vs-challenge', webblasare.burk(VARD_A).get('__Host-vs-challenge') ?? '');
    expect((await webblasare.post(VARD_B, '/_auth/verify', { code: ratt }))?.status).toBe(401);
    expect(await webblasare.vem(VARD_B)).toBeNull();
  });

  it('låter en ny utmaning för samma adress ogiltigförklara den gamla', async () => {
    const forsta = new Webblasare(u.leverantor);
    await forsta.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const gammal = kodUrUtkorgen(u.utkorg, ANNA);
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ny = kodUrUtkorgen(u.utkorg, ANNA);

    expect((await forsta.post(VARD_A, '/_auth/verify', { code: gammal }))?.status).toBe(401);
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: ny }))?.status).toBe(303);
  });

  it('nekar en dubblerad utmaningskaka', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    const kaka = webblasare.burk(VARD_A).get('__Host-vs-challenge') ?? '';
    const svar = await webblasare.post(
      VARD_A,
      '/_auth/verify',
      { code: ratt },
      { headers: { cookie: `__Host-vs-challenge=${kaka}; __Host-vs-challenge=${kaka}` } },
    );
    expect(svar?.status).toBe(401);
  });

  it('tar emot koden med mellanslag, men nekar allt som inte är sex siffror', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    for (const skrap of [`${ratt}0`, ratt.slice(1), '12345a', `${ratt}\u0000`, '١٢٣٤٥٦']) {
      expect((await webblasare.post(VARD_A, '/_auth/verify', { code: skrap }))?.status).toBe(401);
    }
    // Fem försök är nu förbrukade — skräp räknas som försök. Ny kod:
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ny = kodUrUtkorgen(u.utkorg, ANNA);
    const medMellanslag = `${ny.slice(0, 3)} ${ny.slice(3)}`;
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: medMellanslag }))?.status).toBe(303);
  });

  it('har 6 siffror i koden och olika koder varje gång', async () => {
    const koder = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
      koder.add(kodUrUtkorgen(u.utkorg, ANNA));
    }
    for (const kod of koder) expect(kod).toMatch(/^\d{6}$/);
    expect(koder.size).toBeGreaterThan(1);
  });

  it('lagrar aldrig koden, adressen i utmaningen eller sessionsvärdet i klartext', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const kod = kodUrUtkorgen(u.utkorg, ANNA);
    const utmaning = webblasare.burk(VARD_A).get('__Host-vs-challenge') ?? '';
    await webblasare.post(VARD_A, '/_auth/verify', { code: kod });
    const session = webblasare.burk(VARD_A).get('__Host-vs-session') ?? '';
    expect(session.length).toBeGreaterThanOrEqual(43);

    let allt = '';
    for (const fil of await readdir(u.katalog)) allt += (await readFile(`${u.katalog}/${fil}`)).toString('latin1');
    expect(allt).not.toContain(session);
    expect(allt).not.toContain(utmaning);
    expect(allt).not.toContain(HEMLIGHET);
    // Hasharna lagras som binära BLOB-värden, så sex siffror i följd uppstår inte av en slump.
    expect(allt).not.toContain(kod);
  });

  it('svarar 404 (null) på okända rutter under /_auth/', async () => {
    expect(await webblasare.get(VARD_A, '/_auth/okand')).toBeNull();
    expect(await webblasare.get(VARD_A, '/_auth/login/extra')).toBeNull();
    expect(await webblasare.get(VARD_A, '/_auth/test-login', { token: 'x' })).toBeNull();
  });

  it('ger 405 för GET på verify och logout', async () => {
    const verify = await webblasare.get(VARD_A, '/_auth/verify');
    expect(verify?.status).toBe(405);
    expect(verify?.headers['Allow']).toBe('POST');
    expect((await webblasare.get(VARD_A, '/_auth/logout'))?.status).toBe(405);
  });
});
