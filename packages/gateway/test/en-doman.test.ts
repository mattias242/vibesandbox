/**
 * ADR 0002: allt ligger under EN domän. `appDomain` och `previewDomain` är då samma värde, och
 * publicerad app (`<id>.<domän>`) skiljs från förhandsvisning (`p-<id>.<domän>`) enbart på
 * prefixet. Allt annat under domänen — byggverktyget, inloggningen, appens innehållsram
 * (`<id>--c`, nästa skiva), apex och okända namn — hör inte till gatewayn och ska nekas utan
 * att register, lagring eller filer tillfrågas.
 *
 * Första halvan testar den rena funktionen i src/vardnamn.ts, andra halvan hela gatewayn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, DocumentPage } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { createHostParser, parseHost } from '../src/vardnamn.ts';
import { anropa, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import { skapaAppId, skapaGodkannandeIdentityProvider, skapaTestUppsattning } from './fejkar.ts';

const DOMAN = 'plattform.test';
const ENA_DOMANEN = { appDomain: DOMAN, previewDomain: DOMAN };
const NUL_TECKEN = String.fromCharCode(0);

describe('värdnamnstolkning med en enda domän (ren funktion)', () => {
  const id = skapaAppId('en-doman-ren-funktion');

  it('<id>.<domän> är den publicerade appen', () => {
    expect(parseHost(`${id}.${DOMAN}`, ENA_DOMANEN)).toEqual({
      appId: id,
      kind: 'published',
      hostname: `${id}.${DOMAN}`,
    });
  });

  it('p-<id>.<domän> är förhandsvisningen av samma app', () => {
    expect(parseHost(`p-${id}.${DOMAN}`, ENA_DOMANEN)).toEqual({
      appId: id,
      kind: 'draft',
      hostname: `p-${id}.${DOMAN}`,
    });
  });

  it('port strippas och hamnar aldrig i det validerade värdnamnet', () => {
    expect(parseHost(`${id}.${DOMAN}:8443`, ENA_DOMANEN)).toEqual({
      appId: id,
      kind: 'published',
      hostname: `${id}.${DOMAN}`,
    });
  });

  const ogiltiga: ReadonlyArray<[string, string | undefined]> = [
    ['saknat huvud', undefined],
    ['tom sträng', ''],
    ['apex', DOMAN],
    ['byggverktyget', `bygg.${DOMAN}`],
    ['inloggningen', `login.${DOMAN}`],
    ['www', `www.${DOMAN}`],
    ['appens innehållsram (nästa skiva)', `${id}--c.${DOMAN}`],
    ['förhandsvisning av innehållsram', `p-${id}--c.${DOMAN}`],
    ['bara prefixet', `p-.${DOMAN}`],
    ['prefix utan bindestreck', `p${id}.${DOMAN}`],
    ['dubbelt prefix', `p-p-${id}.${DOMAN}`],
    ['prefix i versal', `P-${id}.${DOMAN}`],
    ['annat prefix', `q-${id}.${DOMAN}`],
    ['prefix + för kort id', `p-${id.slice(0, 25)}.${DOMAN}`],
    ['prefix + för långt id', `p-${id}z.${DOMAN}`],
    ['versaler i id', `${id.toUpperCase()}.${DOMAN}`],
    ['versaler i domänen', `${id}.${DOMAN.toUpperCase()}`],
    ['extra subdomännivå', `x.${id}.${DOMAN}`],
    ['id som egen nivå under prefixet', `p-.${id}.${DOMAN}`],
    ['domänsvans', `${id}.${DOMAN}.ond.test`],
    ['avslutande punkt', `${id}.${DOMAN}.`],
    ['inledande blanktecken', ` ${id}.${DOMAN}`],
    ['avslutande blanktecken', `${id}.${DOMAN} `],
    ['avslutande radbrytning', `${id}.${DOMAN}\n`],
    ['NUL före domänen', `${id}${NUL_TECKEN}.${DOMAN}`],
    ['punkten i domänen utbytt (regex-escape)', `${id}.plattformxtest`],
    ['tom port', `${id}.${DOMAN}:`],
    ['port med bokstäver', `${id}.${DOMAN}:80a`],
    ['sexsiffrig port', `${id}.${DOMAN}:123456`],
    ['två portar', `${id}.${DOMAN}:80:80`],
    ['användaruppgifter före värden', `ond@${id}.${DOMAN}`],
    ['sökväg efter värden', `${id}.${DOMAN}/x`],
    ['IPv6-form', '[::1]'],
    ['överlångt värde', `${id}.${DOMAN}${':1'.repeat(200)}`],
  ];

  it.each(ogiltiga)('%s ⇒ ogiltigt', (_beskrivning, varde) => {
    expect(parseHost(varde, ENA_DOMANEN)).toBe('ogiltigt');
  });

  it('felkonfigurerade domäner upptäcks vid start, inte vid första förfrågan', () => {
    for (const trasig of ['', 'Plattform.test', 'plattform.test.', ' plattform.test', 'plattform.test:443', '.*']) {
      expect(() => createHostParser({ appDomain: trasig, previewDomain: DOMAN })).toThrow();
      expect(() => createHostParser({ appDomain: DOMAN, previewDomain: trasig })).toThrow();
    }
  });
});

describe('gatewayn med en enda domän', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  function nyUppsattning() {
    return skapaTestUppsattning({ ...ENA_DOMANEN, identityProvider: skapaGodkannandeIdentityProvider() });
  }

  it('publicerad app och förhandsvisning får olika TenantContext på samma domän', async () => {
    const appId = skapaAppId('en-doman-bada');
    const uppsattning = nyUppsattning();
    uppsattning.register.registrera(appId, { published: true, draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({ port: server.port, path: '/_api/collections/poster/docs', host: `${appId}.${DOMAN}` });
    await anropa({ port: server.port, path: '/_api/collections/poster/docs', host: `p-${appId}.${DOMAN}` });

    expect(uppsattning.store.anrop.map((a) => [a.tenant?.appId, a.tenant?.kind])).toEqual([
      [appId, 'published'],
      [appId, 'draft'],
    ]);
  });

  it('utkast och publicerad version delar aldrig data, fast de delar domän', async () => {
    const appId = skapaAppId('en-doman-isolering');
    const uppsattning = nyUppsattning();
    uppsattning.register.registrera(appId, { published: true, draft: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    await anropa({
      port: server.port,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      host: `p-${appId}.${DOMAN}`,
      headers: { [CSRF_HEADER]: '1' },
      json: { data: { anteckning: 'skrivet av ogranskad utkastkod' } },
    });

    const svar = await anropa({
      port: server.port,
      path: '/_api/collections/poster/docs',
      host: `${appId}.${DOMAN}`,
    });

    expect(svar.status).toBe(200);
    expect(json<DocumentPage>(svar).documents).toHaveLength(0);
  });

  it('en app med bara utkast finns inte på den publicerade adressen, och tvärtom', async () => {
    const baraUtkast = skapaAppId('en-doman-bara-utkast');
    const baraPublicerad = skapaAppId('en-doman-bara-publicerad');
    const uppsattning = nyUppsattning();
    uppsattning.register.registrera(baraUtkast, { draft: true });
    uppsattning.register.registrera(baraPublicerad, { published: true });
    server = await startaTestserver(createGateway(uppsattning.options));

    const publiceradAdress = await anropa({ port: server.port, path: '/_api/whoami', host: `${baraUtkast}.${DOMAN}` });
    const utkastAdress = await anropa({ port: server.port, path: '/_api/whoami', host: `p-${baraPublicerad}.${DOMAN}` });

    expect(publiceradAdress.status).toBe(404);
    expect(utkastAdress.status).toBe(404);
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  describe('plattformens övriga värdnamn under samma domän når aldrig register, lagring eller filer', () => {
    const id = skapaAppId('en-doman-reserverade');
    const reserverade: ReadonlyArray<[string, string]> = [
      ['apex', DOMAN],
      ['byggverktyget', `bygg.${DOMAN}`],
      ['inloggningen', `login.${DOMAN}`],
      ['appens innehållsram', `${id}--c.${DOMAN}`],
      ['okänt namn', `nagot-annat.${DOMAN}`],
      ['dubbelt prefix', `p-p-${id}.${DOMAN}`],
    ];

    it.each(reserverade)('%s ⇒ 400 invalid_request', async (_beskrivning, vardnamn) => {
      const uppsattning = nyUppsattning();
      // Appen FINNS — nekandet ska bero på värdnamnet, inte på att registret är tomt.
      uppsattning.register.registrera(id, { published: true, draft: true });
      server = await startaTestserver(createGateway(uppsattning.options));

      for (const path of ['/_api/whoami', '/']) {
        const svar = await anropa({ port: server.port, path, host: vardnamn });
        expect(svar.status).toBe(400);
        expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
      }

      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    });
  });
});
