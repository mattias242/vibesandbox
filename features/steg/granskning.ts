/**
 * Stegen för granskningen (features/styrning/granskning.feature). Allt går över rå HTTP till
 * byggverktygets riktiga API, som gränssnittet gör — inga genvägar förbi behörigheten.
 *
 * Tre saker är värda att veta om scenarierna:
 *
 *   - Ägaren och granskaren är ALLTID olika personer, utom i det scenario som prövar just att de
 *     inte får vara samma. En granskare som avgör sin egen app har inte granskat något.
 *   - Läget hämtas i Så-steget, aldrig ur ett tidigare svar: ett Så-steg ska se vad som FAKTISKT
 *     står i lagret. Undantaget är de steg som prövar vad som står i SVARET — att kön inte bär
 *     källkod, och att app-id:t är förkortat.
 *   - "Appen är publicerad" prövas på appen, inte på ärendet. Ett godkänt ärende för en app som
 *     inte gick ut vore precis den lögn granskningen finns för att förhindra.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX } from '@vibesandbox/contracts';
import type { AdminReview, BuilderAppDetail, Classification, SourceFiles } from '@vibesandbox/contracts';
import { FORSTA_VERSIONEN, appMedRubrik } from './stod/byggkedja.ts';
import { jsonKropp } from './stod/http.ts';
import type { Varld } from './stod/varld.ts';

const KON = `${BUILDER_API_PREFIX}/admin/granskning`;

/** Nivåerna i verksamhetens språk → kontraktets klasser. Samma tabell som i klassning.ts. */
const NIVAER: Readonly<Record<string, Classification>> = {
  öppen: 'oppen',
  intern: 'intern',
  personuppgifter: 'personuppgift',
  'känsliga uppgifter': 'kanslig',
};

/** Granskningskön som den ser ut NU, hämtad som administratör. */
async function kon(varld: Varld, granskare = 'Erik'): Promise<readonly AdminReview[]> {
  const { reviews } = await varld.byggApi<{ reviews: AdminReview[] }>(granskare, 'GET', '/admin/granskning', 200);
  assert.ok(Array.isArray(reviews), 'Svaret från kontrollrummet innehåller ingen granskningskö.');
  return reviews;
}

/** Ärendet för en persons app, sökt på det förkortade id:t — det enda kön lämnar ut. */
async function arendet(varld: Varld, agare: string, granskare = 'Erik'): Promise<AdminReview> {
  const appId = await varld.byggapp(agare);
  const arende = (await kon(varld, granskare)).find((r) => appId.startsWith(r.appIdPrefix));
  assert.ok(arende !== undefined, `${agare}s app syns inte i granskningskön.`);
  return arende;
}

/** Appen som ägaren ser den — publicerad eller inte, och med sitt granskningsläge. */
async function appen(varld: Varld, agare: string): Promise<BuilderAppDetail> {
  return varld.byggApi<BuilderAppDetail>(agare, 'GET', `/apps/${await varld.byggapp(agare)}`, 200);
}

/** Orden i ett skäl som är långa nog att vara igenkännliga om de skulle läcka. */
function igenkannligaOrd(text: string): readonly string[] {
  return text.split(/[^\p{L}\p{N}-]+/u).filter((ord) => [...ord].length >= 6);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna|Bertil) har begärt publicering$/, async function (this: Varld, person: string) {
  await this.byggApi(person, 'POST', `/apps/${await this.byggapp(person)}/publish`, 202);
});

/**
 * Granskaren bygger något eget. Enda scenariot där ägaren och granskaren är samma person — och
 * det är just det som ska visa sig omöjligt att komma runt.
 */
Given(/^att (Erik) har en egen app som byggts klart$/, async function (this: Varld, person: string) {
  if (!this.personer.has(person)) this.loggaIn(person, undefined, ['admin']);
  this.sattModellsvar([appMedRubrik(FORSTA_VERSIONEN)]);
  const jobb = await this.bestall(person, 'En checklista för driften');
  assert.equal(jobb.status, 'done', `Förberedelsen misslyckades: ${person}s egen app byggdes inte.`);
});

Given(/^att (Erik) har begärt publicering av sin egen app$/, async function (this: Varld, person: string) {
  await this.byggApi(person, 'POST', `/apps/${await this.byggapp(person)}/publish`, 202);
});

