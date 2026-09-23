/**
 * Nekandets två former (felsida.ts, navigering.ts): en sida för människan, ett API-svar för koden.
 *
 * Det som prövas hårdast är att formbytet INTE öppnade en väg att kartlägga appar. `hyresgast.ts`
 * kräver att "appen finns inte", "appen saknar den här versionen" och "du har ingen åtkomst" ger
 * exakt samma svar; här prövas att kravet gäller också i sidform, byte för byte, och att sidan
 * aldrig bär något ur förfrågan — inget app-id, ingen adress, ingen sökväg.
 *
 * Gränsen mot `/_api/` prövas åt båda håll: ett API-anrop som BÄR navigeringshuvuden ska ändå få
 * JSON (appens kod har ett kontrakt att hålla), och en vanlig sidhämtning ska få sidan.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { renderFailurePage } from '../src/felsida.ts';
import type { Failure } from '../src/fel.ts';
import { anropa, enHuvud, startaTestserver } from './hjalp.ts';
import type { AnropOptions, AnropSvar, Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaFejkadIdentityProvider,
  skapaIdentitet,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';

const anna = skapaIdentitet({ userId: 'anv-anna', email: 'anna@exempel.se', roles: ['builder'] });
const cecilia = skapaIdentitet({ userId: 'anv-cecilia', email: 'cecilia@exempel.se', roles: ['builder'] });
const ANVANDARE: readonly Identity[] = [anna, cecilia];

/** Som webbläsaren gör när någon klickar på en länk. */
const NAVIGERING: Readonly<Record<string, string>> = { 'Sec-Fetch-Mode': 'navigate' };
/** Som appens egen kod gör med `fetch`. */
const APPKOD: Readonly<Record<string, string>> = { 'Sec-Fetch-Mode': 'cors' };

function auth(vem: Identity): Record<string, string> {
  return { Authorization: `token-${vem.userId}` };
}

interface Startad {
  readonly port: number;
  /** Annas app: publicerad OCH med ett utkast. */
  readonly appId: string;
  /** Annas andra app: publicerad men UTAN utkast — förhandsvisningen saknar alltså sin version. */
  readonly utanUtkast: string;
  /** Ett app-id registret aldrig hört talas om. */
  readonly okandAppId: string;
}

