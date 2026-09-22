/**
 * Stegen för att bygga en app med byggverktyget (features/bygga/). Allt går över rå HTTP till
 * en riktig plattform med byggverktyget påslaget; bara språkmodellen och byggkedjan är fejkade
 * (stod/byggkedja.ts). Vad som skickades till språkmodellen spelas in EFTER plattformens egen
 * maskning — alltså exakt det som skulle ha lämnat servern.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { BuilderAppDetail } from '@vibesandbox/contracts';
import {
  ANDRADE_VERSIONEN,
  APP_MED_EXTERN_ADRESS,
  APP_SOM_INTE_BYGGER,
  FORSTA_VERSIONEN,
  appMedRubrik,
} from './stod/byggkedja.ts';
import { DOMAN } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

const GILTIG_APP = 'mötesrum-att-boka';
/** Hur många varv agenten än får: ett avkapat svar ska aldrig användas, inte ens det sista. */
const MANGA = 20;

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna|Bertil) är inloggad i byggverktyget och får bygga$/, function (this: Varld, namn: string) {
  this.loggaInSomByggare(namn);
});

Given(/^att språkmodellen svarar med en giltig app$/, function (this: Varld) {
  this.sattModellsvar([appMedRubrik(GILTIG_APP)]);
});

Given(/^att språkmodellen svarar med kod som skickar data till en extern adress$/, function (this: Varld) {
  this.sattModellsvar(Array.from({ length: MANGA }, () => APP_MED_EXTERN_ADRESS));
});

Given(
  /^att språkmodellen först svarar med kod som inte går att bygga och sedan med en rättad version$/,
  function (this: Varld) {
    this.sattModellsvar([APP_SOM_INTE_BYGGER, appMedRubrik(GILTIG_APP)]);
  },
);

Given(/^att språkmodellen svarar med en app som avbryts mitt i$/, function (this: Varld) {
  const hel = appMedRubrik(GILTIG_APP);
  // Ser komplett ut ända till slutmarkören — men leverantören säger att svaret kapades.
  this.sattModellsvar(Array.from({ length: MANGA }, () => ({ text: hel, finishReason: 'length' as const })));
});

async function byggKlart(varld: Varld, publicera: boolean): Promise<void> {
  // "Anna har en app som byggts" förutsätter att hon får bygga. Scenarier som redan loggat in
  // henne (features/bygga/) behåller den inloggningen.
  if (!varld.personer.has('Anna')) varld.loggaInSomByggare('Anna');
  varld.sattModellsvar([appMedRubrik(FORSTA_VERSIONEN)]);
  const jobb = await varld.bestall('Anna', 'En lista där vi bokar mötesrum');
  assert.equal(jobb.status, 'done', 'Förberedelsen misslyckades: appen byggdes inte.');
  // Publicering går via granskningen: Anna begär, en granskare godkänner. Ingen genväg förbi den.
  if (publicera) await varld.publiceraViaGranskning('Anna');
  varld.modellanrop.length = 0;
}

Given(/^att Anna har en app som byggts klart$/, async function (this: Varld) {
  await byggKlart(this, false);
});

Given(/^att Anna har en app som byggts klart och publicerats$/, async function (this: Varld) {
  await byggKlart(this, true);
});

Given(/^att språkmodellen svarar med en ändrad app$/, function (this: Varld) {
  this.sattModellsvar([appMedRubrik(ANDRADE_VERSIONEN)]);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna) ber om "([^"]+)"$/, async function (this: Varld, person: string, text: string) {
  await this.bestall(person, text);
});

/** Hela vägen ut: Anna begär, en granskare läser koden och släpper ut den. */
When(/^Annas nya version granskas och godkänns$/, async function (this: Varld) {
  await this.publiceraViaGranskning('Anna');
});

