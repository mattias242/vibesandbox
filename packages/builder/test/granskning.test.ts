/**
 * Granskningen: en människa läser koden innan appen går ut.
 *
 * Den som bygger publicerar inte längre själv — hon BEGÄR publicering, och en granskare
 * (plattformsrollen `admin`) avgör. Det som prövas här är de tre sidorna av den spärren:
 * ägarens begäran, granskarens kö, och själva beslutet.
 *
 * Tre egenskaper är hela poängen och står därför i egna tester: godkännandet publicerar den
 * version som LÄSTES, ett nej bär ett skäl som når ägaren ORDAGRANT, och en granskare avgör inte
 * sin egen app så länge det finns någon annan att be. Den sista har tre sidor — med en annan
 * administratör, ensam, och utan användarregister — och de står i var sitt test. Utöver det gäller
 * kontrollrummets vanliga tystnad: kön röjer varken källkod eller hela app-id:n, och driftloggen
 * varken adresser eller granskarens skäl.
 */
import { ADMIN_APP_ID_PREFIX_LENGTH, REVIEW_LIMITS, STRICTEST_CLASSIFICATION } from '@vibesandbox/contracts';
import type { Identity } from '@vibesandbox/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADAM,
  ANNA,
  BERTIL,
  EVA,
  VERA,
  anropa,
  api,
  fejkAnvandare,
  lyckadTur,
  nyApp,
  skapaMiljo,
  skicka,
  slumpatAppId,
  vantaPaJobb,
} from './hjalp.ts';
import type { Miljo, Svar } from './hjalp.ts';

const KON = api('/admin/granskning');

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

/**
 * Ett ord som bara finns i appens KOD — aldrig i önskemålet och aldrig i namnet. Dyker det upp i
 * kön har källkoden läckt dit den inte hör hemma, och då spelar resten av svaret ingen roll.
 */
const HEMLIG_KOD = 'vattenmelon';

/** En app med ett grönt bygge bakom sig: den har ett utkast och därmed något att begära för. */
async function byggdApp(agare: Identity = ANNA, onskemal = 'En todo-lista', kod = HEMLIG_KOD): Promise<string> {
  const appId = await nyApp(m.builder, agare);
  m.agent.turer.push(lyckadTur({ 'src/App.tsx': `export function App() { return <h1>${kod}</h1>; }` }));
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, onskemal, agare), agare);
  return appId;
}

async function begar(appId: string, agare: Identity = ANNA): Promise<Svar> {
  return anropa(m.builder, agare, 'POST', api(`/apps/${appId}/publish`));
}

async function kon(): Promise<Svar> {
  return anropa(m.builder, ADAM, 'GET', KON);
}

/** Ärendets id ur kön. Kön bär bara det förkortade app-id:t, så uppslagningen går den vägen. */
async function arendeFor(appId: string): Promise<string> {
  const svar = await kon();
  const rad = svar.json.reviews.find((review: { appIdPrefix: string }) => appId.startsWith(review.appIdPrefix));
  if (rad === undefined) throw new Error('appen syns inte i granskningskön.');
  return rad.reviewId as string;
}

async function avgor(reviewId: string, body: unknown, granskare: Identity = ADAM): Promise<Svar> {
  return anropa(m.builder, granskare, 'POST', api(`/admin/granskning/${reviewId}`), { body });
}

async function detalj(appId: string, agare: Identity = ANNA): Promise<Svar> {
  return anropa(m.builder, agare, 'GET', api(`/apps/${appId}`));
}

