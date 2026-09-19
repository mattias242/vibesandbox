/**
 * Steg för tjänsten `notify` (features/tjanster/notify.feature). Mejlen går till en fejkad
 * utkorg som registreras med `forberedTjanst`; stegen tittar i den i stället för i en riktig
 * mejltjänst. Hastighetsgränsen per avsändare är låg här (5 i timmen), så att scenariot om
 * gränsen når den på några få anrop — samma mekanism som i drift, bara en lägre siffra.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import type { Varld } from '../stod/varld.ts';

interface SkickatMejl {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Scenarierna körs ett i taget per process; utkorgen töms när nästa scenario förbereds. */
let utkorg: SkickatMejl[] = [];
/** Hur många mejl som fanns i utkorgen när det senaste När-steget började. */
let fore = 0;

forberedTjanst('notify', async () => {
  utkorg = [];
  fore = 0;
  return {
    miljo: { SVC_NOTIFY_PER_USER_HOUR: '5' },
    mailer: {
      async send(meddelande) {
        utkorg.push({ to: meddelande.to, subject: meddelande.subject, text: meddelande.text });
      },
    },
  };
});

const SOKVAG = '/_api/notify';

function avisera(varld: Varld, person: string, app: string, json: unknown, forhandsvisning = false): Promise<Svar> {
  return varld.anropaApp({ app, person, metod: 'POST', sokvag: SOKVAG, json, forhandsvisning });
}

async function nar(varld: Varld, anrop: () => Promise<Svar>): Promise<void> {
  fore = utkorg.length;
  varld.svar = [await anrop()];
}

function mejlTill(varld: Varld, person: string): SkickatMejl[] {
  const adress = varld.epost(person);
  return utkorg.filter((m) => m.to === adress);
}

function endaMejlTill(varld: Varld, person: string): SkickatMejl {
  const mejl = mejlTill(varld, person);
  assert.equal(mejl.length, 1, `${person} skulle få exakt ett mejl men fick ${mejl.length}.`);
  return mejl[0] as SkickatMejl;
}

function mottagare(varld: Varld, vem: string): unknown {
  if (vem === 'alla') return 'all';
  if (vem === 'ägaren') return 'owner';
  return [varld.anvandarId(vem)];
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Cecilia) bara har tillgång till appen "([^"]+)"$/, async function (this: Varld, namn: string, app: string) {
  const { identitet } = this.loggaIn(namn);
  await this.control.grantAccess(this.appId(app), identitet.userId, 'user', identitet.email);
});

Given(/^att (Bertil) har stängt av aviseringarna från appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const svar = await this.anropaApp({ app, person, metod: 'PUT', sokvag: `${SOKVAG}/settings`, json: { muted: true } });
  assert.equal(svar.status, 200, `Avstängningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

Given(
  /^att (Bertil) redan har skickat (\d+) aviseringar till ägaren av appen "([^"]+)" den senaste timmen$/,
  async function (this: Varld, person: string, antal: string, app: string) {
    for (let i = 0; i < Number(antal); i += 1) {
      const svar = await avisera(this, person, app, { to: 'owner', subject: 'Hej', text: `Meddelande ${i + 1}.` });
      assert.equal(svar.status, 200, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
    }
  },
);

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna|Bertil) aviserar (alla|ägaren|Cecilia) i appen "([^"]+)" med ämnet "([^"]*)" och texten "([^"]*)"$/,
  async function (this: Varld, person: string, vem: string, app: string, subject: string, text: string) {
    await nar(this, () => avisera(this, person, app, { to: mottagare(this, vem), subject, text }));
  },
);

When(
  /^(Anna) aviserar alla från förhandsvisningen av appen "([^"]+)" med ämnet "([^"]*)" och texten "([^"]*)"$/,
  async function (this: Varld, person: string, app: string, subject: string, text: string) {
    await nar(this, () => avisera(this, person, app, { to: 'all', subject, text }, true));
  },
);

When(/^(Anna) aviserar alla i appen "([^"]+)" med appens egen adress i texten$/, async function (this: Varld, person: string, app: string) {
  const adress = `http://${this.appId(app)}.appar.test/`;
  await nar(this, () => avisera(this, person, app, { to: 'all', subject: 'Nytt i appen', text: `Titta här: ${adress} (eller ${adress}kalender).` }));
});

When(/^(Anna) aviserar alla i appen "([^"]+)" med ett ämne som försöker lägga till ett mejlhuvud$/, async function (this: Varld, person: string, app: string) {
  await nar(this, () => avisera(this, person, app, { to: 'all', subject: 'Hej\r\nX-Prioritet: hög\r\n\r\nFalsk text', text: 'Hej.' }));
});

When(/^(Anna) aviserar alla i appen "([^"]+)" med en text på ([\d ]+) tecken$/, async function (this: Varld, person: string, app: string, antal: string) {
  // Tusentalsavgränsaren är ett mellanslag, som i svensk text: "20 000".
  const langd = Number(antal.replaceAll(' ', ''));
  await nar(this, () => avisera(this, person, app, { to: 'all', subject: 'Långt', text: 'a'.repeat(langd) }));
});