describe('nekandet som sida', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function starta(): Promise<Startad> {
    const leverantor = skapaFejkadIdentityProvider(
      (request) => ANVANDARE.find((vem) => request.headers.authorization === `token-${vem.userId}`) ?? null,
    );
    const uppsattning = skapaTestUppsattning({ identityProvider: leverantor });

    const appId = skapaAppId('annas-app-felsida');
    uppsattning.register.registrera(appId, { published: true, draft: true });
    uppsattning.register.bevilja(appId, anna.userId, 'owner');
    for (const kind of ['published', 'draft'] as const) {
      uppsattning.filer.satt(appId, kind, '/index.html', textfil('<h1>Annas app</h1>'));
    }

    const utanUtkast = skapaAppId('annas-app-utan-utkast');
    uppsattning.register.registrera(utanUtkast, { published: true, draft: false });
    uppsattning.register.bevilja(utanUtkast, anna.userId, 'owner');
    uppsattning.filer.satt(utanUtkast, 'published', '/index.html', textfil('<h1>Utan utkast</h1>'));

    server = await startaTestserver(createGateway(uppsattning.options));
    return { port: server.port, appId, utanUtkast, okandAppId: skapaAppId('ingen-sadan-app') };
  }

  function hamta(port: number, host: string, vem: Identity, anrop: Partial<AnropOptions> = {}): Promise<AnropSvar> {
    return anropa({ port, host, path: '/', ...anrop, headers: { ...auth(vem), ...anrop.headers } });
  }

  /** Hela svaret som text — ett id som läcker i ett huvud är lika röjande som i kroppen. */
  function allt(svar: AnropSvar): string {
    return Object.entries(svar.huvuden).map(([namn, varden]) => `${namn}: ${varden.join(', ')}`).join('\n') + '\n' + svar.kropp;
  }

  /** Allt utom `Date`, som bara säger när svaret skickades. */
  function jamforbart(svar: AnropSvar): unknown {
    const { date: _date, ...huvuden } = svar.huvuden;
    return { status: svar.status, huvuden, kropp: svar.kropp };
  }

  describe('formen väljs efter vem som frågar', () => {
    it('en människa som klickar på länken får en läsbar sida', async () => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: NAVIGERING });

      expect(svar.status).toBe(404);
      expect(enHuvud(svar, 'content-type')).toBe('text/html; charset=utf-8');
      expect(svar.kropp.startsWith('<!doctype html>')).toBe(true);
      expect(svar.kropp).toContain('Appen finns inte.');
      expect(svar.kropp).toContain('<html lang="sv">');
    });

    it('appens egen kod får samma besked som JSON', async () => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: APPKOD });

      expect(svar.status).toBe(404);
      expect(enHuvud(svar, 'content-type')).toBe('application/json; charset=utf-8');
      expect(JSON.parse(svar.kropp)).toEqual({ error: { code: 'not_found', message: 'Appen finns inte.' } });
    });

    it('utan Sec-Fetch avgör Accept — en gammal webbläsare får också sidan', async () => {
      const s = await starta();

      const sida = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const kod = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: { Accept: '*/*' } });

      expect(enHuvud(sida, 'content-type')).toBe('text/html; charset=utf-8');
      expect(enHuvud(kod, 'content-type')).toBe('application/json; charset=utf-8');
    });

    it('Content-Length stämmer, och HEAD ger huvudena utan kroppen', async () => {
      const s = await starta();

      const get = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: NAVIGERING });
      const head = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { method: 'HEAD', headers: NAVIGERING });

      expect(enHuvud(get, 'content-length')).toBe(String(Buffer.byteLength(get.kropp, 'utf8')));
      expect(head.kropp).toBe('');
      // `Content-Length` beskriver vad GET hade gett — samma regel som för alla andra svar.
      expect(enHuvud(head, 'content-length')).toBe(enHuvud(get, 'content-length'));
      expect(enHuvud(head, 'content-type')).toBe('text/html; charset=utf-8');
    });
  });

  describe('sidan röjer inte mer än JSON-svaret gjorde', () => {
    /**
     * De tre orsakerna, alla på FÖRHANDSVISNINGENS värd så att värdsorten — och därmed CSP:n —
     * är densamma. Skillnaden i CSP mellan `p-`-värd och appvärd följer av adressen besökaren
     * själv skrev och säger ingenting om vilka appar som finns.
     */
    it('appen saknas, appen saknar utkast och appen är någon annans ger byte-lika sidor', async () => {
      const s = await starta();

      const finnsInte = await hamta(s.port, vardnamnForForhandsvisning(s.okandAppId), anna, { headers: NAVIGERING });
      const saknarUtkast = await hamta(s.port, vardnamnForForhandsvisning(s.utanUtkast), anna, { headers: NAVIGERING });
      const nagonAnnans = await hamta(s.port, vardnamnForForhandsvisning(s.appId), cecilia, { headers: NAVIGERING });

      expect(finnsInte.status).toBe(404);
      expect(jamforbart(saknarUtkast)).toEqual(jamforbart(finnsInte));
      expect(jamforbart(nagonAnnans)).toEqual(jamforbart(finnsInte));
    });

    it('sidan bär inget app-id, ingen adress och ingen sökväg ur förfrågan', async () => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.appId), cecilia, {
        path: '/kvitton/2026/ett-hemligt-arendenummer',
        headers: NAVIGERING,
      });

      expect(allt(svar)).not.toContain(s.appId);
      expect(allt(svar)).not.toContain(anna.email);
      expect(allt(svar)).not.toContain(cecilia.email);
      expect(svar.kropp).not.toContain('ett-hemligt-arendenummer');
      expect(svar.kropp).not.toContain('kvitton');
    });

    it('sidan säger inte VARFÖR det nekades', async () => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.appId), cecilia, { headers: NAVIGERING });

      // Varje ord här vore en upplysning om att appen finns och att det var behörigheten som fällde.
      for (const ord of ['behörighet', 'åtkomst', 'delad', 'ägare', 'utkast', 'inloggad']) {
        expect(svar.kropp.toLowerCase()).not.toContain(ord);
      }
    });

    it('skyddshuvudena är desamma i båda formerna', async () => {
      const s = await starta();

      const sida = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: NAVIGERING });
      const json = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { headers: APPKOD });

      for (const namn of ['content-security-policy', 'x-content-type-options', 'referrer-policy']) {
        expect(enHuvud(sida, namn)).toBe(enHuvud(json, namn));
      }
    });
  });

  describe('gränsen mot API:t hålls åt båda håll', () => {
    const API_VAGAR = ['/_api/whoami', '/_api/collections/poster/docs', '/_api/finns-inte', '/%5Fapi/whoami'];

    it.each(API_VAGAR)('%s svarar i JSON även med navigeringshuvuden', async (path) => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { path, headers: NAVIGERING });

      expect(enHuvud(svar, 'content-type')).toBe('application/json; charset=utf-8');
      expect(() => JSON.parse(svar.kropp)).not.toThrow();
    });

    it('en vanlig sidhämtning under appen får sidan', async () => {
      const s = await starta();

      for (const path of ['/', '/index.html', '/arenden/42']) {
        const svar = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { path, headers: NAVIGERING });
        expect(enHuvud(svar, 'content-type'), `${path} gav inte en sida`).toBe('text/html; charset=utf-8');
      }
    });

    it('en ogiltig sökväg svarar som förut, i JSON', async () => {
      const s = await starta();

      const svar = await hamta(s.port, vardnamnForApp(s.okandAppId), cecilia, { path: '/%00', headers: NAVIGERING });

      expect(enHuvud(svar, 'content-type')).toBe('application/json; charset=utf-8');
    });
  });
});

describe('renderFailurePage', () => {
  const failure = (message: string): Failure => ({
    status: 404,
    body: { error: { code: 'not_found', message } },
    headers: {},
    closeConnection: false,
    unexpected: false,
  });

  it('samma fel ger samma sida, tecken för tecken', () => {
    const a = renderFailurePage(failure('Appen finns inte.'), 'https://bygg.exempel.se');
    const b = renderFailurePage(failure('Appen finns inte.'), 'https://bygg.exempel.se');

    expect(a).toBe(b);
  });

  it('utan byggverktyg utelämnas länken, och sidan är fortfarande densamma för alla', () => {
    const utan = renderFailurePage(failure('Appen finns inte.'), undefined);

    expect(utan).not.toContain('<a href');
    expect(utan).toBe(renderFailurePage(failure('Appen finns inte.'), undefined));
  });

  it('meddelandet kodas in i HTML, aldrig rakt ut', () => {
    const sida = renderFailurePage(failure('<script>stör()</script> & "citat"'), undefined);

    expect(sida).not.toContain('<script>stör()');
    expect(sida).toContain('&lt;script&gt;');
    expect(sida).toContain('&amp;');
    expect(sida).toContain('&quot;');
  });

  it('byggverktygets adress kodas den också', () => {
    const sida = renderFailurePage(failure('Appen finns inte.'), 'https://bygg.exempel.se/"><b>');

    expect(sida).not.toContain('"><b>');
    expect(sida).toContain('&quot;&gt;&lt;b&gt;');
  });
});
