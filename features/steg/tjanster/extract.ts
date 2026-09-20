/**
 * Steg för tjänsten `extract` (hämta texten ur en bifogad fil). Ingen fejkad leverantör behövs:
 * tjänsten gör allt arbete själv. Filerna byggs här — riktiga zip-arkiv med riktig Office-XML —
 * och laddas upp genom tjänsten `files` (`POST /_api/files`, råa byte med filens typ).
 *
 * Presentationer (pptx) saknas: filtjänsten tar ännu inte emot dem vid uppladdning. Den delen av
 * tjänsten täcks av enhetstesterna i packages/tjanst-extract/test.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { Given, Then, When } from '@cucumber/cucumber';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { createPlatform } from '@vibesandbox/platform';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import type { Varld } from '../stod/varld.ts';

/** Appens dagliga gräns i scenarierna — liten, så att den nås på några anrop. */
const ANROP_PER_DYGN = 3;

const DOCX_TYP = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYP = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Det som står i Word-dokumentet: ett stycke per rad. */
const STYCKEN = ['Protokoll 2026-09-20', 'Beslut: ärendet bordläggs.'];
/** Det som står i kalkylbladet: en rad per rad, tabb mellan cellerna. */
const RADER = [
  ['Ärende', 'Handläggare'],
  ['2026-114', 'Anna'],
];

forberedTjanst('extract', async () => ({
  miljo: {
    SVC_EXTRACT_CALLS_PER_APP_DAY: String(ANROP_PER_DYGN),
    SVC_EXTRACT_CALLS_PER_USER_HOUR: '100',
  },
}));

// ── Filerna ──────────────────────────────────────────────────────────────────────

interface ZipPost {
  readonly namn: string;
  readonly innehall: string;
}

/** Ett riktigt zip-arkiv (packat), byggt för hand: tjänsten läser filer, inte testfixturer. */
function zip(poster: readonly ZipPost[]): Uint8Array {
  const lokala: Buffer[] = [];
  const centrala: Buffer[] = [];
  let offset = 0;
  for (const post of poster) {
    const namn = Buffer.from(post.namn, 'utf8');
    const rått = Buffer.from(post.innehall, 'utf8');
    const data = deflateRawSync(rått);

    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4);
    lokal.writeUInt16LE(8, 8);
    lokal.writeUInt32LE(crc32(rått), 14);
    lokal.writeUInt32LE(data.length, 18);
    lokal.writeUInt32LE(rått.length, 22);
    lokal.writeUInt16LE(namn.length, 26);
    lokala.push(lokal, namn, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(rått), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(rått.length, 24);
    central.writeUInt16LE(namn.length, 28);
    central.writeUInt32LE(offset, 42);
    centrala.push(central, namn);
    offset += 30 + namn.length + data.length;
  }
  const katalog = Buffer.concat(centrala);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(poster.length, 8);
  slut.writeUInt16LE(poster.length, 10);
  slut.writeUInt32LE(katalog.length, 12);
  slut.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...lokala, katalog, slut]));
}

const TYPER = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

