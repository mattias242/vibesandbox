/**
 * Stegen för kontrollrummets adresslista (features/styrning/anvandare.feature). Allt som en
 * administratör gör går över rå HTTP till byggverktygets riktiga API, precis som gränssnittet gör.
 *
 * Tre saker är värda att veta om scenarierna:
 *
 *   - Den FÖRSTA administratören läggs in med identitetspaketets riktiga CLI, mot samma datakatalog
 *     som plattformen — det är vägen över SSH som egenskapen talar om, och den enda vägen in innan
 *     det finns någon administratör att bjuda in med.
 *   - Alla som scenariot loggar in efter en inbjudan får en inloggning UTAN roller. Inloggningen
 *     säger bara vem personen är; vad hen får göra ska avgöras av registret över vilka som får
 *     logga in. Annars skulle scenarierna om höjda och sänkta roller pröva testinloggningen i
 *     stället för plattformen.
 *   - Adresslistan hämtas alltid på nytt i Så-stegen, som administratör. Ett Så-steg ska se vad som
 *     FAKTISKT står i registret, inte vad ett svar råkade säga tidigare i scenariot.
 */
import assert from 'node:assert/strict';
import { DataTable, Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX, isAppId } from '@vibesandbox/contracts';
import type { AdminApp, AdminOverview, AdminUser, Role } from '@vibesandbox/contracts';
import { identityDataDirectory, listUsers, openIdentityDatabase, runIdentityCli } from '@vibesandbox/identity';
import { jsonKropp } from './stod/http.ts';
import type { Varld } from './stod/varld.ts';

const OVERSIKT = `${BUILDER_API_PREFIX}/admin/oversikt`;
const ANVANDARE = `${BUILDER_API_PREFIX}/admin/anvandare`;

/** Rollernas namn i verksamhetens språk → kontraktets. */
const ROLLER: Readonly<Record<string, Role>> = {
  administratör: 'admin',
  byggare: 'builder',
  läsare: 'viewer',
};

function rollen(namn: string): Role {
  const roll = ROLLER[namn];
  assert.ok(roll !== undefined, `Okänd roll "${namn}". Kända roller: ${Object.keys(ROLLER).join(', ')}.`);
  return roll;
}

/** Adresslistan som den ser ut NU, hämtad som administratör. */
async function adresslistan(varld: Varld): Promise<readonly AdminUser[]> {
  const { users } = await varld.byggApi<{ users: AdminUser[] }>('Erik', 'GET', '/admin/anvandare', 200);
  assert.ok(Array.isArray(users), 'Svaret från kontrollrummet innehåller ingen adresslista.');
  return users;
}

async function raden(varld: Varld, namn: string): Promise<AdminUser> {
  const epost = varld.epost(namn);
  const rad = (await adresslistan(varld)).find((användare) => användare.email === epost);
  assert.ok(rad !== undefined, `${namn}s adress finns inte i kontrollrummets adresslista.`);
  return rad;
}

/** Kontrollrummets applista, hämtad som administratör. */
async function apparna(varld: Varld): Promise<readonly AdminApp[]> {
  const { apps } = await varld.byggApi<{ apps: AdminApp[] }>('Erik', 'GET', '/admin/appar', 200);
  return apps;
}

/** Raden för en persons app, sökt på det förkortade id:t — det enda kontrollrummet ger ut. */
async function appraden(varld: Varld, namn: string): Promise<AdminApp> {
  const prefix = [...(await varld.byggapp(namn))].slice(0, ADMIN_APP_ID_PREFIX_LENGTH).join('');
  const rad = (await apparna(varld)).find((app) => app.appIdPrefix === prefix);
  assert.ok(rad !== undefined, `${namn}s app syns inte i kontrollrummet.`);
  return rad;
}

