/**
 * Steg för tjänsten `ocr` (textigenkänning). Berget fejkas med en lokal HTTP-server som svarar
 * som ett OpenAI-kompatibelt API med en bildförstående modell och räknar hur många bilder som
 * skickats — det riktiga API:t anropas aldrig.
 *
 * Filerna laddas upp genom tjänsten `files` (`POST /_api/files`, råa byte med filens typ).
 * Den finns inte i samma gren som den här filen byggdes i; scenarierna som behöver den är
 * taggade `@pågår` tills båda tjänsterna finns.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Given, Then, When } from '@cucumber/cucumber';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { createPlatform } from '@vibesandbox/platform';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import type { Varld } from '../stod/varld.ts';

/** Det som "står på kvittot" — fejkens svar för varje bild. */
const KVITTOTEXT = 'ICA Kvantum Västerås\nKaffe 49,90\nSUMMA 49,90 kr';
/** Det fejken svarar när den är ur funktion. Får aldrig nå appen. */
const HEMLIGT_FEL = 'intern-stackspårning-sk-hemlig-nyckel-0123';
/** Appens dagliga gräns i scenarierna — liten, så att den nås på några anrop. */
const SIDOR_PER_DYGN = 3;

interface FejkadBerget {
  anrop: number;
  trasig: boolean;
}

let berget: FejkadBerget | undefined;

function fejk(): FejkadBerget {
  if (berget === undefined) throw new Error('Scenariot har inte slagit på tjänsten ocr (@tjanst-ocr).');
  return berget;
}

forberedTjanst('ocr', async () => {
  const tillstand: FejkadBerget = { anrop: 0, trasig: false };
  berget = tillstand;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      tillstand.anrop += 1;
      if (tillstand.trasig) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: HEMLIGT_FEL } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: KVITTOTEXT }, finish_reason: 'stop' }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adress = server.address();
  if (adress === null || typeof adress === 'string') throw new Error('Fejkad Berget fick ingen port.');
  return {
    miljo: {
      SVC_OCR_MODEL: 'fejk/bildmodell',
      SVC_OCR_PAGES_PER_APP_DAY: String(SIDOR_PER_DYGN),
      SVC_OCR_PAGES_PER_USER_HOUR: '100',
    },
    berget: { baseUrl: `http://127.0.0.1:${adress.port}/v1`, apiKey: 'bdd-nyckel-som-aldrig-lamnar-datorn' },
    stada: async () => {
      berget = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
});

// ── Filer ────────────────────────────────────────────────────────────────────────

/** En riktig, liten PNG-bild. `variant` ger olika innehåll, så att olika filer inte är samma fil. */
function pngBild(variant = 0): Uint8Array {
  const chunk = (typ: string, data: Buffer): Buffer => {
    const langd = Buffer.alloc(4);
    langd.writeUInt32BE(data.length);
    const typOchData = Buffer.concat([Buffer.from(typ, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typOchData));
    return Buffer.concat([langd, typOchData, crc]);
  };
  const bredd = 4;
  const hojd = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bredd, 0);
  ihdr.writeUInt32BE(hojd, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8 bitar, gråskala
  const rader = Buffer.alloc((bredd + 1) * hojd, variant % 256);
  for (let rad = 0; rad < hojd; rad += 1) rader[rad * (bredd + 1)] = 0; // filtertyp 0
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rader)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Uppladdade filer i scenariot: "kvittot", "textfilen" → fil-id. */
const filer = new Map<Varld, Map<string, string>>();

function filId(varld: Varld, vilken: string): string {
  const id = filer.get(varld)?.get(vilken);
  if (id === undefined) throw new Error(`Scenariot har inte laddat upp "${vilken}".`);
  return id;
}

/** Laddar upp råa byte med tjänsten `files` och kräver att det gick. */
function laddaUpp(varld: Varld, person: string, app: string, bytes: Uint8Array, typ: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: varld.port,
        method: 'POST',
        path: '/_api/files',
        headers: {
          Host: varld.adress(app),
          Authorization: varld.person(person).inloggning,
          [CSRF_HEADER]: '1',
          'Content-Type': typ,
          'Content-Length': String(bytes.byteLength),
        },
      },
      (res) => {
        const delar: Buffer[] = [];
        res.on('data', (del: Buffer) => delar.push(del));
        res.on('end', () => {
          const text = Buffer.concat(delar).toString('utf8');
          if (res.statusCode !== 201 && res.statusCode !== 200) {
            reject(new Error(`Uppladdningen misslyckades: ${res.statusCode} ${text.slice(0, 200)}`));
            return;
          }
          const id = (JSON.parse(text) as { id?: unknown }).id;
          if (typeof id !== 'string') reject(new Error('Uppladdningen gav inget fil-id.'));
          else resolve(id);
        });
      },
    );
    req.on('error', reject);
    req.end(Buffer.from(bytes));
  });
}

