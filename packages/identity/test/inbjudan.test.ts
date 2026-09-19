/**
 * Inbjudningar och användare.
 *
 *   Givet en byggare som delar sin app med en vän
 *   När vännens adress bjuds in
 *   Så kan vännen logga in, och får ett mejl med appens namn och länk
 *
 *   Givet en adress som redan är inbjuden med en högre roll
 *   När den bjuds in igen med en lägre
 *   Så behåller den sin högre roll
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataApiError } from '@vibesandbox/contracts';
import type { Identity } from '@vibesandbox/contracts';
import { normalizeEmail } from '../src/index.ts';
import { VARD_A, Webblasare, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';
import type { Uppsattning } from './hjalp.ts';

const BYGGARE: Identity = { userId: 'byggare-1', email: 'byggare@example.org', roles: ['builder'] };
const APP = { name: 'Handlingslistan', url: `https://${VARD_A}/` };

describe('adresser', () => {
  it('normaliseras: trimmas och görs till gemener', () => {
    expect(normalizeEmail('  Anna.Svensson@Example.ORG\t')).toBe('anna.svensson@example.org');
  });

  const ogiltiga = [
    '',
    'anna',
    'anna@',
    '@example.org',
    'anna@example',
    'anna@@example.org',
    'anna @example.org',
    'anna@exa mple.org',
    '.anna@example.org',
    'anna.@example.org',
    'an..na@example.org',
    'anna@-example.org',
    'anna@example-.org',
    'anna@example..org',
    'anna@example.o',
    'anna@example.org.',
    'anna@[127.0.0.1]',
    '"anna"@example.org',
    'anna@exämple.org',
    'änna@example.org',
    'anna@example.org\r\nBcc: evil@example.org',
    'anna@example.org,evil@example.org',
    'anna@example.org\u0000',
    `${'a'.repeat(65)}@example.org`,
    `anna@${'a'.repeat(250)}.org`,
  ];
  for (const adress of ogiltiga) {
    it(`nekar ${JSON.stringify(adress.slice(0, 40))}`, () => {
      expect(normalizeEmail(adress)).toBeNull();
    });
  }

  it('godtar vanliga former', () => {
    for (const adress of ['a@example.org', 'anna.svensson@sub.example.org', 'anna+lista@example.org', "o'hara@example.org", 'a_b-c@ex-ample.org']) {
      expect(normalizeEmail(adress)).toBe(adress);
    }
  });

  it('nekar icke-strängar', () => {
    expect(normalizeEmail(undefined as unknown as string)).toBeNull();
    expect(normalizeEmail(42 as unknown as string)).toBeNull();
  });
});

describe('inbjudningar', () => {
  let u: Uppsattning;

  beforeEach(async () => {
    u = await skapaUppsattning();
  });
  afterEach(stadaAllt);

  it('låter en inbjuden adress logga in med rollen ur inbjudan', async () => {
    await u.leverantor.invite({ email: ' Vannen@Example.org ', role: 'viewer', invitedBy: BYGGARE, app: APP });
    const w = new Webblasare(u.leverantor);
    await loggaIn(w, u.utkorg, VARD_A, 'vannen@example.org');
    const vem = await w.vem(VARD_A);
    expect(vem?.email).toBe('vannen@example.org');
    expect(vem?.roles).toEqual(['viewer']);
  });

  it('svarar med den inbjudna användarens id och normaliserade adress — samma id som vid inloggning', async () => {
    const inbjuden = await u.leverantor.invite({ email: ' Vannen@Example.org ', role: 'viewer', invitedBy: BYGGARE, app: APP });
    expect(inbjuden).toEqual({ userId: expect.any(String), email: 'vannen@example.org' });
    const w = new Webblasare(u.leverantor);
    await loggaIn(w, u.utkorg, VARD_A, 'vannen@example.org');
    expect((await w.vem(VARD_A))?.userId).toBe(inbjuden.userId);
  });

  it('svarar likadant för en befintlig adress: samma userId, oavsett skiftläge', async () => {
    const befintlig = await u.leverantor.addUser('anna@example.org', 'builder');
    const inbjuden = await u.leverantor.invite({ email: 'ANNA@example.org', role: 'viewer', invitedBy: BYGGARE, app: APP });
    expect(inbjuden).toEqual({ userId: befintlig.userId, email: 'anna@example.org' });
    const igen = await u.leverantor.invite({ email: 'anna@example.org', role: 'viewer', invitedBy: BYGGARE });
    expect(igen).toEqual(inbjuden);
  });

  it('svarar bara med id och adress — rollen och om adressen var ny röjs inte', async () => {
    const inbjuden = await u.leverantor.invite({ email: 'vannen@example.org', role: 'viewer', invitedBy: BYGGARE });
    expect(Object.keys(inbjuden).sort()).toEqual(['email', 'userId']);
  });

  it('mejlar appens namn, länk och hur man loggar in', async () => {
    await u.leverantor.invite({ email: 'vannen@example.org', role: 'viewer', invitedBy: BYGGARE, app: APP });
    expect(u.utkorg.messages).toHaveLength(1);
    const mejl = u.utkorg.messages[0];
    expect(mejl?.to).toBe('vannen@example.org');
    expect(mejl?.subject).toContain('Handlingslistan');
    expect(mejl?.text).toContain('Handlingslistan');
    expect(mejl?.text).toContain(APP.url);
    expect(mejl?.text).toMatch(/kod/i);
    // Inbjudarens adress röjs inte i mejlet — vännen vet vem som delade.
    expect(mejl?.text).not.toContain(BYGGARE.email);
  });

  it('skickar en allmän inbjudan utan app', async () => {
    await u.leverantor.invite({ email: 'vannen@example.org', role: 'viewer', invitedBy: BYGGARE });
    expect(u.utkorg.messages[0]?.text).toMatch(/kod/i);
  });

  it('behåller den högsta rollen vid återinbjudan', async () => {
    await u.leverantor.addUser('anna@example.org', 'builder');
    await u.leverantor.invite({ email: 'anna@example.org', role: 'viewer', invitedBy: BYGGARE, app: APP });
    const w = new Webblasare(u.leverantor);
    await loggaIn(w, u.utkorg, VARD_A, 'anna@example.org');
    expect((await w.vem(VARD_A))?.roles).toEqual(['builder']);
  });

  it('höjer rollen när den nya är högre, och behåller userId', async () => {
    const forst = await u.leverantor.addUser('anna@example.org', 'viewer');
    const sedan = await u.leverantor.addUser('ANNA@example.org', 'builder');
    expect(sedan.userId).toBe(forst.userId);
    expect(sedan.role).toBe('builder');
    const igen = await u.leverantor.addUser('anna@example.org', 'viewer');
    expect(igen.role).toBe('builder');
  });

  it('ger olika användare olika id', async () => {
    const a = await u.leverantor.addUser('a@example.org', 'viewer');
    const b = await u.leverantor.addUser('b@example.org', 'viewer');
    expect(a.userId).not.toBe(b.userId);
  });

  it('nekar ogiltiga adresser med invalid_request', async () => {
    for (const email of ['inte en adress', 'a@example.org\r\nBcc: x@example.org', '']) {
      await expect(u.leverantor.invite({ email, role: 'viewer', invitedBy: BYGGARE, app: APP })).rejects.toMatchObject({
        name: 'DataApiError',
        code: 'invalid_request',
      });
      await expect(u.leverantor.addUser(email, 'viewer')).rejects.toBeInstanceOf(DataApiError);
    }
    expect(u.utkorg.messages).toHaveLength(0);
  });

  it('nekar okända roller', async () => {
    await expect(u.leverantor.addUser('a@example.org', 'owner' as 'viewer')).rejects.toBeInstanceOf(DataApiError);
    await expect(
      u.leverantor.invite({ email: 'a@example.org', role: 'superuser' as 'viewer', invitedBy: BYGGARE }),
    ).rejects.toBeInstanceOf(DataApiError);
  });

  it('låter bara byggare och administratörer bjuda in, och aldrig till en högre roll än den egna', async () => {
    const tittare: Identity = { userId: 'v', email: 'v@example.org', roles: ['viewer'] };
    await expect(u.leverantor.invite({ email: 'a@example.org', role: 'viewer', invitedBy: tittare })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(u.leverantor.invite({ email: 'a@example.org', role: 'admin', invitedBy: BYGGARE })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(u.utkorg.messages).toHaveLength(0);
  });

  it('nekar en applänk som inte är http(s), och rensar radbrytningar ur appens namn', async () => {
    await expect(
      u.leverantor.invite({
        email: 'a@example.org',
        role: 'viewer',
        invitedBy: BYGGARE,
        app: { name: 'x', url: 'javascript:alert(1)' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await u.leverantor.invite({
      email: 'a@example.org',
      role: 'viewer',
      invitedBy: BYGGARE,
      app: { name: 'Lista\r\nBcc: evil@example.org', url: APP.url },
    });
    expect(u.utkorg.messages[0]?.subject).not.toMatch(/[\r\n]/);
  });

  it('meddelar när mejlet inte kunde skickas, men inbjudan står kvar', async () => {
    const trasig = await skapaUppsattning({
      mailSender: {
        async send() {
          throw new Error('nätet är nere');
        },
      },
    });
    await expect(
      trasig.leverantor.invite({ email: 'a@example.org', role: 'viewer', invitedBy: BYGGARE, app: APP }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(trasig.logg.some((p) => p.event === 'mail_failed')).toBe(true);
    const lista = await trasig.leverantor.addUser('a@example.org', 'viewer');
    expect(lista.role).toBe('viewer');
  });
});
