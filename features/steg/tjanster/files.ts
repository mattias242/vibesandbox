/**
 * Stegen för plattformstjänsten `files` (features/tjanster/files.feature).
 *
 * Tjänsten förbereds med små gränser (1 MB per fil, 2 MB per app) så att scenarierna om för
 * stora filer och fullt utrymme går fort, och med en fejkad clamd så att virusskanningen prövas
 * på riktigt, över TCP, i varje scenario.
 *
 * Uppladdningar skickas som råa byte — det världens JSON-klient inte kan — med Nodes egen
 * HTTP-klient, men med samma inloggning, skyddshuvud och värdnamn som `Varld.anropaApp`.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Given, Then, When } from '@cucumber/cucumber';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { FEJKVIRUS_MARKOR, HTML, PDF, PNG, SVG, SVG_MED_XML, startaFejkClamd } from '@vibesandbox/tjanst-files/testing';
import { huvud, jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { forberedTjanst } from '../stod/tjanster.ts';
import type { Varld } from '../stod/varld.ts';

const MAX_FIL_MB = 1;
const KVOT_MB = 2;

forberedTjanst('files', async () => {
  const clamd = await startaFejkClamd();
  return {
    miljo: { SVC_FILES_MAX_FILE_MB: String(MAX_FIL_MB), SVC_FILES_QUOTA_MB: String(KVOT_MB), SVC_FILES_CLAMD: clamd.adress },
    stada: () => clamd.stang(),
  };
});

interface UppladdadFil {
  readonly app: string;
  readonly person: string;
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** Scenariots filer. Världen är gemensam och ändras inte av en tjänst, så tillståndet hålls här. */
const FILER = new WeakMap<Varld, { senaste?: UppladdadFil; per: Map<string, UppladdadFil> }>();

function filer(varld: Varld): { senaste?: UppladdadFil; per: Map<string, UppladdadFil> } {
  let tillstand = FILER.get(varld);
  if (tillstand === undefined) {
    tillstand = { per: new Map() };
    FILER.set(varld, tillstand);
  }
  return tillstand;
}

interface BinartSvar {
  readonly svar: Svar;
  readonly bytes: Buffer;
}

/** Ett anrop till appen med råa byte i och ur. Svaret har samma form som världens `Svar`. */
function anropaBinart(
  varld: Varld,
  anrop: { app: string; person: string; metod: string; sokvag: string; bytes?: Uint8Array; typ?: string; forhandsvisning?: boolean },
): Promise<BinartSvar> {
  const huvuden: Record<string, string> = {
    Host: varld.adress(anrop.app, anrop.forhandsvisning === true),
    Authorization: varld.person(anrop.person).inloggning,
    Connection: 'close',
  };
  if (anrop.metod !== 'GET') huvuden[CSRF_HEADER] = '1';
  if (anrop.bytes !== undefined) {
    huvuden['Content-Type'] = anrop.typ ?? 'application/octet-stream';
    huvuden['Content-Length'] = String(anrop.bytes.length);
  }
  return new Promise((resolve, reject) => {
    let klar = false;
    const req = request({ host: '127.0.0.1', port: varld.port, method: anrop.metod, path: anrop.sokvag, headers: huvuden }, (res) => {
      const bitar: Buffer[] = [];
      res.on('data', (bit: Buffer) => bitar.push(bit));
      res.on('end', () => {
        klar = true;
        const bytes = Buffer.concat(bitar);
        const hv: Record<string, string[]> = {};
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          (hv[(res.rawHeaders[i] ?? '').toLowerCase()] ??= []).push(res.rawHeaders[i + 1] ?? '');
        }
        const kropp = bytes.toString('utf8');
        resolve({ svar: { status: res.statusCode ?? 0, huvuden: hv, kropp, ratt: kropp }, bytes });
      });
    });
    // Nekar gatewayn en för stor kropp kan skrivandet avbrytas efter att svaret kommit; då gäller svaret.
    req.on('error', (fel) => {
      if (!klar) reject(fel);
    });
    req.end(anrop.bytes === undefined ? undefined : Buffer.from(anrop.bytes));
  });
}

async function laddaUpp(
  varld: Varld,
  person: string,
  app: string,
  namn: string,
  bytes: Uint8Array,
  typ: string,
  personlig = false,
): Promise<Svar> {
  const sokvag = `/_api/files?name=${encodeURIComponent(namn)}${personlig ? '&personal=true' : ''}`;
  const { svar } = await anropaBinart(varld, { app, person, metod: 'POST', sokvag, bytes, typ });
  if (svar.status === 201) {
    const { id } = jsonKropp(svar) as { id: string };
    const fil = { app, person, id, bytes };
    filer(varld).senaste = fil;
    filer(varld).per.set(person, fil);
  }
  return svar;
}

function exempel(sort: string): { bytes: Uint8Array; typ: string } {
  return sort === 'bilden' ? { bytes: PNG, typ: 'image/png' } : { bytes: PDF, typ: 'application/pdf' };
}

