/**
 * När-steg: det någon gör. Varje steg ersätter `this.svar` med svaren på just sina anrop, så att
 * Så-stegen alltid bedömer det som nyss hände. Ett steg som prövar flera varianter av samma
 * handling lägger ALLA svar där — då måste varje variant ge det svar scenariot kräver.
 */
import assert from 'node:assert/strict';
import { When } from '@cucumber/cucumber';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { newAppId } from './stod/app-id.ts';
import { SKRIPTETS_SOKVAG } from './stod/fixtur.ts';
import { anropa } from './stod/http.ts';
import { somJsonObjekt } from './stod/json.ts';
import { DOMAN, LITET_DOKUMENT, dokument, dokumentlista } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

// ── Lista ────────────────────────────────────────────────────────────────────────

When(
  /^(Anna|Bertil) listar (den personliga kollektionen|kollektionen) "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, sort: string, kollektion: string, app: string) {
    // "kollektionen" utan tillägg = appen anger ingen synlighet alls; plattformens standard gäller.
    const scope = sort === 'den personliga kollektionen' ? 'user' : undefined;
    this.svar = [await this.anropaApp({ app, person, sokvag: dokumentlista(kollektion, scope) })];
  },
);

When(
  /^(Anna|Bertil) listar kollektionen "([^"]+)" i appen "([^"]+)" som om den vore gemensam$/,
  async function (this: Varld, person: string, kollektion: string, app: string) {
    this.svar = [await this.anropaApp({ app, person, sokvag: dokumentlista(kollektion, 'app') })];
  },
);

When(
  /^(Anna|Bertil) listar kollektionen "([^"]+)" i appen "([^"]+)" och skickar med app-id för "([^"]+)" i frågesträngen$/,
  async function (this: Varld, person: string, kollektion: string, app: string, annanApp: string) {
    const annat = this.appId(annanApp);
    // De namn en slarvig server kunde tänkas lyssna på. Inget av dem får ändra vilken app det gäller.
    const fragor = [`appId=${annat}`, `app_id=${annat}`, `app=${annat}`, `tenant=${annat}`, `host=${this.adress(annanApp)}`];
    this.svar = [];
    for (const fraga of fragor) {
      this.svar.push(await this.anropaApp({ app, person, sokvag: dokumentlista(kollektion, undefined, fraga) }));
    }
  },
);

When(
  /^(Anna|Bertil) listar kollektionen "([^"]+)" i appen "([^"]+)" med huvudet "([^"]+)" satt till adressen för "([^"]+)"$/,
  async function (this: Varld, person: string, kollektion: string, app: string, huvudnamn: string, annanApp: string) {
    this.svar = [
      await this.anropaApp({ app, person, sokvag: dokumentlista(kollektion), huvuden: { [huvudnamn]: this.adress(annanApp) } }),
    ];
  },
);

When(
  /^(Anna|Bertil) listar kollektionen "([^"]+)" i förhandsvisningen av appen "([^"]+)"$/,
  async function (this: Varld, person: string, kollektion: string, app: string) {
    // Att tala om appens förhandsvisning förutsätter att det finns ett utkast att förhandsvisa.
    // Utan det svarar plattformen "finns inte", och scenariot skulle inte pröva datadelningen alls.
    await this.sattUtkast(app);
    this.svar = [await this.anropaApp({ app, forhandsvisning: true, person, sokvag: dokumentlista(kollektion) })];
  },
);

When(
  /^någon som inte är inloggad listar kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, kollektion: string, app: string) {
    this.svar = [await this.anropaApp({ app, sokvag: dokumentlista(kollektion) })];
  },
);