Given(/^att (Anna) har bett om att få rubriken bytt$/, async function (this: Varld, person: string) {
  const jobb = await this.bestall(person, 'Byt rubrik');
  assert.equal(jobb.status, 'done', 'Förberedelsen misslyckades: ombyggnaden blev aldrig klar.');
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil) begär publicering$/, async function (this: Varld, person: string) {
  this.svar = [await this.anropaByggverktyget({ person, sokvag: `${BUILDER_API_PREFIX}/apps/${await this.byggapp(person)}/publish`, metod: 'POST' })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Anna|Bertil|Erik) öppnar granskningskön$/, async function (this: Varld, person: string) {
  this.svar = [await this.anropaByggverktyget({ person, sokvag: KON })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Erik) öppnar (Anna)s ärende i granskningskön$/, async function (this: Varld, granskare: string, agare: string) {
  const arende = await arendet(this, agare, granskare);
  this.svar = [await this.anropaByggverktyget({ person: granskare, sokvag: `${KON}/${arende.reviewId}` })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Erik) godkänner (Anna)s app$/, async function (this: Varld, granskare: string, agare: string) {
  const arende = await arendet(this, agare, granskare);
  await this.byggApi(granskare, 'POST', `/admin/granskning/${arende.reviewId}`, 200, { decision: 'godkand' });
});

When(/^(Erik) avvisar (Anna)s app med skälet "([^"]+)"$/, async function (this: Varld, granskare: string, agare: string, skal: string) {
  const arende = await arendet(this, agare, granskare);
  await this.byggApi(granskare, 'POST', `/admin/granskning/${arende.reviewId}`, 200, { decision: 'avvisad', reason: skal });
});

When(/^(Erik) försöker avvisa (Anna)s app utan skäl$/, async function (this: Varld, granskare: string, agare: string) {
  const arende = await arendet(this, agare, granskare);
  this.svar = [
    await this.anropaByggverktyget({
      person: granskare,
      sokvag: `${KON}/${arende.reviewId}`,
      metod: 'POST',
      json: { decision: 'avvisad' },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Erik) försöker godkänna sin egen app$/, async function (this: Varld, person: string) {
  const arende = await arendet(this, person, person);
  this.svar = [
    await this.anropaByggverktyget({
      person,
      sokvag: `${KON}/${arende.reviewId}`,
      metod: 'POST',
      json: { decision: 'godkand' },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^är appen publicerad$/, async function (this: Varld) {
  assert.equal((await appen(this, 'Anna')).published, true, 'Appen gick aldrig ut.');
});

Then(/^är appen inte publicerad$/, async function (this: Varld) {
  assert.equal((await appen(this, 'Anna')).published, false, 'Appen gick ut trots att ingen släppt ut den.');
});

Then(/^är hans app inte publicerad$/, async function (this: Varld) {
  assert.equal((await appen(this, 'Erik')).published, false, 'Granskaren släppte ut sin egen app.');
});

Then(/^väntar appen på granskning$/, async function (this: Varld) {
  assert.equal((await appen(this, 'Anna')).review?.state, 'vantar', 'Appen väntar inte på granskning.');
});

Then(/^väntar appen fortfarande på granskning$/, async function (this: Varld) {
  assert.equal((await appen(this, 'Anna')).review?.state, 'vantar', 'Appen väntar inte längre på granskning.');
});

Then(/^är (Anna)s ärende tillbakadraget$/, async function (this: Varld, person: string) {
  const app = await appen(this, person);
  assert.equal(app.review?.state, 'tillbakadragen', 'Ärendet drogs inte tillbaka av det nya bygget.');
  // Ett tillbakadraget ärende är inget nej: ingen har avgjort det, och inget skäl finns att ge.
  assert.equal(app.review?.reason, null, 'Ett tillbakadraget ärende bär ett skäl, som om någon sagt nej.');
});

Then(/^får (Anna) veta att appen är granskad och publicerad$/, async function (this: Varld, person: string) {
  const app = await appen(this, person);
  assert.equal(app.review?.state, 'godkand', 'Ärendet står inte som godkänt.');
  const sista = app.messages.at(-1);
  assert.equal(sista?.role, 'assistant', 'Det sista i samtalet är inte ett besked från plattformen.');
  assert.match(sista?.text ?? '', /godkänd/i, 'Beskedet säger inte att appen är godkänd.');
  assert.match(sista?.text ?? '', /publicerad/i, 'Beskedet säger inte att appen är publicerad.');
});

Then(/^står skälet "([^"]+)" ordagrant i (Anna)s samtal$/, async function (this: Varld, skal: string, person: string) {
  const app = await appen(this, person);
  assert.equal(app.review?.state, 'avvisad', 'Ärendet står inte som avvisat.');
  const sista = app.messages.at(-1);
  assert.equal(sista?.role, 'assistant', 'Det sista i samtalet är inte ett besked från plattformen.');
  // Ordagrant: en omskrivning gör skälet till en gissning, och nästa försök blir en gissning till.
  assert.ok(sista?.text.includes(skal), `Skälet står inte ordagrant i samtalet. Fick: ${sista?.text}`);
});

Then(/^ser han appens källkod$/, function (this: Varld) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined, 'Ärendet har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Ärendet svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { files } = jsonKropp(svar) as { files: SourceFiles };
  assert.ok(files !== undefined && Object.keys(files).length > 0, 'Ärendet innehåller ingen källkod att granska.');
  assert.ok(JSON.stringify(files).includes(FORSTA_VERSIONEN), 'Koden i ärendet är inte den som byggdes.');
});

Then(/^står där ett ärende för (Anna)s app$/, async function (this: Varld, person: string) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined && svar.status === 200, 'Granskningskön har inte öppnats i scenariot.');
  const { reviews } = jsonKropp(svar) as { reviews: AdminReview[] };
  const appId = await this.byggapp(person);
  assert.equal(reviews.length, 1, `Kön visar ${reviews.length} ärenden; scenariot har begärt ett.`);
  assert.ok(appId.startsWith(reviews[0]?.appIdPrefix ?? '\0'), 'Ärendet pekar inte ut den app som begärde.');
});

Then(/^syns ingen källkod i kön$/, function (this: Varld) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined, 'Granskningskön har inte öppnats i scenariot.');
  // Kön ska gå att öppna utan att varje apps kod läses ur databasen. Koden hör till ETT ärende.
  assert.ok(!svar.ratt.includes(FORSTA_VERSIONEN), 'Granskningskön bär appens källkod.');
});

