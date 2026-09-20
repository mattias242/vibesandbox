/**
 * Stegen för återkoppling på BYGGVERKTYGET (features/bygga/aterkoppling.feature).
 *
 * Allt går över rå HTTP till byggverktygets riktiga API, som i gränssnittet. Två saker syns inte
 * i ett HTTP-svar och läses därför vid sidan av:
 *
 *   - Mejlen till plattformens ägare. I scenarierna finns ingen mejltjänst (testinloggning) och
 *     ingen ägaradress, så plattformen skriver mejlen som filer under datakatalogen — samma väg
 *     som `MAIL_OUTBOX_DIR` lokalt. Stegen läser den katalogen.
 *   - Räknaren för uppskattningar. Den ska INTE synas i något API-svar (ingen ska kunna läsa av
 *     andras tummar), så steget läser byggverktygets egen databas med en egen anslutning.
 *
 * Löftet i rutan ("hela konversationen följer med") hör hemma i webbgränssnittet; det steget läser
 * därför `apps/builder-ui/src/` — utan att ändra något där.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Given, Then, When } from '@cucumber/cucumber';
import { BUILDER_API_PREFIX } from '@vibesandbox/contracts';
import type { ApiErrorBody, BuilderAppDetail } from '@vibesandbox/contracts';
import { MAX_FEEDBACK_PER_HOUR } from '@vibesandbox/builder';
import { FORSTA_VERSIONEN } from './stod/byggkedja.ts';
import { jsonKropp } from './stod/http.ts';
import type { Svar } from './stod/http.ts';
import type { Varld } from './stod/varld.ts';

/** Katalogen plattformen lägger återkopplingsmejlen i när det inte finns någon adress att mejla. */
const UTKORG = 'aterkoppling';

/** Texten Anna senast lämnade — det Så-stegen letar efter i mejlet och i modellanropen. */
let lamnadText = '';
/** Hur många mejl som låg i utkorgen när det senaste När-steget började. */
let fore = 0;

// ── Utkorgen och räknaren ────────────────────────────────────────────────────────

async function utkorgen(varld: Varld): Promise<string[]> {
  const katalog = join(varld.dataDir, UTKORG);
  let filer: string[];
  try {
    filer = await readdir(katalog);
  } catch {
    return [];
  }
  return Promise.all(filer.sort().map((fil) => readFile(join(katalog, fil), 'utf8')));
}

/** Mejlen som skickades under det senaste När-steget. */
async function nyaMejl(varld: Varld): Promise<string[]> {
  return (await utkorgen(varld)).slice(fore);
}

/** Uppskattningarna i byggverktygets databas. Egen anslutning, bara läsning. */
function uppskattningar(varld: Varld): number {
  const db = new DatabaseSync(join(varld.dataDir, 'builder', 'builder.sqlite'), { readOnly: true });
  try {
    const rad = db.prepare('SELECT count(*) AS antal FROM feedback WHERE helpful = 1').get();
    return Number(rad?.['antal'] ?? 0);
  } finally {
    db.close();
  }
}

// ── Anrop ────────────────────────────────────────────────────────────────────────

async function lamna(varld: Varld, person: string, kropp: unknown, appAgare = person): Promise<Svar> {
  const appId = await varld.byggapp(appAgare);
  return varld.anropaByggverktyget({ person, metod: 'POST', sokvag: `${BUILDER_API_PREFIX}/apps/${appId}/feedback`, json: kropp });
}

