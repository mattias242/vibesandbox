/**
 * Så-steg: det scenariot kräver av svaret. Stegen bedömer ALLA svar från det senaste När-steget,
 * så att ett steg som prövat flera varianter av samma handling inte kan bli grönt på en av dem.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { Then } from '@cucumber/cucumber';
import { APP_CONTENT_SECURITY_POLICY } from '@vibesandbox/contracts';
import type { ApiErrorBody, DocumentPage, StoredDocument } from '@vibesandbox/contracts';
import { APPENS_KANNETECKEN, EGEN_META_REGEL } from './stod/fixtur.ts';
import { huvud, jsonKropp } from './stod/http.ts';
import type { Svar } from './stod/http.ts';
import { somJsonObjekt } from './stod/json.ts';
import { vantatFelsvar } from './stod/svarsfraser.ts';
import { dokument, dokumentlista } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

function allaSvar(varld: Varld): readonly Svar[] {
  assert.ok(varld.svar.length > 0, 'Inget När-steg har gjort något anrop.');
  return varld.svar;
}

/** Plattformens skyddsregler: exakt kontraktets värde, exakt en gång, och ingen "bara rapportera"-variant. */
function kravPaSkyddsregler(svar: Svar): void {
  // Varje direktiv ur kontraktet, plus exakt ett `frame-ancestors` som gatewayn lägger till per
  // värdsort: `'none'`, eller byggverktygets origin för en förhandsvisning — och inget annat.
  const regler = (huvud(svar, 'Content-Security-Policy') ?? '').split(';').map((del) => del.trim()).filter(Boolean);
  const kontraktet = APP_CONTENT_SECURITY_POLICY.split(';').map((del) => del.trim());
  for (const krav of kontraktet) assert.ok(regler.includes(krav), `Skyddsreglerna saknar "${krav}".`);
  const inramning = regler.filter((del) => del.split(/\s+/)[0] === 'frame-ancestors');
  assert.equal(inramning.length, 1, 'Skyddsreglerna ska ange frame-ancestors exakt en gång.');
  assert.match(inramning[0] ?? '', /^frame-ancestors (?:'none'|https?:\/\/bygg\.[a-z0-9.-]+(?::[0-9]{1,5})?)$/);
  assert.equal(regler.length, kontraktet.length + 1, 'Skyddsreglerna innehåller något utöver kontraktet.');
  assert.equal(huvud(svar, 'Content-Security-Policy-Report-Only'), undefined);
  assert.equal(huvud(svar, 'X-Content-Type-Options'), 'nosniff');
}

/** Skyddsreglerna uppdelade per direktiv: `connect-src` → [`'self'`]. */
function direktiv(svar: Svar): ReadonlyMap<string, readonly string[]> {
  const regler = huvud(svar, 'Content-Security-Policy');
  assert.ok(regler !== undefined, 'Svaret saknar skyddsregler.');
  const resultat = new Map<string, readonly string[]>();
  for (const del of regler.split(';')) {
    const [namn, ...varden] = del.trim().split(/\s+/);
    if (namn === undefined || namn.length === 0) continue;
    assert.ok(!resultat.has(namn), `Direktivet ${namn} förekommer två gånger; webbläsaren använder bara det första.`);
    resultat.set(namn, varden);
  }
  return resultat;
}

function sida(svar: Svar): DocumentPage {
  assert.equal(svar.status, 200, `Listningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as DocumentPage;
  assert.ok(Array.isArray(kropp.documents), 'Svaret saknar dokumentlista.');
  return kropp;
}

// ── Felsvar ──────────────────────────────────────────────────────────────────────

Then(/^får (?:han|hon|anroparen) svaret "([^"]+)"$/, function (this: Varld, fras: string) {
  const vantat = vantatFelsvar(fras);
  for (const svar of allaSvar(this)) {
    assert.equal(svar.status, vantat.status, `Väntade ${vantat.status} (${fras}) men fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
    const kropp = jsonKropp(svar) as ApiErrorBody;
    assert.equal(kropp.error?.code, vantat.kod);
    assert.ok(typeof kropp.error.message === 'string' && kropp.error.message.length > 0, 'Felsvaret saknar ett meddelande att visa.');
    // "Även felsidor bär skyddsreglerna" — prövas på varje felsvar i varje scenario.
    kravPaSkyddsregler(svar);
  }
});