When(
  /^någon med en manipulerad inloggning listar kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, kollektion: string, app: string) {
    // Utgå från en ÄKTA inloggning, så att det enda som skiljer är manipulationen.
    const tidigare = this.senastInloggad;
    const akta = this.loggaIn('Mallory').inloggning;
    this.senastInloggad = tidigare;
    const [nyttolast = '', signatur = ''] = akta.slice('Test '.length).split('.');
    const innehall = JSON.parse(Buffer.from(nyttolast, 'base64url').toString('utf8')) as Record<string, unknown>;
    const andrad = (andring: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify({ ...innehall, ...andring }), 'utf8').toString('base64url');

    const forsok = [
      // Någon annans användar-id (Annas), med den äkta signaturen kvar.
      `Test ${andrad({ userId: this.anvandarId('Anna') })}.${signatur}`,
      // Högre behörighet och längre giltighet.
      `Test ${andrad({ roles: ['admin'], exp: 9_999_999_999 })}.${signatur}`,
      // Orörd nyttolast, ändrad signatur.
      `Test ${nyttolast}.${signatur.slice(0, -2)}${signatur.endsWith('AA') ? 'BB' : 'AA'}`,
      // Ingen signatur alls.
      `Test ${nyttolast}.`,
      `Test ${nyttolast}`,
    ];
    this.svar = [];
    for (const inloggning of forsok) {
      this.svar.push(await this.anropaApp({ app, sokvag: dokumentlista(kollektion), huvuden: { Authorization: inloggning } }));
    }
  },
);

// ── Hämta, ändra, radera ─────────────────────────────────────────────────────────

When(/^(Anna|Bertil) hämtar (Anna|Bertil)s dokument med dess id$/, async function (this: Varld, person: string, agare: string) {
  const sparat = this.senastSparat.get(agare);
  assert.ok(sparat !== undefined, `${agare} har inte sparat något dokument i det här scenariot.`);
  this.svar = [await this.anropaApp({ app: sparat.app, person, sokvag: dokument(sparat.kollektion, sparat.id) })];
});

When(
  /^(Anna|Bertil) försöker ersätta (Anna|Bertil)s dokument med (\{.*\})$/,
  async function (this: Varld, person: string, agare: string, data: string) {
    const sparat = this.senastSparat.get(agare);
    assert.ok(sparat !== undefined, `${agare} har inte sparat något dokument i det här scenariot.`);
    const sokvag = dokument(sparat.kollektion, sparat.id);
    this.svar = [
      await this.anropaApp({ app: sparat.app, person, metod: 'PUT', sokvag, json: { data: somJsonObjekt(data) } }),
      // Rubriken säger "ändra eller radera": raderingen ska nekas på samma sätt.
      await this.anropaApp({ app: sparat.app, person, metod: 'DELETE', sokvag }),
    ];
  },
);

When(
  /^(Anna|Bertil) hämtar samma dokument-id i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, kollektion: string, app: string) {
    const sparat = this.senastSparat.get(person);
    assert.ok(sparat !== undefined, `${person} har inte sparat något dokument i det här scenariot.`);
    this.svar = [await this.anropaApp({ app, person, sokvag: dokument(kollektion, sparat.id) })];
  },
);

When(/^(Anna|Bertil) raderar ett dokument i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  const id = (this.dokumentIApp.get(app) ?? []).at(-1);
  assert.ok(id !== undefined, `Det finns inget dokument att radera i appen "${app}".`);
  this.svar = [await this.anropaApp({ app, person, metod: 'DELETE', sokvag: dokument('poster', id) })];
});

// ── Spara ────────────────────────────────────────────────────────────────────────

When(/^(Anna|Bertil) sparar ett dokument i appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  this.svar = [await this.anropaApp({ app, person, metod: 'POST', sokvag: dokumentlista('poster'), json: LITET_DOKUMENT })];
});

When(
  /^(Anna|Bertil) sparar ett dokument i appen "([^"]+)" utan skyddshuvudet mot förfalskade anrop$/,
  async function (this: Varld, person: string, app: string) {
    this.svar = [
      await this.anropaApp({
        app,
        person,
        metod: 'POST',
        sokvag: dokumentlista('poster'),
        json: LITET_DOKUMENT,
        utanSkyddshuvud: true,
      }),
    ];
  },
);

When(/^(Anna|Bertil) sparar ett dokument på (\d+) kB i appen "([^"]+)"$/, async function (this: Varld, person: string, kilobyte: string, app: string) {
  const json = { data: { fyllnad: 'x'.repeat(Number(kilobyte) * 1024) } };
  this.svar = [await this.anropaApp({ app, person, metod: 'POST', sokvag: dokumentlista('poster'), json })];
});