/** Ett När-steg: notera utkorgens längd först, så att Så-stegen kan tala om just det här mejlet. */
async function nar(varld: Varld, anrop: () => Promise<Svar>): Promise<void> {
  fore = (await utkorgen(varld)).length;
  varld.svar = [await anrop()];
  varld.svarFranByggverktyget = true;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att Anna redan lämnat återkoppling så många gånger som tillåts denna timme$/, async function (this: Varld) {
  for (let i = 0; i < MAX_FEEDBACK_PER_HOUR; i += 1) {
    const svar = await lamna(this, 'Anna', { helpful: false, text: `Återkoppling ${i + 1}` });
    assert.equal(svar.status, 200, `Förberedelsen misslyckades på försök ${i + 1}: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  }
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(/^Anna lämnar återkopplingen "([^"]*)"$/, async function (this: Varld, text: string) {
  lamnadText = text;
  await nar(this, () => lamna(this, 'Anna', { helpful: false, text }));
});

When(/^Anna uppskattar ett svar$/, async function (this: Varld) {
  lamnadText = '';
  await nar(this, () => lamna(this, 'Anna', { helpful: true }));
});

When(/^(Bertil) lämnar återkoppling om (Anna)s app$/, async function (this: Varld, person: string, agare: string) {
  lamnadText = 'Verktyget begrep ingenting';
  await nar(this, () => lamna(this, person, { helpful: false, text: lamnadText }, agare));
});

When(/^Anna öppnar rutan för återkoppling$/, async function (this: Varld) {
  // Rutan finns där byggverktyget har svarat henne — utan ett svar finns inget att tycka till om.
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.ok(
    app.messages.some((meddelande) => meddelande.role === 'assistant'),
    'Byggverktyget har inte svarat Anna än; då finns ingen ruta att öppna.',
  );
});

// ── Så ───────────────────────────────────────────────────────────────────────────

function lyckat(varld: Varld): void {
  const svar = varld.endaSvaret();
  assert.equal(svar.status, 200, `Återkopplingen togs inte emot: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  assert.deepEqual(jsonKropp(svar), { received: true });
}

Then(/^får plattformens ägare ett mejl med återkopplingen$/, async function (this: Varld) {
  lyckat(this);
  const mejl = await nyaMejl(this);
  assert.equal(mejl.length, 1, `Plattformens ägare skulle få exakt ett mejl men fick ${mejl.length}.`);
  const brev = mejl[0] ?? '';
  assert.ok(brev.includes(lamnadText), 'Mejlet innehåller inte det Anna skrev.');
  // Det går till den som driver plattformen, inte tillbaka till Anna själv.
  const till = /^Till: (.+)$/m.exec(brev)?.[1];
  assert.ok(till !== undefined && till.length > 0, 'Mejlet saknar mottagare.');
  assert.notEqual(till, this.epost('Anna'), 'Mejlet gick till Anna i stället för till plattformens ägare.');
  // Ägaren ska kunna svara henne.
  assert.ok(brev.includes(this.epost('Anna')), 'Mejlet säger inte vem som lämnade återkopplingen.');
});

Then(/^mejlet innehåller konversationen om appen$/, async function (this: Varld) {
  const brev = (await nyaMejl(this))[0] ?? '';
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.ok(app.messages.length > 0, 'Appen har ingen konversation — scenariot prövar då ingenting.');
  for (const meddelande of app.messages) {
    assert.ok(brev.includes(meddelande.text), `Mejlet saknar ett av konversationens meddelanden: ${meddelande.text.slice(0, 60)}`);
  }
});

Then(/^står det att konversationen om appen följer med$/, async function () {
  // Löftet står i rutan, alltså i webbgränssnittet. Stegen läser bara — gränssnittet ägs av
  // apps/builder-ui.
  const rot = join(import.meta.dirname, '..', '..', 'apps', 'builder-ui', 'src');
  const filer = (await readdir(rot, { recursive: true, withFileTypes: true })).filter((post) => post.isFile());
  const texter = await Promise.all(filer.map((post) => readFile(join(post.parentPath, post.name), 'utf8')));
  const loftet = /hela\s+(?:er|din|era)\s+konversation/i;
  assert.ok(
    texter.some((text) => loftet.test(text)),
    'Byggverktygets gränssnitt (apps/builder-ui/src) säger ingenstans att hela konversationen följer med.',
  );
});

Then(/^innehåller inget som skickades till språkmodellen återkopplingen$/, function (this: Varld) {
  lyckat(this);
  // Återkopplingen startar ingen tur: språkmodellen anropas inte alls, och därmed kan den inte
  // heller ha sett texten. (`modellanrop` tömdes när appen byggts klart.)
  assert.equal(this.modellanrop.length, 0, 'Språkmodellen anropades av återkopplingen.');
  assert.ok(!JSON.stringify(this.modellanrop).includes(lamnadText), 'Återkopplingen skickades till språkmodellen.');
});

Then(/^appens utkast är oförändrat$/, async function (this: Varld) {
  const app = await this.byggApi<BuilderAppDetail>('Anna', 'GET', `/apps/${await this.byggapp('Anna')}`, 200);
  assert.equal(app.hasDraft, true, 'Appen har inget utkast kvar.');
  assert.ok(
    !app.messages.some((meddelande) => meddelande.text.includes(lamnadText)),
    'Återkopplingen hamnade i konversationen om appen.',
  );
  const forhandsvisning = await this.oppnaFranByggverktyget('Anna', 'preview');
  assert.equal(forhandsvisning.status, 200, `Förhandsvisningen svarade ${forhandsvisning.status}.`);
  assert.ok(forhandsvisning.kropp.includes(FORSTA_VERSIONEN), 'Utkastet är inte längre det som byggdes.');
  assert.ok(!forhandsvisning.kropp.includes(lamnadText), 'Återkopplingen ändrade appen.');
});

Then(/^(?:får plattformens ägare|plattformens ägare får) inget mejl(?: om den sista)?$/, async function (this: Varld) {
  const mejl = await nyaMejl(this);
  assert.equal(mejl.length, 0, `Plattformens ägare fick ${mejl.length} mejl som inte skulle ha skickats.`);
});

Then(/^uppskattningen är räknad$/, function (this: Varld) {
  lyckat(this);
  assert.equal(uppskattningar(this), 1, 'Uppskattningen räknades inte.');
});

Then(/^Anna får veta att hon behöver skriva något först$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 400, `Väntade 400 men fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as ApiErrorBody;
  assert.equal(kropp.error?.code, 'invalid_request');
  assert.match(kropp.error.message, /[Ss]kriv/);
});

Then(/^får hon veta att hon får vänta en stund$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 429, `Väntade 429 men fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as ApiErrorBody;
  assert.equal(kropp.error?.code, 'rate_limited');
  assert.match(kropp.error.message, /[Vv]änta en stund/);
});