async function sparaFil(varld: Varld, vilken: string, person: string, app: string, bytes: Uint8Array, typ: string): Promise<void> {
  const id = await laddaUpp(varld, person, app, bytes, typ);
  const varldensFiler = filer.get(varld) ?? new Map<string, string>();
  varldensFiler.set(vilken, id);
  filer.set(varld, varldensFiler);
}

function lasText(varld: Varld, person: string, app: string, fileId: string): Promise<Svar> {
  return varld.anropaApp({ app, person, metod: 'POST', sokvag: '/_api/ocr', json: { fileId, language: 'sv' } });
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna) har laddat upp en bild av ett kvitto i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await sparaFil(this, 'kvittot', person, app, pngBild(), 'image/png');
});

Given(/^att (Anna) har laddat upp en textfil i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await sparaFil(this, 'textfilen', person, app, new TextEncoder().encode('Inköpslista: mjölk, bröd'), 'text/plain');
});

Given(/^att textigenkänningen hos Berget är ur funktion$/, function (this: Varld) {
  fejk().trasig = true;
});

Given(/^att appen "([^"]+)" redan har läst så många sidor som den får i dag$/, async function (this: Varld, app: string) {
  for (let i = 1; i <= SIDOR_PER_DYGN; i += 1) {
    const id = await laddaUpp(this, 'Anna', app, pngBild(i), 'image/png');
    const svar = await lasText(this, 'Anna', app, id);
    assert.equal(svar.status, 200, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  }
  fejk().anrop = 0;
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna) ber appen "([^"]+)" läsa texten i (kvittot|textfilen)( två gånger)?$/,
  async function (this: Varld, person: string, app: string, vilken: string, tvaGanger: string | undefined) {
    const id = filId(this, vilken);
    this.svar = [await lasText(this, person, app, id)];
    if (tvaGanger !== undefined) this.svar.push(await lasText(this, person, app, id));
  },
);

let startfel: unknown;

When(/^plattformen startas med textigenkänning men utan filtjänsten$/, async function (this: Varld) {
  const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bdd-ocr-'));
  startfel = undefined;
  try {
    const plattform = createPlatform(
      {
        baseDomain: 'appar.test',
        appDomain: 'appar.test',
        dataDir: join(katalog, 'data'),
        port: 0,
        listenHost: '127.0.0.1',
        publicScheme: 'http',
        identity: { provider: 'test', testSecret: 'bdd-hemlighet-for-ocr-scenariot-0123456789abcdef' },
        appServices: { enabled: ['ocr'], env: { SVC_OCR_MODEL: 'fejk/bildmodell' } },
      },
      { appServiceOverrides: { berget: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'aldrig-anvand' } } },
    );
    await plattform.close();
  } catch (fel) {
    startfel = fel;
  } finally {
    // Plattformen stänger det den hunnit öppna i bakgrunden; ge den en stund innan katalogen tas bort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(katalog, { recursive: true, force: true });
  }
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^vägrar plattformen starta och förklarar att båda måste slås på$/, function (this: Varld) {
  assert.ok(startfel instanceof Error, 'Plattformen startade trots att filtjänsten saknas.');
  assert.match(startfel.message, /files/);
  assert.match(startfel.message, /slå på båda/);
});

Then(/^får hon texten som står på kvittot$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 200, `${svar.status} ${svar.kropp.slice(0, 200)}`);
  assert.equal((jsonKropp(svar) as { text?: unknown }).text, KVITTOTEXT);
});

Then(/^får hon samma text båda gångerna$/, function (this: Varld) {
  assert.equal(this.svar.length, 2);
  for (const svar of this.svar) {
    assert.equal(svar.status, 200, `${svar.status} ${svar.kropp.slice(0, 200)}`);
    assert.equal((jsonKropp(svar) as { text?: unknown }).text, KVITTOTEXT);
  }
});

Then(/^har bilden bara skickats för textigenkänning en gång$/, function (this: Varld) {
  assert.equal(fejk().anrop, 1);
});

Then(/^har ingen bild skickats för textigenkänning$/, function (this: Varld) {
  assert.equal(fejk().anrop, 0);
});

function felsvar(svar: Svar): ApiErrorBody['error'] {
  const kropp = jsonKropp(svar) as Partial<ApiErrorBody>;
  assert.ok(kropp.error !== undefined && typeof kropp.error.message === 'string' && kropp.error.message.length > 0, 'Felsvaret saknar ett meddelande.');
  return kropp.error;
}

Then(/^får hon veta att textigenkänningen inte är tillgänglig just nu$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 503, `${svar.status} ${svar.kropp.slice(0, 200)}`);
  assert.match(felsvar(svar).message, /inte tillgänglig/);
});

Then(/^innehåller svaret inget av det Berget svarade$/, function (this: Varld) {
  assert.ok(!this.endaSvaret().ratt.includes(HEMLIGT_FEL));
  assert.ok(!this.endaSvaret().ratt.includes('sk-hemlig'));
});

Then(/^får hon veta att gränsen för i dag är nådd$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 429, `${svar.status} ${svar.kropp.slice(0, 200)}`);
  assert.equal(felsvar(svar).code, 'rate_limited');
  assert.match(felsvar(svar).message, /gräns/);
});
