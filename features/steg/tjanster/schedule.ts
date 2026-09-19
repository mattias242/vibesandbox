/**
 * Steg för tjänsten `schedule` (features/tjanster/schedule.feature).
 *
 * Påminnelserna skickas genom tjänsten `notify`, som mejlar appens medlemmar. Här får plattformen
 * en utkorg i stället för Mailgun, och tjänsten vaknar ofta (SVC_SCHEDULE_TICK_MS), så att "om ett
 * ögonblick" blir ett par sekunder. Plattformens klocka är den riktiga — scenarierna väntar på
 * riktigt; klockhopp och sommartid prövas i enhetstesterna, där klockan går att styra.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { AppMailer } from '@vibesandbox/contracts';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import type { Varld } from '../stod/varld.ts';

const SOKVAG = '/_api/schedule';
/** "Om ett ögonblick": tillräckligt långt fram för att hinna ta bort någons åtkomst först. */
const OGONBLICK_MS = 2_000;
/** Så länge ett "får ingen påminnelse" väntar efter den schemalagda tiden. */
const EFTERSLAP_MS = 1_500;
const LANGST_VANTAN_MS = 10_000;

interface Utskick {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Utkorgen för det pågående scenariot. Scenarierna i en process körs ett i taget. */
let utkorg: Utskick[] = [];

forberedTjanst('schedule', async () => {
  utkorg = [];
  const mailer: AppMailer = {
    send: async (meddelande) => {
      utkorg.push({ to: meddelande.to, subject: meddelande.subject, text: meddelande.text });
    },
  };
  return { miljo: { SVC_SCHEDULE_TICK_MS: '100' }, mailer };
});

interface Scenariodata {
  /** Den påminnelse var och en senast schemalade. */
  readonly senaste: Map<string, { readonly app: string; readonly id: string }>;
  /** När den senast schemalagda påminnelsen ska gå. */
  sistaTid: number;
}

const DATA = new WeakMap<Varld, Scenariodata>();

function data(varld: Varld): Scenariodata {
  let d = DATA.get(varld);
  if (d === undefined) {
    d = { senaste: new Map(), sistaTid: 0 };
    DATA.set(varld, d);
  }
  return d;
}

function omEttOgonblick(varld: Varld): string {
  const tid = Date.now() + OGONBLICK_MS;
  data(varld).sistaTid = tid;
  return new Date(tid).toISOString();
}

/** Långt nog fram för att aldrig hinna gå under scenariot. */
function iMorgon(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

async function schemalagg(
  varld: Varld,
  person: string,
  app: string,
  kropp: Record<string, unknown>,
  forhandsvisning = false,
): Promise<Svar> {
  const svar = await varld.anropaApp({ app, person, metod: 'POST', sokvag: SOKVAG, json: kropp, forhandsvisning });
  if (svar.status === 201) {
    const { id } = jsonKropp(svar) as { id: string };
    data(varld).senaste.set(person, { app, id });
  }
  return svar;
}

async function kravSchemalagt(varld: Varld, person: string, app: string, kropp: Record<string, unknown>): Promise<void> {
  const svar = await schemalagg(varld, person, app, kropp);
  if (svar.status !== 201) throw new Error(`Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
}

function senaste(varld: Varld, person: string): { app: string; id: string } {
  const p = data(varld).senaste.get(person);
  if (p === undefined) throw new Error(`${person} har inte schemalagt någon påminnelse i scenariot.`);
  return p;
}

function tillPerson(varld: Varld, person: string, amne: string): Utskick[] {
  const epost = varld.epost(person);
  return utkorg.filter((u) => u.to === epost && u.subject.includes(amne));
}

async function vantaTills(villkor: () => boolean, gransMs: number): Promise<boolean> {
  const slut = Date.now() + gransMs;
  while (Date.now() < slut) {
    if (villkor()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return villkor();
}

async function amnen(varld: Varld, person: string, app: string): Promise<string[]> {
  const svar = await varld.anropaApp({ app, person, sokvag: SOKVAG });
  assert.equal(svar.status, 200, `Listningen gick inte: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const { reminders } = jsonKropp(svar) as { reminders: { subject: string }[] };
  return reminders.map((r) => r.subject).sort();
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(
  /^att (Anna|Bertil) har schemalagt en påminnelse i appen "([^"]+)" med ämnet "([^"]+)"$/,
  async function (this: Varld, person: string, app: string, amne: string) {
    await kravSchemalagt(this, person, app, { at: iMorgon(), to: 'owner', subject: amne, text: 'Glöm inte.' });
  },
);

Given(
  /^att (Anna|Bertil) har schemalagt en påminnelse till alla i appen "([^"]+)" om ett ögonblick med ämnet "([^"]+)"$/,
  async function (this: Varld, person: string, app: string, amne: string) {
    await kravSchemalagt(this, person, app, { at: omEttOgonblick(this), to: 'all', subject: amne, text: 'Glöm inte.' });
  },
);

// Utkastet: det gemensamma steget `att appen "X" har ett utkast` (features/steg/tjanster/gemensamt.ts).

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna|Bertil) schemalägger en påminnelse till alla i (förhandsvisningen av )?appen "([^"]+)" om ett ögonblick med ämnet "([^"]+)"$/,
  async function (this: Varld, person: string, forhandsvisning: string | null | undefined, app: string, amne: string) {
    const kropp = { at: omEttOgonblick(this), to: 'all', subject: amne, text: 'Glöm inte.' };
    this.svar = [await schemalagg(this, person, app, kropp, typeof forhandsvisning === 'string' && forhandsvisning !== '')];
    assert.equal(this.endaSvaret().status, 201, `Det gick inte att schemalägga: ${this.endaSvaret().kropp.slice(0, 200)}`);
  },
);

When(
  /^(Anna|Bertil) schemalägger en påminnelse till alla i appen "([^"]+)" för en tid som redan har passerat$/,
  async function (this: Varld, person: string, app: string) {
    const passerad = new Date(Date.now() - 60_000).toISOString();
    this.svar = [await schemalagg(this, person, app, { at: passerad, to: 'all', subject: 'Sent', text: 'För sent.' })];
  },
);

