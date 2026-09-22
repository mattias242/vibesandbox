/**
 * Stegen för avveckling och export (features/livscykel/avveckling.feature). Allt går över rå HTTP
 * till byggverktygets riktiga API och till appens riktiga adress — ingenting fejkas.
 *
 * Två saker är värda att veta om scenarierna:
 *
 *   - Raderna sparas i den PUBLICERADE appen, på dess egen adress, som vilken användare som helst
 *     gör. Det är den hyresgästen exporten läser; förhandsvisningen har en egen databas med
 *     testmaterial som med flit inte följer med (se `AppExport` i kontraktet).
 *   - "Finns appen kvar för Anna" prövas mot byggverktyget, och "svarar adressen" mot appens egen
 *     värd. En avveckling som bara gjorde det ena är precis det ett gallringsbevis inte får ljuga om.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { BUILDER_API_PREFIX, isAppId } from '@vibesandbox/contracts';
import type { AdminRegisterEntry, AppExport, AppId, BuilderAppSummary, DecommissionEvidence } from '@vibesandbox/contracts';
import { jsonKropp } from './stod/http.ts';
import { dokumentlista } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

/** App-id ur byggverktyget, prövat innan det används som adress. */
function somAppId(value: string): AppId {
  assert.ok(isAppId(value), 'Byggverktyget gav ett app-id med fel format.');
  return value;
}

/** Kollektionen scenarierna sparar i när de inte säger något annat. */
const KOLLEKTION = 'anteckningar';
const EGEN_KOLLEKTION = 'mina-svar';

function exportSokvag(appId: string): string {
  return `${BUILDER_API_PREFIX}/apps/${appId}/export`;
}

function avvecklaSokvag(appId: string): string {
  return `${BUILDER_API_PREFIX}/apps/${appId}/avveckla`;
}

