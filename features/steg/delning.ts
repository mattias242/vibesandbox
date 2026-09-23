/**
 * Stegen för åtkomst per app (features/delning/). Anna bygger och publicerar sin app i
 * byggverktyget och delar den som i gränssnittet — med byggverktygets riktiga API. Den som fått
 * appen delad med sig loggar in med det konto som inbjudan gav hen; den som inte fått den har ett
 * eget konto på plattformen men ingen åtkomst.
 *
 * "Samma svar som för en app som inte finns" jämförs med det FAKTISKA svaret på exakt samma anrop
 * mot ett app-id som inte finns — inte med en siffra i testet.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { BUILDER_API_PREFIX, isAppId } from '@vibesandbox/contracts';
import type { ApiErrorBody, AppId, BuilderAppDetail, BuilderAppMember } from '@vibesandbox/contracts';
import { newAppId } from './stod/app-id.ts';
import { FORSTA_VERSIONEN } from './stod/byggkedja.ts';
import { huvud, jsonKropp } from './stod/http.ts';
import type { Svar } from './stod/http.ts';
import { LITET_DOKUMENT, dokumentlista } from './stod/varld.ts';
import type { AnropTillApp, Varld } from './stod/varld.ts';

/** Annas app, som scenariot talar om den ("Annas publicerade app", "appen"). */
const ANNAS_APP = 'Annas app';

/** Annas app i byggverktyget, också registrerad under sitt namn så att den kan anropas på sin egen adress. */
async function annasApp(varld: Varld): Promise<AppId> {
  const appId = await varld.byggapp('Anna');
  assert.ok(isAppId(appId), `Byggverktyget gav ett app-id som inte följer kontraktet: ${appId}`);
  varld.appar.set(ANNAS_APP, appId);
  return appId;
}

/** Anrop till Annas app (publicerad eller utkast). Anropen sparas, så att ett Så-steg kan göra om dem. */
async function anropaAnnasApp(varld: Varld, anrop: readonly Omit<AnropTillApp, 'app'>[]): Promise<void> {
  await annasApp(varld);
  const fullstandiga = anrop.map((a) => ({ ...a, app: ANNAS_APP }));
  varld.svar = [];
  for (const a of fullstandiga) varld.svar.push(await varld.anropaApp(a));
  varld.appanrop = fullstandiga;
  varld.svarFranByggverktyget = false;
}

async function medlemmar(varld: Varld): Promise<readonly BuilderAppMember[]> {
  const { members } = await varld.byggApi<{ members: BuilderAppMember[] }>('Anna', 'GET', `/apps/${await annasApp(varld)}/members`, 200);
  return members;
}

function visarAppensInnehall(svar: Svar, vem: string): void {
  assert.equal(svar.status, 200, `${vem} fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  assert.ok(svar.kropp.includes(FORSTA_VERSIONEN), `${vem} fick inte se appens innehåll.`);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att Anna har delat appen med (Bertil|Cecilia)$/, async function (this: Varld, namn: string) {
  const appId = await annasApp(this);
  const email = this.epost(namn);
  // Som när Anna delar i gränssnittet: byggverktygets API, med hennes inloggning.
  await this.byggApi('Anna', 'POST', `/apps/${appId}/share`, 200, { email });
  // Inbjudan gav adressen ett konto. Personen loggar sedan in med just det kontot — annars vore det
  // någon annan. Id:t läses ur Annas åtkomstlista, där kontraktet säger att `memberId` är användar-id:t.
  const rad = (await medlemmar(this)).find((m) => m.email === email.toLowerCase() && m.role === 'user');
  assert.ok(rad !== undefined, `${namn} syns inte som användare i åtkomstlistan efter delningen.`);
  this.anvandarIdn.set(namn, rad.memberId);
  this.loggaIn(namn);
});

Given(/^att (Cecilia) är inloggad på plattformen$/, function (this: Varld, namn: string) {
  // Ett giltigt konto på plattformen — men ingen har delat Annas app med henne.
  this.loggaIn(namn);
});

Given(/^att (Erik) är administratör för plattformen$/, function (this: Varld, namn: string) {
  this.loggaIn(namn, undefined, ['admin']);
});

Given(/^att (Bertil) har öppnat Annas publicerade app$/, async function (this: Varld, namn: string) {
  await anropaAnnasApp(this, [{ person: namn }]);
  // Förutsättningen: han var inne i appen innan åtkomsten togs bort.
  visarAppensInnehall(this.endaSvaret(), namn);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil|Cecilia|Erik) öppnar Annas publicerade app(?: igen)?$/, async function (this: Varld, person: string) {
  await anropaAnnasApp(this, [{ person }]);
});

When(/^(Bertil) sparar ett dokument i Annas publicerade app$/, async function (this: Varld, person: string) {
  await anropaAnnasApp(this, [{ person, metod: 'POST', sokvag: dokumentlista('poster'), json: LITET_DOKUMENT }]);
});

When(/^(Cecilia) listar en kollektion i Annas publicerade app$/, async function (this: Varld, person: string) {
  // Både att läsa och att skriva: ingen väg in i appens data får skilja sig från en app som inte finns.
  await anropaAnnasApp(this, [
    { person, sokvag: dokumentlista('poster') },
    { person, metod: 'POST', sokvag: dokumentlista('poster'), json: LITET_DOKUMENT },
  ]);
});

When(/^(Bertil) öppnar förhandsvisningen av Annas app$/, async function (this: Varld, person: string) {
  // Utan ett utkast skulle förhandsvisningen svara "finns inte" för vem som helst, och scenariot
  // skulle då inte pröva någonting.
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await annasApp(this)}`, 200);
  assert.equal(app.hasDraft, true, 'Annas app har inget utkast att förhandsvisa.');
  await anropaAnnasApp(this, [
    { person, forhandsvisning: true },
    { person, forhandsvisning: true, sokvag: dokumentlista('poster') },
  ]);
});

