/**
 * Steg för tjänsten `search` (features/tjanster/search.feature).
 *
 * Berget fejkas med en lokal HTTP-server som talar samma OpenAI-kompatibla `/embeddings` som den
 * riktiga — så att tjänstens riktiga HTTP-klient prövas. Fejkens "inbäddning" är ett histogram
 * över teckentrigram: texter med gemensamma ordstammar hamnar nära varandra, vilket räcker för
 * att scenarierna ska kunna säga något om ordningen på träffarna.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Given, Then, When } from '@cucumber/cucumber';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { forberedTjanst } from '../stod/tjanster.ts';
import { jsonKropp } from '../stod/http.ts';
import type { Svar } from '../stod/http.ts';
import { somJsonObjekt } from '../stod/json.ts';
import { dokument } from '../stod/varld.ts';
import type { Varld } from '../stod/varld.ts';

/** Så låga gränser att scenarierna om kvoter når dem på några få anrop. */
const FRAGOR_PER_MINUT = 5;
const TOKENS_PER_DYGN = 4000;
const DIMENSIONER = 256;

interface FejkadBerget {
  /** Varje text som skickats för inbäddning, i den ordning den kom. */
  readonly mottaget: string[];
  trasig: boolean;
}

/** Den pågående scenariots fejk. Scenarierna i en process körs en i taget. */
let fejk: FejkadBerget | undefined;

function aktuellFejk(): FejkadBerget {
  assert.ok(fejk !== undefined, 'Tjänsten search är inte förberedd i det här scenariot.');
  return fejk;
}

function bädda(text: string): number[] {
  const vektor = new Array<number>(DIMENSIONER).fill(0);
  const ren = ` ${text.replace(/^(?:query|passage): /, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  for (let i = 0; i + 3 <= ren.length; i += 1) {
    let hash = 2166136261;
    for (const tecken of ren.slice(i, i + 3)) hash = Math.imul(hash ^ tecken.codePointAt(0)!, 16777619);
    vektor[(hash >>> 0) % DIMENSIONER]! += 1;
  }
  return vektor;
}

forberedTjanst('search', async () => {
  const tillstand: FejkadBerget = { mottaget: [], trasig: false };
  fejk = tillstand;
  const server = createServer((req, res) => {
    const delar: Buffer[] = [];
    req.on('data', (del: Buffer) => delar.push(del));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings' || req.headers.authorization !== 'Bearer bdd-sok-nyckel') {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (tillstand.trasig) {
        res.statusCode = 503;
        res.end('{"error":{"message":"överbelastad"}}');
        return;
      }
      const kropp = JSON.parse(Buffer.concat(delar).toString('utf8')) as { input: string[]; model: string };
      tillstand.mottaget.push(...kropp.input);
      const tokens = kropp.input.reduce((summa, text) => summa + text.length, 0);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          model: kropp.model,
          data: kropp.input.map((text, index) => ({ object: 'embedding', index, embedding: bädda(text) })),
          usage: { prompt_tokens: tokens, total_tokens: tokens },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    miljo: {
      SVC_SEARCH_MODEL: 'intfloat/multilingual-e5-large',
      SVC_SEARCH_QUERIES_PER_USER_MINUTE: String(FRAGOR_PER_MINUT),
      SVC_SEARCH_TOKENS_PER_APP_DAY: String(TOKENS_PER_DYGN),
    },
    berget: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bdd-sok-nyckel' },
    stada: async () => {
      if (fejk === tillstand) fejk = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
});

// ── Hjälp ────────────────────────────────────────────────────────────────────────

interface Traff {
  readonly id: string;
  readonly score: number;
}

function sok(varld: Varld, person: string, app: string, kollektion: string, fraga: string, personlig: boolean): Promise<Svar> {
  return varld.anropaApp({
    app,
    person,
    metod: 'POST',
    sokvag: '/_api/search',
    json: { collection: kollektion, query: fraga, ...(personlig ? { personal: true } : {}) },
  });
}

function traffar(svar: Svar): Traff[] {
  assert.equal(svar.status, 200, `Sökningen misslyckades: ${svar.status} ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as { results?: unknown };
  assert.ok(Array.isArray(kropp.results), 'Svaret saknar träfflista.');
  return kropp.results as Traff[];
}

function senastSparade(varld: Varld, person: string) {
  const sparat = varld.senastSparat.get(person);
  assert.ok(sparat !== undefined, `${person} har inte sparat något dokument i scenariot.`);
  return sparat;
}

// ── Givet ────────────────────────────────────────────────────────────────────────

Given(
  /^att (Anna|Bertil) har sökt efter "([^"]*)" i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, fraga: string, kollektion: string, app: string) {
    traffar(await sok(this, person, app, kollektion, fraga, false));
  },
);

Given(/^att (Anna|Bertil) har ändrat sitt senaste dokument till (\{.*\})$/, async function (this: Varld, person: string, data: string) {
  const sparat = senastSparade(this, person);
  const nytt = somJsonObjekt(data);
  const svar = await this.anropaApp({ app: sparat.app, person, metod: 'PUT', sokvag: dokument(sparat.kollektion, sparat.id), json: { data: nytt } });
  assert.equal(svar.status, 200, `Ändringen misslyckades: ${svar.status}`);
  this.senastSparat.set(person, { ...sparat, data: nytt });
});

