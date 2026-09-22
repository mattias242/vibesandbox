/**
 * Stegen för appens namn (features/bygga/namn.feature). Allt går över rå HTTP till byggverktygets
 * riktiga API, precis som gränssnittet gör.
 *
 * Två saker skiljer scenarierna åt, och det är hela poängen med egenskapen:
 *
 *   - Ett namn ÄGAREN skrivit följer med till kontrollrummet. Det är hennes val om vad appen är.
 *   - Ett namn PLATTFORMEN skrivit av ur det första önskemålet gör det inte. Där står "Namnlös
 *     app" i stället, och Så-stegen prövar dessutom att önskemålets egna ord inte slunkit med på
 *     något annat sätt.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { ADMIN_APP_ID_PREFIX_LENGTH, BUILDER_API_PREFIX } from '@vibesandbox/contracts';
import type { AdminApp, BuilderAppSummary } from '@vibesandbox/contracts';
import type { Varld } from './stod/varld.ts';

/** Det önskemål Annas app byggs av i den här egenskapen — se `bygga.ts`. */
const ONSKEMALET = 'En lista där vi bokar mötesrum';

/** Ord ur önskemålet som är långa nog att vara igenkännliga om de skulle läcka. */
const IGENKANNLIGA = ONSKEMALET.split(/\s+/u).filter((ord) => [...ord].length >= 5);

async function dopOm(varld: Varld, person: string, namn: string, status: number): Promise<void> {
  const svar = await varld.anropaByggverktyget({
    person,
    sokvag: `${BUILDER_API_PREFIX}/apps/${await varld.byggapp(person)}/namn`,
    metod: 'POST',
    json: { name: namn },
  });
  assert.equal(svar.status, status, `Omdöpningen svarade ${svar.status}: ${svar.kropp.slice(0, 200)}`);
}

/** Appen som ägaren ser den i sin egen lista — inte via detaljvyn, utan där namnet faktiskt visas. */
async function iListan(varld: Varld, person: string): Promise<BuilderAppSummary> {
  const { apps } = await varld.byggApi<{ apps: BuilderAppSummary[] }>(person, 'GET', '/apps', 200);
  const appId = await varld.byggapp(person);
  const rad = apps.find((app) => app.appId === appId);
  assert.ok(rad !== undefined, `${person}s app syns inte i hennes egen lista.`);
  return rad;
}

/** Raden för en persons app i kontrollrummet, sökt på det förkortade id:t. */
async function iKontrollrummet(varld: Varld, agare: string, admin: string): Promise<AdminApp> {
  const { apps } = await varld.byggApi<{ apps: AdminApp[] }>(admin, 'GET', '/admin/appar', 200);
  const prefix = [...(await varld.byggapp(agare))].slice(0, ADMIN_APP_ID_PREFIX_LENGTH).join('');
  const rad = apps.find((app) => app.appIdPrefix === prefix);
  assert.ok(rad !== undefined, `${agare}s app syns inte i kontrollrummet.`);
  return rad;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna) har döpt appen till "([^"]+)"$/, async function (this: Varld, person: string, namn: string) {
  await dopOm(this, person, namn, 200);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna) döper appen till "([^"]*)"$/, async function (this: Varld, person: string, namn: string) {
  await dopOm(this, person, namn, 200);
});

When(/^(Anna) försöker döpa appen till "([^"]*)"$/, async function (this: Varld, person: string, namn: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person,
      sokvag: `${BUILDER_API_PREFIX}/apps/${await this.byggapp(person)}/namn`,
      metod: 'POST',
      json: { name: namn },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

When(/^(Bertil) försöker döpa om (Anna)s app$/, async function (this: Varld, person: string, agare: string) {
  this.svar = [
    await this.anropaByggverktyget({
      person,
      sokvag: `${BUILDER_API_PREFIX}/apps/${await this.byggapp(agare)}/namn`,
      metod: 'POST',
      json: { name: 'Bertils lista' },
    }),
  ];
  this.appanrop = [];
  this.svarFranByggverktyget = true;
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^heter appen "([^"]+)" i (Anna)s lista$/, async function (this: Varld, namn: string, person: string) {
  assert.equal((await iListan(this, person)).name, namn, 'Appen heter något annat i ägarens egen lista.');
});

Then(/^står (Anna)s app som "([^"]+)" i kontrollrummet$/, async function (this: Varld, agare: string, namn: string) {
  assert.equal((await iKontrollrummet(this, agare, 'Erik')).name, namn, 'Kontrollrummet visar ett annat namn.');
});

/**
 * Standardnamnet är de första tecknen ur önskemålet, och önskemålet kan bära personuppgifter.
 * Att kontrollrummet skriver "Namnlös app" i namnfältet räcker inte som prövning — texten får
 * inte stå någon annanstans i svaret heller.
 */
Then(/^nämns inget av önskemålet i kontrollrummet$/, function (this: Varld) {
  const kroppar = this.svar.map((svar) => svar.kropp).join('\n');
  assert.ok(kroppar.length > 0, 'Kontrollrummet svarade utan innehåll.');
  for (const ord of IGENKANNLIGA) {
    assert.ok(!kroppar.includes(ord), `Ordet "${ord}" ur önskemålet står i kontrollrummet.`);
  }
});
