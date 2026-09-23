/**
 * Stegen för kontrollrummet (features/styrning/). Allt går över rå HTTP till byggverktygets
 * riktiga API, precis som gränssnittet gör — inga genvägar förbi behörigheten.
 *
 * Två saker är värda att veta om scenarierna:
 *
 *   - Apparna byggs av Anna och Bertil med den inspelade språkmodellen, som här också rapporterar
 *     vad svaret kostade (`KOSTNAD`). Utan den rapporten vore varje app noll tokens, och
 *     scenariot om kostnaden skulle inte pröva någonting.
 *   - "Ser han appen" avgörs på appens FÖRKORTADE id. Applistan bär numera också hela id:t och
 *     adressen till appen, men prefixet är det som går att matcha mot en loggrad, och det som
 *     står i de övriga adminvyerna.
 */
import assert from 'node:assert/strict';
import { DataTable, Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX, isAppId } from '@vibesandbox/contracts';
import type { AdminApp, AdminFailedJob, AdminOverview, AdminStop, ApiErrorBody } from '@vibesandbox/contracts';
import { FORSTA_VERSIONEN, appMedRubrik } from './stod/byggkedja.ts';
import { jsonKropp } from './stod/http.ts';
import { DOMAN, dokumentlista } from './stod/varld.ts';
import type { AnropTillApp, Varld } from './stod/varld.ts';

/** Kontrollrummets två rutter, i den ordning När-steget hämtar dem. */
const OVERSIKT = `${BUILDER_API_PREFIX}/admin/oversikt`;
const APPAR = `${BUILDER_API_PREFIX}/admin/appar`;
const BYGGFEL = `${BUILDER_API_PREFIX}/admin/byggfel`;

/** Annas app, så att den kan anropas på sin egen adress som vilken app som helst. */
const ANNAS_APP = 'Annas app';

/**
 * Vad språkmodellen säger att bygget kostade, per person. Olika siffror för Anna och Bertil, så
 * att ett kontrollrum som blandar ihop apparna inte kan bli grönt av en slump.
 */
const KOSTNAD: Readonly<Record<string, { readonly inputTokens: number; readonly outputTokens: number }>> = {
  Anna: { inputTokens: 900, outputTokens: 100 },
  Bertil: { inputTokens: 400, outputTokens: 40 },
};

/** Det kontrollrummet visar av ett app-id. */
function forkortat(appId: string): string {
  return [...appId].slice(0, ADMIN_APP_ID_PREFIX_LENGTH).join('');
}