Then(/^visas bara början av app-id:t i kön$/, async function (this: Varld) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined && svar.status === 200, 'Granskningskön har inte öppnats i scenariot.');
  const { reviews } = jsonKropp(svar) as { reviews: AdminReview[] };
  const arende = reviews[0];
  assert.ok(arende !== undefined, 'Kön är tom — scenariot prövar då ingenting.');
  assert.equal([...arende.appIdPrefix].length, ADMIN_APP_ID_PREFIX_LENGTH, 'Kön visar fel mängd av app-id:t.');
  const appId = await this.byggapp('Anna');
  assert.ok(!svar.ratt.includes(appId), 'Granskningskön lämnar ut hela app-id:t.');
});

Then(/^står (Anna)s ärende som "([^"]+)" i kön$/, async function (this: Varld, person: string, niva: string) {
  const vantad = NIVAER[niva];
  assert.ok(vantad !== undefined, `Okänd nivå "${niva}".`);
  assert.equal((await arendet(this, person)).classification, vantad, 'Ärendet står på fel nivå i kön.');
});

Then(/^finns det inga ärenden i granskningskön$/, async function (this: Varld) {
  assert.deepEqual(await kon(this), [], 'Granskningskön visar ett ärende som inte borde vänta.');
});

Then(/^står det bara ett ärende i granskningskön$/, async function (this: Varld) {
  assert.equal((await kon(this)).length, 1, 'Granskningskön visar fel antal ärenden.');
});

/**
 * Beslutet SKA loggas — det är revisionsspåret, och hela poängen med att en människa avgör. Men
 * skälet är fritext om någon annans app och hör hemma i samtalet, aldrig i en driftlogg.
 */
Then(/^står beslutet i driftloggarna$/, function (this: Varld) {
  const loggen = this.loggrader.join('\n');
  assert.ok(loggen.includes('review_decided'), 'Beslutet loggades inte alls.');
});

Then(/^nämns inget av skälet "([^"]+)" i driftloggarna$/, function (this: Varld, skal: string) {
  assert.ok(this.loggrader.length > 0, 'Plattformen har inte loggat något alls — scenariot prövar då ingenting.');
  const loggen = this.loggrader.join('\n');
  assert.ok(!loggen.includes(skal), 'Skälet står i en driftlogg.');
  for (const ord of igenkannligaOrd(skal)) {
    assert.ok(!loggen.includes(ord), `Ordet "${ord}" ur skälet står i en driftlogg.`);
  }
});