describe('ägaren begär, hon publicerar inte', () => {
  it('begäran ger 202 och ärendet syns som väntande i hennes egen app', async () => {
    const appId = await byggdApp();
    const svar = await begar(appId);

    expect(svar.status).toBe(202);
    expect(svar.json).toEqual({ review: { state: 'vantar', requestedAt: '2026-09-19T08:00:00.000Z' } });

    const app = await detalj(appId);
    expect(app.json.review).toEqual({
      state: 'vantar',
      requestedAt: '2026-09-19T08:00:00.000Z',
      decidedAt: null,
      reason: null,
    });
    // Ingenting har gått ut: begäran är en begäran, inte en publicering.
    expect(app.json.published).toBe(false);
    expect(m.control.anrop).not.toContain('publish');
  });

  it('utan ett grönt utkast finns det inget att granska ⇒ 409', async () => {
    const appId = await nyApp(m.builder);
    const svar = await begar(appId);
    expect(svar.status).toBe(409);
    expect(svar.json.error.code).toBe('conflict');
    expect((await kon()).json.reviews).toEqual([]);
  });

  it('två begäranden i rad ⇒ den andra får veta att det redan är igång', async () => {
    const appId = await byggdApp();
    expect((await begar(appId)).status).toBe(202);

    const andra = await begar(appId);
    expect(andra.status).toBe(409);
    expect(andra.json.error.code).toBe('conflict');
    expect(andra.json.error.message).toContain('väntar redan på granskning');

    // Högst ett väntande ärende per app — kön ska inte fyllas av samma app två gånger.
    expect((await kon()).json.reviews).toHaveLength(1);
  });

  it('ett nytt bygge drar tillbaka det väntande ärendet, och ägaren kan begära på nytt', async () => {
    const appId = await byggdApp();
    expect((await begar(appId)).status).toBe(202);

    m.tid.ms += 60_000;
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Byt rubrik'));

    const app = await detalj(appId);
    expect(app.json.review).toEqual({
      state: 'tillbakadragen',
      requestedAt: '2026-09-19T08:00:00.000Z',
      decidedAt: '2026-09-19T08:01:00.000Z',
      reason: null,
    });
    // Ingen läste den, och ingen ska tro att någon gjorde det.
    expect((await kon()).json.reviews).toEqual([]);

    const igen = await begar(appId);
    expect(igen.status).toBe(202);
    expect((await kon()).json.reviews).toHaveLength(1);
  });

  it('den som inte äger appen kan inte begära — och får samma svar som för en app som inte finns', async () => {
    const appId = await byggdApp(ANNA);
    const annansApp = await begar(appId, BERTIL);
    const ingenApp = await anropa(m.builder, BERTIL, 'POST', api(`/apps/${slumpatAppId()}/publish`));

    expect(annansApp.status).toBe(404);
    expect(annansApp.text).toBe(ingenApp.text);
    expect(annansApp.headers).toEqual(ingenApp.headers);
    expect((await kon()).json.reviews).toEqual([]);
  });
});