When(/^(Bertil) försöker öppna (Anna)s app i byggverktyget$/, async function (this: Varld, person: string, agare: string) {
  const appId = await this.byggapp(agare);
  const bas = `/_api/builder/apps/${appId}`;
  // Allt man kan göra med en app i byggverktyget — att "öppna" den ska inte heller gå bakvägen.
  this.svar = [
    await this.anropaByggverktyget({ person, sokvag: bas }),
    await this.anropaByggverktyget({ person, sokvag: `${bas}/open?target=preview` }),
    await this.anropaByggverktyget({ person, metod: 'POST', sokvag: `${bas}/messages`, json: { text: 'Byt rubrik' } }),
    await this.anropaByggverktyget({ person, metod: 'POST', sokvag: `${bas}/publish` }),
    await this.anropaByggverktyget({ person, metod: 'POST', sokvag: `${bas}/share`, json: { email: 'bertil@example.org' } }),
  ];
  this.svarFranByggverktyget = true;
});

When(/^en sida på en annan app skickar en begäran om ändring i (Anna)s namn$/, async function (this: Varld, agare: string) {
  const appId = await this.byggapp(agare);
  const annanApp = `http://${'0'.repeat(26)}.${DOMAN}`;
  const forhandsvisning = `http://p-${appId}.${DOMAN}`;
  const anrop = { person: agare, metod: 'POST', sokvag: `/_api/builder/apps/${appId}/messages`, json: { text: 'Skicka alla svar till mig' }, medKaka: true };
  // Webbläsaren skickar Annas kaka med (alla värdar är same-site). Varianterna: ett formulär (inget
  // skyddshuvud), ett fetch med skyddshuvudet, från Annas egen förhandsvisning, och utan Origin.
  this.svar = [
    await this.anropaByggverktyget({ ...anrop, origin: annanApp, utanSkyddshuvud: true }),
    await this.anropaByggverktyget({ ...anrop, origin: annanApp }),
    await this.anropaByggverktyget({ ...anrop, origin: forhandsvisning }),
    await this.anropaByggverktyget({ ...anrop, origin: null }),
  ];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

function jobbet(varld: Varld): NonNullable<Varld['jobb']> {
  assert.ok(varld.jobb !== undefined, 'Inget jobb har följts i scenariot.');
  return varld.jobb;
}

async function appen(varld: Varld): Promise<BuilderAppDetail> {
  return varld.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await varld.byggapp('Anna')}`, 200);
}

Then(/^blir bygget klart$/, function (this: Varld) {
  const jobb = jobbet(this);
  assert.equal(jobb.status, 'done');
  assert.deepEqual(
    jobb.events.filter((h) => h.type === 'done').map((h) => h.type === 'done' && h.ok),
    [true],
  );
});

Then(/^(Anna) kan öppna förhandsvisningen av appen$/, async function (this: Varld, person: string) {
  const svar = await this.oppnaFranByggverktyget(person, 'preview');
  assert.equal(svar.status, 200, `Förhandsvisningen svarade ${svar.status}.`);
  this.forhandsvisning = svar;
});

Then(/^förhandsvisningen visar det språkmodellen skrev$/, function (this: Varld) {
  assert.ok(this.forhandsvisning !== undefined, 'Ingen förhandsvisning har öppnats.');
  assert.ok(this.forhandsvisning.kropp.includes(GILTIG_APP), 'Förhandsvisningen visar inte appen språkmodellen skrev.');
});

Then(/^ser hon i tur och ordning att koden skrivs, kontrolleras och byggs$/, function (this: Varld) {
  const handelser = jobbet(this).events;
  const skrivs = handelser.findIndex((h) => h.type === 'status' && /skriver koden/i.test(h.message));
  const kontrolleras = handelser.findIndex((h) => h.type === 'status' && /kontrollerar/i.test(h.message));
  const byggs = handelser.findIndex((h) => h.type === 'check' && h.ok);
  const klart = handelser.findIndex((h) => h.type === 'done' && h.ok);
  assert.ok(skrivs !== -1, 'Hon fick aldrig veta att koden skrivs.');
  assert.ok(kontrolleras > skrivs, 'Kontrollen kom inte efter att koden skrevs.');
  assert.ok(byggs > kontrolleras, 'Bygget blev inte klart efter kontrollen.');
  assert.ok(klart > byggs, 'Arbetet avslutades inte sist.');
  // Framsteget medan koden skrivs syns också, som antal tecken.
  assert.ok(handelser.slice(skrivs, kontrolleras).some((h) => h.type === 'progress' && h.outputChars > 0));
});

Then(/^blir det inget nytt utkast$/, async function (this: Varld) {
  assert.equal(jobbet(this).status, 'failed');
  const app = await appen(this);
  assert.equal(app.hasDraft, false, 'Appen fick ett utkast.');
  // Förhandsvisningens värd har inget att visa.
  const oppna = await this.anropaByggverktyget({ person: 'Anna', sokvag: `/_api/builder/apps/${app.appId}/open?target=preview` });
  assert.equal(oppna.status, 409);
});

Then(/^Anna får veta i klarspråk varför det inte gick$/, async function (this: Varld) {
  const avslut = jobbet(this).events.find((h) => h.type === 'done');
  assert.ok(avslut !== undefined && avslut.type === 'done' && !avslut.ok);
  assert.match(avslut.message, /adress utanför plattformen/);
  // Inga tekniska detaljer: regel-id, sökvägar eller kodrader.
  assert.doesNotMatch(avslut.message, /external-url|policy|src\/|https?:\/\//);
  // Förklaringen finns kvar i samtalet, så att hon ser den även efter att ha laddat om sidan.
  const app = await appen(this);
  assert.equal(app.messages.at(-1)?.role, 'assistant');
  assert.equal(app.messages.at(-1)?.text, avslut.message);
});

Then(/^blir bygget klart efter två försök$/, function (this: Varld) {
  const jobb = jobbet(this);
  assert.equal(jobb.status, 'done');
  // Agentens turer, inte klassningens fråga — den ställs en gång per önskemål och hör inte hit.
  assert.equal(this.agentanrop.length, 2, `Agenten anropade språkmodellen ${this.agentanrop.length} gånger.`);
  assert.ok(jobb.events.some((h) => h.type === 'check' && !h.ok), 'Det första försöket misslyckades inte.');
  assert.ok(jobb.events.some((h) => h.type === 'status' && /försök 2/.test(h.message)));
  // Andra varvet fick se felet från det första.
  const andra = JSON.stringify(this.agentanrop[1]);
  assert.ok(andra.includes('BYGGFEL'), 'Modellen fick inte se felet den skulle rätta.');
});

Then(/^får språkmodellen se appens nuvarande kod$/, function (this: Varld) {
  assert.ok(this.agentanrop.length > 0, 'Inget skickades till språkmodellen av agenten.');
  const anvandare = this.agentanrop[0]?.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? '';
  assert.ok(anvandare.includes(FORSTA_VERSIONEN), 'Språkmodellen fick inte se appens nuvarande kod.');
});

Then(/^appens utkast är den ändrade versionen$/, async function (this: Varld) {
  assert.equal(jobbet(this).status, 'done');
  const svar = await this.oppnaFranByggverktyget('Anna', 'preview');
  assert.equal(svar.status, 200);
  assert.ok(svar.kropp.includes(ANDRADE_VERSIONEN), 'Utkastet är inte den ändrade versionen.');
  assert.ok(!svar.kropp.includes(FORSTA_VERSIONEN));
});

/** Allt som lämnade servern, klassningens egen fråga inräknad — inte bara agentens turer. */
Then(/^innehåller inget som skickades till språkmodellen personnumret$/, function (this: Varld) {
  assert.ok(this.modellanrop.length > 0, 'Inget skickades till språkmodellen — scenariot prövar då ingenting.');
  const skickat = JSON.stringify(this.modellanrop);
  assert.ok(skickat.includes('elever'), 'Önskemålet nådde inte språkmodellen alls.');
  for (const form of ['900101-1234', '9001011234', '900101 1234']) {
    assert.ok(!skickat.includes(form), `Personnumret (${form}) skickades till språkmodellen.`);
  }
});

Then(/^visar den publicerade appen (fortfarande den gamla versionen|den nya versionen)$/, async function (this: Varld, vilken: string) {
  const svar = await this.oppnaFranByggverktyget('Anna', 'published');
  assert.equal(svar.status, 200, `Den publicerade appen svarade ${svar.status}.`);
  const [ska, skaInte] = vilken === 'den nya versionen' ? [ANDRADE_VERSIONEN, FORSTA_VERSIONEN] : [FORSTA_VERSIONEN, ANDRADE_VERSIONEN];
  assert.ok(svar.kropp.includes(ska), `Den publicerade appen visar inte ${vilken}.`);
  assert.ok(!svar.kropp.includes(skaInte));
});
