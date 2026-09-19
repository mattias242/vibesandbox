/**
 * Stegen för tal till text (features/tjanster/transcribe.feature).
 *
 * Tjänsten `files` finns ännu inte i den här grenen, och plattformen startar inte `transcribe`
 * utan den. Därför körs tjänsten här DIREKT — samma fabrik som plattformen använder — med:
 *   - en fejkad filtjänst (`AppFileReader`) där "har laddat upp" lägger filen, och
 *   - en fejkad Berget på en lokal port, som tar emot riktig multipart över HTTP.
 * Stegen spelar gatewayns roll: hyresgäst, inloggad användare och roll i appen sätts här, precis
 * som gatewayn skulle ha avgjort dem. Därför används `unsafeCreateTenantContext`, som annars är
 * förbehållet gatewayn.
 *
 * När `files` finns: tagga egenskapen @tjanst-files @tjanst-transcribe, låt "har laddat upp" gå
 * genom /_api/files, låt När-stegen anropa /_api/transcribe med `varld.anropaApp`, och registrera
 * den fejkade Berget med `forberedTjanst('transcribe', …)`. Scenarierna behöver inte ändras.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Before, Given, Then, When } from '@cucumber/cucumber';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppAccessRole, AppFileReader, AppId, AppService, AppServiceResponse, TenantContext } from '@vibesandbox/contracts';
import { factory } from '@vibesandbox/tjanst-transcribe';
import { newAppId } from '../stod/app-id.ts';
import type { Varld } from '../stod/varld.ts';

/** Det Berget "hör" i varje inspelning. Får aldrig synas i driftloggen. */
const MOTESTEXT = 'Välkomna till mötet. Första punkten är budgeten.';
/** Bergets egen feltext — får aldrig nå appen. */
const BERGETS_FELTEXT = 'Traceback (most recent call last): CUDA out of memory on gpu-node-7';
/** Bergets gräns för en ljudfil, enligt Bergets dokumentation. */
const BERGETS_GRANS = 100_000_000;

type BergetLage = 'ok' | 'fel' | 'långsam';

interface Fil {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly name: string;
}

interface Tillstand {
  readonly katalog: string;
  readonly appar: Map<string, AppId>;
  readonly roller: Map<string, AppAccessRole>;
  readonly filer: Map<string, Fil>;
  /** Den fil varje person senast laddade upp: app och fil-id. */
  readonly uppladdat: Map<string, { app: string; fileId: string }>;
  readonly logg: unknown[];
  readonly env: Record<string, string>;
  berget: { lage: BergetLage; duration: number; anrop: number; server: Server; baseUrl: string };
  tjanst: AppService | undefined;
  senasteSvar: AppServiceResponse | undefined;
  senasteJobb: string | undefined;
  nastaFil: number;
}

const TILLSTAND = new WeakMap<Varld, Tillstand>();

function tillstand(varld: Varld): Tillstand {
  const t = TILLSTAND.get(varld);
  if (t === undefined) throw new Error('Scenariot om tal till text är inte förberett (taggen @transcribe saknas).');
  return t;
}

/** En giltig WAV: 8 kHz, 8 bitar, mono — 8000 byte per sekund. */
function wav(sekunder: number): Uint8Array {
  const data = Math.round(sekunder * 8000);
  const b = Buffer.alloc(44 + data, 0x80);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return new Uint8Array(b);
}

async function fejkadBerget(t: () => Tillstand): Promise<Tillstand['berget']> {
  const server = createServer((request, response) => {
    request.on('error', () => response.destroy());
    request.resume();
    request.on('end', () => {
      const b = t().berget;
      b.anrop += 1;
      if (b.lage === 'fel') {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(BERGETS_FELTEXT);
        return;
      }
      const svara = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            text: MOTESTEXT,
            duration: t().berget.duration,
            segments: [
              { id: 0, start: 0, end: 2.5, text: ' Välkomna till mötet.' },
              { id: 1, start: 2.5, end: 5, text: ' Första punkten är budgeten.' },
            ],
          }),
        );
      };
      // Långsam: svarar aldrig — tills anslutningen stängs av den som anropade.
      if (b.lage !== 'långsam') svara();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adress = server.address();
  if (adress === null || typeof adress === 'string') throw new Error('Den fejkade Berget fick ingen port.');
  return { lage: 'ok', duration: 5, anrop: 0, server, baseUrl: `http://127.0.0.1:${adress.port}/v1` };
}