When(/^Anna tittar på vilka som har åtkomst till appen$/, async function (this: Varld) {
  this.svar = [await this.anropaByggverktyget({ person: 'Anna', sokvag: `${BUILDER_API_PREFIX}/apps/${await annasApp(this)}/members` })];
  this.svarFranByggverktyget = true;
});

When(/^Anna tar bort (Bertil)s åtkomst till appen$/, async function (this: Varld, namn: string) {
  const sokvag = `${BUILDER_API_PREFIX}/apps/${await annasApp(this)}/members/${encodeURIComponent(this.person(namn).identitet.userId)}`;
  const svar = await this.anropaByggverktyget({ person: 'Anna', metod: 'DELETE', sokvag });
  assert.equal(svar.status, 200, `Borttagningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  this.svar = [svar];
  this.svarFranByggverktyget = true;
});

When(/^(Bertil) försöker dela Annas app med (Cecilia)$/, async function (this: Varld, person: string, mottagare: string) {
  const sokvag = `${BUILDER_API_PREFIX}/apps/${await annasApp(this)}/share`;
  this.svar = [await this.anropaByggverktyget({ person, metod: 'POST', sokvag, json: { email: this.epost(mottagare) } })];
  this.svarFranByggverktyget = true;
});

When(/^Anna försöker ta bort sin egen åtkomst till appen$/, async function (this: Varld) {
  const sokvag = `${BUILDER_API_PREFIX}/apps/${await annasApp(this)}/members/${encodeURIComponent(this.person('Anna').identitet.userId)}`;
  this.svar = [await this.anropaByggverktyget({ person: 'Anna', metod: 'DELETE', sokvag })];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^visas appens innehåll$/, function (this: Varld) {
  visarAppensInnehall(this.endaSvaret(), this.senastInloggad ?? 'Anroparen');
});

Then(/^lyckas det$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 201, `Det gick inte: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

Then(/^får (?:han|hon) samma svar som för en app som inte finns$/, async function (this: Varld) {
  assert.ok(this.appanrop.length > 0 && this.appanrop.length === this.svar.length, 'Inget anrop att jämföra med.');
  // Ett app-id som inte finns, men med samma form som ett riktigt — och i övrigt exakt samma anrop.
  const okant = newAppId();
  for (const [index, anrop] of this.appanrop.entries()) {
    const svar = this.svar[index];
    assert.ok(svar !== undefined);
    const vantat = await this.anropaApp({ ...anrop, appId: okant });
    const vad = `${anrop.metod ?? 'GET'} ${anrop.sokvag ?? '/'}${anrop.forhandsvisning === true ? ' (förhandsvisningen)' : ''}`;
    assert.equal(svar.status, vantat.status, `${vad}: ${svar.status}, men en app som inte finns ger ${vantat.status}.`);
    const kropp = jsonKropp(svar) as ApiErrorBody;
    const vantadKropp = jsonKropp(vantat) as ApiErrorBody;
    assert.equal(kropp.error?.code, vantadKropp.error?.code, `${vad}: annan felkod än för en app som inte finns.`);
    assert.equal(kropp.error?.message, vantadKropp.error?.message, `${vad}: annat felmeddelande än för en app som inte finns.`);
    for (const namn of ['Content-Type', 'Content-Security-Policy', 'X-Content-Type-Options']) {
      assert.equal(huvud(svar, namn), huvud(vantat, namn), `${vad}: huvudet ${namn} skiljer sig från en app som inte finns.`);
    }
    // Och ingenting av appen läcker ut.
    assert.ok(!svar.ratt.includes(FORSTA_VERSIONEN), `${vad}: svaret innehåller appens innehåll.`);
  }
});

Then(/^ser hon (Bertil)s och (Cecilia)s adresser$/, function (this: Varld, forsta: string, andra: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200, `Åtkomstlistan svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { members } = jsonKropp(svar) as { members: BuilderAppMember[] };
  const anvandare = members.filter((m) => m.role === 'user').map((m) => m.email).sort();
  assert.deepEqual(anvandare, [this.epost(forsta), this.epost(andra)].sort());
  // Utöver dem finns bara Anna själv, som ägare.
  assert.deepEqual(
    members.filter((m) => m.role !== 'user').map((m) => [m.role, m.email]),
    [['owner', this.epost('Anna')]],
  );
});

Then(/^(Anna) kan fortfarande öppna Annas publicerade app$/, async function (this: Varld, person: string) {
  const svar = await this.anropaApp({ app: ANNAS_APP, person });
  visarAppensInnehall(svar, person);
});

// ── Nekandets två former: en sida för människan, ett API-svar för appkoden ────────

/** Som en webbläsare gör när någon klickar på en länk. Det är detta huvud gatewayn går på. */
const SOM_I_WEBBLASARE: Readonly<Record<string, string>> = { 'Sec-Fetch-Mode': 'navigate' };
/** Som appens egen kod gör med `fetch`. Samma adress, samma användare — bara en annan sorts anrop. */
const SOM_APPKOD: Readonly<Record<string, string>> = { 'Sec-Fetch-Mode': 'cors' };

When(
  /^(Anna|Bertil|Cecilia|Erik) klickar sig till (Annas publicerade app|förhandsvisningen av Annas app|en app som inte finns|förhandsvisningen av en app som inte finns)$/,
  async function (this: Varld, person: string, vad: string) {
    // `annasApp` bygger appen och kontrollerar id:t; utan den finns ingen app att nekas åtkomst till.
    await annasApp(this);
    this.sidor.push(
      await this.anropaApp({
        app: ANNAS_APP,
        person,
        huvuden: SOM_I_WEBBLASARE,
        ...(vad.includes('inte finns') ? { appId: newAppId() } : {}),
        ...(vad.startsWith('förhandsvisningen') ? { forhandsvisning: true } : {}),
      }),
    );
  },
);

When(/^(Cecilia)s appkod hämtar Annas publicerade app$/, async function (this: Varld, person: string) {
  await anropaAnnasApp(this, [{ person, huvuden: SOM_APPKOD }]);
});

Then(/^får (?:han|hon) en läsbar sida i stället för ett API-svar$/, function (this: Varld) {
  const sida = this.sidor.at(-1);
  assert.ok(sida !== undefined, 'Inget sidanrop i scenariot.');
  assert.equal(sida.status, 404, `Sidan svarade ${sida.status}.`);
  assert.match(huvud(sida, 'Content-Type') ?? '', /^text\/html/, 'Sidan är inte HTML.');
  assert.ok(sida.kropp.includes('<!doctype html>'), 'Kroppen är inget HTML-dokument.');
  // Det avgörande: en människa ska inte mötas av rå JSON.
  assert.ok(!sida.kropp.trimStart().startsWith('{'), 'Kroppen är fortfarande JSON.');
  assert.ok(sida.kropp.includes('Appen finns inte.'), 'Sidan saknar beskedet i klarspråk.');
});

Then(/^sidan nämner varken appens id eller vem som äger den$/, async function (this: Varld) {
  const sida = this.sidor.at(-1);
  assert.ok(sida !== undefined, 'Inget sidanrop i scenariot.');
  const appId = await annasApp(this);
  // Hela svaret, huvuden och kropp: ett id som läcker i ett huvud är lika röjande som i kroppen.
  assert.ok(!sida.ratt.includes(appId), 'Sidan röjer appens id.');
  assert.ok(!sida.ratt.includes(this.epost('Anna')), 'Sidan röjer vem som äger appen.');
  for (const ord of ['behörighet', 'åtkomst', 'delad', 'ägare', 'utkast']) {
    assert.ok(!sida.kropp.toLowerCase().includes(ord), `Sidan säger "${ord}" och röjer därmed varför det nekades.`);
  }
});

Then(/^är de två sidorna ordagrant identiska$/, function (this: Varld) {
  assert.equal(this.sidor.length, 2, `Scenariot hämtade ${this.sidor.length} sidor, inte två.`);
  const [forsta, andra] = this.sidor as [Svar, Svar];
  assert.equal(forsta.status, andra.status, 'Sidorna har olika status.');
  assert.equal(forsta.kropp, andra.kropp, 'Sidorna har olika innehåll.');
  for (const namn of ['Content-Type', 'Content-Length', 'Content-Security-Policy', 'X-Content-Type-Options']) {
    assert.equal(huvud(forsta, namn), huvud(andra, namn), `Huvudet ${namn} skiljer sig mellan sidorna.`);
  }
});
