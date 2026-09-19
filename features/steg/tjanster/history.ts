/**
 * Steg för tjänsten `history` (`/_api/history`): ändringshistorik för appars dokument.
 *
 * Tjänsten behöver inga fejkar — den läser plattformens riktiga data-API. Historiken slås på i
 * lagringen när `history` finns i APP_SERVICES, precis som i drift. Kvarhållningstiden sätts
 * uttryckligen här så att scenarierna inte beror på standardvärdet.
 */
import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { DataTable } from '@cucumber/cucumber';
import { jsonKropp } from '../stod/http.ts';
import { somJsonObjekt } from '../stod/json.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import { dokument } from '../stod/varld.ts';
import type { SparatDokument, Varld } from '../stod/varld.ts';

forberedTjanst('history', async () => ({ miljo: { SVC_HISTORY_RETENTION_DAYS: '365' } }));

/** Verksamhetens ord för händelserna → tjänstens. */
const HANDELSER: ReadonlyMap<string, string> = new Map([
  ['skapat', 'create'],
  ['ändrat', 'replace'],
  ['raderat', 'delete'],
  ['återställt', 'restore'],
]);

interface Historikrad {
  readonly event: string;
  readonly at: string;
  readonly userId: string;
  readonly displayName: string;
  readonly data: unknown;
}

function sparat(varld: Varld, agare: string): SparatDokument {
  const dok = varld.senastSparat.get(agare);
  assert.ok(dok !== undefined, `${agare} har inte sparat något dokument i det här scenariot.`);
  return dok;
}

function dokumentetsHistorik(dok: SparatDokument): string {
  return `/_api/history/collections/${dok.kollektion}/docs/${dok.id}`;
}

