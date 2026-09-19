/**
 * Projektets mål i ett test, genom den RIKTIGA gatewayn: en person bygger en todo-lista med
 * byggverktyget och delar länken med en vän, som öppnar länken, får en kod till mejlen och
 * kommer in. Språkmodellen och byggkedjan är fejkade; allt annat är det riktiga.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuilderAppDetail, BuilderJob } from '@vibesandbox/contracts';
import { todoApp } from './stod/byggkedja.ts';
import { Webblasare } from './stod/webblasare.ts';
import type { Svar } from './stod/webblasare.ts';
import { BYGG, BYGG_ORIGIN, lasUtkorg, loggaInMedKod, startaPlattform } from './stod/plattform.ts';
import type { Testplattform } from './stod/plattform.ts';

function json<T>(svar: Svar): T {
  return JSON.parse(svar.body) as T;
}

async function foljJobbet(webblasare: Webblasare, jobId: string): Promise<BuilderJob> {
  for (let forsok = 0; forsok < 200; forsok += 1) {
    const svar = await webblasare.api(BYGG, 'GET', `/_api/builder/jobs/${jobId}`, { origin: null });
    expect(svar.status).toBe(200);
    const jobb = json<BuilderJob>(svar);
    if (jobb.status === 'done' || jobb.status === 'failed') return jobb;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Jobbet blev aldrig klart.');
}

function vard(url: string): string {
  return new URL(url).host;
}

describe('Målet: bygga en todo-lista och dela den med en vän', () => {
  let plattform: Testplattform;

  beforeEach(async () => {
    plattform = await startaPlattform({ identitet: 'email-otp', modellsvar: [todoApp('Våra att göra')] });
  });

  afterEach(async () => {
    await plattform.stang();
  });

  it('från en mening till en app som vännen kommer in i — och ingen annan', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = new Webblasare(plattform.port);
    expect((await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org')).status).toBe(303);

    // 1. En ny app, och ett önskemål i vanlig svenska.
    const skapad = await anna.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin: BYGG_ORIGIN });
    expect(skapad.status).toBe(201);
    const { appId } = json<{ appId: string }>(skapad);

    const bestallning = await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/messages`, {
      json: { text: 'En todo-lista' },
      origin: BYGG_ORIGIN,
    });
    expect(bestallning.status).toBe(202);
    const { jobId } = json<{ jobId: string }>(bestallning);

    // 2. Jobbet följs tills det är klart; det gröna bygget blir appens utkast.
    const jobb = await foljJobbet(anna, jobId);
    expect(jobb.status).toBe('done');
    expect(jobb.events.at(-1)).toMatchObject({ type: 'done', ok: true });
    expect(plattform.modell.requests).toHaveLength(1);
    expect(plattform.byggkedja.kvar.size).toBe(0);

    // 3. Förhandsvisningen: byggverktyget ger adressen, och på den värden loggar Anna in där.
    const oppna = await anna.api(BYGG, 'GET', `/_api/builder/apps/${appId}/open?target=preview`, { origin: null });
    expect(oppna.status).toBe(200);
    const forhandsvisning = json<{ url: string }>(oppna).url;
    expect(forhandsvisning).toBe(`http://p-${appId}.example.org/`);
    const pHost = vard(forhandsvisning);
    expect((await anna.oppna(pHost, '/')).status).toBe(303);
    expect((await loggaInMedKod(anna, plattform, pHost, 'anna@example.org')).status).toBe(303);
    const utkast = await anna.oppna(pHost, '/');
    expect(utkast.status).toBe(200);
    expect(utkast.body).toContain('Våra att göra');
    // Förhandsvisningen får ramas in av byggverktyget, och bara av det.
    expect(String(utkast.headers['content-security-policy'])).toContain(`frame-ancestors ${BYGG_ORIGIN}`);

    // 4. Publicera.
    const publicerad = await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/publish`, { origin: BYGG_ORIGIN });
    expect(publicerad.status).toBe(200);
    const lank = json<{ publishedUrl: string }>(publicerad).publishedUrl;
    expect(lank).toBe(`http://${appId}.example.org/`);

    // 5. Dela med en vän ⇒ ett inbjudningsmejl med länken.
    const delad = await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/share`, {
      json: { email: 'bertil@example.org' },
      origin: BYGG_ORIGIN,
    });
    expect(delad.status).toBe(200);
    const inbjudan = (await lasUtkorg(plattform.utkorg)).find((m) => m.till === 'bertil@example.org');
    expect(inbjudan).toBeDefined();
    expect(inbjudan?.text).toContain(lank);

    // 6. Vännen öppnar länken i sin egen webbläsare, loggar in med koden och får appen.
    const bertil = new Webblasare(plattform.port);
    const appHost = vard(lank);
    const forsta = await bertil.oppna(appHost, '/');
    expect(forsta.status).toBe(303);
    expect(forsta.headers.location).toBe('/_auth/login?next=%2F');
    const inloggad = await loggaInMedKod(bertil, plattform, appHost, 'bertil@example.org');
    expect(inloggad.status).toBe(303);
    expect(inloggad.headers.location).toBe('/');
    const appen = await bertil.oppna(appHost, '/');
    expect(appen.status).toBe(200);
    expect(appen.body).toContain('Våra att göra');

    // Vännen är tittare: hon kommer inte åt byggverktyget.
    expect((await loggaInMedKod(bertil, plattform, BYGG, 'bertil@example.org')).status).toBe(303);
    expect((await bertil.api(BYGG, 'GET', `/_api/builder/apps/${appId}`, { origin: null })).status).toBe(403);

    // 7. En tredje person som inte är inbjuden kommer inte in.
    const cecilia = new Webblasare(plattform.port);
    const begaran = await cecilia.skickaFormular(appHost, '/_auth/login', { email: 'cecilia@example.org', next: '/' }, `http://${appHost}`);
    expect(begaran.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await lasUtkorg(plattform.utkorg)).some((m) => m.till === 'cecilia@example.org')).toBe(false);
    expect((await cecilia.skickaFormular(appHost, '/_auth/verify', { code: '000000' }, `http://${appHost}`)).status).toBe(401);
    expect((await cecilia.oppna(appHost, '/')).status).toBe(303);
    expect((await cecilia.api(appHost, 'GET', '/', { origin: null })).status).toBe(401);

    // Samtalet finns kvar i byggverktyget, med länken.
    const detalj = json<BuilderAppDetail>(await anna.api(BYGG, 'GET', `/_api/builder/apps/${appId}`, { origin: null }));
    expect(detalj.published).toBe(true);
    expect(detalj.publishedUrl).toBe(lank);
    expect(detalj.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('inget i driftloggen innehåller en e-postadress, en kod eller önskemålets text', async () => {
    await plattform.platform.addUser('anna@example.org', 'builder');
    const anna = new Webblasare(plattform.port);
    await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org');
    const { appId } = json<{ appId: string }>(await anna.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin: BYGG_ORIGIN }));
    const { jobId } = json<{ jobId: string }>(
      await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/messages`, { json: { text: 'En todo-lista' }, origin: BYGG_ORIGIN }),
    );
    await foljJobbet(anna, jobId);

    const logg = JSON.stringify(plattform.logg);
    expect(plattform.logg.some((rad) => rad.source === 'gateway')).toBe(true);
    expect(plattform.logg.some((rad) => rad.source === 'builder')).toBe(true);
    expect(plattform.logg.some((rad) => rad.source === 'identity')).toBe(true);
    expect(logg).not.toContain('anna@example.org');
    expect(logg).not.toContain('todo-lista');
    expect(logg).not.toContain(appId);
  });
});

describe('Byggverktygets skydd genom den riktiga gatewayn', () => {
  let plattform: Testplattform;
  let anna: Webblasare;

  beforeEach(async () => {
    plattform = await startaPlattform({ identitet: 'email-otp', modellsvar: [] });
    await plattform.platform.addUser('anna@example.org', 'builder');
    anna = new Webblasare(plattform.port);
    await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org');
  });

  afterEach(async () => {
    await plattform.stang();
  });

  it.each([
    ['utan Origin', null],
    ['från en annan app', 'http://0123456789abcdefghjkmnpqrs.example.org'],
    ['från en förhandsvisning', 'http://p-0123456789abcdefghjkmnpqrs.example.org'],
    ['över https i stället för http', 'https://bygg.example.org'],
    ['med en annan port', 'http://bygg.example.org:8080'],
  ])('ett skrivande anrop %s nekas med 403 och skapar ingenting', async (_namn, origin) => {
    const svar = await anna.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin });
    expect(svar.status).toBe(403);
    const lista = json<{ apps: unknown[] }>(await anna.api(BYGG, 'GET', '/_api/builder/apps', { origin: null }));
    expect(lista.apps).toEqual([]);
  });

  it('ett skrivande anrop utan skyddshuvudet nekas med 403 även med rätt Origin', async () => {
    const svar = await anna.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin: BYGG_ORIGIN, skyddshuvud: false });
    expect(svar.status).toBe(403);
  });

  it('utan inloggning: API-anrop får 401, sidnavigeringar 303 till inloggningen', async () => {
    const okand = new Webblasare(plattform.port);
    expect((await okand.api(BYGG, 'GET', '/_api/builder/me', { origin: null })).status).toBe(401);
    expect((await okand.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin: BYGG_ORIGIN })).status).toBe(401);
    const navigering = await okand.oppna(BYGG, '/appar');
    expect(navigering.status).toBe(303);
    expect(navigering.headers.location).toBe('/_auth/login?next=%2Fappar');
  });
});