/** Exporten ur det senaste När-steget. */
function exporten(varld: Varld): AppExport {
  const svar = varld.svar[0];
  assert.ok(svar !== undefined, 'Exporten har inte hämtats i scenariot.');
  assert.equal(svar.status, 200, `Exporten svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  return jsonKropp(svar) as AppExport;
}

/** Alla dokument i exporten, oavsett kollektion. */
function radernaIExporten(exp: AppExport): readonly Record<string, unknown>[] {
  return Object.values(exp.collections).flatMap((k) => [...k.documents]) as Record<string, unknown>[];
}

/** Sparar en rad i en persons PUBLICERADE app, på appens egen adress. */
async function sparaIAppen(varld: Varld, person: string, agare: string, kollektion: string, personlig: boolean, data: Record<string, unknown>): Promise<void> {
  const appId = somAppId(await varld.byggapp(agare));
  const svar = await varld.anropaApp({
    app: agare,
    appId,
    person,
    metod: 'POST',
    sokvag: dokumentlista(kollektion, personlig ? 'user' : undefined),
    json: { data },
  });
  assert.equal(svar.status, 201, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
}

/** Orden i en text som är långa nog att vara igenkännliga om de skulle läcka. */
function igenkannligaOrd(text: string): readonly string[] {
  return text.split(/[^\p{L}\p{N}-]+/u).filter((ord) => [...ord].length >= 6);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna) har sparat två rader i sin app$/, async function (this: Varld, person: string) {
  await sparaIAppen(this, person, person, KOLLEKTION, false, { titel: 'Första raden' });
  await sparaIAppen(this, person, person, KOLLEKTION, false, { titel: 'Andra raden' });
});

Given(/^att (Anna) har sparat en rad med texten "([^"]+)" i sin app$/, async function (this: Varld, person: string, text: string) {
  await sparaIAppen(this, person, person, KOLLEKTION, false, { titel: text });
});

Given(
  /^att (Anna|Bertil) har sparat en egen rad i (?:en kollektion som är var och ens egen|samma kollektion)$/,
  async function (this: Varld, person: string) {
    await sparaIAppen(this, person, 'Anna', EGEN_KOLLEKTION, true, { svar: `${person}s eget svar` });
  },
);

Given(/^att (Anna) har avvecklat appen$/, async function (this: Varld, person: string) {
  const app = await this.byggApi<BuilderAppSummary>(person, 'GET', `/apps/${await this.byggapp(person)}`, 200);
  await this.byggApi(person, 'POST', `/apps/${await this.byggapp(person)}/avveckla`, 200, { confirm: app.name });
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna) hämtar ut appens innehåll$/, async function (this: Varld, person: string) {
  this.svar = [await this.anropaByggverktyget({ person, sokvag: exportSokvag(await this.byggapp(person)) })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Anna) avvecklar appen med dess namn$/, async function (this: Varld, person: string) {
  const appId = await this.byggapp(person);
  const app = await this.byggApi<BuilderAppSummary>(person, 'GET', `/apps/${appId}`, 200);
  this.svar = [
    await this.anropaByggverktyget({ person, sokvag: avvecklaSokvag(appId), metod: 'POST', json: { confirm: app.name } }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Anna) försöker avveckla appen med namnet "([^"]+)"$/, async function (this: Varld, person: string, namn: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person,
      sokvag: avvecklaSokvag(await this.byggapp(person)),
      metod: 'POST',
      json: { confirm: namn },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

/** En kryssruta är inget namn. `true` är precis det som klickas bort utan att läsas. */
When(/^(Anna) försöker avveckla appen med en kryssruta i stället för namnet$/, async function (this: Varld, person: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person,
      sokvag: avvecklaSokvag(await this.byggapp(person)),
      metod: 'POST',
      json: { confirm: true },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Bertil|Erik) försöker avveckla (Anna)s app med dess namn$/, async function (this: Varld, person: string, agare: string) {
  const appId = await this.byggapp(agare);
  const app = await this.byggApi<BuilderAppSummary>(agare, 'GET', `/apps/${appId}`, 200);
  this.svar = [
    await this.anropaByggverktyget({ person, sokvag: avvecklaSokvag(appId), metod: 'POST', json: { confirm: app.name } }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^innehåller exporten båda raderna$/, function (this: Varld) {
  const rader = radernaIExporten(exporten(this));
  assert.equal(rader.length, 2, `Exporten innehåller ${rader.length} rader, inte 2.`);
  const titlar = rader.map((r) => r['titel']).sort();
  assert.deepEqual(titlar, ['Andra raden', 'Första raden']);
});

Then(/^innehåller exporten bara (Anna)s egen rad$/, function (this: Varld, person: string) {
  const rader = radernaIExporten(exporten(this));
  // Synligheten gäller ÄVEN i en export. Annars vore hela regeln som skiljer kollegors svar åt
  // upphävd av ett anrop med ett annat namn.
  assert.equal(rader.length, 1, `Exporten innehåller ${rader.length} rader — den ger andras svar.`);
  assert.equal(rader[0]?.['svar'], `${person}s eget svar`);
  const svar = this.svar[0];
  assert.ok(svar !== undefined && !svar.ratt.includes('Bertils eget svar'), 'Exporten bär någon annans rad.');
});

Then(/^står appens namn och känslighetsnivå i exporten$/, async function (this: Varld) {
  const exp = exporten(this);
  const app = await this.byggApi<BuilderAppSummary>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.equal(exp.app.name, app.name, 'Exporten bär inte appens namn.');
  assert.ok(typeof exp.app.classification === 'string' && exp.app.classification.length > 0, 'Exporten saknar känslighetsnivå.');
  assert.ok(typeof exp.app.classificationSource === 'string', 'Exporten säger inte hur nivån sattes.');
});

Then(/^finns samtalet som byggde appen med i exporten$/, function (this: Varld) {
  const exp = exporten(this);
  assert.ok(exp.conversation.length > 0, 'Exporten saknar samtalet.');
  // Samtalet hör till handlingen: det visar VARFÖR appen ser ut som den gör.
  assert.ok(exp.conversation.some((m) => m.role === 'user'), 'Exporten saknar det som beställdes.');
});

Then(/^är exporten tom men fullständig$/, function (this: Varld) {
  const exp = exporten(this);
  assert.deepEqual(radernaIExporten(exp), [], 'Exporten innehåller rader trots att appen är tom.');
  // Tom är inte trasig: formatet, tidpunkten och appens uppgifter ska ändå finnas.
  assert.equal(exp.format, 1);
  assert.ok(!Number.isNaN(Date.parse(exp.exportedAt)), 'Exporten saknar en läsbar tidpunkt.');
  assert.ok(exp.app.name.length > 0, 'Exporten saknar appens namn.');
});

Then(/^finns appen inte längre för (Anna)$/, async function (this: Varld, person: string) {
  const appId = await this.byggapp(person);
  const svar = await this.anropaByggverktyget({ person, sokvag: `${BUILDER_API_PREFIX}/apps/${appId}` });
  assert.equal(svar.status, 404, `Appen svarar fortfarande ${svar.status} i byggverktyget.`);
  const { apps } = await this.byggApi<{ apps: BuilderAppSummary[] }>(person, 'GET', '/apps', 200);
  assert.ok(!apps.some((a) => a.appId === appId), 'Appen står kvar i ägarens lista.');
});

Then(/^finns appen kvar för (Anna)$/, async function (this: Varld, person: string) {
  const appId = await this.byggapp(person);
  const svar = await this.anropaByggverktyget({ person, sokvag: `${BUILDER_API_PREFIX}/apps/${appId}` });
  assert.equal(svar.status, 200, `Appen svarar ${svar.status} — den togs bort trots att den inte skulle det.`);
});

Then(/^svarar appens adress inte längre$/, async function (this: Varld) {
  const appId = somAppId(await this.byggapp('Anna'));
  const svar = await this.anropaApp({ app: 'Anna', appId, person: 'Anna', sokvag: '/' });
  assert.ok(svar.status === 404 || svar.status === 303, `Appens adress svarar fortfarande ${svar.status}.`);
});

Then(/^står det i gallringsbeviset att två rader raderades$/, function (this: Varld) {
  const svar = this.svar[0];
  assert.ok(svar !== undefined && svar.status === 200, 'Avvecklingen gick inte igenom.');
  const { evidence } = jsonKropp(svar) as { evidence: DecommissionEvidence };
  assert.equal(evidence.documentsDeleted, 2, `Beviset säger ${evidence.documentsDeleted} rader, inte 2.`);
  assert.ok(!Number.isNaN(Date.parse(evidence.decommissionedAt)), 'Beviset saknar en läsbar tidpunkt.');
});

Then(/^står (Anna)s app kvar i registret som avvecklad$/, async function (this: Varld, person: string) {
  const rad = await registerraden(this, person);
  assert.ok(rad.decommissionedAt !== null, 'Registret visar inte att appen är avvecklad.');
  assert.equal(rad.published, false, 'Registret säger att en avvecklad app är publicerad.');
});

Then(/^står det när den avvecklades$/, async function (this: Varld) {
  const rad = await registerraden(this, 'Anna');
  assert.ok(rad.decommissionedAt !== null && !Number.isNaN(Date.parse(rad.decommissionedAt)), 'Tidpunkten går inte att läsa.');
});

Then(/^står appens känslighetsnivå kvar$/, async function (this: Varld) {
  const rad = await registerraden(this, 'Anna');
  // Uppgifterna i appen är raderade. Att den har funnits och hur känslig den var är kvar — det är
  // just det en tillsyn frågar efter.
  assert.ok(typeof rad.classification === 'string' && rad.classification.length > 0, 'Registret tappade nivån.');
  assert.ok(typeof rad.source === 'string' && rad.source.length > 0, 'Registret tappade hur nivån sattes.');
});

Then(/^står gallringsbeviset i driftloggarna$/, function (this: Varld) {
  assert.ok(this.loggrader.join('\n').includes('app_decommissioned'), 'Avvecklingen loggades inte alls.');
});

Then(/^nämns inget av texten "([^"]+)" i driftloggarna$/, function (this: Varld, text: string) {
  assert.ok(this.loggrader.length > 0, 'Plattformen har inte loggat något alls — scenariot prövar då ingenting.');
  const loggen = this.loggrader.join('\n');
  assert.ok(!loggen.includes(text), 'Innehållet står i en driftlogg.');
  for (const ord of igenkannligaOrd(text)) {
    assert.ok(!loggen.includes(ord), `Ordet "${ord}" ur innehållet står i en driftlogg.`);
  }
});

/** Registerraden för en persons app, hämtad som administratör. */
async function registerraden(varld: Varld, person: string): Promise<AdminRegisterEntry> {
  const appId = await varld.byggapp(person);
  const { entries } = await varld.byggApi<{ entries: AdminRegisterEntry[] }>('Erik', 'GET', '/admin/register', 200);
  const rad = entries.find((e) => appId.startsWith(e.appIdPrefix));
  assert.ok(rad !== undefined, `${person}s app syns inte i AI-registret.`);
  return rad;
}