Before({ tags: '@transcribe' }, async function (this: Varld) {
  const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bdd-transcribe-'));
  const t: Partial<Tillstand> & { berget?: Tillstand['berget'] } = {
    katalog,
    appar: new Map(),
    roller: new Map(),
    filer: new Map(),
    uppladdat: new Map(),
    logg: [],
    env: {},
    tjanst: undefined,
    senasteSvar: undefined,
    senasteJobb: undefined,
    nastaFil: 0,
  };
  t.berget = await fejkadBerget(() => t as Tillstand);
  TILLSTAND.set(this, t as Tillstand);
});

After({ tags: '@transcribe' }, async function (this: Varld) {
  const t = TILLSTAND.get(this);
  if (t === undefined) return;
  await t.tjanst?.close?.().catch(() => {});
  t.berget.server.closeAllConnections();
  await new Promise<void>((resolve) => t.berget.server.close(() => resolve()));
  await rm(t.katalog, { recursive: true, force: true });
});

// ── Tjänsten, som gatewayn anropar den ─────────────────────────────────────────

function appId(t: Tillstand, app: string): AppId {
  let id = t.appar.get(app);
  if (id === undefined) {
    id = newAppId();
    t.appar.set(app, id);
  }
  return id;
}

function hyresgast(t: Tillstand, app: string): TenantContext {
  return unsafeCreateTenantContext(appId(t, app), 'published');
}

function tjanst(t: Tillstand): AppService {
  if (t.tjanst !== undefined) return t.tjanst;
  const filer: AppFileReader = {
    async read(tenant, fileId) {
      return t.filer.get(`${tenant.appId}:${tenant.kind}:${fileId}`) ?? null;
    },
  };
  t.tjanst = factory({
    dataDir: t.katalog,
    env: t.env,
    log: (rad) => t.logg.push(rad),
    now: () => new Date(),
    members: { members: async () => [] },
    store: {} as never,
    publishedUrl: () => 'http://example.org/',
    berget: { baseUrl: t.berget.baseUrl, apiKey: 'bdd-nyckel-som-bara-finns-i-scenarierna' },
    files: filer,
  }).service;
  return t.tjanst;
}

async function anropa(
  t: Tillstand,
  person: string,
  app: string,
  metod: 'GET' | 'POST',
  segment: readonly string[],
  json?: unknown,
): Promise<AppServiceResponse> {
  return tjanst(t).handle({
    method: metod,
    segments: segment,
    query: '',
    headers: { 'content-type': 'application/json' },
    tenant: hyresgast(t, app),
    identity: { userId: `anv-${person.toLowerCase()}`, email: `${person.toLowerCase()}@example.org`, roles: ['viewer'] },
    access: t.roller.get(person) ?? 'user',
    ...(json === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(json)) }),
  });
}

function kropp(svar: AppServiceResponse): Record<string, unknown> {
  const text = typeof svar.body === 'string' ? svar.body : new TextDecoder().decode(svar.body);
  return JSON.parse(text) as Record<string, unknown>;
}

function ladda(t: Tillstand, person: string, app: string, fil: Omit<Fil, 'name'>): void {
  t.nastaFil += 1;
  const fileId = `fil-${t.nastaFil}`;
  t.filer.set(`${appId(t, app)}:published:${fileId}`, { ...fil, name: `${person}s inspelning.wav` });
  t.uppladdat.set(person, { app, fileId });
}

async function bestall(t: Tillstand, person: string, app?: string): Promise<AppServiceResponse> {
  const fil = t.uppladdat.get(person);
  assert.ok(fil, `${person} har inte laddat upp något.`);
  const svar = await anropa(t, person, app ?? fil.app, 'POST', [], { fileId: fil.fileId, language: 'sv' });
  t.senasteSvar = svar;
  if (svar.status === 202) t.senasteJobb = String(kropp(svar)['jobId']);
  return svar;
}