// ── Listor och dokument ──────────────────────────────────────────────────────────

Then(/^är listan tom$/, function (this: Varld) {
  for (const svar of allaSvar(this)) {
    const { documents, nextCursor } = sida(svar);
    assert.deepEqual(documents, []);
    assert.equal(nextCursor, undefined);
  }
});

Then(/^innehåller listan ett dokument med (\{.*\})$/, function (this: Varld, data: string) {
  const vantat = somJsonObjekt(data);
  const traffar = sida(this.endaSvaret()).documents.filter((dok) => JSON.stringify(dok.data) === JSON.stringify(vantat));
  assert.equal(traffar.length, 1);
});

Then(/^(Anna|Bertil)s dokument innehåller fortfarande (\{.*\})$/, async function (this: Varld, agare: string, data: string) {
  const sparat = this.senastSparat.get(agare);
  assert.ok(sparat !== undefined, `${agare} har inte sparat något dokument i det här scenariot.`);
  const svar = await this.anropaApp({ app: sparat.app, person: agare, sokvag: dokument(sparat.kollektion, sparat.id) });
  assert.equal(svar.status, 200, `Dokumentet gick inte att hämta: ${svar.status}`);
  assert.deepEqual((jsonKropp(svar) as StoredDocument).data, somJsonObjekt(data));
});

Then(/^lyckas raderingen$/, async function (this: Varld) {
  assert.equal(this.endaSvaret().status, 204);
});

Then(/^(Anna|Bertil) kan fortfarande spara ett dokument i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const svar = await this.anropaApp({
    app,
    person,
    metod: 'POST',
    sokvag: dokumentlista('poster'),
    json: { data: { anteckning: 'den andra appen märker ingenting' } },
  });
  assert.equal(svar.status, 201, `Den andra appen kunde inte spara: ${svar.status} ${svar.kropp.slice(0, 200)}`);
});

Then(/^får hon högst (\d+) dokument och en markör till nästa sida$/, async function (this: Varld, hogst: string) {
  const forsta = sida(this.endaSvaret());
  assert.ok(forsta.documents.length > 0 && forsta.documents.length <= Number(hogst), `Första sidan hade ${forsta.documents.length} dokument.`);
  assert.ok(typeof forsta.nextCursor === 'string' && forsta.nextCursor.length > 0, 'Svaret saknar markör till nästa sida.');

  // Markören ska också FUNGERA: följ den till slutet och kräv att varje dokument kommer exakt en gång.
  const person = this.senastInloggad;
  assert.ok(person !== undefined);
  const app = this.endaAppenMedDokument();
  const sedda = new Set(forsta.documents.map((dok) => dok.id));
  let markor: string | undefined = forsta.nextCursor;
  let antal = forsta.documents.length;
  for (let varv = 0; markor !== undefined; varv += 1) {
    assert.ok(varv < 50, 'Sidindelningen tar aldrig slut.');
    const nasta = sida(
      await this.anropaApp({ app, person, sokvag: dokumentlista('poster', undefined, `cursor=${encodeURIComponent(markor)}`) }),
    );
    assert.ok(nasta.documents.length <= Number(hogst));
    for (const dok of nasta.documents) sedda.add(dok.id);
    antal += nasta.documents.length;
    markor = nasta.nextCursor;
  }
  assert.equal(antal, (this.dokumentIApp.get(app) ?? []).length);
  assert.equal(sedda.size, antal, 'Samma dokument kom på flera sidor.');
});

// ── Inloggning och identitet ─────────────────────────────────────────────────────

Then(/^visas inte appens innehåll$/, function (this: Varld) {
  for (const svar of allaSvar(this)) {
    assert.equal(svar.status, 401);
    assert.ok(!svar.ratt.includes(APPENS_KANNETECKEN), 'Svaret innehåller appens innehåll.');
    assert.ok(!/<html|<script|console\.log/i.test(svar.kropp), 'Svaret ser ut att innehålla en sida eller ett skript.');
    assert.match(huvud(svar, 'Content-Type') ?? '', /^application\/json/);
  }
});

