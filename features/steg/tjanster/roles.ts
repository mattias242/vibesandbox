/**
 * Steg för tjänsten `roles` (features/tjanster/roles.feature). Allt går över rå HTTP mot en
 * riktig plattform med tjänsten påslagen (`@tjanst-roles`); medlemskapet ändras i control, som
 * byggverktyget gör. Tjänsten behöver inga egna inställningar och inga fejkar.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { DocumentPage } from '@vibesandbox/contracts';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { dokumentlista } from '../stod/varld.ts';
import type { Varld } from '../stod/varld.ts';

interface Medlem {
  readonly userId: string;
  readonly displayName: string;
  readonly access: 'owner' | 'user';
  readonly roles: readonly string[];
}

/** Appen scenariot handlar om ("appen") — den som Anna äger och delat, inte en andra app. */
const HUVUDAPP = new WeakMap<Varld, string>();

function appen(varld: Varld): string {
  const app = HUVUDAPP.get(varld);
  assert.ok(app !== undefined, 'Scenariot har ingen app med roller.');
  return app;
}

interface RollAnrop {
  readonly person: string;
  readonly metod?: string;
  readonly vag: string;
  readonly json?: unknown;
  readonly forhandsvisning?: boolean;
  readonly app?: string;
}

function roller(varld: Varld, anrop: RollAnrop): Promise<Svar> {
  return varld.anropaApp({
    app: anrop.app ?? appen(varld),
    person: anrop.person,
    metod: anrop.metod ?? 'GET',
    sokvag: `/_api/roles${anrop.vag}`,
    ...(anrop.json === undefined ? {} : { json: anrop.json }),
    ...(anrop.forhandsvisning === true ? { forhandsvisning: true } : {}),
  });
}