When(
  /^(Anna|Bertil) schemalägger en påminnelse till alla i appen "([^"]+)" för tiden "([^"]+)"$/,
  async function (this: Varld, person: string, app: string, tid: string) {
    this.svar = [await schemalagg(this, person, app, { at: tid, to: 'all', subject: 'Möte', text: 'Möte.' })];
  },
);

When(/^(Anna|Bertil) listar påminnelserna i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  this.svar = [await this.anropaApp({ app, person, sokvag: SOKVAG })];
});

When(
  /^(Anna|Bertil) tar bort (Anna|Bertil)s påminnelse i appen "([^"]+)"$/,
  async function (this: Varld, person: string, skapare: string, app: string) {
    const { id } = senaste(this, skapare);
    this.svar = [await this.anropaApp({ app, person, metod: 'DELETE', sokvag: `${SOKVAG}/${id}` })];
  },
);

When(/^Anna tar bort (Bertil)s åtkomst till appen "([^"]+)"$/, async function (this: Varld, namn: string, app: string) {
  await this.control.revokeAccess(this.appId(app), this.person(namn).identitet.userId);
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^får (Anna|Bertil) en påminnelse med ämnet "([^"]+)"$/, async function (this: Varld, person: string, amne: string) {
  const kom = await vantaTills(() => tillPerson(this, person, amne).length > 0, LANGST_VANTAN_MS);
  assert.ok(kom, `${person} fick ingen påminnelse med ämnet "${amne}".`);
});

Then(/^får (Anna|Bertil) ingen påminnelse$/, async function (this: Varld, person: string) {
  const vanta = Math.max(0, data(this).sistaTid + EFTERSLAP_MS - Date.now());
  await new Promise((resolve) => setTimeout(resolve, vanta));
  const epost = this.epost(person);
  assert.equal(utkorg.filter((u) => u.to === epost).length, 0, `${person} fick en påminnelse.`);
});

Then(/^kommer varje påminnelse bara en gång$/, async function (this: Varld) {
  // Tjänsten vaknar var tionde sekund-del; en dubblett hade hunnit komma under väntan.
  await new Promise((resolve) => setTimeout(resolve, EFTERSLAP_MS));
  const per = new Map<string, number>();
  for (const u of utkorg) per.set(`${u.to} ${u.subject}`, (per.get(`${u.to} ${u.subject}`) ?? 0) + 1);
  for (const [vem, antal] of per) assert.equal(antal, 1, `${vem} fick ${antal} påminnelser.`);
});

Then(/^ser (?:han|hon) bara påminnelsen "([^"]+)"$/, function (this: Varld, amne: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200);
  const { reminders } = jsonKropp(svar) as { reminders: { subject: string }[] };
  assert.deepEqual(reminders.map((r) => r.subject), [amne]);
});

Then(/^ser (?:han|hon) påminnelserna "([^"]+)" och "([^"]+)"$/, function (this: Varld, forsta: string, andra: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200);
  const { reminders } = jsonKropp(svar) as { reminders: { subject: string }[] };
  assert.deepEqual(reminders.map((r) => r.subject).sort(), [forsta, andra].sort());
});

Then(/^finns (Anna|Bertil)s påminnelse kvar$/, async function (this: Varld, skapare: string) {
  const { app } = senaste(this, skapare);
  const kvar = await amnen(this, skapare, app);
  assert.equal(kvar.length, 1, `${skapare}s påminnelse finns inte kvar.`);
});

Then(/^är (Anna|Bertil)s påminnelse borttagen$/, async function (this: Varld, skapare: string) {
  assert.equal(this.endaSvaret().status, 200, `Borttagningen gick inte: ${this.endaSvaret().kropp.slice(0, 200)}`);
  const { app } = senaste(this, skapare);
  assert.deepEqual(await amnen(this, skapare, app), []);
});