describe('kön och koden: granskarens sida', () => {
  it('kön visar väntande ärenden, äldst först', async () => {
    const annas = await byggdApp(ANNA, 'En todo-lista');
    const bertils = await byggdApp(BERTIL, 'En anmälningslista');

    await begar(annas, ANNA);
    m.tid.ms += 60_000;
    await begar(bertils, BERTIL);

    const svar = await kon();
    expect(svar.status).toBe(200);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(svar.json.reviews.map((review: { appIdPrefix: string }) => review.appIdPrefix)).toEqual([
      annas.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      bertils.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    ]);
    expect(svar.json.reviews[0]).toMatchObject({
      ownerEmail: ANNA.email,
      state: 'vantar',
      requestedAt: '2026-09-19T08:00:00.000Z',
      decidedAt: null,
      reason: null,
    });
    expect(svar.json.reviews[1].ownerEmail).toBe(BERTIL.email);
  });

  it('kön bär ingen källkod — den hämtas för ett ärende i taget', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const svar = await kon();
    expect(svar.text).not.toContain(HEMLIG_KOD);
    expect(svar.json.reviews[0].files).toBeUndefined();
  });

  it('kön visar nivån och hur den sattes, så granskaren ser ett omdöme från ett misslyckande', async () => {
    // Först en app i en plattform utan klassning alls: nivån är okänd och faller åt det stränga
    // hållet. Sedan en app som en modell faktiskt har klassat.
    const oklassad = await byggdApp(ANNA, 'En todo-lista');
    await begar(oklassad, ANNA);

    await m.builder.close();
    m.builder = m.starta({ classifyRequest: async () => ({ classification: 'intern', source: 'modell' }) });
    const klassad = await byggdApp(BERTIL, 'En anmälningslista');
    m.tid.ms += 60_000;
    await begar(klassad, BERTIL);

    const svar = await kon();
    expect(svar.json.reviews[0]).toMatchObject({
      classification: STRICTEST_CLASSIFICATION,
      classificationSource: 'fail-closed',
    });
    expect(svar.json.reviews[1]).toMatchObject({ classification: 'intern', classificationSource: 'modell' });
  });

  it('app-id:t är förkortat, och hela id:t finns ingenstans i svaret', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const svar = await kon();
    expect(svar.json.reviews[0].appIdPrefix).toBe(appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
    expect(svar.text).not.toContain(appId);
    // Ingen länk: kön ger insyn i att appen finns, aldrig en väg in i den.
    expect(svar.text).not.toContain('https://');
  });

  it('ETT ärende ger koden — granskningen ÄR att någon läser den', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    const svar = await anropa(m.builder, ADAM, 'GET', api(`/admin/granskning/${reviewId}`));
    expect(svar.status).toBe(200);
    expect(svar.json.review.reviewId).toBe(reviewId);
    expect(svar.json.files).toEqual({ 'src/App.tsx': `export function App() { return <h1>${HEMLIG_KOD}</h1>; }` });
  });

  it('en byggare nekas alla tre rutterna — samma grind som resten av kontrollrummet', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    const svar = [
      await anropa(m.builder, ANNA, 'GET', KON),
      await anropa(m.builder, ANNA, 'GET', api(`/admin/granskning/${reviewId}`)),
      await avgor(reviewId, { decision: 'godkand' }, ANNA),
    ];
    for (const ett of svar) {
      expect(ett.status).toBe(403);
      expect(ett.json.error.code).toBe('forbidden');
      expect(ett.json.reviews).toBeUndefined();
      expect(ett.json.files).toBeUndefined();
      expect(ett.text).not.toContain(HEMLIG_KOD);
    }
    // Och ingen byggare har kunnat publicera något den vägen.
    expect(m.control.anrop).not.toContain('publish');
  });

  it('ett okänt och ett felformat ärende-id ger exakt samma svar', async () => {
    const appId = await byggdApp();
    await begar(appId);

    const okant = await anropa(m.builder, ADAM, 'GET', api(`/admin/granskning/${'0'.repeat(32)}`));
    expect(okant.status).toBe(404);

    // Inget av de här värdena får nå en SQL-parameter, och inget av dem får svara annorlunda än
    // ett välformat id som råkar sakna ärende: skillnaden vore ett svar på frågan "finns det?".
    for (const id of ['abc', 'z'.repeat(32), '0'.repeat(33), '0'.repeat(31), 'A'.repeat(32), '..', '0'.repeat(32) + '/x']) {
      const svar = await anropa(m.builder, ADAM, 'GET', api(`/admin/granskning/${id}`));
      expect(svar.status, id).toBe(okant.status);
      expect(svar.text, id).toBe(okant.text);
      const beslut = await avgor(id, { decision: 'godkand' });
      expect(beslut.status, id).toBe(404);
      expect(beslut.text, id).toBe(okant.text);
    }
    expect(m.control.anrop).not.toContain('publish');
  });
});