When(
  /^(Anna|Bertil) sparar ett dokument i kollektionen "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, person: string, kollektion: string, app: string) {
    // Både som namnet står — en klient som inte kodar något — och kodat så som SDK:t skulle göra.
    const varianter = [kollektion, encodeURIComponent(kollektion)];
    this.svar = [];
    for (const namn of varianter) {
      this.svar.push(await this.anropaApp({ app, person, metod: 'POST', sokvag: dokumentlista(namn), json: LITET_DOKUMENT }));
    }
  },
);

// ── Sidor och adresser ───────────────────────────────────────────────────────────

When(/^(Anna|Bertil) öppnar startsidan för appen "([^"]+)"$/, async function (this: Varld, person: string, app: string) {
  this.svar = [await this.anropaApp({ app, person })];
});

When(/^någon som inte är inloggad öppnar startsidan för appen "([^"]+)"$/, async function (this: Varld, app: string) {
  // Startsidan, en sida i appen, och skriptet som startsidan pekar ut.
  this.svar = [
    await this.anropaApp({ app }),
    await this.anropaApp({ app, sokvag: '/index.html' }),
    await this.anropaApp({ app, sokvag: SKRIPTETS_SOKVAG }),
  ];
});

When(/^(Anna|Bertil) öppnar den sidan$/, async function (this: Varld, person: string) {
  assert.ok(this.sida !== undefined, 'Scenariot har inte pekat ut någon sida.');
  this.svar = [await this.anropaApp({ app: this.endaAppen(), person, sokvag: this.sida })];
});

When(/^(Anna|Bertil) öppnar en adress med ett app-id som inte finns$/, async function (this: Varld, person: string) {
  const okant = newAppId();
  this.okantAppId = okant;
  const gemensamt = { port: this.port, host: `${okant}.${DOMAN}:${this.port}` };
  const inloggning = { Authorization: this.person(person).inloggning };
  this.svar = [
    await anropa({ ...gemensamt, huvuden: inloggning }),
    // Att öppna en app är också att dess kod börjar läsa och spara. Inget av det får ge något annat.
    await anropa({ ...gemensamt, sokvag: dokumentlista('poster'), huvuden: inloggning }),
    await anropa({
      ...gemensamt,
      metod: 'POST',
      sokvag: dokumentlista('poster'),
      huvuden: { ...inloggning, [CSRF_HEADER]: '1' },
      json: LITET_DOKUMENT,
    }),
  ];
});

When(/^ett anrop kommer med värdnamnet "([^"]+)"$/, async function (this: Varld, vardnamn: string) {
  // Medvetet UTAN inloggning: "innan något annat händer" betyder att svaret ska vara "ogiltig
  // begäran" och inte "inte inloggad" — värdnamnet prövas före allt annat.
  this.svar = [
    await anropa({ port: this.port, host: vardnamn }),
    await anropa({ port: this.port, host: `${vardnamn}:${this.port}`, sokvag: dokumentlista('poster') }),
  ];
});

When(/^en begäran om att registrera ett bakgrundsskript kommer till appen "([^"]+)"$/, async function (this: Varld, app: string) {
  // Så ser webbläsarens hämtning ut när en sida anropar `navigator.serviceWorker.register()`.
  // Skriptet FINNS och anroparen är inloggad, så det enda som kan neka är själva spärren.
  const person = this.senastInloggad;
  assert.ok(person !== undefined, 'Steget förutsätter att någon är inloggad.');
  this.svar = [await this.anropaApp({ app, person, sokvag: SKRIPTETS_SOKVAG, huvuden: { 'Service-Worker': 'script' } })];
});

When(/^appen "([^"]+)" frågar vem användaren är$/, async function (this: Varld, app: string) {
  const person = this.senastInloggad;
  assert.ok(person !== undefined, 'Steget förutsätter att någon är inloggad.');
  this.svar = [await this.anropaApp({ app, person, sokvag: '/_api/whoami' })];
});