Then(/^får den ett användar-id och visningsnamnet "([^"]+)"$/, function (this: Varld, visningsnamn: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200);
  const kropp = jsonKropp(svar) as Record<string, unknown>;
  assert.ok(typeof kropp['userId'] === 'string' && kropp['userId'].length > 0, 'Svaret saknar användar-id.');
  assert.equal(kropp['displayName'], visningsnamn);
  // "Inte mer än nödvändigt": svaret har de här två uppgifterna och inga andra.
  assert.deepEqual(Object.keys(kropp).sort(), ['displayName', 'userId']);
});

Then(/^svaret innehåller inte e-postadressen$/, function (this: Varld) {
  const person = this.senastInloggad;
  assert.ok(person !== undefined);
  const epost = this.person(person).identitet.email;
  const doman = epost.slice(epost.lastIndexOf('@'));
  const svar = this.endaSvaret();
  // Hela svaret, huvuden inräknade — inte bara kroppen.
  assert.ok(!svar.ratt.includes(epost), 'Svaret innehåller e-postadressen.');
  assert.ok(!svar.ratt.includes(doman), 'Svaret innehåller e-postadressens domän.');
});

// ── Adresser som inte hör till någon app ─────────────────────────────────────────

Then(/^ingen databas har skapats för det app-id:t$/, async function (this: Varld) {
  const appId = this.okantAppId;
  assert.ok(appId !== undefined, 'Scenariot har inte använt något okänt app-id.');
  // Ingenting någonstans i datakatalogen får bära det okända app-id:t i sitt namn.
  assert.ok(existsSync(this.dataDir));
  const poster = await readdir(this.dataDir, { recursive: true });
  const traffar = poster.filter((post) => post.includes(appId));
  assert.deepEqual(traffar, []);
  // Och kontrollen är inte tom: de riktiga apparnas data HADE synts på samma sätt.
  assert.ok(poster.length > 0);
});

// ── Skyddsregler ─────────────────────────────────────────────────────────────────

Then(/^tillåter skyddsreglerna bara anslutningar till appens egen adress$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200);
  assert.ok(svar.kropp.includes(APPENS_KANNETECKEN), 'Det var inte appens startsida som kom tillbaka.');
  const regler = direktiv(svar);
  assert.deepEqual(regler.get('connect-src'), ["'self'"]);
  // Det som `connect-src` inte täcker faller tillbaka på `default-src`.
  assert.deepEqual(regler.get('default-src'), ["'self'"]);
  assert.deepEqual(regler.get('script-src'), ["'self'"]);
});

Then(/^skyddsreglerna förbjuder inbäddade ramar, insticksobjekt och ändrad basadress$/, function (this: Varld) {
  const regler = direktiv(this.endaSvaret());
  assert.deepEqual(regler.get('frame-src'), ["'none'"]);
  assert.deepEqual(regler.get('object-src'), ["'none'"]);
  assert.deepEqual(regler.get('base-uri'), ["'none'"]);
});

Then(/^formulär får bara skickas till appens egen adress$/, function (this: Varld) {
  assert.deepEqual(direktiv(this.endaSvaret()).get('form-action'), ["'self'"]);
});

Then(/^bär svaret plattformens skyddsregler$/, function (this: Varld) {
  for (const svar of allaSvar(this)) kravPaSkyddsregler(svar);
});

Then(/^webbläsaren förbjuds gissa innehållstyp$/, function (this: Varld) {
  for (const svar of allaSvar(this)) assert.equal(huvud(svar, 'X-Content-Type-Options'), 'nosniff');
});

Then(/^gäller fortfarande plattformens skyddsregler i svarshuvudet$/, function (this: Varld) {
  const svar = this.endaSvaret();
  // Sidan med sin egen meta-tagg kom verkligen fram …
  assert.equal(svar.status, 200);
  assert.ok(svar.kropp.includes(EGEN_META_REGEL), 'Det var inte sidan med egna regler som kom tillbaka.');
  // … men svarshuvudet är plattformens, orört. En meta-tagg kan bara skärpa det, aldrig lätta det.
  kravPaSkyddsregler(svar);
});
