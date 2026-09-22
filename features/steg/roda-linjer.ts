/**
 * Stegen för de röda linjerna (features/styrning/roda-linjer.feature). Allt går över rå HTTP till
 * byggverktygets riktiga API, med plattformens riktiga prövning inkopplad — scenarierna fejkar
 * inget omdöme om vad som är förbjudet.
 *
 * Tre saker är värda att veta om scenarierna:
 *
 *   - Varje scenario som stoppar ett önskemål ger FÖRST språkmodellen ett giltigt svar. Utan det
 *     skulle ett trasigt stopp också sluta med ett misslyckat bygge, och scenarierna vore gröna av
 *     fel skäl. Nu byggs appen om spärren inte håller, och då faller steget.
 *   - Att modellen aldrig anropades prövas på `modellanrop`, som fylls EFTER plattformens maskning
 *     — alltså exakt det som skulle ha lämnat servern.
 *   - Kontrollrummets stopplista hämtas som administratör, aldrig ur ett tidigare svar: ett Så-steg
 *     ska se vad som FAKTISKT står i lagret.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX } from '@vibesandbox/contracts';
import type { AdminOverview, AdminStop, BuilderAppDetail, RedlineCategory } from '@vibesandbox/contracts';
import { FORSTA_VERSIONEN } from './stod/byggkedja.ts';
import { jsonKropp } from './stod/http.ts';
import type { Varld } from './stod/varld.ts';

const STOPP = `${BUILDER_API_PREFIX}/admin/stopp`;

/** De röda linjernas namn i verksamhetens språk → kontraktets kategorier. */
const KATEGORIER: Readonly<Record<string, RedlineCategory>> = {
  'poängsättning av människor': 'social-poangsattning',
  känsloigenkänning: 'kansloigenkanning',
  'biometrisk identifiering': 'biometri',
  'förutsägelser om brott': 'prediktiv-brottsbekampning',
  'automatiskt beslut om en enskild': 'automatiskt-beslut-om-enskild',
  'påverkan utan att personen märker det': 'manipulation',
};

function kategorin(namn: string): RedlineCategory {
  const kategori = KATEGORIER[namn];
  assert.ok(kategori !== undefined, `Okänd röd linje "${namn}". Kända: ${Object.keys(KATEGORIER).join(', ')}.`);
  return kategori;
}

function jobbet(varld: Varld): NonNullable<Varld['jobb']> {
  assert.ok(varld.jobb !== undefined, 'Inget jobb har följts i scenariot.');
  return varld.jobb;
}

/** Beskedet som avslutade jobbet — det Anna faktiskt läser. */
function avslutet(varld: Varld): string {
  const handelse = jobbet(varld).events.find((h) => h.type === 'done');
  assert.ok(handelse !== undefined && handelse.type === 'done', 'Jobbet avslutades utan besked till Anna.');
  assert.equal(handelse.ok, false, 'Jobbet avslutades som lyckat.');
  return handelse.message;
}

/** Stopplistan som den ser ut NU, hämtad som administratör. */
async function stoppen(varld: Varld): Promise<readonly AdminStop[]> {
  const { stops } = await varld.byggApi<{ stops: AdminStop[] }>('Erik', 'GET', '/admin/stopp', 200);
  assert.ok(Array.isArray(stops), 'Svaret från kontrollrummet innehåller ingen lista över stopp.');
  return stops;
}