async function foljTillSlut(t: Tillstand, person: string, app = 'protokoll'): Promise<Record<string, unknown>> {
  assert.ok(t.senasteJobb, 'Inget jobb har beställts.');
  for (let forsok = 0; forsok < 2000; forsok += 1) {
    const jobb = kropp(await anropa(t, person, app, 'GET', [t.senasteJobb]));
    if (jobb['status'] === 'done' || jobb['status'] === 'failed') return jobb;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Utskriften blev aldrig klar.');
}

function felsvar(t: Tillstand, status: number, kod: string): string {
  const svar = t.senasteSvar;
  assert.ok(svar, 'Inget svar att granska.');
  assert.equal(svar.status, status);
  const fel = kropp(svar)['error'] as { code: string; message: string };
  assert.equal(fel.code, kod);
  return fel.message;
}

// ── Givet ──────────────────────────────────────────────────────────────────────

Given('att appen {string} har tal till text påslaget', function (this: Varld, app: string) {
  appId(tillstand(this), app);
});

Given('att {word} äger appen {string} och {word} och {word} använder den', function (this: Varld, agare: string, app: string, a: string, b: string) {
  const t = tillstand(this);
  appId(t, app);
  t.roller.set(agare, 'owner');
  t.roller.set(a, 'user');
  t.roller.set(b, 'user');
});

Given('att {word} har laddat upp en inspelning av ett möte i appen {string}', function (this: Varld, person: string, app: string) {
  ladda(tillstand(this), person, app, { body: wav(5), contentType: 'audio/wav' });
});

Given('att {word} har laddat upp en pdf i appen {string}', function (this: Varld, person: string, app: string) {
  ladda(tillstand(this), person, app, { body: new Uint8Array(Buffer.from('%PDF-1.7\n%âãÏÓ\n')), contentType: 'application/pdf' });
});

Given('att {word} har laddat upp en inspelning som är större än Berget tar emot', function (this: Varld, person: string) {
  const stor = Buffer.alloc(BERGETS_GRANS + 1);
  stor.write('ID3', 0, 'ascii');
  ladda(tillstand(this), person, 'protokoll', { body: new Uint8Array(stor), contentType: 'audio/mpeg' });
});

Given('att {word} har laddat upp en inspelning på {int} minuter', function (this: Varld, person: string, minuter: number) {
  ladda(tillstand(this), person, 'protokoll', { body: wav(minuter * 60), contentType: 'audio/wav' });
});

Given('att appen {string} får skriva ut {int} minuter ljud per dygn', function (this: Varld, _app: string, minuter: number) {
  const t = tillstand(this);
  assert.equal(t.tjanst, undefined, 'Kvoten måste sättas innan tjänsten används.');
  t.env['SVC_TRANSCRIBE_MINUTES_PER_APP_DAY'] = String(minuter);
});

Given('att {word} redan har fått {int} minuter ljud utskrivna i dag', async function (this: Varld, person: string, minuter: number) {
  const t = tillstand(this);
  ladda(t, person, 'protokoll', { body: wav(minuter * 60), contentType: 'audio/wav' });
  t.berget.duration = minuter * 60;
  const svar = await bestall(t, person);
  assert.equal(svar.status, 202);
  assert.equal((await foljTillSlut(t, person))['status'], 'done');
});

Given('att {word} har fått en färdig utskrift av inspelningen', async function (this: Varld, person: string) {
  const t = tillstand(this);
  assert.equal((await bestall(t, person)).status, 202);
  assert.equal((await foljTillSlut(t, person))['status'], 'done');
});

Given('att Berget svarar med ett internt fel', function (this: Varld) {
  tillstand(this).berget.lage = 'fel';
});

Given('att Berget arbetar långsamt', function (this: Varld) {
  tillstand(this).berget.lage = 'långsam';
});

// ── När ────────────────────────────────────────────────────────────────────────

When('{word} ber om en utskrift av inspelningen', async function (this: Varld, person: string) {
  await bestall(tillstand(this), person);
});

When('{word} ber om en utskrift av filen', async function (this: Varld, person: string) {
  await bestall(tillstand(this), person);
});

When('{word} ber om en utskrift av inspelningen i appen {string}', async function (this: Varld, person: string, app: string) {
  await bestall(tillstand(this), person, app);
});

When('plattformen startas om medan utskriften pågår', async function (this: Varld) {
  const t = tillstand(this);
  for (let forsok = 0; t.berget.anrop === 0; forsok += 1) {
    assert.ok(forsok < 1000, 'Utskriften startade aldrig.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(kropp(await anropa(t, 'Bertil', 'protokoll', 'GET', [t.senasteJobb ?? '']))['status'], 'running');
  // Plattformen stänger tjänsterna vid omstart; Berget hinner bli klar med annat under tiden.
  await t.tjanst?.close?.();
  t.tjanst = undefined;
  t.berget.lage = 'ok';
});

// ── Så ─────────────────────────────────────────────────────────────────────────

Then('tar tjänsten emot beställningen och ger ett jobb att följa', function (this: Varld) {
  const t = tillstand(this);
  assert.equal(t.senasteSvar?.status, 202);
  assert.match(t.senasteJobb ?? '', /^[0-9a-f]{32}$/);
});

Then('när jobbet är klart kan {word} läsa texten med tidsangivelser', async function (this: Varld, person: string) {
  const jobb = await foljTillSlut(tillstand(this), person);
  assert.equal(jobb['status'], 'done');
  assert.equal(jobb['text'], MOTESTEXT);
  assert.deepEqual(jobb['segments'], [
    { start: 0, end: 2.5, text: 'Välkomna till mötet.' },
    { start: 2.5, end: 5, text: 'Första punkten är budgeten.' },
  ]);
});

Then('kan {word} läsa utskriften', async function (this: Varld, person: string) {
  const t = tillstand(this);
  const svar = await anropa(t, person, 'protokoll', 'GET', [t.senasteJobb ?? '']);
  assert.equal(svar.status, 200);
  assert.equal(kropp(svar)['text'], MOTESTEXT);
});

Then('för {word} finns utskriften inte', async function (this: Varld, person: string) {
  const t = tillstand(this);
  const svar = await anropa(t, person, 'protokoll', 'GET', [t.senasteJobb ?? '']);
  const okant = await anropa(t, person, 'protokoll', 'GET', ['f'.repeat(32)]);
  assert.equal(svar.status, 404);
  // Samma svar som för ett jobb som inte finns: ingenting röjer att det finns.
  assert.deepEqual(svar, okant);
});

Then('får han svaret att filen inte finns', function (this: Varld) {
  felsvar(tillstand(this), 404, 'not_found');
});

Then('får han svaret att bara ljudfiler kan skrivas ut', function (this: Varld) {
  assert.match(felsvar(tillstand(this), 400, 'invalid_request'), /ljudfiler/);
});

Then('får han svaret att filen är för stor', function (this: Varld) {
  assert.match(felsvar(tillstand(this), 413, 'too_large'), /för stor/);
});

Then('ingenting har skickats till Berget', function (this: Varld) {
  assert.equal(tillstand(this).berget.anrop, 0);
});

Then('får han svaret att dygnets ljudminuter är slut', function (this: Varld) {
  assert.match(felsvar(tillstand(this), 429, 'rate_limited'), /ljudminuter/);
});

Then('misslyckas jobbet med ett begripligt besked på svenska', async function (this: Varld) {
  const jobb = await foljTillSlut(tillstand(this), 'Bertil');
  assert.equal(jobb['status'], 'failed');
  assert.match(String(jobb['error']), /^Det gick inte .*Försök igen/);
});

Then('beskedet innehåller ingenting av det Berget svarade', async function (this: Varld) {
  const t = tillstand(this);
  const jobb = await foljTillSlut(t, 'Bertil');
  for (const del of ['Traceback', 'CUDA', 'gpu-node']) {
    assert.ok(!JSON.stringify(jobb).includes(del), `Beskedet innehåller "${del}".`);
    assert.ok(!JSON.stringify(t.logg).includes(del), `Driftloggen innehåller "${del}".`);
  }
});

Then('blir jobbet klart efter omstarten och {word} kan läsa texten', async function (this: Varld, person: string) {
  const jobb = await foljTillSlut(tillstand(this), person);
  assert.equal(jobb['status'], 'done');
  assert.equal(jobb['text'], MOTESTEXT);
});

Then('innehåller driftloggen varken ljudet eller texten', function (this: Varld) {
  const t = tillstand(this);
  const logg = JSON.stringify(t.logg);
  assert.ok(t.logg.length > 0, 'Driftloggen är tom — då prövar steget ingenting.');
  for (const del of ['Välkomna', 'budgeten', 'RIFF', 'inspelning.wav', 'anv-bertil', 'bertil@']) {
    assert.ok(!logg.includes(del), `Driftloggen innehåller "${del}".`);
  }
  // Varje rad är kort: inget ljud och ingen text ryms.
  for (const rad of t.logg) assert.ok(JSON.stringify(rad).length < 300);
});