async function historik(varld: Varld, person: string, dok: SparatDokument): Promise<Historikrad[]> {
  const svar = await varld.anropaApp({ app: dok.app, person, sokvag: dokumentetsHistorik(dok) });
  assert.equal(svar.status, 200, `Historiken gick inte att läsa: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  return (jsonKropp(svar) as { entries: Historikrad[] }).entries;
}

async function skrivOm(varld: Varld, person: string, agare: string, data: string) {
  const dok = sparat(varld, agare);
  return varld.anropaApp({
    app: dok.app,
    person,
    metod: 'PUT',
    sokvag: dokument(dok.kollektion, dok.id),
    json: { data: somJsonObjekt(data) },
  });
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna|Bertil) har skrivit om (Anna|Bertil)s dokument till (\{.*\})$/, async function (this: Varld, person: string, agare: string, data: string) {
  const svar = await skrivOm(this, person, agare, data);
  assert.equal(svar.status, 200, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

Given(/^att (Anna|Bertil) har försökt skriva om (Anna|Bertil)s dokument till (\{.*\})$/, async function (this: Varld, person: string, agare: string, data: string) {
  const svar = await skrivOm(this, person, agare, data);
  assert.equal(svar.status, 404, `Försöket skulle ha nekats, men gav ${svar.status}.`);
});

Given(/^att (Anna|Bertil) har raderat (Anna|Bertil)s dokument$/, async function (this: Varld, person: string, agare: string) {
  const dok = sparat(this, agare);
  const svar = await this.anropaApp({ app: dok.app, person, metod: 'DELETE', sokvag: dokument(dok.kollektion, dok.id) });
  assert.equal(svar.status, 204, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil) tittar på ändringshistoriken för (Anna|Bertil)s dokument$/, async function (this: Varld, person: string, agare: string) {
  const dok = sparat(this, agare);
  this.svar = [await this.anropaApp({ app: dok.app, person, sokvag: dokumentetsHistorik(dok) })];
});

When(
  /^(Anna|Bertil) tittar på ändringshistoriken för (Anna|Bertil)s dokument i appen "([^"]+)"$/,
  async function (this: Varld, person: string, agare: string, app: string) {
    // Samma kollektion och samma dokument-id — bara en annan app.
    const dok = sparat(this, agare);
    this.svar = [await this.anropaApp({ app, person, sokvag: dokumentetsHistorik(dok) })];
  },
);

When(
  /^(Anna|Bertil) tittar på ändringshistoriken för kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, kollektion: string, app: string) {
    this.svar = [await this.anropaApp({ app, person, sokvag: `/_api/history/collections/${kollektion}` })];
  },
);

When(
  /^(Anna|Bertil) (?:återställer|försöker återställa) (Anna|Bertil)s dokument till hur det var när det skapades$/,
  async function (this: Varld, person: string, agare: string) {
    const dok = sparat(this, agare);
    // Tidpunkten läses av ägaren, som ser historiken — den som försöker återställa behöver inte göra det.
    const skapat = (await historik(this, agare, dok)).find((rad) => rad.event === 'create');
    assert.ok(skapat !== undefined, 'Historiken saknar skapandet.');
    this.svar = [
      await this.anropaApp({ app: dok.app, person, metod: 'POST', sokvag: `${dokumentetsHistorik(dok)}/restore`, json: { at: skapat.at } }),
    ];
  },
);

When(
  /^(Anna|Bertil) återställer (Anna|Bertil)s dokument till en tidpunkt som inte finns i historiken$/,
  async function (this: Varld, person: string, agare: string) {
    const dok = sparat(this, agare);
    this.svar = [
      await this.anropaApp({
        app: dok.app,
        person,
        metod: 'POST',
        sokvag: `${dokumentetsHistorik(dok)}/restore`,
        json: { at: '2001-01-01T00:00:00.000Z' },
      }),
    ];
  },
);

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^visar ändringshistoriken i tur och ordning:$/, function (this: Varld, tabell: DataTable) {
  const [svar] = this.svar;
  assert.ok(svar !== undefined && this.svar.length === 1, 'Steget förutsätter exakt ett svar.');
  assert.equal(svar.status, 200, `Historiken gick inte att läsa: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const rader = (jsonKropp(svar) as { entries: Historikrad[] }).entries;
  const vantat = tabell.hashes();
  assert.equal(rader.length, vantat.length, `Väntade ${vantat.length} rader, fick ${rader.length}.`);
  vantat.forEach((rad, i) => {
    const faktisk = rader[i];
    assert.ok(faktisk !== undefined);
    assert.equal(faktisk.event, HANDELSER.get(rad['händelse'] ?? ''), `Rad ${i + 1}: fel händelse.`);
    assert.equal(faktisk.displayName, rad['vem'], `Rad ${i + 1}: fel person.`);
    assert.deepEqual(faktisk.data, somJsonObjekt(rad['innehåll'] ?? ''), `Rad ${i + 1}: fel innehåll.`);
    assert.match(faktisk.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

Then(/^innehåller ändringshistoriken inga e-postadresser$/, function (this: Varld) {
  for (const svar of this.svar) {
    assert.ok(!svar.ratt.includes('@'), 'Historiken röjer en e-postadress.');
    assert.ok(!svar.ratt.includes('exempel.se'), 'Historiken röjer en e-postdomän.');
  }
});

Then(/^innehåller (Anna|Bertil)s dokument nu (\{.*\})$/, async function (this: Varld, agare: string, data: string) {
  const [svar] = this.svar;
  assert.ok(svar !== undefined);
  assert.equal(svar.status, 200, `Återställningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const dok = sparat(this, agare);
  const hamtat = await this.anropaApp({ app: dok.app, person: agare, sokvag: dokument(dok.kollektion, dok.id) });
  assert.equal(hamtat.status, 200);
  assert.deepEqual((jsonKropp(hamtat) as { data: unknown }).data, somJsonObjekt(data));
});

Then(
  /^visar (Anna|Bertil)s ändringshistorik överst att ([a-z.]+) återställde det till (\{.*\})$/,
  async function (this: Varld, agare: string, vem: string, data: string) {
    const [overst] = await historik(this, agare, sparat(this, agare));
    assert.ok(overst !== undefined, 'Historiken är tom.');
    assert.equal(overst.event, 'restore');
    assert.equal(overst.displayName, vem);
    assert.deepEqual(overst.data, somJsonObjekt(data));
  },
);