Given(/^att (Anna|Bertil) har raderat sitt senaste dokument$/, async function (this: Varld, person: string) {
  const sparat = senastSparade(this, person);
  const svar = await this.anropaApp({ app: sparat.app, person, metod: 'DELETE', sokvag: dokument(sparat.kollektion, sparat.id) });
  assert.ok(svar.status === 200 || svar.status === 204, `Raderingen misslyckades: ${svar.status}`);
});

Given(/^att sökleverantören inte svarar$/, function () {
  aktuellFejk().trasig = true;
});

Given(
  /^att (Anna|Bertil) har sparat (\d+) långa dokument i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, antal: string, kollektion: string, app: string) {
    for (let nummer = 1; nummer <= Number(antal); nummer += 1) {
      const text = `Ärende ${nummer}: ` + 'Protokoll från mötet om lokalerna och budgeten. '.repeat(40);
      await this.sparaDokument(person, app, kollektion, false, { text });
    }
  },
);

// ── När ──────────────────────────────────────────────────────────────────────────

When(
  /^(Anna|Bertil) söker efter "([^"]*)" i (den personliga kollektionen|kollektionen) "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, fraga: string, sort: string, kollektion: string, app: string) {
    this.svar = [await sok(this, person, app, kollektion, fraga, sort === 'den personliga kollektionen')];
  },
);

When(
  /^(Anna|Bertil) söker efter en fråga på (\d+) tecken i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, antal: string, kollektion: string, app: string) {
    this.svar = [await sok(this, person, app, kollektion, 'cykel '.repeat(Number(antal)).slice(0, Number(antal)), false)];
  },
);

When(
  /^(Anna|Bertil) söker efter "([^"]*)" (\d+) gånger i rad i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, fraga: string, antal: string, kollektion: string, app: string) {
    const svar: Svar[] = [];
    for (let i = 0; i < Number(antal); i += 1) svar.push(await sok(this, person, app, kollektion, fraga, false));
    // De första ska ha gått bra; bara det sista bedöms av Så-steget.
    for (const tidigare of svar.slice(0, -1)) traffar(tidigare);
    this.svar = svar.slice(-1);
  },
);

// ── Så ───────────────────────────────────────────────────────────────────────────

Then(/^är den första träffen dokumentet (\{.*\})$/, async function (this: Varld, data: string) {
  const [forsta] = traffar(this.endaSvaret());
  assert.ok(forsta !== undefined, 'Sökningen gav inga träffar.');
  assert.ok(typeof forsta.score === 'number' && Number.isFinite(forsta.score));
  // Id:t slås upp som en app gör: dokumentet hämtas med data-API:t (av Anna, som skrev det).
  const hittat = [...this.senastSparat.values()].find((s) => s.id === forsta.id);
  assert.ok(hittat !== undefined, 'Första träffen är inget dokument som scenariot sparat.');
  const svar = await this.anropaApp({ app: hittat.app, person: 'Anna', sokvag: dokument(hittat.kollektion, forsta.id) });
  assert.equal(svar.status, 200);
  assert.deepEqual((jsonKropp(svar) as { data: unknown }).data, somJsonObjekt(data));
});

Then(/^får (?:han|hon) inga träffar$/, function (this: Varld) {
  assert.deepEqual(traffar(this.endaSvaret()), []);
});

Then(/^finns (Anna|Bertil)s raderade dokument inte bland träffarna$/, function (this: Varld, agare: string) {
  const raderat = senastSparade(this, agare);
  const lista = traffar(this.endaSvaret());
  assert.ok(lista.length > 0, 'Sökningen borde ha hittat det dokument som finns kvar.');
  assert.ok(!lista.some((t) => t.id === raderat.id), 'Det raderade dokumentet kom med bland träffarna.');
});

Then(/^har sökleverantören inte fått se telefonnumret "([^"]+)"$/, function (this: Varld, nummer: string) {
  traffar(this.endaSvaret());
  const mottaget = aktuellFejk().mottaget;
  assert.ok(mottaget.length > 0, 'Inget skickades till sökleverantören.');
  const siffror = nummer.replace(/\D/g, '');
  for (const text of mottaget) {
    assert.ok(!text.includes(nummer) && !text.replace(/\D/g, '').includes(siffror), 'Telefonnumret skickades till sökleverantören.');
  }
});

const BESKED: ReadonlyMap<string, { status: number; kod: ApiErrorBody['error']['code'] }> = new Map([
  ['sökningen inte går att använda just nu', { status: 503, kod: 'internal' }],
  ['det blev för många sökningar', { status: 429, kod: 'rate_limited' }],
  ['appens sökkvot för i dag är slut', { status: 429, kod: 'quota_exceeded' }],
]);

Then(/^får (?:han|hon) beskedet att (.+)$/, function (this: Varld, fras: string) {
  const vantat = BESKED.get(fras);
  assert.ok(vantat !== undefined, `Okänt besked "${fras}".`);
  const svar = this.endaSvaret();
  assert.equal(svar.status, vantat.status, `Väntade ${vantat.status} men fick ${svar.status}: ${svar.kropp.slice(0, 200)}`);
  const kropp = jsonKropp(svar) as ApiErrorBody;
  assert.equal(kropp.error?.code, vantat.kod);
  assert.ok(kropp.error.message.length > 0, 'Beskedet saknar text att visa.');
});