describe('beslutet', () => {
  it('godkänt publicerar appen, och ägaren får besked i sitt eget samtal', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    m.tid.ms += 60_000;
    const svar = await avgor(reviewId, { decision: 'godkand' });
    expect(svar.status).toBe(200);
    expect(svar.json.review).toMatchObject({
      reviewId,
      state: 'godkand',
      decidedAt: '2026-09-19T08:01:00.000Z',
      reason: null,
    });

    const app = await detalj(appId);
    expect(app.json.published).toBe(true);
    expect(app.json.publishedUrl).toBe(`https://${appId}.example.org/`);
    expect(app.json.review.state).toBe('godkand');

    const sista = app.json.messages.at(-1);
    expect(sista.role).toBe('assistant');
    expect(sista.text).toBe('Granskad och godkänd — appen är publicerad och går att dela.');

    // Avbetad: ett avgjort ärende ligger inte kvar i kön.
    expect((await kon()).json.reviews).toEqual([]);
  });

  /**
   * Godkännandet publicerar den version som LÄSTES, inte det som råkar vara senast byggt.
   *
   * Regeln går inte att pröva med ett nyare bygge, och det är med flit: ett nytt bygge drar
   * tillbaka det väntande ärendet i samma transaktion som revisionen sparas (`completeGreenJob`),
   * så ett ärende som fortfarande väntar kan aldrig ha hunnit bli omsprunget. Det som testas här
   * är därför spärren som gör regeln onåbar — och att en app som byggts om inte går att godkänna
   * på den gamla koden. Att versionen faktiskt låses vid begäran prövas i publicera-dela.test.ts
   * ("granskningen publicerar senaste gröna revisionen, inte det misslyckade försöket").
   */
  it('har ägaren byggt om går den gamla koden inte att godkänna — ärendet är redan tillbakadraget', async () => {
    const appId = await byggdApp(ANNA, 'En todo-lista', 'forsta');
    await begar(appId);
    const reviewId = await arendeFor(appId);

    m.tid.ms += 60_000;
    m.agent.turer.push(lyckadTur({ 'src/App.tsx': 'export function App() { return <h1>andra</h1>; }' }));
    await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'Byt rubrik'));

    const svar = await avgor(reviewId, { decision: 'godkand' });
    expect(svar.status).toBe(409);
    expect(m.control.anrop).not.toContain('publish');
    expect((await detalj(appId)).json.published).toBe(false);
  });

  it('ett nej utan skäl går inte igenom ⇒ 400, och ärendet står kvar', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    for (const kropp of [{ decision: 'avvisad' }, { decision: 'avvisad', reason: '   ' }, { decision: 'avvisad', reason: 42 }]) {
      const svar = await avgor(reviewId, kropp);
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
    }
    // Ett beslut som inte gick igenom är inget beslut: ärendet väntar fortfarande.
    expect((await kon()).json.reviews).toHaveLength(1);
    expect((await detalj(appId)).json.review.state).toBe('vantar');
  });

  it('ett nej med skäl går ordagrant till ägaren, och appen stannar inne', async () => {
    const SKAL = 'Appen skickar deltagarnas personnummer till en extern adress. Ta bort det anropet först.';
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    m.tid.ms += 60_000;
    const svar = await avgor(reviewId, { decision: 'avvisad', reason: SKAL });
    expect(svar.status).toBe(200);
    expect(svar.json.review).toMatchObject({ state: 'avvisad', reason: SKAL, decidedAt: '2026-09-19T08:01:00.000Z' });

    const app = await detalj(appId);
    expect(app.json.published).toBe(false);
    expect(app.json.publishedUrl).toBeUndefined();
    expect(m.control.anrop).not.toContain('publish');
    expect(app.json.review).toEqual({
      state: 'avvisad',
      requestedAt: '2026-09-19T08:00:00.000Z',
      decidedAt: '2026-09-19T08:01:00.000Z',
      reason: SKAL,
    });

    // Ordagrant: ett omskrivet skäl lämnar ägaren med en gissning om vad som behöver åtgärdas.
    const sista = app.json.messages.at(-1);
    expect(sista.role).toBe('assistant');
    expect(sista.text).toContain(SKAL);
    expect(sista.text.endsWith(SKAL)).toBe(true);

    expect((await kon()).json.reviews).toEqual([]);
  });

  it(`ett skäl över ${REVIEW_LIMITS.maxReasonChars} tecken ⇒ 400`, async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    const precis = await avgor(reviewId, { decision: 'avvisad', reason: 'å'.repeat(REVIEW_LIMITS.maxReasonChars) });
    expect(precis.status).toBe(200);

    const appId2 = await byggdApp(BERTIL, 'En anmälningslista');
    await begar(appId2, BERTIL);
    const reviewId2 = await arendeFor(appId2);
    const forLangt = await avgor(reviewId2, { decision: 'avvisad', reason: 'å'.repeat(REVIEW_LIMITS.maxReasonChars + 1) });
    expect(forLangt.status).toBe(400);
    expect(forLangt.json.error.code).toBe('invalid_request');
    expect((await kon()).json.reviews).toHaveLength(1);
  });

  it('en granskare avgör inte sin egen app när det finns någon annan att be ⇒ 400', async () => {
    // ADAM är både administratör och byggare. Bygger han något är han ÄGARE i det läget, och så
    // länge EVA också förvaltar plattformen finns det någon att be.
    await m.builder.close();
    m.builder = m.starta({ users: fejkAnvandare([ANNA, ADAM, EVA]) });

    const appId = await byggdApp(ADAM, 'Min egen app');
    expect((await begar(appId, ADAM)).status).toBe(202);
    const reviewId = await arendeFor(appId);

    for (const kropp of [{ decision: 'godkand' }, { decision: 'avvisad', reason: 'Jag ångrade mig.' }]) {
      const svar = await avgor(reviewId, kropp, ADAM);
      expect(svar.status).toBe(400);
      expect(svar.json.error.code).toBe('invalid_request');
      expect(svar.json.error.message).toContain('din egen app');
    }
    expect(m.control.anrop).not.toContain('publish');
    expect((await detalj(appId, ADAM)).json.published).toBe(false);
    // Ärendet ligger kvar i kön, så att den andra administratören kan ta det.
    expect((await kon()).json.reviews).toHaveLength(1);
  });

  /**
   * Fyraögonsprincipen förutsätter fyra ögon. Är ADAM ensam förvaltare finns ingen att be, och
   * spärren blir inte en granskning utan en låst dörr utan nyckel: appen kan aldrig gå ut.
   */
  it('plattformens ende administratör avgör sin egen app — och det syns i loggen', async () => {
    await m.builder.close();
    m.builder = m.starta({ users: fejkAnvandare([ANNA, BERTIL, ADAM, VERA]) });

    const appId = await byggdApp(ADAM, 'Min egen app');
    await begar(appId, ADAM);
    const svar = await avgor(await arendeFor(appId), { decision: 'godkand' }, ADAM);

    expect(svar.status).toBe(200);
    expect((await detalj(appId, ADAM)).json.published).toBe(true);
    const beslutet = m.logg.filter((rad) => rad.event === 'review_decided').at(-1);
    expect(beslutet?.status).toBe('godkand');
    expect(beslutet?.selfReview, 'ett beslut ingen annan läste ska gå att hitta i efterhand').toBe(true);
  });

  it('ett beslut om någon ANNANS app bär inte selfReview', async () => {
    await m.builder.close();
    m.builder = m.starta({ users: fejkAnvandare([ANNA, BERTIL, ADAM, VERA]) });

    const appId = await byggdApp();
    await begar(appId);
    expect((await avgor(await arendeFor(appId), { decision: 'godkand' })).status).toBe(200);
    expect(m.logg.filter((rad) => rad.event === 'review_decided').at(-1)?.selfReview).toBeUndefined();
  });

  /**
   * Utan bryggan till identiteten går frågan "finns det någon annan att be?" inte att besvara.
   * Osäkerhet ska falla åt det stränga hållet: spärren står kvar.
   */
  it('utan användarregister står spärren kvar — osäkerhet faller åt det stränga hållet', async () => {
    const appId = await byggdApp(ADAM, 'Min egen app');
    await begar(appId, ADAM);
    const svar = await avgor(await arendeFor(appId), { decision: 'godkand' }, ADAM);
    expect(svar.status).toBe(400);
    expect((await detalj(appId, ADAM)).json.published).toBe(false);
  });

  it('ett redan avgjort ärende går inte att avgöra igen ⇒ 409', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);
    expect((await avgor(reviewId, { decision: 'godkand' })).status).toBe(200);

    const igen = await avgor(reviewId, { decision: 'avvisad', reason: 'Jag ändrade mig.' });
    expect(igen.status).toBe(409);
    expect(igen.json.error.code).toBe('conflict');
    // Beslutet står kvar som det blev: appen är publicerad och skälet fastnade aldrig.
    const app = await detalj(appId);
    expect(app.json.published).toBe(true);
    expect(app.json.review).toMatchObject({ state: 'godkand', reason: null });
    expect(app.json.messages.at(-1).text).not.toContain('ändrade mig');
  });

  it('går publiceringen fel ⇒ 503 i klarspråk, appen är opublicerad och ärendet väntar kvar', async () => {
    const appId = await byggdApp();
    await begar(appId);
    const reviewId = await arendeFor(appId);

    m.control.publish = async () => {
      throw new Error('/srv/data/apps: disk full');
    };
    const svar = await avgor(reviewId, { decision: 'godkand' });
    expect(svar.status).toBe(503);
    expect(svar.json.error.code).toBe('unavailable');
    expect(svar.text).not.toContain('/srv');
    expect(svar.text).not.toContain('disk full');

    const app = await detalj(appId);
    expect(app.json.published).toBe(false);
    expect(app.json.review.state).toBe('vantar');
    // Hellre ett ärende som väntar än ett godkänt ärende för en app som aldrig gick ut.
    expect((await kon()).json.reviews).toHaveLength(1);
    // Och inget falskt besked i ägarens samtal.
    expect(JSON.stringify(app.json.messages)).not.toContain('Granskad och godkänd');
  });

  it('besluten går att följa i driftloggen — utan adresser, utan skäl och utan hela app-id:t', async () => {
    const SKAL = 'Appen mejlar deltagarlistan till en adress utanför kommunen.';
    const godkand = await byggdApp(ANNA, 'En todo-lista');
    const avvisad = await byggdApp(BERTIL, 'En anmälningslista');
    await begar(godkand, ANNA);
    await begar(avvisad, BERTIL);

    expect((await avgor(await arendeFor(godkand), { decision: 'godkand' })).status).toBe(200);
    expect((await avgor(await arendeFor(avvisad), { decision: 'avvisad', reason: SKAL })).status).toBe(200);

    const beslut = m.logg.filter((rad) => rad.event === 'review_decided');
    expect(beslut.map((rad) => rad.status)).toEqual(['godkand', 'avvisad']);
    // Granskaren går med som pseudonymt id, aldrig som adress.
    expect(beslut.every((rad) => rad.userId === ADAM.userId)).toBe(true);
    expect(beslut.map((rad) => rad.appIdPrefix)).toEqual([
      godkand.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      avvisad.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    ]);

    const publicerade = m.logg.filter((rad) => rad.event === 'app_published');
    expect(publicerade).toHaveLength(1);
    expect(publicerade[0]?.appIdPrefix).toBe(godkand.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));

    const allt = JSON.stringify(m.logg);
    expect(allt).not.toContain('@');
    for (const person of [ANNA, BERTIL, ADAM]) expect(allt).not.toContain(person.email);
    expect(allt).not.toContain(SKAL);
    expect(allt).not.toContain('deltagarlistan');
    expect(allt).not.toContain(godkand);
    expect(allt).not.toContain(avvisad);
  });
});