function senaste(varld: Varld): UppladdadFil {
  const fil = filer(varld).senaste;
  assert.ok(fil !== undefined, 'Ingen fil har laddats upp i scenariot.');
  return fil;
}

function filAv(varld: Varld, person: string): UppladdadFil {
  const fil = filer(varld).per.get(person);
  assert.ok(fil !== undefined, `${person} har inte laddat upp någon fil i scenariot.`);
  return fil;
}

/** En fil som når precis över gränsen, men med en riktig bilds början (så att det är storleken som avgör). */
function stor(bytes: number): Uint8Array {
  const fil = new Uint8Array(bytes);
  fil.set(PNG);
  return fil;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(
  /^att (Anna|Bertil) har laddat upp (bilden|dokumentet|den personliga filen) "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, sort: string, namn: string, app: string) {
    const { bytes, typ } = exempel(sort === 'bilden' ? 'bilden' : 'dokumentet');
    const svar = await laddaUpp(this, person, app, namn, bytes, typ, sort === 'den personliga filen');
    assert.equal(svar.status, 201, `Uppladdningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  },
);

Given(/^att appen "([^"]+)" har fyllt sitt utrymme för filer$/, async function (this: Varld, app: string) {
  const person = this.senastInloggad;
  assert.ok(person !== undefined, 'Steget förutsätter att någon är inloggad.');
  // Nästan en hel fil i taget tills appen säger nej; det ska ske inom kvoten delat med filstorleken.
  const storlek = MAX_FIL_MB * 1024 * 1024 - 1024;
  for (let forsok = 0; ; forsok += 1) {
    assert.ok(forsok <= (KVOT_MB / MAX_FIL_MB) * 2 + 2, 'Appens utrymme för filer tog aldrig slut.');
    const svar = await laddaUpp(this, person, app, `fyllnad-${forsok}.png`, stor(storlek), 'image/png');
    if (svar.status !== 201) {
      assert.equal(svar.status, 507, `Oväntat svar medan appen fylldes: ${svar.status} ${svar.kropp.slice(0, 200)}`);
      break;
    }
  }
});

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna|Bertil) laddar upp (bilden|dokumentet) "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, sort: string, namn: string, app: string) {
    const { bytes, typ } = exempel(sort);
    this.svar = [await laddaUpp(this, person, app, namn, bytes, typ)];
  },
);

When(/^(Anna|Bertil) listar filerna i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  this.svar = [await this.anropaApp({ app, person, sokvag: '/_api/files' })];
});

When(/^(Anna|Bertil) försöker hämta och ta bort (Anna|Bertil)s fil$/, async function (this: Varld, person: string, agare: string) {
  const fil = filAv(this, agare);
  this.svar = [
    await this.anropaApp({ app: fil.app, person, sokvag: `/_api/files/${fil.id}` }),
    await this.anropaApp({ app: fil.app, person, sokvag: `/_api/files/${fil.id}/content` }),
    await this.anropaApp({ app: fil.app, person, metod: 'DELETE', sokvag: `/_api/files/${fil.id}` }),
  ];
});

When(
  /^(Anna|Bertil) laddar upp en SVG-bild som kallar sig "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, namn: string, app: string) {
    // Förklädd på alla sätt vi kan tänka oss: som PNG, som sig själv, med XML-huvud och utan typ.
    this.svar = [
      await laddaUpp(this, person, app, namn, SVG, 'image/png'),
      await laddaUpp(this, person, app, namn, SVG, 'image/svg+xml'),
      await laddaUpp(this, person, app, namn, SVG_MED_XML, 'image/png'),
      await laddaUpp(this, person, app, namn, SVG, 'application/octet-stream'),
      await laddaUpp(this, person, app, namn, SVG, 'text/plain'),
    ];
  },
);

When(
  /^(Anna|Bertil) laddar upp en webbsida som kallar sig "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, namn: string, app: string) {
    this.svar = [];
    for (const typ of ['text/html', 'text/plain', 'application/octet-stream', 'image/png']) {
      this.svar.push(await laddaUpp(this, person, app, namn, HTML, typ));
    }
  },
);

When(
  /^(Anna|Bertil) laddar upp ett PDF-dokument som påstår att det är en bild i appen "([^"]+)"$/,
  async function (this: Varld, person: string, app: string) {
    this.svar = [
      await laddaUpp(this, person, app, 'bild.png', PDF, 'image/png'),
      await laddaUpp(this, person, app, 'bild.jpg', PDF, 'image/jpeg'),
    ];
  },
);

When(/^(Anna|Bertil) hämtar samma fil i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const fil = senaste(this);
  assert.notEqual(fil.app, app, 'Scenariot ska hämta filen i en ANNAN app.');
  this.svar = [
    await this.anropaApp({ app, person, sokvag: `/_api/files/${fil.id}` }),
    await this.anropaApp({ app, person, sokvag: `/_api/files/${fil.id}/content` }),
  ];
});

When(/^(Anna|Bertil) hämtar samma fil i förhandsvisningen av appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const fil = senaste(this);
  // Utan ett utkast svarar förhandsvisningen "finns inte" för allt, och scenariot prövade ingenting.
  await this.sattUtkast(app);
  const lista = await this.anropaApp({ app, person, forhandsvisning: true, sokvag: '/_api/files' });
  assert.equal(lista.status, 200, `Förhandsvisningen svarar inte alls: ${lista.status} ${lista.kropp.slice(0, 200)}`);
  assert.deepEqual((jsonKropp(lista) as { files: unknown[] }).files, [], 'Utkastet ser den publicerade appens filer.');
  this.svar = [
    await this.anropaApp({ app, person, forhandsvisning: true, sokvag: `/_api/files/${fil.id}` }),
    await this.anropaApp({ app, person, forhandsvisning: true, sokvag: `/_api/files/${fil.id}/content` }),
  ];
});

When(/^(Anna|Bertil) (?:tar|försöker ta) bort (Anna|Bertil)s fil$/, async function (this: Varld, person: string, agare: string) {
  const fil = filAv(this, agare);
  this.svar = [await this.anropaApp({ app: fil.app, person, metod: 'DELETE', sokvag: `/_api/files/${fil.id}` })];
  filer(this).senaste = { ...fil, person };
});

When(
  /^(Anna|Bertil) laddar upp en fil som är större än gränsen i appen "([^"]+)"$/,
  async function (this: Varld, person: string, app: string) {
    this.svar = [await laddaUpp(this, person, app, 'stor.png', stor(MAX_FIL_MB * 1024 * 1024 + 1), 'image/png')];
  },
);

When(/^(Anna|Bertil) laddar upp en fil med skadlig kod i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const text = Uint8Array.from(Buffer.from(`Helt vanlig text.\n${FEJKVIRUS_MARKOR}\n`, 'utf8'));
  this.svar = [await laddaUpp(this, person, app, 'anteckning.txt', text, 'text/plain')];
});

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^sparas filen som "([^"]+)" av typen "([^"]+)"$/, function (this: Varld, namn: string, typ: string) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 201, `Uppladdningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const fil = jsonKropp(svar) as Record<string, unknown>;
  const uppladdad = senaste(this);
  assert.equal(fil['name'], namn);
  assert.equal(fil['contentType'], typ);
  assert.equal(fil['size'], uppladdad.bytes.length);
  assert.equal(fil['uploadedBy'], this.person(uppladdad.person).identitet.userId);
  assert.match(String(fil['createdAt']), /^\d{4}-\d{2}-\d{2}T/);
});

async function hamtaInnehall(varld: Varld): Promise<BinartSvar> {
  const fil = senaste(varld);
  const svar = await anropaBinart(varld, { app: fil.app, person: fil.person, metod: 'GET', sokvag: `/_api/files/${fil.id}/content` });
  assert.equal(svar.svar.status, 200, `Filen gick inte att hämta: ${svar.svar.status} ${svar.svar.kropp.slice(0, 200)}`);
  assert.ok(Buffer.from(fil.bytes).equals(svar.bytes), 'Innehållet är inte det som laddades upp.');
  assert.equal(huvud(svar.svar, 'X-Content-Type-Options'), 'nosniff');
  assert.match(huvud(svar.svar, 'Cache-Control') ?? '', /no-store/);
  return svar;
}

Then(/^kan filen visas direkt i webbläsaren$/, async function (this: Varld) {
  const { svar } = await hamtaInnehall(this);
  assert.equal(huvud(svar, 'Content-Type'), 'image/png');
  assert.match(huvud(svar, 'Content-Disposition') ?? '', /^inline(?:;|$)/);
});

Then(/^laddas filen ned som en bilaga med namnet "([^"]+)"$/, async function (this: Varld, namn: string) {
  const { svar } = await hamtaInnehall(this);
  assert.equal(huvud(svar, 'Content-Disposition'), `attachment; filename="${namn}"`);
});

function filnamnIListan(varld: Varld): string[] {
  const svar = varld.endaSvaret();
  assert.equal(svar.status, 200, `Listningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const { files } = jsonKropp(svar) as { files: { name: string }[] };
  assert.ok(Array.isArray(files), 'Svaret saknar fillista.');
  return files.map((f) => f.name);
}

Then(/^finns filen "([^"]+)" i listan$/, function (this: Varld, namn: string) {
  assert.ok(filnamnIListan(this).includes(namn), `"${namn}" saknas i listan.`);
});

Then(/^finns inte filen "([^"]+)" i listan$/, function (this: Varld, namn: string) {
  assert.ok(!filnamnIListan(this).includes(namn), `"${namn}" syns i listan.`);
});

Then(/^är filen borta$/, async function (this: Varld) {
  const svar = this.endaSvaret();
  assert.equal(svar.status, 204, `Borttagningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const fil = senaste(this);
  for (const sokvag of [`/_api/files/${fil.id}`, `/_api/files/${fil.id}/content`]) {
    const efter = await this.anropaApp({ app: fil.app, person: fil.person, sokvag });
    assert.equal(efter.status, 404, `${sokvag} finns kvar efter borttagningen: ${efter.status}`);
  }
});
