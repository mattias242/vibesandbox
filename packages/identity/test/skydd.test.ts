/**
 * Skydden leverantören själv måste verkställa, eftersom inloggningsrutterna körs FÖRE gatewayns
 * CSRF-kontroll och alla appar ligger under samma domän (ADR 0002).
 *
 *   Givet en syskonapp eller en främmande sida
 *   När den postar ett formulär mot en apps inloggningsrutter
 *   Så nekas det med 403 och ingenting händer — ingen kod, ingen kaka, ingen utloggning
 *
 *   Givet en inloggningslänk med ett `next` som pekar någon annanstans
 *   Så hamnar besökaren på appens startsida, aldrig på en annan webbplats
 *
 *   Givet en session från app A
 *   Så godtas den aldrig på app B, och en planterad dubblettkaka ger ingen inloggning
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VARD_A, VARD_B, Webblasare, kodUrUtkorgen, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';
import type { Uppsattning } from './hjalp.ts';

const ANNA = 'anna@example.org';

describe('Origin-kontroll på POST-rutterna', () => {
  let u: Uppsattning;
  let webblasare: Webblasare;

  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
    webblasare = new Webblasare(u.leverantor);
  });
  afterEach(stadaAllt);

  const felaktiga: ReadonlyArray<readonly [string, string | null]> = [
    ['utan Origin', null],
    ['Origin: null', 'null'],
    ['en syskonapp', `https://${VARD_B}`],
    ['fel schema', `http://${VARD_A}`],
    ['annan port', `https://${VARD_A}:8443`],
    ['avslutande snedstreck', `https://${VARD_A}/`],
    ['versaler', `https://${VARD_A.toUpperCase()}`],
    ['en främmande sida', 'https://evil.example.org'],
    ['värden som prefix', `https://${VARD_A}.evil.example.org`],
  ];

  for (const [namn, origin] of felaktiga) {
    it(`nekar begäran om kod med ${namn} — och skickar inget`, async () => {
      const svar = await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }, { origin });
      expect(svar?.status).toBe(403);
      expect(svar?.kakor).toEqual([]);
      expect(u.utkorg.messages).toHaveLength(0);
    });
  }

  it('nekar verify med fel Origin — och förbrukar inget försök', async () => {
    await webblasare.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    const ratt = kodUrUtkorgen(u.utkorg, ANNA);
    for (let i = 0; i < 10; i += 1) {
      const svar = await webblasare.post(VARD_A, '/_auth/verify', { code: ratt }, { origin: `https://${VARD_B}` });
      expect(svar?.status).toBe(403);
      expect(svar?.kakor).toEqual([]);
    }
    expect(await webblasare.vem(VARD_A)).toBeNull();
    expect((await webblasare.post(VARD_A, '/_auth/verify', { code: ratt }))?.status).toBe(303);
  });

  it('nekar utloggning med fel eller saknad Origin — sessionen finns kvar', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    for (const origin of [null, 'null', `https://${VARD_B}`]) {
      const svar = await webblasare.post(VARD_A, '/_auth/logout', {}, { origin });
      expect(svar?.status).toBe(403);
      expect(svar?.kakor).toEqual([]);
    }
    expect((await webblasare.vem(VARD_A))?.email).toBe(ANNA);
  });

  it('godtar en port när leverantören är inställd på den', async () => {
    const lokal = await skapaUppsattning({ publicScheme: 'http', publicPort: 8080 });
    await lokal.leverantor.addUser(ANNA, 'viewer');
    const b = new Webblasare(lokal.leverantor, 'http');
    const utanPort = await b.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' });
    expect(utanPort?.status).toBe(403);
    const medPort = await b.post(VARD_A, '/_auth/login', { email: ANNA, next: '/' }, { origin: `http://${VARD_A}:8080` });
    expect(medPort?.status).toBe(200);
  });

  it('nekar en kropp som inte är ett formulär', async () => {
    const json = await webblasare.post(VARD_A, '/_auth/login', {}, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ANNA }),
    });
    expect(json?.status).toBe(400);
    const utanKropp = await webblasare.post(VARD_A, '/_auth/login', {}, { body: undefined });
    expect(utanKropp?.status).toBe(400);
    const dubbel = await webblasare.post(VARD_A, '/_auth/login', {}, {
      body: `email=${encodeURIComponent(ANNA)}&email=${encodeURIComponent('okand@example.org')}`,
    });
    expect(dubbel?.status).toBe(400);
    const jattestor = await webblasare.post(VARD_A, '/_auth/login', {}, { body: `email=${'a'.repeat(10_000)}` });
    expect(jattestor?.status).toBe(400);
    expect(u.utkorg.messages).toHaveLength(0);
  });
});

describe('next — bara en sökväg på samma värd', () => {
  let u: Uppsattning;
  let webblasare: Webblasare;

  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'viewer');
    webblasare = new Webblasare(u.leverantor);
  });
  afterEach(stadaAllt);

  const farliga = [
    '//evil.example.org',
    '/\\evil.example.org',
    '\\\\evil.example.org',
    'https://evil.example.org',
    'javascript:alert(1)',
    '/%2F%2Fevil.example.org',
    '/%2fevil.example.org',
    '/%5Cevil.example.org',
    '/%252F%252Fevil.example.org',
    '/\tevil',
    '/\n/evil.example.org',
    '/ /evil',
    'lista',
    '',
    `/${'a'.repeat(3000)}`,
    '/åäö',
  ];

  for (const next of farliga) {
    it(`gör ${JSON.stringify(next.slice(0, 40))} till /`, async () => {
      const sida = await webblasare.get(VARD_A, '/_auth/login', { next });
      expect(sida?.body).toContain('name="next" value="/"');
      const svar = await loggaIn(webblasare, u.utkorg, VARD_A, ANNA, next);
      expect(svar?.headers['Location']).toBe('/');
    });
  }

  it('behåller en vanlig sökväg med fråga och fragmentfri adress', async () => {
    const svar = await loggaIn(webblasare, u.utkorg, VARD_A, ANNA, '/lista/1?visa=alla&x=%C3%A5');
    expect(svar?.headers['Location']).toBe('/lista/1?visa=alla&x=%C3%A5');
  });

  it('skickar aldrig tillbaka till inloggningsrutterna', async () => {
    const svar = await loggaIn(webblasare, u.utkorg, VARD_A, ANNA, '/_auth/logout');
    expect(svar?.headers['Location']).toBe('/');
  });

  it('eskapar next i sidan', async () => {
    const sida = await webblasare.get(VARD_A, '/_auth/login', { next: '/"><img src=x>' });
    expect(sida?.body).not.toContain('<img');
  });
});

describe('sessionen', () => {
  let u: Uppsattning;
  let webblasare: Webblasare;

  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'builder');
    webblasare = new Webblasare(u.leverantor);
  });
  afterEach(stadaAllt);

  it('godtas inte på en annan värd, även om kakan flyttas dit', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    expect((await webblasare.vem(VARD_A))?.email).toBe(ANNA);
    expect(await webblasare.vem(VARD_B)).toBeNull();
    webblasare.burk(VARD_B).set('__Host-vs-session', webblasare.burk(VARD_A).get('__Host-vs-session') ?? '');
    expect(await webblasare.vem(VARD_B)).toBeNull();
  });

  it('ger ingen inloggning när sessionskakan förekommer två gånger', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    const varde = webblasare.burk(VARD_A).get('__Host-vs-session') ?? '';
    for (const cookie of [
      `__Host-vs-session=${varde}; __Host-vs-session=${varde}`,
      `__Host-vs-session=${varde}; __Host-vs-session=planterad`,
      `__Host-vs-session=planterad; __Host-vs-session=${varde}`,
    ]) {
      expect(await u.leverantor.authenticate({ host: VARD_A, headers: { cookie } })).toBeNull();
    }
  });

  it('ignorerar okända kakor', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    const varde = webblasare.burk(VARD_A).get('__Host-vs-session') ?? '';
    const cookie = `annat=1; vs-session=x; __Host-vs-session=${varde}; tema=mork`;
    expect((await u.leverantor.authenticate({ host: VARD_A, headers: { cookie } }))?.email).toBe(ANNA);
  });

  it('nekar skräp, överlånga och saknade kakor', async () => {
    for (const cookie of [undefined, '', '__Host-vs-session=', '__Host-vs-session=abc', `__Host-vs-session=${'A'.repeat(43)}`, `x=${'a'.repeat(10_000)}`]) {
      expect(await u.leverantor.authenticate({ host: VARD_A, headers: { cookie } })).toBeNull();
    }
  });

  it('går ut efter sin livslängd', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    u.klocka.flytta(12 * 60 * 60 * 1000 - 1000);
    expect(await webblasare.vem(VARD_A)).not.toBeNull();
    u.klocka.flytta(2000);
    expect(await webblasare.vem(VARD_A)).toBeNull();
  });

  it('tas bort vid utloggning via POST, och kakan rensas', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    const varde = webblasare.burk(VARD_A).get('__Host-vs-session') ?? '';
    const svar = await webblasare.post(VARD_A, '/_auth/logout', {});
    expect(svar?.status).toBe(303);
    expect(svar?.headers['Location']).toBe('/_auth/login');
    expect(svar?.kakor.some((k) => k.startsWith('__Host-vs-session=;') && k.includes('Max-Age=0'))).toBe(true);
    // Även den som sparat kakans värde är utloggad: sessionen finns inte längre på servern.
    expect(await u.leverantor.authenticate({ host: VARD_A, headers: { cookie: `__Host-vs-session=${varde}` } })).toBeNull();
  });

  it('loggar bara ut på den värd där utloggningen görs', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    await loggaIn(webblasare, u.utkorg, VARD_B, ANNA);
    await webblasare.post(VARD_A, '/_auth/logout', {});
    expect(await webblasare.vem(VARD_A)).toBeNull();
    expect((await webblasare.vem(VARD_B))?.email).toBe(ANNA);
  });

  it('följer användarens aktuella roll', async () => {
    await loggaIn(webblasare, u.utkorg, VARD_A, ANNA);
    await u.leverantor.addUser(ANNA, 'admin');
    expect((await webblasare.vem(VARD_A))?.roles).toEqual(['admin']);
  });
});
