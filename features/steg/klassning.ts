/**
 * Stegen för informationsklassningen (features/styrning/klassning.feature). Allt går över rå HTTP
 * till byggverktygets riktiga API, med plattformens riktiga bedömning inkopplad — scenarierna
 * fejkar bara språkmodellens svar, aldrig omdömet om vad svaret betyder.
 *
 * Tre saker är värda att veta om scenarierna:
 *
 *   - Klassningen är en EGEN fråga till modellen, med egen systemprompt (se stod/varld.ts). Den
 *     äter därför inte scenariots manus, och `sattKlassning` styr bara den frågan.
 *   - Registret hämtas som administratör i Så-steget, aldrig ur ett tidigare svar: ett Så-steg ska
 *     se vad som FAKTISKT står i lagret, inte vad ett När-steg råkade få med sig. Undantaget är de
 *     två steg som prövar just vad som står i SVARET — att app-id:t är förkortat, och att inget av
 *     önskemålet följde med.
 *   - Nivåerna heter `oppen`/`intern`/`personuppgift`/`kanslig` i kontraktet. Scenarierna skriver
 *     dem på svenska, och översättningen står här — inga interna ord i en feature-fil.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX } from '@vibesandbox/contracts';
import type { AdminRegisterEntry, Classification, ClassificationSource } from '@vibesandbox/contracts';
import { jsonKropp } from './stod/http.ts';
import type { Varld } from './stod/varld.ts';

const REGISTER = `${BUILDER_API_PREFIX}/admin/register`;

/** Nivåerna i verksamhetens språk → kontraktets klasser. */
const NIVAER: Readonly<Record<string, Classification>> = {
  öppen: 'oppen',
  intern: 'intern',
  personuppgifter: 'personuppgift',
  'känsliga uppgifter': 'kanslig',
};

/** Hur nivån sattes, i verksamhetens språk → kontraktets källor. */
const KALLOR: Readonly<Record<string, ClassificationSource>> = {
  'plattformen läste beskrivningen': 'modell',
  'ett ord i beskrivningen satte nivån': 'signalord',
  'det inte gick att avgöra': 'fail-closed',
};

function nivan(namn: string): Classification {
  const nivа = NIVAER[namn];
  assert.ok(nivа !== undefined, `Okänd nivå "${namn}". Kända: ${Object.keys(NIVAER).join(', ')}.`);
  return nivа;
}

/** Registret som det ser ut NU, hämtat som administratör. */
async function registret(varld: Varld): Promise<readonly AdminRegisterEntry[]> {
  const { entries } = await varld.byggApi<{ entries: AdminRegisterEntry[] }>('Erik', 'GET', '/admin/register', 200);
  assert.ok(Array.isArray(entries), 'Svaret från kontrollrummet innehåller inget register.');
  return entries;
}

/** Registret ur det senaste När-steget. */
function registretIsvaret(varld: Varld): readonly AdminRegisterEntry[] {
  const svar = varld.svar[0];
  assert.ok(svar !== undefined, 'AI-registret har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Registret svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { entries } = jsonKropp(svar) as { entries: AdminRegisterEntry[] };
  assert.ok(Array.isArray(entries), 'Svaret från kontrollrummet innehåller inget register.');
  return entries;
}

/** Raden för en persons app, sökt på det förkortade id:t — det enda registret lämnar ut. */
async function raden(varld: Varld, namn: string): Promise<AdminRegisterEntry> {
  const prefix = [...(await varld.byggapp(namn))].slice(0, ADMIN_APP_ID_PREFIX_LENGTH).join('');
  const rad = (await registret(varld)).find((post) => post.appIdPrefix === prefix);
  assert.ok(rad !== undefined, `${namn}s app syns inte i AI-registret.`);
  return rad;
}

/** Orden i ett önskemål som är långa nog att vara igenkännliga om de skulle läcka. */
function igenkannligaOrd(onskemal: string): readonly string[] {
  return onskemal.split(/[^\p{L}\p{N}-]+/u).filter((ord) => [...ord].length >= 6);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att plattformen bedömer önskemålet som "([^"]+)"$/, function (this: Varld, nivå: string) {
  this.sattKlassning(nivan(nivå));
});

/** En modell som inte går att nå. Allt som går fel är samma sak för klassningen: vi vet inte. */
Given(/^att språkmodellen inte kan svara på hur känslig appen är$/, function (this: Varld) {
  this.sattKlassning(new Error('språkmodellen svarar inte'));
});

Given(/^att språkmodellen svarar "([^"]+)" om hur känslig appen är$/, function (this: Varld, svar: string) {
  this.sattKlassning(svar);
});

/**
 * Önskemålet är redan avlagt när scenariot börjar, och det BYGGDES. Misslyckades det prövar
 * scenariot inte det det säger sig pröva — då är nivån satt på ett bygge som aldrig blev av.
 */
Given(/^att (Anna|Bertil) har beskrivit appen som "([^"]+)"$/, async function (this: Varld, person: string, text: string) {
  const jobb = await this.bestall(person, text);
  assert.equal(jobb.status, 'done', `Förberedelsen misslyckades: "${text}" byggdes inte.`);
});