/** Ett Word-dokument. `variant` ger olika innehåll, så att olika filer inte är samma fil. */
function wordDokument(variant = 0): Uint8Array {
  const stycken = (variant === 0 ? STYCKEN : [...STYCKEN, `Kopia ${variant}`])
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join('');
  return zip([
    { namn: '[Content_Types].xml', innehall: TYPER },
    {
      namn: 'word/document.xml',
      innehall: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${stycken}</w:body></w:document>`,
    },
  ]);
}

function kalkylblad(): Uint8Array {
  const rader = RADER.map(
    (rad, r) =>
      `<row r="${r + 1}">${rad
        .map((cell, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`)
        .join('')}</row>`,
  ).join('');
  return zip([
    { namn: '[Content_Types].xml', innehall: TYPER },
    { namn: 'xl/workbook.xml', innehall: '<?xml version="1.0"?><workbook><sheets><sheet name="Blad1"/></sheets></workbook>' },
    {
      namn: 'xl/worksheets/sheet1.xml',
      innehall: `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${rader}</sheetData></worksheet>`,
    },
  ]);
}

/** En inskannad PDF: ett riktigt PDF-huvud, men ingen text att hämta. */
function inskannadPdf(): Uint8Array {
  const rader = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ];
  return Uint8Array.from(Buffer.from(rader.join('\n'), 'latin1'));
}

// ── Uppladdning och anrop ────────────────────────────────────────────────────────

/** Uppladdade filer i scenariot: "dokumentet", "kalkylbladet" … → fil-id. */
const filer = new Map<Varld, Map<string, string>>();

function filId(varld: Varld, vilken: string): string {
  const id = filer.get(varld)?.get(vilken);
  if (id === undefined) throw new Error(`Scenariot har inte bifogat "${vilken}".`);
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

async function bifoga(varld: Varld, vilken: string, person: string, app: string, bytes: Uint8Array, typ: string): Promise<void> {
  const id = await laddaUpp(varld, person, app, bytes, typ);
  const varldensFiler = filer.get(varld) ?? new Map<string, string>();
  varldensFiler.set(vilken, id);
  filer.set(varld, varldensFiler);
}

function hamtaText(varld: Varld, person: string, app: string, fileId: string): Promise<Svar> {
  return varld.anropaApp({ app, person, metod: 'POST', sokvag: '/_api/extract', json: { fileId } });
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(/^att (Anna) har bifogat ett Word-dokument i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await bifoga(this, 'dokumentet', person, app, wordDokument(), DOCX_TYP);
});

Given(/^att (Anna) har bifogat ett kalkylblad i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await bifoga(this, 'kalkylbladet', person, app, kalkylblad(), XLSX_TYP);
});

Given(/^att (Anna) har bifogat en anteckning i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await bifoga(this, 'anteckningen', person, app, new TextEncoder().encode('Kom ihåg att ringa Bertil.'), 'text/plain');
});

Given(/^att (Anna) har bifogat en inskannad PDF i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  await bifoga(this, 'den inskannade filen', person, app, inskannadPdf(), 'application/pdf');
});

Given(/^att appen "([^"]+)" redan har hämtat text så många gånger som den får i dag$/, async function (this: Varld, app: string) {
  for (let i = 1; i <= ANROP_PER_DYGN; i += 1) {
    const id = await laddaUpp(this, 'Anna', app, wordDokument(i), DOCX_TYP);
    const svar = await hamtaText(this, 'Anna', app, id);
    assert.equal(svar.status, 200, `Förberedelsen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  }
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna) ber appen "([^"]+)" hämta texten ur (dokumentet|kalkylbladet|anteckningen|den inskannade filen)( två gånger)?$/,
  // Cucumber ger en grupp som inte matchat som `null`, inte `undefined` — därför ett sanningstest.
  async function (this: Varld, person: string, app: string, vilken: string, tvaGanger: string | null) {
    const id = filId(this, vilken);
    this.svar = [await hamtaText(this, person, app, id)];
    if (tvaGanger) this.svar.push(await hamtaText(this, person, app, id));
  },
);

let startfel: unknown;

When(/^plattformen startas med texthämtning men utan filtjänsten$/, async function (this: Varld) {
  const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bdd-extract-'));
  startfel = undefined;
  try {
    const plattform = createPlatform({
      baseDomain: 'appar.test',
      appDomain: 'appar.test',
      dataDir: join(katalog, 'data'),
      port: 0,
      listenHost: '127.0.0.1',
      publicScheme: 'http',
      identity: { provider: 'test', testSecret: 'bdd-hemlighet-for-extract-scenariot-0123456789ab' },
      appServices: { enabled: ['extract'], env: {} },
    });
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

function felsvar(svar: Svar): ApiErrorBody['error'] {
  const kropp = jsonKropp(svar) as Partial<ApiErrorBody>;
  assert.ok(kropp.error !== undefined && typeof kropp.error.message === 'string' && kropp.error.message.length > 0, 'Felsvaret saknar ett meddelande.');
  return kropp.error;
}

interface Textsvar {
  readonly text?: unknown;
  readonly kind?: unknown;
  readonly hasText?: unknown;
  readonly message?: unknown;
}

function textsvar(svar: Svar): Textsvar {
  assert.equal(svar.status, 200, `${svar.status} ${svar.kropp.slice(0, 200)}`);
  return jsonKropp(svar) as Textsvar;
}

Then(/^vägrar plattformen starta och förklarar att filtjänsten också måste slås på$/, function (this: Varld) {
  assert.ok(startfel instanceof Error, 'Plattformen startade trots att filtjänsten saknas.');
  assert.match(startfel.message, /files/);
  assert.match(startfel.message, /slå på båda/);
});

Then(/^får hon texten ur dokumentet, ett stycke per rad$/, function (this: Varld) {
  const kropp = textsvar(this.endaSvaret());
  assert.equal(kropp.kind, 'docx');
  assert.equal(kropp.text, STYCKEN.join('\n'));
});

Then(/^får hon kalkylbladets rader med en tabb mellan cellerna$/, function (this: Varld) {
  const kropp = textsvar(this.endaSvaret());
  assert.equal(kropp.kind, 'xlsx');
  assert.equal(kropp.text, RADER.map((rad) => rad.join('\t')).join('\n'));
});

Then(/^får hon samma text ur dokumentet båda gångerna$/, function (this: Varld) {
  assert.equal(this.svar.length, 2);
  const texter = this.svar.map((svar) => textsvar(svar).text);
  assert.equal(texter[0], STYCKEN.join('\n'));
  assert.equal(texter[1], texter[0]);
});

Then(/^får hon veta att filen saknar text att hämta och att den behöver läsas som en bild$/, function (this: Varld) {
  const kropp = textsvar(this.endaSvaret());
  assert.equal(kropp.text, '');
  assert.equal(kropp.hasText, false);
  assert.match(String(kropp.message), /bild/i);
});

Then(/^får hon veta att gränsen för texthämtning i dag är nådd$/, function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 429, `${svar.status} ${svar.kropp.slice(0, 200)}`);
  assert.equal(felsvar(svar).code, 'rate_limited');
  assert.match(felsvar(svar).message, /gräns/);
});