function kravOk(svar: Svar, vad: string): unknown {
  assert.equal(svar.status, 200, `${vad} misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  return jsonKropp(svar);
}

function definitioner(ids: readonly string[]): { id: string; name: string }[] {
  return ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
}

async function infor(varld: Varld, ids: readonly string[], forhandsvisning = false): Promise<Svar> {
  const svar = await roller(varld, { person: 'Anna', metod: 'PUT', vag: '/definitions', json: definitioner(ids), forhandsvisning });
  kravOk(svar, 'Att införa roller');
  return svar;
}

async function ge(varld: Varld, person: string, roll: string): Promise<Svar> {
  const userId = varld.person(person).identitet.userId;
  const svar = await roller(varld, { person: 'Anna', metod: 'PUT', vag: `/members/${encodeURIComponent(userId)}`, json: { roles: [roll] } });
  kravOk(svar, 'Att ge en roll');
  return svar;
}

async function minaRoller(varld: Varld, person: string): Promise<readonly string[]> {
  const jag = kravOk(await roller(varld, { person, vag: '/me' }), 'Att fråga vem man är') as { userId: string; roles: string[] };
  assert.equal(jag.userId, varld.person(person).identitet.userId);
  return jag.roles;
}

function medlemslista(varld: Varld): readonly Medlem[] {
  return kravOk(varld.endaSvaret(), 'Att hämta medlemmarna') as Medlem[];
}

function medlem(varld: Varld, person: string): Medlem | undefined {
  const userId = varld.person(person).identitet.userId;
  return medlemslista(varld).find((m) => m.userId === userId);
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att Anna äger appen "([^"]+)" och har delat den med Bertil och Cecilia$/, async function (this: Varld, app: string) {
  // `publicera` gör Anna till ägare och alla som loggat in (och fått apparna) till användare.
  for (const namn of ['Anna', 'Bertil', 'Cecilia']) {
    this.loggaIn(namn);
    await this.gePubliceradeAppar(namn);
  }
  await this.publicera(app);
  HUVUDAPP.set(this, app);
});

Given(/^att Anna har infört rollerna "([^"]+)" och "([^"]+)"$/, async function (this: Varld, forsta: string, andra: string) {
  await infor(this, [forsta, andra]);
});

Given(/^att Anna har gett (Bertil|Cecilia) rollen "([^"]+)"$/, async function (this: Varld, person: string, roll: string) {
  await ge(this, person, roll);
});

Given(/^att appen "([^"]+)" har ett utkast$/, async function (this: Varld, app: string) {
  await this.sattUtkast(app);
});

Given(/^att Anna också äger appen "([^"]+)"$/, async function (this: Varld, app: string) {
  await this.publicera(app);
});

Given(/^att Anna har sparat ett dokument i appens gemensamma kollektion "([^"]+)"$/, async function (this: Varld, kollektion: string) {
  await this.sparaDokument('Anna', appen(this), kollektion, false, { visa: 'bara för admin' });
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^Anna inför rollerna "([^"]+)" och "([^"]+)"( i förhandsvisningen)?$/, async function (this: Varld, forsta: string, andra: string, forhandsvisning?: string | null) {
  // En valfri grupp som inte matchade kommer som tom sträng eller null, inte som undefined.
  this.svar = [await infor(this, [forsta, andra], typeof forhandsvisning === 'string' && forhandsvisning.length > 0)];
});

When(/^Anna ger (Bertil|Cecilia) rollen "([^"]+)"$/, async function (this: Varld, person: string, roll: string) {
  this.svar = [await ge(this, person, roll)];
});

When(/^(Anna|Bertil) hämtar appens medlemmar$/, async function (this: Varld, person: string) {
  this.svar = [await roller(this, { person, vag: '/members' })];
});

When(/^(Bertil) försöker införa rollen "([^"]+)"$/, async function (this: Varld, person: string, roll: string) {
  this.svar = [await roller(this, { person, metod: 'PUT', vag: '/definitions', json: definitioner([roll]) })];
});

When(/^(Bertil) försöker ge sig själv rollen "([^"]+)"$/, async function (this: Varld, person: string, roll: string) {
  const userId = this.person(person).identitet.userId;
  this.svar = [await roller(this, { person, metod: 'PUT', vag: `/members/${encodeURIComponent(userId)}`, json: { roles: [roll] } })];
});

When(/^Anna försöker ge (Bertil) rollen "([^"]+)"$/, async function (this: Varld, person: string, roll: string) {
  const userId = this.person(person).identitet.userId;
  this.svar = [await roller(this, { person: 'Anna', metod: 'PUT', vag: `/members/${encodeURIComponent(userId)}`, json: { roles: [roll] } })];
});

When(/^Anna försöker ge rollen "([^"]+)" till någon som inte är medlem i appen$/, async function (this: Varld, roll: string) {
  // Ett id som ser ut som en riktig användares, och en person som finns på plattformen men inte i appen.
  this.loggaIn('David');
  const utanfor = [this.person('David').identitet.userId, 'anv-okand'];
  this.svar = await Promise.all(
    utanfor.map((userId) => roller(this, { person: 'Anna', metod: 'PUT', vag: `/members/${encodeURIComponent(userId)}`, json: { roles: [roll] } })),
  );
});

When(/^(Bertil) tas bort ur appen$/, async function (this: Varld, person: string) {
  await this.control.revokeAccess(this.appId(appen(this)), this.person(person).identitet.userId);
});

When(/^Anna frågar appen "([^"]+)" vilka roller den har$/, async function (this: Varld, app: string) {
  this.svar = [await roller(this, { person: 'Anna', vag: '/definitions', app })];
});

When(
  /^(Bertil), som inte har rollen "([^"]+)", listar kollektionen "([^"]+)"$/,
  async function (this: Varld, person: string, roll: string, kollektion: string) {
    assert.ok(!(await minaRoller(this, person)).includes(roll), `${person} har rollen ${roll}; scenariot prövar då ingenting.`);
    this.svar = [await this.anropaApp({ app: appen(this), person, sokvag: dokumentlista(kollektion) })];
  },
);

When(/^Anna försöker införa en roll med id "([^"]*)"$/, async function (this: Varld, id: string) {
  this.svar = [await roller(this, { person: 'Anna', metod: 'PUT', vag: '/definitions', json: [{ id, name: 'Roll' }] })];
});

When(/^Anna försöker införa (\d+) roller$/, async function (this: Varld, antal: string) {
  const ids = Array.from({ length: Number(antal) }, (_, i) => `roll-${i + 1}`);
  this.svar = [await roller(this, { person: 'Anna', metod: 'PUT', vag: '/definitions', json: definitioner(ids) })];
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^ser (Bertil) att appen har rollerna "([^"]+)" och "([^"]+)"$/, async function (this: Varld, person: string, forsta: string, andra: string) {
  const defs = kravOk(await roller(this, { person, vag: '/definitions' }), 'Att hämta rollerna') as { id: string }[];
  assert.deepEqual(
    defs.map((d) => d.id),
    [forsta, andra],
  );
});

Then(
  /^har (Bertil|Cecilia) rollen "([^"]+)" när (?:han|hon) frågar appen vem (?:han|hon) är$/,
  async function (this: Varld, person: string, roll: string) {
    assert.deepEqual(await minaRoller(this, person), [roll]);
  },
);

Then(/^har (Bertil|Cecilia) inga roller när (?:han|hon) frågar appen vem (?:han|hon) är$/, async function (this: Varld, person: string) {
  assert.deepEqual(await minaRoller(this, person), []);
});

Then(/^är Anna ägare, och Bertil och Cecilia användare, i listan$/, function (this: Varld) {
  assert.equal(medlem(this, 'Anna')?.access, 'owner');
  assert.equal(medlem(this, 'Bertil')?.access, 'user');
  assert.equal(medlem(this, 'Cecilia')?.access, 'user');
  assert.equal(medlemslista(this).length, 3);
  // Namnet att visa är adressens lokala del — samma som appen får av whoami.
  assert.equal(medlem(this, 'Bertil')?.displayName, 'bertil');
});

Then(/^har (Cecilia) rollen "([^"]+)" i listan$/, function (this: Varld, person: string, roll: string) {
  assert.deepEqual(medlem(this, person)?.roles, [roll]);
});

Then(/^innehåller listan inga e-postadresser$/, function (this: Varld) {
  const svar = this.endaSvaret();
  for (const namn of ['Anna', 'Bertil', 'Cecilia']) {
    assert.ok(!svar.ratt.includes(this.epost(namn)), `Svaret innehåller ${namn}s adress.`);
  }
  assert.ok(!svar.kropp.includes('@'), 'Svaret innehåller något som liknar en e-postadress.');
});

Then(/^finns (Bertil) inte i listan$/, function (this: Varld, person: string) {
  assert.equal(medlem(this, person), undefined);
});

Then(/^har ingen i listan rollen "([^"]+)"$/, function (this: Varld, roll: string) {
  assert.ok(medlemslista(this).every((m) => !m.roles.includes(roll)), `Någon har fortfarande rollen ${roll}.`);
});

Then(/^har appen inga roller$/, function (this: Varld) {
  assert.deepEqual(kravOk(this.endaSvaret(), 'Att hämta rollerna'), []);
});

Then(/^ser han Annas dokument$/, function (this: Varld) {
  const sida = kravOk(this.endaSvaret(), 'Listningen') as DocumentPage;
  const annas = this.senastSparat.get('Anna');
  assert.ok(annas !== undefined, 'Anna har inte sparat något dokument.');
  assert.ok(
    sida.documents.some((d) => d.id === annas.id),
    'Bertil ser inte Annas dokument.',
  );
});