/** Stopplistan ur det senaste När-steget. */
function stoppenIsvaret(varld: Varld): readonly AdminStop[] {
  const svar = varld.svar[0];
  assert.ok(svar !== undefined, 'Stopplistan har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Stopplistan svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { stops } = jsonKropp(svar) as { stops: AdminStop[] };
  assert.ok(Array.isArray(stops), 'Svaret från kontrollrummet innehåller ingen lista över stopp.');
  return stops;
}

/** Orden i ett önskemål som är långa nog att vara igenkännliga om de skulle läcka. */
function igenkannligaOrd(onskemal: string): readonly string[] {
  return onskemal.split(/[^\p{L}\p{N}-]+/u).filter((ord) => [...ord].length >= 6);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

/**
 * Önskemålet är redan avlagt när scenariot börjar. Att det INTE blev någon app hör till
 * förutsättningen: gick bygget igenom prövar scenariot inte det det säger sig pröva.
 */
Given(/^att (Anna|Bertil) har bett om "([^"]+)"$/, async function (this: Varld, person: string, text: string) {
  const jobb = await this.bestall(person, text);
  assert.equal(jobb.status, 'failed', `Förberedelsen prövar ingenting: "${text}" byggdes.`);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil|Cecilia|Erik) öppnar listan över stoppade önskemål i kontrollrummet$/, async function (this: Varld, person: string) {
  this.svar = [await this.anropaByggverktyget({ person, sokvag: STOPP })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^får Anna veta att det här inte är tillåtet, inte att något gick sönder$/, async function (this: Varld) {
  const besked = avslutet(this);
  // Ett beslut: det säger att vi inte bygger det här, och varför.
  assert.match(besked, /bygger vi inte/i, 'Beskedet säger inte att appen inte blir byggd.');
  assert.match(besked, /(?:lagen|regler).*inte tillåter/i, 'Beskedet säger inte att användningen inte är tillåten.');
  assert.match(besked, /inget som gick sönder/i, 'Beskedet skiljer inte beslutet från ett fel.');
  // Ingen krasch, ingen uppmaning att vänta ut ett fel som inte finns.
  assert.doesNotMatch(besked, /gick fel|om en stund|misslyckades|tekniskt/i, 'Beskedet låter som ett tekniskt fel.');
  // Inga tekniska detaljer: vår egen kategorikod, regel-id, sökvägar eller adresser.
  assert.doesNotMatch(besked, /redline|policy|src\/|https?:\/\//i, 'Beskedet innehåller tekniska detaljer.');
  for (const kategori of Object.values(KATEGORIER)) {
    assert.ok(!besked.includes(kategori), `Beskedet innehåller vårt eget ordval "${kategori}".`);
  }
  // Förklaringen finns kvar i samtalet, så att hon ser den även efter att ha laddat om sidan.
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.equal(app.messages.at(-1)?.role, 'assistant');
  assert.equal(app.messages.at(-1)?.text, besked, 'Beskedet står inte kvar i samtalet om appen.');
});

Then(/^fick språkmodellen aldrig se önskemålet$/, function (this: Varld) {
  assert.equal(
    this.modellanrop.length,
    0,
    `Önskemålet skickades till språkmodellen ${this.modellanrop.length} gång(er) — spärren sitter efter modellen.`,
  );
  // Och agenten startade aldrig: det enda som hände med jobbet var att det avslutades.
  const ovrigt = jobbet(this).events.filter((h) => h.type !== 'done');
  assert.deepEqual(ovrigt, [], 'Agenten hann arbeta innan önskemålet stoppades.');
});

Then(/^står appens utkast kvar orört$/, async function (this: Varld) {
  assert.equal(jobbet(this).status, 'failed', 'Önskemålet stoppades inte.');
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.equal(app.hasDraft, true, 'Appen har inget utkast kvar.');
  const forhandsvisning = await this.oppnaFranByggverktyget('Anna', 'preview');
  assert.equal(forhandsvisning.status, 200, `Förhandsvisningen svarade ${forhandsvisning.status}.`);
  assert.ok(forhandsvisning.kropp.includes(FORSTA_VERSIONEN), 'Utkastet är inte längre det som byggdes.');
});

Then(/^står där ett stopp för "([^"]+)"$/, function (this: Varld, linje: string) {
  const stopp = stoppenIsvaret(this);
  assert.equal(stopp.length, 1, `Kontrollrummet visar ${stopp.length} stopp; scenariot har gjort ett.`);
  assert.equal(stopp[0]?.category, kategorin(linje), 'Stoppet står under fel röd linje.');
});