/** En app finns, men ingen har sagt vad den ska göra. Då finns det inget att bedöma. */
Given(/^att (Anna|Bertil) har börjat en app utan att beskriva den$/, async function (this: Varld, person: string) {
  await this.byggapp(person);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil|Cecilia|Erik) öppnar AI-registret$/, async function (this: Varld, person: string) {
  this.svar = [await this.anropaByggverktyget({ person, sokvag: REGISTER })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^står (Anna|Bertil)s app som "([^"]+)" i AI-registret$/, async function (this: Varld, person: string, nivå: string) {
  assert.equal((await raden(this, person)).classification, nivan(nivå), `${person}s app står på fel nivå i AI-registret.`);
});

Then(/^står det att (plattformen läste beskrivningen|ett ord i beskrivningen satte nivån|det inte gick att avgöra)$/, async function (
  this: Varld,
  fras: string,
) {
  const kalla = KALLOR[fras];
  assert.ok(kalla !== undefined, `Okänd förklaring "${fras}".`);
  assert.equal((await raden(this, 'Anna')).source, kalla, 'Registret säger fel sak om hur nivån sattes.');
});

Then(/^står det när nivån sattes$/, async function (this: Varld) {
  const rad = await raden(this, 'Anna');
  assert.ok(rad.classifiedAt !== null, 'Registret säger inte när nivån sattes.');
  const tidpunkt = Date.parse(rad.classifiedAt);
  assert.ok(!Number.isNaN(tidpunkt), `Tidpunkten "${rad.classifiedAt}" går inte att läsa som en tid.`);
  const alder = Date.now() - tidpunkt;
  assert.ok(alder >= 0 && alder < 5 * 60 * 1000, `Tidpunkten ligger ${Math.round(alder / 1000)} s från nu.`);
});

/** En app som aldrig bedömts fick sin nivå av fail-closed, inte vid en tidpunkt. Då hittas ingen på. */
Then(/^står det ingen tidpunkt vid (Anna|Bertil)s app$/, async function (this: Varld, person: string) {
  assert.equal((await raden(this, person)).classifiedAt, null, 'Registret visar en tidpunkt för en app som aldrig bedömts.');
});

Then(/^står (Anna|Bertil)s adress vid hennes app i registret$/, async function (this: Varld, person: string) {
  assert.equal((await raden(this, person)).ownerEmail, this.epost(person), `Registret visar inte ${person}s adress.`);
});

Then(/^står det att (Anna|Bertil)s app är publicerad$/, async function (this: Varld, person: string) {
  assert.equal((await raden(this, person)).published, true, `Registret visar inte att ${person}s app är publicerad.`);
});

Then(/^visas bara början av app-id:t i registret$/, async function (this: Varld) {
  const appId = await this.byggapp('Anna');
  const rad = registretIsvaret(this).find((post) => appId.startsWith(post.appIdPrefix));
  assert.ok(rad !== undefined, 'Annas app syns inte i registret.');
  assert.equal([...rad.appIdPrefix].length, ADMIN_APP_ID_PREFIX_LENGTH, 'Registret visar fel mängd av app-id:t.');
  // Hela app-id:t ÄR appens hemliga adress och lämnar aldrig kontrollrummet.
  const svar = this.svar[0];
  assert.ok(svar !== undefined && !svar.ratt.includes(appId), 'Registret lämnar ut hela app-id:t.');
});

Then(/^nämns inget av önskemålet "([^"]+)" i registret$/, function (this: Varld, onskemal: string) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined, 'AI-registret har inte öppnats i scenariot.');
  assert.ok(registretIsvaret(this).length > 0, 'Registret är tomt — scenariot prövar då ingenting.');
  // Hela svaret, huvuden inräknade — inte bara kroppen.
  assert.ok(!svar.ratt.includes(onskemal), 'Registret visar vad som skrevs.');
  for (const ord of igenkannligaOrd(onskemal)) {
    assert.ok(!svar.ratt.includes(ord), `Registret innehåller ordet "${ord}" ur önskemålet.`);
  }
});

/**
 * Nivån SKA stå i driftloggen. Det är så en rad fail-closed i följd syns som ett driftfel i stället
 * för att bara bli en sträng rad i registret som ingen förstår.
 */
Then(/^står nivån i driftloggarna$/, function (this: Varld) {
  const loggen = this.loggrader.join('\n');
  assert.ok(loggen.includes('request_classified'), 'Klassningen loggades inte alls.');
  assert.ok(loggen.includes('"classification"'), 'Loggraden säger inte vilken nivå appen fick.');
  assert.ok(loggen.includes('"classificationSource"'), 'Loggraden säger inte hur nivån sattes.');
});

Then(/^nämns inget av önskemålet "([^"]+)" i driftloggarna$/, function (this: Varld, onskemal: string) {
  assert.ok(this.loggrader.length > 0, 'Plattformen har inte loggat något alls — scenariot prövar då ingenting.');
  const loggen = this.loggrader.join('\n');
  assert.ok(!loggen.includes(onskemal), 'Önskemålet står i en driftlogg.');
  for (const ord of igenkannligaOrd(onskemal)) {
    assert.ok(!loggen.includes(ord), `Ordet "${ord}" ur önskemålet står i en driftlogg.`);
  }
});