function oversikten(varld: Varld): AdminOverview {
  const svar = varld.svar[0];
  assert.ok(svar !== undefined, 'Kontrollrummet har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Översikten svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  return jsonKropp(svar) as AdminOverview;
}

function apparna(varld: Varld): readonly AdminApp[] {
  const svar = varld.svar[1];
  assert.ok(svar !== undefined, 'Kontrollrummets applista har inte hämtats i scenariot.');
  assert.equal(svar.status, 200, `Applistan svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { apps } = jsonKropp(svar) as { apps: AdminApp[] };
  assert.ok(Array.isArray(apps), 'Svaret från kontrollrummet innehåller ingen applista.');
  return apps;
}

/** Hämtar applistan på nytt — för steg som ska se listan utan att röra det senaste När-steget. */
async function hamtaAppar(varld: Varld, person: string): Promise<readonly AdminApp[]> {
  const { apps } = await varld.byggApi<{ apps: AdminApp[] }>(person, 'GET', '/admin/appar', 200);
  return apps;
}

/** Raden för en persons app, sökt på det förkortade id:t — det enda kontrollrummet lämnar ut. */
async function raden(varld: Varld, appar: readonly AdminApp[], namn: string): Promise<AdminApp> {
  const prefix = forkortat(await varld.byggapp(namn));
  const rad = appar.find((app) => app.appIdPrefix === prefix);
  assert.ok(rad !== undefined, `${namn}s app syns inte i kontrollrummet.`);
  return rad;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna|Bertil) har byggt en app i byggverktyget$/, async function (this: Varld, namn: string) {
  if (!this.personer.has(namn)) this.loggaInSomByggare(namn);
  const kostnad = KOSTNAD[namn];
  assert.ok(kostnad !== undefined, `Scenariot har ingen kostnad inspelad för ${namn}.`);
  this.sattModellsvar([{ text: appMedRubrik(FORSTA_VERSIONEN), usage: kostnad }]);
  const jobb = await this.bestall(namn, 'En lista där vi bokar mötesrum');
  assert.equal(jobb.status, 'done', `Förberedelsen misslyckades: ${namn}s app byggdes inte.`);
  this.modellanrop.length = 0;
});

Given(/^att (Anna|Bertil) har publicerat sin app$/, async function (this: Varld, namn: string) {
  await this.publiceraViaGranskning(namn);
});

Given(/^att (Erik) har sett (Anna)s app i kontrollrummet$/, async function (this: Varld, admin: string, agare: string) {
  await raden(this, await hamtaAppar(this, admin), agare);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil|Cecilia|Erik) öppnar kontrollrummet$/, async function (this: Varld, person: string) {
  this.svar = [
    await this.anropaByggverktyget({ person, sokvag: OVERSIKT }),
    await this.anropaByggverktyget({ person, sokvag: APPAR }),
    await this.anropaByggverktyget({ person, sokvag: BYGGFEL }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^någon som inte är inloggad öppnar kontrollrummet$/, async function (this: Varld) {
  this.svar = [await this.anropaByggverktyget({ sokvag: OVERSIKT }), await this.anropaByggverktyget({ sokvag: APPAR })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Erik) försöker gå in i (Anna)s app$/, async function (this: Varld, person: string, agare: string) {
  const appId = await this.byggapp(agare);
  assert.ok(isAppId(appId), `Byggverktyget gav ett app-id som inte följer kontraktet: ${appId}`);
  this.appar.set(ANNAS_APP, appId);
  // Varje väg in i appen: den publicerade sidan, dess data, och utkastets förhandsvisning.
  const anrop: AnropTillApp[] = [
    { app: ANNAS_APP, person },
    { app: ANNAS_APP, person, sokvag: dokumentlista('poster') },
    { app: ANNAS_APP, person, forhandsvisning: true },
  ];
  this.svar = [];
  for (const a of anrop) this.svar.push(await this.anropaApp(a));
  this.appanrop = anrop;
  this.svarFranByggverktyget = false;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(
  /^ser han (?:ändå )?både (Anna)s och (Bertil)s app, var och en med sin ägare$/,
  async function (this: Varld, forsta: string, andra: string) {
    const appar = apparna(this);
    for (const namn of [forsta, andra]) {
      const rad = await raden(this, appar, namn);
      assert.equal(rad.ownerEmail, this.epost(namn), `Kontrollrummet visar fel ägare till ${namn}s app.`);
    }
  },
);

Then(/^finns det inga andra appar i listan$/, function (this: Varld) {
  assert.equal(apparna(this).length, this.byggappar.size, 'Kontrollrummet visar ett annat antal appar än de som byggts.');
});

/**
 * Två vägar per app: arbetsytan i byggverktyget (som `appId` pekar ut — resten är en rutt i
 * gränssnittet) och appen som den körs. Prefixet står kvar bredvid det hela id:t: det är det man
 * läser för att känna igen en app, och det enda som står i en loggrad.
 *
 * Att vägarna finns säger ingenting om att de leder någonstans för den som klickar. Det prövar
 * scenariot "Länken i kontrollrummet är ingen nyckel", och det gör det på appens riktiga adress.
 */
Then(/^står det för varje app en väg till arbetsytan och en till appen som den körs$/, function (this: Varld) {
  const appar = apparna(this);
  assert.ok(appar.length > 0, 'Kontrollrummet är tomt — scenariot prövar då ingenting.');
  for (const app of appar) {
    assert.ok(isAppId(app.appId), `Kontrollrummet ger inget app-id att öppna arbetsytan med: ${app.appId}`);
    assert.equal(app.appIdPrefix, forkortat(app.appId), 'Det förkortade id:t hör inte ihop med det hela.');
    assert.ok(app.appUrl !== null, 'Kontrollrummet ger ingen adress till appen som den körs.');
    assert.ok(app.appUrl.includes(DOMAN), `Adressen till appen pekar någon annanstans än på plattformen: ${app.appUrl}`);
    assert.ok(app.appUrl.includes(app.appId), 'Adressen till appen pekar inte på den app raden gäller.');
  }
});

Then(/^visar översikten:$/, function (this: Varld, tabell: DataTable) {
  const oversikt = oversikten(this);
  const falt: Readonly<Record<string, number | undefined>> = {
    appar: oversikt.apps,
    publicerade: oversikt.published,
    utkast: oversikt.drafts,
  };
  for (const [namn = '', varde = ''] of tabell.raw()) {
    const faktiskt = falt[namn];
    assert.ok(faktiskt !== undefined, `Översikten räknar inte "${namn}". Kända rader: ${Object.keys(falt).join(', ')}.`);
    assert.equal(faktiskt, Number(varde), `Översikten säger ${faktiskt} ${namn}, inte ${varde}.`);
  }
});

Then(/^står det för varje app vad bygget av den kostat i tokens$/, async function (this: Varld) {
  const appar = apparna(this);
  for (const namn of this.byggappar.keys()) {
    const kostnad = KOSTNAD[namn];
    assert.ok(kostnad !== undefined, `Scenariot har ingen kostnad inspelad för ${namn}.`);
    const rad = await raden(this, appar, namn);
    assert.deepEqual(
      { input: rad.tokens.input, output: rad.tokens.output },
      { input: kostnad.inputTokens, output: kostnad.outputTokens },
      `Kontrollrummet visar fel kostnad för ${namn}s app.`,
    );
  }
});

Then(/^är översiktens summa lika med apparnas tillsammans$/, function (this: Varld) {
  const oversikt = oversikten(this);
  const appar = apparna(this);
  const summa = appar.reduce(
    (hittills, app) => ({ input: hittills.input + app.tokens.input, output: hittills.output + app.tokens.output }),
    { input: 0, output: 0 },
  );
  assert.deepEqual(
    { input: oversikt.tokens.input, output: oversikt.tokens.output },
    summa,
    'Översiktens summa stämmer inte med apparnas kostnader.',
  );
  assert.equal(oversikt.tokens.jobs, appar.length, 'Översikten räknar inte ett jobb per byggd app.');
});

Then(/^är (Erik)s egen applista i byggverktyget tom$/, async function (this: Varld, namn: string) {
  const { apps } = await this.byggApi<{ apps: unknown[] }>(namn, 'GET', '/apps', 200);
  assert.deepEqual(apps, [], `${namn} äger appar i byggverktyget — scenariot prövar då ingenting.`);
});

Then(/^kommer (Erik) inte in i (Anna)s app i byggverktyget heller$/, async function (this: Varld, person: string, agare: string) {
  const bas = `${BUILDER_API_PREFIX}/apps/${await this.byggapp(agare)}`;
  // Kontrollrummet ger insyn i att appen finns. Byggverktygets vanliga rutter gör det inte:
  // för den som inte äger appen finns den inte, och plattformsrollen ändrar ingenting.
  for (const sokvag of [bas, `${bas}/open?target=preview`, `${bas}/open?target=published`, `${bas}/members`]) {
    const svar = await this.anropaByggverktyget({ person, sokvag });
    assert.equal(svar.status, 404, `${sokvag} gav ${svar.status} för plattformens administratör.`);
    assert.equal((jsonKropp(svar) as ApiErrorBody).error?.code, 'not_found');
  }
});

Then(/^står (Anna)s app kvar i (Erik)s kontrollrum$/, async function (this: Varld, agare: string, admin: string) {
  await raden(this, await hamtaAppar(this, admin), agare);
});

// ── Bygg som gick fel ────────────────────────────────────────────────────────────

/** Det Anna bad om när bygget inte gick. Står här så att Så-stegen kan leta efter texten. */
const OMOJLIGT_ONSKEMAL = 'En sida som räknar ut lönen för varje anställd';

function byggfelen(varld: Varld): readonly AdminFailedJob[] {
  const svar = varld.svar[2];
  assert.ok(svar !== undefined, 'Kontrollrummets byggfel har inte hämtats i scenariot.');
  assert.equal(svar.status, 200, `Byggfelen svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const { jobs } = jsonKropp(svar) as { jobs: AdminFailedJob[] };
  assert.ok(Array.isArray(jobs), 'Svaret innehåller ingen lista över byggfel.');
  return jobs;
}

Given(/^att (Anna) bad om något som inte gick att bygga$/, async function (this: Varld, namn: string) {
  if (!this.personer.has(namn)) this.loggaInSomByggare(namn);
  // `BYGGFEL` i koden gör att den fejkade byggkedjan underkänner den, med ett riktigt diagnosfel.
  this.sattModellsvar([appMedRubrik('BYGGFEL')]);
  const jobb = await this.bestall(namn, OMOJLIGT_ONSKEMAL);
  assert.equal(jobb.status, 'failed', 'Förberedelsen prövar ingenting: bygget gick igenom.');
});

Given(/^att (Anna) bad om något som en röd linje stoppade$/, async function (this: Varld, namn: string) {
  if (!this.personer.has(namn)) this.loggaInSomByggare(namn);
  const jobb = await this.bestall(namn, 'Poängsätt alla elever efter hur de beter sig');
  assert.equal(jobb.status, 'failed', 'Förberedelsen prövar ingenting: önskemålet stoppades inte.');
});

Then(/^ser han (Anna)s misslyckade bygge med felet kontrollen gav$/, async function (this: Varld, agare: string) {
  const prefix = forkortat(await this.byggapp(agare));
  const rad = byggfelen(this).find((jobb) => jobb.appIdPrefix === prefix);
  assert.ok(rad !== undefined, `${agare}s misslyckade bygge syns inte i kontrollrummet.`);
  assert.equal(rad.ownerEmail, this.epost(agare), 'Raden pekar ut fel ägare.');
  assert.ok(rad.problems > 0, 'Raden säger att noll saker gick fel.');
  // Det support faktiskt behöver: vad kontrollen sa, med fil och rad.
  const fel = rad.diagnostics[0];
  assert.ok(fel !== undefined, 'Raden bär inga fel från kontrollen.');
  assert.equal(fel.source, 'typecheck');
  assert.equal(fel.file, 'src/App.tsx');
  assert.ok(fel.message.includes('BYGGFEL'), `Felet säger inte vad som var fel: ${fel.message}`);
});

Then(/^står (Anna)s önskemål ingenstans i kontrollrummet$/, function (this: Varld, _agare: string) {
  for (const svar of this.svar) {
    assert.ok(!svar.kropp.includes(OMOJLIGT_ONSKEMAL), 'Önskemålets text finns i kontrollrummet.');
    // Också de enskilda orden: en sammanfattning kunde bära dem utan att vara ordagrann.
    assert.ok(!svar.kropp.includes('anställd'), 'Ord ur önskemålet finns i kontrollrummet.');
  }
});

/**
 * Jämförelsen görs mot det agenten FAKTISKT skrev i det här jobbet, inte mot en sträng testet
 * hittat på. Ett påhittat ord kunde aldrig läcka, och steget skulle bli grönt utan att pröva
 * något; jobbets egna `status`- och `done`-meddelanden kan läcka, och är det som ska stoppas.
 */
Then(/^står agentens egna ord ingenstans i kontrollrummet$/, function (this: Varld) {
  const jobb = this.jobb;
  assert.ok(jobb !== undefined, 'Inget jobb i scenariot att jämföra med.');
  const orden = jobb.events
    .flatMap((h) => (h.type === 'status' || h.type === 'done' ? [h.message] : []))
    .filter((text) => text.length > 0);
  assert.ok(orden.length > 0, 'Agenten skrev inga egna ord — steget prövar ingenting.');
  for (const svar of this.svar) {
    for (const text of orden) {
      assert.ok(!svar.kropp.includes(text), `Agentens ord "${text.slice(0, 40)}" finns i kontrollrummet.`);
    }
  }
});

Then(/^finns det inga misslyckade bygg i listan$/, function (this: Varld) {
  assert.deepEqual(byggfelen(this), [], 'Kontrollrummet visar ett misslyckat bygge som inte borde stå där.');
});

Then(/^ser han stoppet i listan över stoppade önskemål$/, async function (this: Varld) {
  const { stops } = await this.byggApi<{ stops: AdminStop[] }>('Erik', 'GET', '/admin/stopp', 200);
  assert.ok(stops.length > 0, 'Stoppet syns inte i listan över stoppade önskemål.');
});