/** Översikten ur det senaste När-steget (`öppnar kontrollrummet` hämtar den först). */
function oversikten(varld: Varld): AdminOverview {
  const svar = varld.svar[0];
  assert.ok(svar !== undefined, 'Kontrollrummet har inte öppnats i scenariot.');
  assert.equal(svar.status, 200, `Översikten svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  return jsonKropp(svar) as AdminOverview;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

/**
 * Den första administratören: identitetspaketets CLI mot plattformens datakatalog, precis som när
 * någon loggar in på servern och kör kommandot. Id:t läses ur registret och blir hans inloggning —
 * annars vore den inloggade Erik en annan person än den Erik som står i registret.
 */
Given(/^att Erik lades in som administratör när plattformen sattes upp$/, async function (this: Varld) {
  const utskrift: string[] = [];
  const utfall = await runIdentityCli(['lagg-till', this.epost('Erik'), 'admin'], { DATA_DIR: this.dataDir }, {
    out: (rad) => utskrift.push(rad),
    err: (rad) => utskrift.push(rad),
  });
  assert.equal(utfall, 0, `Kommandot för att lägga in administratören misslyckades: ${utskrift.join(' ')}`);

  const db = openIdentityDatabase(identityDataDirectory(this.dataDir));
  try {
    const rad = listUsers(db).find((användare) => användare.email === this.epost('Erik'));
    assert.ok(rad !== undefined, 'Administratören står inte i registret efter kommandot.');
    this.anvandarIdn.set('Erik', rad.userId);
  } finally {
    db.close();
  }
  this.loggaIn('Erik', undefined, []);
});

Given(
  /^att Erik har bjudit in (Anna|Bertil|Cecilia) som (administratör|byggare|läsare)$/,
  async function (this: Varld, namn: string, roll: string) {
    const { user } = await this.byggApi<{ user: AdminUser }>('Erik', 'POST', '/admin/anvandare', 201, {
      email: this.epost(namn),
      role: rollen(roll),
    });
    // Inbjudan gav adressen ett konto. Personen loggar sedan in med just det kontot — annars vore
    // det någon annan — och utan roller i inloggningen: registret avgör vad hen får göra.
    this.anvandarIdn.set(namn, user.userId);
    if (!this.personer.has(namn)) this.loggaIn(namn, undefined, []);
  },
);

/**
 * En app vars ägaradress control inte har. Så ser en app ut som skapades innan driftregistret
 * började spara ägarens adress: byggverktyget vet vem som äger den (ett användar-id), control kan
 * inte svara på vad hen har för adress. Här åstadkoms det genom att ta bort appens rad i control.
 */
Given(/^att driftregistret tappat adressen till (Anna|Bertil)s app$/, async function (this: Varld, namn: string) {
  const appId = this.byggappar.get(namn);
  assert.ok(appId !== undefined && isAppId(appId), `${namn} har ingen app i byggverktyget i det här scenariot.`);
  await this.control.deleteApp(appId);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^Erik öppnar adresslistan i kontrollrummet$/, async function (this: Varld) {
  this.svar = [await this.anropaByggverktyget({ person: 'Erik', sokvag: ANVANDARE })];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^Erik bjuder in (Anna|Bertil|Cecilia) som (administratör|byggare|läsare)$/, async function (this: Varld, namn: string, roll: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person: 'Erik',
      metod: 'POST',
      sokvag: ANVANDARE,
      json: { email: this.epost(namn), role: rollen(roll) },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

/** Rollen sätts rakt av — den enda vägen att SÄNKA. Ett Givet-liknande När: det ska lyckas. */
When(/^Erik sätter (Anna|Bertil|Cecilia)s roll till (administratör|byggare|läsare)$/, async function (this: Varld, namn: string, roll: string) {
  await this.byggApi('Erik', 'POST', `/admin/anvandare/${this.anvandarId(namn)}`, 200, { role: rollen(roll) });
});

When(/^Erik försöker sätta sin egen roll till (byggare|läsare)$/, async function (this: Varld, roll: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person: 'Erik',
      metod: 'POST',
      sokvag: `${ANVANDARE}/${this.anvandarId('Erik')}`,
      json: { role: rollen(roll) },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

/** Båda vägarna att ändra registret: att bjuda in någon ny, och att sätta någons roll. */
When(/^(Anna) försöker ändra vem som får logga in$/, async function (this: Varld, person: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person,
      metod: 'POST',
      sokvag: ANVANDARE,
      json: { email: this.epost('Cecilia'), role: 'builder' },
    }),
    await this.anropaByggverktyget({
      person,
      metod: 'POST',
      sokvag: `${ANVANDARE}/${this.anvandarId('Bertil')}`,
      json: { role: 'admin' },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Bertil) ber om en ändring i sin app$/, async function (this: Varld, person: string) {
  const appId = this.byggappar.get(person);
  assert.ok(appId !== undefined, `${person} har ingen app i byggverktyget i det här scenariot.`);
  this.svar = [
    await this.anropaByggverktyget({
      person,
      metod: 'POST',
      sokvag: `${BUILDER_API_PREFIX}/apps/${appId}/messages`,
      json: { text: 'Lägg till en kolumn för vem som bokade' },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(
  /^står (Anna|Bertil|Cecilia|Erik) (?:kvar )?som (administratör|byggare|läsare) i adresslistan$/,
  async function (this: Varld, namn: string, roll: string) {
    const rad = await raden(this, namn);
    assert.equal(rad.role, rollen(roll), `${namn} står som ${rad.role} i adresslistan, inte som ${roll}.`);
  },
);

Then(/^är Eriks egen rad markerad som hans egen$/, async function (this: Varld) {
  const lista = await adresslistan(this);
  const egen = lista.filter((användare) => användare.self);
  assert.equal(egen.length, 1, `${egen.length} rader är markerade som den egna; det ska vara exakt en.`);
  assert.equal(egen[0]?.email, this.epost('Erik'), 'Fel rad är markerad som administratörens egen.');
});

Then(/^finns det inga andra adresser i listan$/, async function (this: Varld) {
  const vantade = [...this.anvandarIdn.keys()].map((namn) => this.epost(namn)).sort();
  const faktiska = (await adresslistan(this)).map((användare) => användare.email).sort();
  assert.deepEqual(faktiska, vantade, 'Adresslistan innehåller andra adresser än de scenariot lagt in.');
});

Then(/^saknas (Anna|Bertil|Cecilia)s adress i adresslistan$/, async function (this: Varld, namn: string) {
  const epost = this.epost(namn);
  const lista = await adresslistan(this);
  assert.ok(!lista.some((användare) => användare.email === epost), `${namn}s adress står i adresslistan.`);
});

Then(/^kommer (Erik) fortfarande in i kontrollrummet$/, async function (this: Varld, person: string) {
  const svar = await this.anropaByggverktyget({ person, sokvag: OVERSIKT });
  assert.equal(svar.status, 200, `${person} nekas kontrollrummet: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

Then(/^räknar översikten adresserna:$/, function (this: Varld, tabell: DataTable) {
  const { users } = oversikten(this);
  const falt: Readonly<Record<string, number | undefined>> = {
    administratörer: users?.admin,
    byggare: users?.builder,
    läsare: users?.viewer,
  };
  for (const [namn = '', varde = ''] of tabell.raw()) {
    const faktiskt = falt[namn];
    assert.ok(faktiskt !== undefined, `Översikten räknar inte "${namn}". Kända rader: ${Object.keys(falt).join(', ')}.`);
    assert.equal(faktiskt, Number(varde), `Översikten säger ${faktiskt} ${namn}, inte ${varde}.`);
  }
});

Then(/^finns (Anna|Bertil)s app kvar i kontrollrummet$/, async function (this: Varld, namn: string) {
  await appraden(this, namn);
});

Then(/^står (Anna|Bertil)s adress vid hennes app i kontrollrummet$/, async function (this: Varld, namn: string) {
  const rad = await appraden(this, namn);
  assert.equal(rad.ownerEmail, this.epost(namn), `Kontrollrummet visar fel ägare till ${namn}s app.`);
});

Then(/^står ingen adress vid (Anna|Bertil)s app i kontrollrummet$/, async function (this: Varld, namn: string) {
  const rad = await appraden(this, namn);
  assert.equal(rad.ownerEmail, null, `Kontrollrummet visar en adress till ${namn}s app trots att ingen finns.`);
});

Then(/^nämns (Anna|Bertil|Cecilia)s adress ingenstans i kontrollrummet$/, async function (this: Varld, namn: string) {
  const epost = this.epost(namn);
  const kroppar = [
    ...this.svar.map((svar) => svar.kropp),
    JSON.stringify(await apparna(this)),
    JSON.stringify(await adresslistan(this)),
  ].join('\n');
  assert.ok(!kroppar.includes(epost), `${namn}s adress står i kontrollrummet trots att plattformen inte känner den.`);
});

Then(/^nämns ingen av adresserna i driftloggarna$/, function (this: Varld) {
  assert.ok(this.loggrader.length > 0, 'Plattformen har inte loggat något alls — scenariot prövar då ingenting.');
  const loggen = this.loggrader.join('\n');
  for (const namn of this.personer.keys()) {
    assert.ok(!loggen.includes(this.epost(namn)), `${namn}s adress står i en driftlogg.`);
  }
});
