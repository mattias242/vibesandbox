/**
 * `createTestIdentityProvider` + `signTestIdentity`: inloggningen för tester och lokal
 * utveckling. Testas fristående från HTTP-servern, direkt mot `IdentityProvider`-
 * gränssnittet. Se docs/konventioner.md ("Testinloggningen vägrar starta när
 * NODE_ENV=production") och jsdoc i src/index.ts.
 *
 * ANTAGANDE (kontraktet är tyst om detta): `signTestIdentity` returnerar HELA värdet till
 * Authorization-huvudet (dvs. "Test <payload>.<signatur>"), och `AuthRequest.headers`
 * har samma nycklar som Node ger `IncomingMessage.headers` — gemener, t.ex. "authorization".
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthRequest, Identity } from '@vibesandbox/contracts';
import { createTestIdentityProvider, signTestIdentity } from '../src/index.ts';
import { skapaIdentitet } from './fejkar.ts';

function fragan(varde: string | undefined): AuthRequest {
  return { host: 'exempel.appar.test', headers: { authorization: varde } };
}

describe('testidentitetsleverantören', () => {
  const ursprungligNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ursprungligNodeEnv;
  });

  it('vägrar skapas när NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createTestIdentityProvider({ secret: 'vilken-hemlighet-som-helst-minst-32-tecken' })).toThrow();
  });

  it('går att skapa och används utanför produktion', () => {
    process.env.NODE_ENV = 'test';
    expect(() => createTestIdentityProvider({ secret: 'en-testhemlighet-som-ar-minst-32-tecken-lang' })).not.toThrow();
  });

  it('en hemlighet på 31 byte är för kort ⇒ kastar', () => {
    process.env.NODE_ENV = 'test';
    const forKort = 'a'.repeat(31);
    expect(Buffer.byteLength(forKort, 'utf8')).toBe(31);
    expect(() => createTestIdentityProvider({ secret: forKort })).toThrow();
  });

  it('en hemlighet på exakt 32 byte godtas', () => {
    process.env.NODE_ENV = 'test';
    const precisLagom = 'a'.repeat(32);
    expect(Buffer.byteLength(precisLagom, 'utf8')).toBe(32);
    expect(() => createTestIdentityProvider({ secret: precisLagom })).not.toThrow();
  });

  it('roundtrip: signTestIdentity + authenticate ger tillbaka samma identitet', async () => {
    process.env.NODE_ENV = 'test';
    const hemlighet = 'delad-hemlighet-for-roundtrip-minst-32-tecken';
    const identitet: Identity = skapaIdentitet({ userId: 'roundtrip-user', email: 'roundtrip@exempel.se' });
    const leverantor = createTestIdentityProvider({ secret: hemlighet });

    const huvudvarde = signTestIdentity(identitet, hemlighet);
    const resultat = await leverantor.authenticate(fragan(huvudvarde));

    expect(resultat).toEqual(identitet);
  });

  it('avvisar (null) när Authorization-huvudet saknas helt', async () => {
    process.env.NODE_ENV = 'test';
    const leverantor = createTestIdentityProvider({ secret: 'en-hemlighet-som-ar-minst-32-tecken-lang' });

    const resultat = await leverantor.authenticate(fragan(undefined));

    expect(resultat).toBeNull();
  });

  it('avvisar (null) för fel hemlighet', async () => {
    process.env.NODE_ENV = 'test';
    const identitet = skapaIdentitet();
    const leverantor = createTestIdentityProvider({ secret: 'ratt-hemlighet-som-ar-minst-32-tecken-lang' });
    const huvudvarde = signTestIdentity(identitet, 'fel-hemlighet-som-ar-minst-32-tecken-lang');

    const resultat = await leverantor.authenticate(fragan(huvudvarde));

    expect(resultat).toBeNull();
  });

  it('signaturjämförelsen kastar aldrig, även när längden skiljer sig från en riktig signatur', async () => {
    process.env.NODE_ENV = 'test';
    const leverantor = createTestIdentityProvider({ secret: 'en-hemlighet-som-ar-minst-32-tecken-lang' });

    // Kortare, längre och helt tomma värden — en naiv `Buffer.equals`/`===`-jämförelse är
    // ofarlig, men en naiv `crypto.timingSafeEqual` KASTAR om buffrarna har olika längd.
    const skräpvarden = ['Test a', 'Test a.b', 'Test ' + 'x'.repeat(500), 'Test ', 'helt utan Test-prefix'];

    for (const skräp of skräpvarden) {
      await expect(leverantor.authenticate(fragan(skräp))).resolves.toBeNull();
    }
  });
});
