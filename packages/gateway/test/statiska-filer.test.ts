/**
 * Statiska filer: `/` ger index.html, okänd sökväg utan filändelse faller tillbaka till
 * index.html (SPA-routing i webbläsaren), okänd sökväg MED filändelse ger 404. Ingen
 * sökväg med `..`, NUL-byte eller bakåtstreck får någonsin nå `AppFiles.read` — antingen
 * avvisas den (400) eller normaliseras den säkert innan den når fejken. Se
 * docs/konventioner.md ("fientliga indata").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/index.ts';
import { anropa, enHuvud, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaGodkannandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
  STANDARDANVANDARE,
} from './fejkar.ts';
import type { FejkadeFiler } from './fejkar.ts';

const NUL_TECKEN = String.fromCharCode(0);

function forvantaAldrigTraversering(filer: FejkadeFiler) {
  for (const anrop of filer.anrop) {
    expect(anrop.path, `sökvägen "${anrop.path}" nådde AppFiles.read`).not.toMatch(/(^|\/)\.\.(\/|$)/);
    expect(anrop.path).not.toContain(NUL_TECKEN);
    expect(anrop.path).not.toContain('\\');
  }
}

describe('statiska filer', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  it('"/" ger index.html', async () => {
    const appId = skapaAppId('statisk-index');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>startsidan</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    expect(svar.kropp).toContain('startsidan');
  });

  it('okänd sökväg UTAN filändelse faller tillbaka till index.html (SPA)', async () => {
    const appId = skapaAppId('statisk-spa');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>startsidan</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/installningar/konto', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    expect(svar.kropp).toContain('startsidan');
  });

  it('okänd sökväg MED filändelse ⇒ 404 (inget SPA-fallback)', async () => {
    const appId = skapaAppId('statisk-404-andelse');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>startsidan</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/finns-inte.js', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(404);
  });

  it('Content-Type hämtas från AppFile', async () => {
    const appId = skapaAppId('statisk-content-type');
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html></html>'));
    uppsattning.filer.satt(
      appId,
      'published',
      '/style.css',
      textfil('body { color: red; }', 'text/css; charset=utf-8'),
    );
    server = await startaTestserver(createGateway(uppsattning.options));

    const svar = await anropa({ port: server.port, path: '/style.css', host: vardnamnForApp(appId) });

    expect(svar.status).toBe(200);
    expect(enHuvud(svar, 'Content-Type')).toBe('text/css; charset=utf-8');
  });

  describe('sökvägstraversering når aldrig AppFiles.read', () => {
    const traverseringsforsok: ReadonlyArray<[string, string]> = [
      ['okodad ".." i sökvägen', '/../x'],
      ['url-kodad ".."', '/%2e%2e/x'],
      ['url-kodat snedstreck efter ".."', '/..%2fx'],
      ['flera nivåer uppåt', '/a/../../x'],
      ['url-kodad NUL-byte', '/%00'],
      ['bakåtstreck', '/a\\..\\x'],
      ['dubbelt url-kodad ".."', '/%252e%252e/x'],
    ];

    it.each(traverseringsforsok)('%s ⇒ avvisas eller normaliseras säkert', async (_beskrivning, sokvag) => {
      const appId = skapaAppId('statisk-traversering');
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      uppsattning.register.registrera(appId, { published: true });
      uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, 'owner');
      uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>startsidan</html>'));
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({ port: server.port, path: sokvag, host: vardnamnForApp(appId) });

      expect(svar.status).not.toBe(500);
      forvantaAldrigTraversering(uppsattning.filer);
    });
  });
});