Then(/^står det när stoppet skedde$/, function (this: Varld) {
  const stopp = stoppenIsvaret(this)[0];
  assert.ok(stopp !== undefined, 'Kontrollrummet visar inget stopp.');
  const tidpunkt = Date.parse(stopp.at);
  assert.ok(!Number.isNaN(tidpunkt), `Tidpunkten "${stopp.at}" går inte att läsa som en tid.`);
  const alder = Date.now() - tidpunkt;
  assert.ok(alder >= 0 && alder < 5 * 60 * 1000, `Tidpunkten ligger ${Math.round(alder / 1000)} s från nu.`);
});

Then(/^visas bara början av app-id:t vid stoppet$/, async function (this: Varld) {
  const stopp = stoppenIsvaret(this)[0];
  assert.ok(stopp !== undefined, 'Kontrollrummet visar inget stopp.');
  const appId = await this.byggapp('Anna');
  assert.equal([...stopp.appIdPrefix].length, ADMIN_APP_ID_PREFIX_LENGTH, 'Stoppet visar fel mängd av app-id:t.');
  assert.ok(appId.startsWith(stopp.appIdPrefix), 'Stoppet pekar inte ut den app önskemålet gällde.');
  // Hela app-id:t ÄR appens hemliga adress och lämnar aldrig kontrollrummet.
  const svar = this.svar[0];
  assert.ok(svar !== undefined && !svar.ratt.includes(appId), 'Kontrollrummet lämnar ut hela app-id:t.');
});

Then(/^nämns inget av önskemålet "([^"]+)" i kontrollrummet$/, function (this: Varld, onskemal: string) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined, 'Stopplistan har inte öppnats i scenariot.');
  assert.equal(stoppenIsvaret(this).length, 1, 'Kontrollrummet visar inget stopp — scenariot prövar då ingenting.');
  // Hela svaret, huvuden inräknade — inte bara kroppen.
  assert.ok(!svar.ratt.includes(onskemal), 'Kontrollrummet visar vad som skrevs.');
  for (const ord of igenkannligaOrd(onskemal)) {
    assert.ok(!svar.ratt.includes(ord), `Kontrollrummet innehåller ordet "${ord}" ur önskemålet.`);
  }
});

Then(/^finns det inga stoppade önskemål i kontrollrummet$/, async function (this: Varld) {
  assert.deepEqual(await stoppen(this), [], 'Kontrollrummet visar ett stopp trots att inget önskemål stoppades.');
});

Then(/^räknar översikten bara byggfelet, inte stoppet$/, async function (this: Varld) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined, 'Kontrollrummet har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Översikten svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const oversikt = jsonKropp(svar) as AdminOverview;
  // Scenariot har gjort två misslyckade jobb: ett bygge som bröt mot reglerna, och ett stopp.
  assert.equal(oversikt.failedJobs, 1, `Översikten räknar ${oversikt.failedJobs} misslyckade bygg, inte 1.`);
  assert.equal((await stoppen(this)).length, 1, 'Stoppet syns inte i kontrollrummet — scenariot prövar då ingenting.');
});

Then(/^har inget av önskemålet "([^"]+)" hamnat i driftloggarna$/, function (this: Varld, onskemal: string) {
  assert.ok(this.loggrader.length > 0, 'Plattformen har inte loggat något alls — scenariot prövar då ingenting.');
  const loggen = this.loggrader.join('\n');
  // Stoppet ÄR loggat — det är kategorin som får loggas, aldrig texten.
  assert.ok(loggen.includes('request_stopped'), 'Stoppet loggades inte alls — scenariot prövar då ingenting.');
  assert.ok(!loggen.includes(onskemal), 'Önskemålet står i en driftlogg.');
  for (const ord of igenkannligaOrd(onskemal)) {
    assert.ok(!loggen.includes(ord), `Ordet "${ord}" ur önskemålet står i en driftlogg.`);
  }
});