// ── Så ───────────────────────────────────────────────────────────────────────────

function lyckat(varld: Varld): Record<string, unknown> {
  const svar = varld.endaSvaret();
  assert.equal(svar.status, 200, `Aviseringen misslyckades: ${svar.status} ${svar.kropp.slice(0, 300)}`);
  return jsonKropp(svar) as Record<string, unknown>;
}

Then(/^svarar tjänsten att (\d+) mejl skickades$/, function (this: Varld, antal: string) {
  assert.equal(lyckat(this)['sent'], Number(antal));
});

Then(/^(Anna|Bertil) får ett mejl med ämnet "([^"]+)"$/, function (this: Varld, person: string, amne: string) {
  const mejl = endaMejlTill(this, person);
  assert.ok(mejl.subject.includes(amne), `Ämnet "${mejl.subject}" innehåller inte "${amne}".`);
});

Then(/^(Anna|Bertil|Cecilia) får inget mejl$/, function (this: Varld, person: string) {
  assert.equal(mejlTill(this, person).length, 0, `${person} fick mejl hen inte skulle ha fått.`);
});

Then(/^inget mejl skickas$/, function (this: Varld) {
  assert.equal(utkorg.length, fore, 'Mejl skickades trots att aviseringen avvisades.');
});

Then(/^inget skickat mejl har en radbrytning i ämnet$/, function (this: Varld) {
  const nya = utkorg.slice(fore);
  assert.ok(nya.length > 0, 'Inga mejl skickades.');
  for (const mejl of nya) assert.doesNotMatch(mejl.subject, /[\r\n]/, `Ämnet har en radbrytning: ${JSON.stringify(mejl.subject)}`);
});

Then(
  /^mejlet till (Bertil) visar att det kommer från "([^"]+)" och länkar till appen "([^"]+)"$/,
  function (this: Varld, person: string, avsandare: string, app: string) {
    const mejl = endaMejlTill(this, person);
    assert.ok(mejl.text.includes(avsandare), 'Mejlet visar inte avsändarens namn.');
    assert.ok(mejl.text.includes(`${this.appId(app)}.appar.test`), 'Mejlet länkar inte till appen.');
    // Bara visningsnamnet — avsändarens hela adress lämnas inte ut.
    assert.ok(!mejl.text.includes(this.epost('Anna')), 'Mejlet röjer avsändarens adress.');
  },
);

Then(/^mejlet till (Bertil) berättar varför han får det och hur han stänger av aviseringarna$/, function (this: Varld, person: string) {
  const text = endaMejlTill(this, person).text;
  assert.match(text, /eftersom du har tillgång till appen/);
  assert.match(text, /stänga av/);
});

Then(/^innehåller svaret ingen av medlemmarnas e-postadresser$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200);
  for (const person of ['Anna', 'Bertil']) assert.ok(!svar.ratt.includes(this.epost(person)), `Svaret röjer ${person}s adress.`);
  assert.ok(!svar.ratt.includes('@'), 'Svaret innehåller något som liknar en e-postadress.');
});

Then(/^svaret är detsamma som för ett användar-id som inte finns alls$/, async function (this: Varld) {
  const svar = this.endaSvaret();
  const jamforelse = await avisera(this, 'Anna', 'Klubben', { to: ['anv-finns-inte-alls'], subject: 'Hej', text: 'Hallå där.' });
  assert.equal(jamforelse.status, svar.status);
  assert.equal(jamforelse.kropp, svar.kropp);
});

Then(/^meddelandet förklarar att mejlet inte får innehålla webbadresser$/, function (this: Varld) {
  const kropp = jsonKropp(this.endaSvaret()) as ApiErrorBody;
  assert.match(kropp.error.message, /webbadress/);
});

Then(/^får (Bertil) veta i klarspråk att han har skickat för många aviseringar$/, function (this: Varld, _person: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 429, `Väntade 429 men fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as ApiErrorBody;
  assert.equal(kropp.error.code, 'rate_limited');
  assert.match(kropp.error.message, /för många aviseringar/);
});

Then(/^svaret säger att bara ägaren fick mejlet eftersom det är ett utkast$/, function (this: Varld) {
  const kropp = lyckat(this);
  assert.equal(kropp['onlyOwner'], true);
  assert.ok(typeof kropp['message'] === 'string' && /utkast/.test(kropp['message']), 'Svaret förklarar inte varför.');
});

Then(/^(Bertil) ser att hans aviseringar från appen "([^"]+)" är avstängda$/, async function (this: Varld, person: string, app: string) {
  const svar = await this.anropaApp({ app, person, sokvag: `${SOKVAG}/settings` });
  assert.equal(svar.status, 200);
  assert.deepEqual(jsonKropp(svar), { muted: true });
});
