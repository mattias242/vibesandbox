/**
 * Kontrollrummet renderat till märkspråk (ingen webbläsare behövs), efter samma mönster som
 * `startPage.test.ts`. Testfilen är .ts, inte .tsx, så vyn skapas med createElement.
 *
 * Det som låses här är löftet vyn bär. Applistan visar ATT appar finns, aldrig en väg in i dem:
 * hela app-id:t är appens hemliga adress — syns det, eller byggs en länk av det, har vyn gett bort
 * nyckeln till någon annans app. Adresslistan är vyns enda del som ÄNDRAR något, och där är det
 * den egna raden som måste hållas i styr: en förvaltare som sänker sig själv låser ut sig.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Classification, ClassificationSource } from '@vibesandbox/contracts';
import {
  ADMIN_APP_ID_PREFIX_LENGTH,
  CLASSIFICATIONS,
  CLASSIFICATION_SOURCES,
  REDLINE_CATEGORIES,
  type AdminApp,
  type AdminOverview,
  type AdminRegisterEntry,
  type AdminReview,
  type AdminStop,
  type AdminUser,
} from '@vibesandbox/contracts';
import {
  ADMIN_FORBIDDEN,
  ADMIN_OWNER_MISSING,
  ADMIN_REVIEWS_EMPTY,
  ADMIN_REVIEWS_LEAD,
  ADMIN_REVIEW_APPROVE_BUTTON,
  ADMIN_REVIEW_APPROVE_NOTE,
  ADMIN_REVIEW_CODE_NOTE,
  ADMIN_REVIEW_NO_FILES,
  ADMIN_REVIEW_OPEN_BUTTON,
  ADMIN_REVIEW_REASON_LABEL,
  ADMIN_REVIEW_REASON_NOTE,
  ADMIN_REVIEW_REJECT_BUTTON,
  ADMIN_REGISTER_DECOMMISSIONED,
  ADMIN_REGISTER_DECOMMISSIONED_NOTE,
  ADMIN_REGISTER_EMPTY,
  ADMIN_REGISTER_LEAD,
  ADMIN_REGISTER_NEVER_CLASSIFIED,
  ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE,
  ADMIN_REGISTER_PUBLISHED,
  ADMIN_REGISTER_UNPUBLISHED,
  ADMIN_SELF_NOTE,
  ADMIN_STOPS_EMPTY,
  ADMIN_STOPS_PATTERN_NOTE,
  ADMIN_STOPS_PRIVACY_NOTE,
  ADMIN_TITLE,
  CLASSIFICATION_SOURCE_TEXTS,
  CLASSIFICATION_TEXTS,
  REDLINE_TEXTS,
  ROLES,
  ROLE_TEXTS,
} from '../src/admin.ts';
import { AdminView, ReviewCase } from '../src/AdminPage.tsx';

/** Ett riktigt app-id. Bara de första tecknen får nå märkspråket. */
const FULL_ID = '01jabcdefghjkmnpqrstvwxyz0';
const OTHER_ID = '01kzyxwvutsrqponmlkjihgfe1';

const OVERVIEW: AdminOverview = {
  apps: 2,
  published: 1,
  drafts: 1,
  users: { admin: 2, builder: 17, viewer: 134 },
  tokens: { input: 1_234_567, output: 89_000, jobs: 42 },
  failedJobs: 3,
};

const APPS: readonly AdminApp[] = [
  {
    appIdPrefix: FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Bokning av mötesrum',
    ownerEmail: 'anna@example.se',
    updatedAt: '2026-09-19T10:00:00Z',
    hasDraft: true,
    published: true,
    members: 4,
    tokens: { input: 12_000, output: 3_400 },
  },
  {
    appIdPrefix: OTHER_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Enkät om fikat',
    ownerEmail: null,
    updatedAt: '2026-09-17T08:30:00Z',
    hasDraft: false,
    published: false,
    members: 1,
    tokens: { input: 0, output: 0 },
  },
];

/** Första raden är den inloggade själv — `self`. De andra två är någon annan. */
const USERS: readonly AdminUser[] = [
  { userId: 'u-anna', email: 'anna@example.se', role: 'admin', createdAt: '2026-08-01T08:00:00Z', self: true },
  { userId: 'u-karin', email: 'karin@example.se', role: 'builder', createdAt: '2026-08-14T09:30:00Z', self: false },
  { userId: 'u-johan', email: 'johan@example.se', role: 'viewer', createdAt: '2026-09-02T11:15:00Z', self: false },
];

/**
 * Stoppade önskemål: flera kategorier, och en kategori som återkommer — det är just den
 * upprepningen panelen finns för. Ingen rad bär önskemålets text; den finns inte i kontraktet.
 */
const STOPS: readonly AdminStop[] = [
  {
    appIdPrefix: FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    category: 'biometri',
    at: '2026-09-20T14:05:00Z',
  },
  {
    appIdPrefix: OTHER_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    category: 'biometri',
    at: '2026-09-19T09:40:00Z',
  },
  {
    appIdPrefix: OTHER_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    category: 'automatiskt-beslut-om-enskild',
    at: '2026-09-12T16:20:00Z',
  },
];

/**
 * AI-registret: varje nivå och varje källa företrädd minst en gång, plus de två raderna som är
 * lätta att göra fel — en app utan känd ägaradress, och en app som aldrig klassats och därför
 * saknar tidpunkt men ändå står på den strängaste nivån.
 */
const REGISTER: readonly AdminRegisterEntry[] = [
  {
    appIdPrefix: FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Bokning av mötesrum',
    ownerEmail: 'anna@example.se',
    classification: 'oppen',
    source: 'modell',
    classifiedAt: '2026-09-19T10:05:00Z',
    published: true,
    decommissionedAt: null,
  },
  {
    appIdPrefix: OTHER_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Enkät om fikat',
    ownerEmail: null,
    classification: 'intern',
    source: 'modell',
    classifiedAt: '2026-09-17T08:35:00Z',
    published: false,
    decommissionedAt: null,
  },
  {
    appIdPrefix: '01jc3d4e',
    name: 'Anmälan till kursen',
    ownerEmail: 'karin@example.se',
    classification: 'personuppgift',
    source: 'signalord',
    classifiedAt: '2026-09-15T13:20:00Z',
    published: true,
    decommissionedAt: null,
  },
  {
    appIdPrefix: '01jf5g6h',
    name: 'Uppföljning av rehab',
    ownerEmail: 'johan@example.se',
    classification: 'kanslig',
    source: 'fail-closed',
    classifiedAt: '2026-09-11T09:00:00Z',
    published: false,
    decommissionedAt: null,
  },
  {
    appIdPrefix: '01jh7j8k',
    name: 'Ny app',
    ownerEmail: 'johan@example.se',
    classification: 'kanslig',
    source: 'fail-closed',
    classifiedAt: null,
    published: false,
    decommissionedAt: null,
  },
];

/**
 * Granskningskön: äldst först, och de två raderna som säger mest för den som ska läsa koden —
 * en app vars nivå är en gjord bedömning, och en vars nivå ingen kunnat avgöra.
 */
const REVIEWS: readonly AdminReview[] = [
  {
    reviewId: 'a'.repeat(32),
    appIdPrefix: FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Bokning av mötesrum',
    ownerEmail: 'anna@example.se',
    classification: 'personuppgift',
    classificationSource: 'signalord',
    state: 'vantar',
    requestedAt: '2026-09-20T09:00:00Z',
    decidedAt: null,
    reason: null,
  },
  {
    reviewId: 'b'.repeat(32),
    appIdPrefix: OTHER_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: 'Uppföljning av rehab',
    ownerEmail: null,
    classification: 'kanslig',
    classificationSource: 'fail-closed',
    state: 'vantar',
    requestedAt: '2026-09-21T11:30:00Z',
    decidedAt: null,
    reason: null,
  },
];

const CALLBACKS = {
  onInvite: async () => '',
  onSetRole: async () => '',
  onOpenReview: async () => ({ review: REVIEWS[0]!, files: {} }),
  onDecide: async () => '',
};

function render(props: Parameters<typeof AdminView>[0]): string {
  return renderToStaticMarkup(createElement(AdminView, props));
}

const loaded = {
  overview: OVERVIEW,
  apps: APPS,
  users: USERS,
  stops: STOPS,
  register: REGISTER,
  reviews: REVIEWS,
  error: null,
  ...CALLBACKS,
};

/** Vyn innan den vet något: alla sex hämtningarna är obesvarade. */
const pending = {
  ...CALLBACKS,
  overview: null,
  apps: null,
  users: null,
  stops: null,
  register: null,
  reviews: null,
  error: null,
};

/** Märkspråket för en av vyns sex delar, så att en del går att pröva utan de andra. */
function part(html: string, name: 'figures' | 'apps' | 'users' | 'stops' | 'register' | 'granskning'): string {
  const starts = {
    figures: 'admin-figures-heading',
    apps: 'admin-apps-heading',
    users: 'admin-users-heading',
    stops: 'admin-stops-heading',
    register: 'admin-register-heading',
    granskning: 'admin-reviews-heading',
  };
  const order: Array<keyof typeof starts> = ['figures', 'apps', 'users', 'stops', 'register', 'granskning'];
  const from = html.indexOf(starts[name]);
  expect(from, `delen ${name} ska finnas`).toBeGreaterThan(0);
  const next = order[order.indexOf(name) + 1];
  const to = next === undefined ? html.length : html.indexOf(starts[next]);
  return html.slice(from, to > from ? to : html.length);
}

/** Raderna i adresslistans tabellkropp, en sträng var. */
function userRows(html: string): readonly string[] {
  const body = /<tbody>([\s\S]*)<\/tbody>/.exec(part(html, 'users'));
  expect(body, 'adresslistan ska vara en tabell med en kropp').not.toBeNull();
  return (body![1] ?? '').split('<tr').slice(1);
}

describe('kontrollrummet', () => {
  it('har sin rubrik och en lista med apparna i den ordning servern gav dem', () => {
    const html = render(loaded);
    expect(html).toContain(ADMIN_TITLE);
    const first = html.indexOf('Bokning av mötesrum');
    const second = html.indexOf('Enkät om fikat');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('är en riktig tabell med kolumnrubriker', () => {
    const html = part(render(loaded), 'apps');
    expect(html).toContain('<table');
    expect(html.match(/<th scope="col"/g) ?? []).toHaveLength(6);
    expect(html).toMatch(/<th scope="col"[^>]*>App</);
    expect(html).toMatch(/<th scope="col"[^>]*>Ägare</);
  });

  it('visar aldrig ett helt app-id och bygger aldrig en länk av det', () => {
    const html = render(loaded);
    for (const id of [FULL_ID, OTHER_ID]) {
      expect(html, 'hela id:t är appens hemliga adress').not.toContain(id);
      // Inte ens ett tecken mer än förkortningen: då hade servern kunnat läcka resten bit för bit.
      expect(html).not.toContain(id.slice(0, ADMIN_APP_ID_PREFIX_LENGTH + 1));
    }
    expect(html, 'ingen väg in i någon annans app').not.toContain('href');
    expect(html).not.toContain('#/app/');
  });

  it('säger vem som äger appen, och säger rakt ut när adressen inte är känd', () => {
    const html = render(loaded);
    expect(html).toContain('anna@example.se');
    expect(html).toContain(ADMIN_OWNER_MISSING);
    // Appen HAR en ägare — byggverktyget vet vem som skapade den. Det är adressen som saknas,
    // och en text som påstår att ägaren saknas vore osann (se atkomst.ts i byggverktyget).
    expect(html, 'en app utan känd adress har ändå en ägare').not.toMatch(/[Ss]aknar ägare|[Ii]ngen ägare/);
  });

  it('visar lägesetiketter och att en publicerad app ändrats sedan dess', () => {
    const html = render(loaded);
    expect(html).toContain('Publicerad');
    expect(html).toContain('Inte byggd än');
    expect(html).toMatch(/[Ää]ndrad sedan publiceringen/);
  });

  it('skriver stora tal med mellanrum, så att de går att läsa', () => {
    const html = render(loaded);
    expect(html.replace(/[\u00a0\u202f\u2009]/g, ' ')).toContain('1 234 567');
  });

  it('tomt läge är en vänlig mening, inte en tom yta', () => {
    const html = render({ ...loaded, overview: { ...OVERVIEW, apps: 0, published: 0, drafts: 0 }, apps: [] });
    expect(html).toMatch(/Inga appar ännu/);
    expect(part(html, 'apps')).not.toContain('<table');
  });

  it('väntar man på svaret syns det', () => {
    const html = render(pending);
    expect(html).toMatch(/Hämtar|Laddar/);
  });

  it('403 möts med klarspråk i stället för en trasig sida', () => {
    const html = render({ ...pending, error: ADMIN_FORBIDDEN });
    expect(html).toContain(ADMIN_FORBIDDEN);
    expect(html).toContain('notice-error');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<table');
    expect(html, 'inget går att ändra förrän vyn vet hur det ser ut').not.toContain('<button');
  });

  it('applistan är fortfarande ren läsning, medan adressdelen är det som ändrar', () => {
    const html = render(loaded);
    const apps = part(html, 'apps');
    expect(apps, 'ingen knapp rör någon annans app').not.toContain('<button');
    expect(apps).not.toContain('<form');
    expect(apps).not.toContain('href');

    const users = part(html, 'users');
    expect(users).toContain('<form');
    expect(users).toContain('<button');
  });
});

/**
 * Siffrorna för inloggningsadresser fanns i kontraktet men räknades inte i skivan innan — då sa
 * vyn det rakt ut i stället för att visa nollor. Nu räknas de, och då ska de synas.
 */
describe('kontrollrummets siffror för adresser', () => {
  it('visar hur många som får logga in, per roll och med rollens svenska namn', () => {
    const html = part(render(loaded), 'figures').replace(/[\u00a0\u202f\u2009]/g, ' ');
    for (const role of ROLES) expect(html).toContain(ROLE_TEXTS[role].label);
    expect(html).toContain('134');
    expect(html).toContain('17');
  });

  it('säger inte längre att adresserna inte räknas', () => {
    expect(render(loaded)).not.toMatch(/räknas inte i den här versionen/);
  });
});

describe('kontrollrummets adresser och roller', () => {
  it('varje roll står med sitt svenska namn och en mening om vad den får göra', () => {
    const html = part(render(loaded), 'users');
    for (const role of ROLES) {
      expect(html).toContain(ROLE_TEXTS[role].label);
      expect(html).toContain(ROLE_TEXTS[role].explanation);
    }
  });

  it('adresserna står som radrubriker i en riktig tabell', () => {
    const html = part(render(loaded), 'users');
    expect(html).toContain('<table');
    for (const user of USERS) expect(html).toMatch(new RegExp(`<th scope="row"[^>]*>${user.email}`));
  });

  it('den egna raden erbjuds ingen ny roll — de andra raderna gör det', () => {
    const rows = userRows(render(loaded));
    expect(rows).toHaveLength(USERS.length);
    const [self, ...others] = rows;
    expect(self, 'den som sänker sig själv låser ut sig').not.toContain('<select');
    expect(self).not.toContain('<button');
    expect(self).not.toContain('<form');
    for (const row of others) {
      expect(row).toContain('<select');
      expect(row).toContain('<button');
    }
  });

  it('skriver i klarspråk varför den egna raden ser annorlunda ut', () => {
    const [self] = userRows(render(loaded));
    expect(self).toContain(ADMIN_SELF_NOTE);
    expect(ADMIN_SELF_NOTE).toMatch(/din egen roll/i);
    expect(ADMIN_SELF_NOTE, 'säg vad följden blir, inte bara att det inte går').toMatch(/lås|stäng|ut/i);
  });

  it('varje rad går att välja en ny roll för, med alla tre rollernas namn', () => {
    const [, other] = userRows(render(loaded));
    for (const role of ROLES) expect(other).toContain(`>${ROLE_TEXTS[role].label}</option>`);
  });

  it('formuläret för att bjuda in har riktig etikett, riktigt fält och en riktig knapp', () => {
    const html = part(render(loaded), 'users');
    expect(html).toMatch(/<form[^>]*>/);
    expect(html).toMatch(/<label[^>]*for="/);
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    // Inga klickbara divar: det som går att klicka på ska vara en knapp.
    expect(html).not.toMatch(/<div[^>]*onclick/i);
  });

  it('en adress hamnar aldrig i ett attribut — bara i tabellcellen', () => {
    const html = render(loaded);
    for (const [, value] of html.matchAll(/(?:aria-label|title|id|aria-describedby|placeholder)="([^"]*)"/g)) {
      for (const user of USERS) {
        expect(value, 'adresser är personuppgifter och hör hemma i cellen').not.toContain(user.email);
        expect(value).not.toContain(user.email.split('@')[0]);
      }
    }
  });

  it('visar när adressen bjöds in, så att en gammal rad går att känna igen', () => {
    const html = part(render(loaded), 'users');
    expect(html).toMatch(/<th scope="col"[^>]*>Inbjuden</);
  });

  it('en lista utan andra än en själv säger det i stället för att se tom ut', () => {
    const only = [USERS[0]!];
    const html = part(render({ ...loaded, users: only }), 'users');
    expect(userRows(render({ ...loaded, users: only }))).toHaveLength(1);
    expect(html).toContain('anna@example.se');
  });
});

/**
 * Kontrollrummets fjärde del: önskemål som stoppats av en röd linje.
 *
 * Panelen finns för mönstret, inte för de enskilda raderna: en kategori som dyker upp gång på
 * gång är oftast en regel som är för bred, inte många skumma användare. Och önskemålets text
 * står aldrig här — den kan innehålla personuppgifter, så vyn får varken visa eller be om den.
 */
describe('kontrollrummets stoppade önskemål', () => {
  it('är en egen del med rubrik, efter de tre som redan fanns', () => {
    const html = render(loaded);
    expect(html).toContain('admin-stops-heading');
    expect(html.indexOf('admin-stops-heading')).toBeGreaterThan(html.indexOf('admin-users-heading'));
  });

  it('varje stoppad kategori står med svensk rubrik, aldrig kontraktets maskintext', () => {
    const html = part(render(loaded), 'stops');
    for (const stop of STOPS) {
      expect(html).toContain(REDLINE_TEXTS[stop.category].label);
      expect(html, 'maskintexten hör inte hemma i vyn').not.toContain(stop.category);
    }
  });

  it('förklarar vad kategorin betyder, så att en förvaltare förstår vad som stoppades', () => {
    const html = part(render(loaded), 'stops');
    expect(html).toContain(REDLINE_TEXTS['biometri'].explanation);
    expect(html).toContain(REDLINE_TEXTS['automatiskt-beslut-om-enskild'].explanation);
  });

  it('säger varför önskemålets text inte står här', () => {
    expect(part(render(loaded), 'stops')).toContain(ADMIN_STOPS_PRIVACY_NOTE);
  });

  it('bär upplysningen om att en återkommande kategori kan vara en för bred regel', () => {
    expect(part(render(loaded), 'stops')).toContain(ADMIN_STOPS_PATTERN_NOTE);
  });

  it('visar hur ofta varje gräns träffats, den vanligaste först', () => {
    const html = part(render(loaded), 'stops');
    const often = html.indexOf(REDLINE_TEXTS['biometri'].label);
    const seldom = html.indexOf(REDLINE_TEXTS['automatiskt-beslut-om-enskild'].label);
    expect(often).toBeGreaterThan(0);
    expect(seldom).toBeGreaterThan(often);
    expect(html).toContain('2 gånger');
  });

  it('nämner inte en kategori som aldrig träffats', () => {
    const html = part(render(loaded), 'stops');
    const untouched = REDLINE_CATEGORIES.filter((category) => !STOPS.some((stop) => stop.category === category));
    for (const category of untouched) expect(html).not.toContain(REDLINE_TEXTS[category].label);
  });

  it('är en riktig tabell och ren läsning — ingen knapp, inget formulär, ingen länk', () => {
    const html = part(render(loaded), 'stops');
    expect(html).toContain('<table');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('href');
  });

  it('tomt läge är en god nyhet, och ingen tabell', () => {
    const html = part(render({ ...loaded, stops: [] }), 'stops');
    expect(html).toContain(ADMIN_STOPS_EMPTY);
    expect(html).not.toContain('<table');
    // Upplysningen om vad panelen är till för står kvar: den förklarar varför ytan är tom.
    expect(html).toContain(ADMIN_STOPS_PRIVACY_NOTE);
  });
});


/**
 * Kontrollrummets femte del: AI-registret.
 *
 * Registret är det svar en tillsyn får — vilka appar finns, vem äger dem, hur känsliga uppgifter
 * hanterar de. Två saker låses hårt här. Kontraktets ord för nivå och källa (`personuppgift`,
 * `fail-closed`) är maskintext och får aldrig nå sidan: den som förvaltar plattformen ska läsa
 * nivån i klartext OCH förstå hur den sattes, eftersom "ett ord satte ett golv" och "det gick inte
 * att avgöra" inte betyder samma sak som en gjord bedömning. Och en app utan tidpunkt får inte se
 * ut som ett fel: den har aldrig beskrivits, står därför på den strängaste nivån, och registret
 * hittar inte på ett datum åt den.
 */
describe('kontrollrummets AI-register', () => {
  /** Raderna i registrets tabellkropp, en sträng var — i serverns ordning. */
  function registerRows(html: string): readonly string[] {
    const body = /<tbody>([\s\S]*)<\/tbody>/.exec(part(html, 'register'));
    expect(body, 'registret ska vara en tabell med en kropp').not.toBeNull();
    return (body![1] ?? '').split('<tr').slice(1);
  }

  it('är en egen del med rubrik, efter de fyra som redan fanns', () => {
    const html = render(loaded);
    expect(html).toContain('admin-register-heading');
    expect(html.indexOf('admin-register-heading')).toBeGreaterThan(html.indexOf('admin-stops-heading'));
  });

  it('säger vad registret är och varför det finns, innan en enda rad', () => {
    const html = part(render(loaded), 'register');
    expect(html).toContain(ADMIN_REGISTER_LEAD);
    expect(ADMIN_REGISTER_LEAD, 'frågan är en tillsyns').toMatch(/tillsyn/i);
    expect(ADMIN_REGISTER_LEAD, 'vem som äger appen är halva svaret').toMatch(/äger/);
    expect(ADMIN_REGISTER_LEAD, 'nivån är inte något man väljer själv').toMatch(/sätts åt/);
    expect(html.indexOf(ADMIN_REGISTER_LEAD)).toBeLessThan(html.indexOf('<table'));
  });

  it('varje nivå står med sitt läsbara namn, aldrig kontraktets maskintext', () => {
    const html = part(render(loaded), 'register');
    for (const classification of CLASSIFICATIONS) {
      expect(html, `nivån ${classification} saknar läsbart namn`).toContain(CLASSIFICATION_TEXTS[classification].label);
      expect(html, 'maskintexten hör inte hemma i vyn').not.toContain(classification);
    }
    expect(html).toContain('Personuppgifter');
    expect(html).toContain('Känsliga uppgifter');
  });

  it('förklarar vad varje nivå betyder, så att en förvaltare förstår skillnaden', () => {
    const html = part(render(loaded), 'register');
    for (const classification of CLASSIFICATIONS) {
      expect(html).toContain(CLASSIFICATION_TEXTS[classification].explanation);
    }
  });

  it('varje källa förklarar HUR nivån sattes, inte bara vad källan heter', () => {
    const html = part(render(loaded), 'register');
    for (const source of CLASSIFICATION_SOURCES) {
      expect(html, `källan ${source} saknar förklaring`).toContain(CLASSIFICATION_SOURCE_TEXTS[source].explanation);
      expect(html).toContain(CLASSIFICATION_SOURCE_TEXTS[source].label);
      expect(html, 'maskintexten hör inte hemma i vyn').not.toContain(source);
    }
    // De tre skiljer sig i sak, och skillnaden ska gå att läsa: en gjord bedömning, ett golv som
    // bedömningen inte fick underskrida, och ingen bedömning alls.
    expect(CLASSIFICATION_SOURCE_TEXTS['signalord'].explanation).toMatch(/golv|lägsta|underskrida/);
    expect(CLASSIFICATION_SOURCE_TEXTS['fail-closed'].explanation).toMatch(/strängaste/);
  });

  it('en app som aldrig beskrivits visar ingen tidpunkt, och säger att den aldrig klassats', () => {
    const rows = registerRows(render(loaded));
    expect(rows).toHaveLength(REGISTER.length);
    const never = rows.at(-1)!;
    expect(never).toContain('Ny app');
    expect(never).toContain(ADMIN_REGISTER_NEVER_CLASSIFIED);
    expect(never, 'ingen påhittad tidpunkt').not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
    // Den står ändå på strängaste nivån — och sidan säger varför, annars ser raden ut som ett fel.
    expect(never).toContain(CLASSIFICATION_TEXTS['kanslig'].label);
    expect(part(render(loaded), 'register')).toContain(ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE);
    expect(ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE).toMatch(/strängaste/);
    expect(ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE, 'säg att det inte är ett fel').toMatch(/inte ett fel|avsiktligt/);
  });

  it('en klassad app visar när nivån sattes, i samma form som resten av kontrollrummet', () => {
    const [first] = registerRows(render(loaded));
    expect(first).toMatch(/19 sep/);
    expect(first, 'rå maskintid hör inte hemma i vyn').not.toContain('2026-09-19T10:05:00Z');
  });

  it('en nivå eller källa utanför kontraktet kraschar inte vyn — den läses som det strängaste', () => {
    const odd = [
      {
        ...REGISTER[0]!,
        classification: 'ganska-hemlig' as Classification,
        source: 'gissning' as ClassificationSource,
      },
    ];
    const html = part(render({ ...loaded, register: odd }), 'register');
    expect(html).toContain('Bokning av mötesrum');
    expect(html, 'det okända väger strängast').toContain(CLASSIFICATION_TEXTS['kanslig'].label);
    expect(html).toContain(CLASSIFICATION_SOURCE_TEXTS['fail-closed'].label);
    expect(html, 'maskintexten hör inte hemma i vyn').not.toContain('ganska-hemlig');
    expect(html).not.toContain('gissning');
    expect(html).not.toContain('undefined');
  });

  it('en ägare utan känd adress får en begriplig text, aldrig "null" eller en tom cell', () => {
    const [, withoutOwner] = registerRows(render(loaded));
    expect(withoutOwner).toContain(ADMIN_OWNER_MISSING);
    expect(withoutOwner).not.toContain('null');
    expect(withoutOwner, 'en app utan känd adress har ändå en ägare').not.toMatch(/[Ss]aknar ägare|[Ii]ngen ägare/);
    expect(withoutOwner).not.toMatch(/<td><\/td>/);
  });

  it('visar om appen är publicerad, eftersom en tillsyn frågar vad som är i bruk', () => {
    const rows = registerRows(render(loaded));
    expect(rows[0]).toContain('Publicerad');
    expect(rows[1]).toContain('Inte publicerad');
  });

  it('är en riktig tabell med appen som radrubrik, och ren läsning', () => {
    const html = part(render(loaded), 'register');
    expect(html).toContain('<table');
    expect(html).toMatch(/<th scope="row"/);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<select');
    expect(html, 'registret är ingen väg in i någon annans app').not.toContain('href');
  });

  it('visar bara början av app-id:t, och gör aldrig en länk av den', () => {
    const html = part(render(loaded), 'register');
    for (const id of [FULL_ID, OTHER_ID]) {
      expect(html).not.toContain(id);
      expect(html).not.toContain(id.slice(0, ADMIN_APP_ID_PREFIX_LENGTH + 1));
    }
    expect(html).toContain(FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
    expect(html).not.toContain('#/app/');
  });

  it('tomt register är en vänlig mening, inte en tom yta — och förklaringarna står kvar', () => {
    const html = part(render({ ...loaded, register: [] }), 'register');
    expect(html).toContain(ADMIN_REGISTER_EMPTY);
    expect(html).not.toContain('<table');
    // Vad nivåerna betyder står kvar: det förklarar vad den tomma ytan skulle ha innehållit.
    expect(html).toContain(CLASSIFICATION_TEXTS['oppen'].explanation);
    expect(html).toContain(ADMIN_REGISTER_LEAD);
  });
});


/**
 * Kontrollrummets sjätte del: granskningskön.
 *
 * Den skiljer sig från de fem andra på två punkter, och båda låses här. Nivån ur AI-registret
 * står i KÖN, inte bara i registret: granskaren ska se om nivån är ett omdöme eller ett
 * misslyckande innan hon öppnar koden, eftersom en app vars känslighet ingen kunnat avgöra inte
 * är samma sak att släppa ut som en prövad app. Och ett öppnat ärende visar appens kod — det enda
 * stället i hela kontrollrummet där innehållet i någons app syns, och sidan säger varför.
 */
describe('kontrollrummets granskningskö', () => {
  function reviewRows(html: string): readonly string[] {
    const body = /<tbody>([\s\S]*)<\/tbody>/.exec(part(html, 'granskning'));
    expect(body, 'kön ska vara en tabell med en kropp').not.toBeNull();
    return (body![1] ?? '').split('<tr').slice(1);
  }

  it('är en egen del med rubrik, efter de fem som redan fanns', () => {
    const html = render(loaded);
    expect(html).toContain('admin-reviews-heading');
    expect(html.indexOf('admin-reviews-heading')).toBeGreaterThan(html.indexOf('admin-register-heading'));
  });

  it('säger vad kön är innan en enda rad: någon läser koden, och ägaren väntar', () => {
    const html = part(render(loaded), 'granskning');
    expect(html).toContain(ADMIN_REVIEWS_LEAD);
    expect(html.indexOf(ADMIN_REVIEWS_LEAD)).toBeLessThan(html.indexOf('<table'));
  });

  it('visar ärendena i den ordning servern gav dem — äldst först', () => {
    const rows = reviewRows(render(loaded));
    expect(rows).toHaveLength(REVIEWS.length);
    expect(rows[0]).toContain('Bokning av mötesrum');
    expect(rows[1]).toContain('Uppföljning av rehab');
  });

  it('varje rad bär appens namn, ägarens adress och när publiceringen begärdes', () => {
    const rows = reviewRows(render(loaded));
    expect(rows[0]).toMatch(/<th scope="row"[^>]*>[\s\S]*Bokning av mötesrum/);
    expect(rows[0]).toContain('anna@example.se');
    expect(rows[0], 'rå maskintid hör inte hemma i vyn').not.toContain('2026-09-20T09:00:00Z');
    expect(rows[0]).toMatch(/20 sep/);
    // En ägare utan känd adress har ändå en ägare — samma text som i applistan och registret.
    expect(rows[1]).toContain(ADMIN_OWNER_MISSING);
    expect(rows[1]).not.toContain('null');
  });

  it('nivån OCH hur den sattes står i kön, innan någon har öppnat koden', () => {
    const rows = reviewRows(render(loaded));
    expect(rows[0]).toContain(CLASSIFICATION_TEXTS['personuppgift'].label);
    expect(rows[0], 'ett golv är inte samma sak som en gjord bedömning').toContain(
      CLASSIFICATION_SOURCE_TEXTS['signalord'].label,
    );
    // Den app ingen kunnat bedöma ska synas som just det, inte som en prövad app.
    expect(rows[1]).toContain(CLASSIFICATION_TEXTS['kanslig'].label);
    expect(rows[1]).toContain(CLASSIFICATION_SOURCE_TEXTS['fail-closed'].label);
    const html = part(render(loaded), 'granskning');
    for (const code of ['personuppgift', 'kanslig', 'signalord', 'fail-closed']) {
      expect(html, 'maskintexten hör inte hemma i vyn').not.toContain(code);
    }
  });

  it('visar bara början av app-id:t och gör aldrig en länk av den — kön är ingen väg in i appen', () => {
    const html = part(render(loaded), 'granskning');
    for (const id of [FULL_ID, OTHER_ID]) {
      expect(html).not.toContain(id);
      expect(html).not.toContain(id.slice(0, ADMIN_APP_ID_PREFIX_LENGTH + 1));
    }
    expect(html).toContain(FULL_ID.slice(0, ADMIN_APP_ID_PREFIX_LENGTH));
    expect(html).not.toContain('href');
    expect(html).not.toContain('#/app/');
  });

  it('kön bär aldrig koden — den enda knappen hämtar den, ett ärende i taget', () => {
    const html = part(render(loaded), 'granskning');
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(REVIEWS.length);
    for (const button of buttons) expect(button).toContain(ADMIN_REVIEW_OPEN_BUTTON);
    expect(html, 'inget ärende är öppet från början').not.toContain('<pre>');
    expect(html).not.toContain(ADMIN_REVIEW_APPROVE_BUTTON);
  });

  it('tom kö är en god nyhet, och ingen tabell — men upplysningen står kvar', () => {
    const html = part(render({ ...loaded, reviews: [] }), 'granskning');
    expect(html).toContain(ADMIN_REVIEWS_EMPTY);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<button');
    expect(html).toContain(ADMIN_REVIEWS_LEAD);
  });

  it('väntar man på svaret syns det, och ingen halv sida ritas', () => {
    const html = render(pending);
    expect(html).toMatch(/Hämtar|Laddar/);
    expect(html).not.toContain('admin-reviews-heading');
  });

  it('403 tar med sig kön också — inget av kontrollrummet ritas utan behörighet', () => {
    const html = render({ ...pending, error: ADMIN_FORBIDDEN });
    expect(html).toContain(ADMIN_FORBIDDEN);
    expect(html).not.toContain('admin-reviews-heading');
  });
});

/**
 * Det öppnade ärendet: den enda ytan i kontrollrummet som visar innehållet i någons app.
 *
 * Tre saker låses. Koden syns, och sidan säger varför den får göra det just här. Skälet har en
 * ruta, och upplysningen om att ägaren får texten ordagrant står FÖRE den — den som skriver ska
 * veta vart orden tar vägen innan hon skriver dem, inte efter att hon skickat. Och ett ärende
 * utan kod går inte att avgöra alls: då erbjuds inga beslut.
 */
describe('ett öppnat granskningsärende', () => {
  const FILES = {
    'index.html': '<h1>Bokning av mötesrum</h1>',
    'app.js': "const rooms = ['Stora', 'Lilla'];",
  };

  function renderCase(files: Record<string, string> = FILES, reason = ''): string {
    return renderToStaticMarkup(
      createElement(ReviewCase, {
        review: REVIEWS[0]!,
        files,
        reason,
        deciding: false,
        onReasonChange: () => {},
        onDecide: () => {},
        onClose: () => {},
      }),
    );
  }

  it('visar koden, fil för fil, med filnamnet som rubrik', () => {
    const html = renderCase();
    expect(html).toContain('index.html');
    expect(html).toContain('app.js');
    expect(html).toContain('Bokning av mötesrum');
    expect(html).toContain('const rooms');
    expect(html.match(/<pre>/g) ?? []).toHaveLength(2);
  });

  it('koden skrivs ut som text, aldrig som märkspråk — den är skriven av en modell', () => {
    const html = renderCase({ 'index.html': '<script>alert(1)</script>' });
    expect(html, 'taggarna ska stå som tecken, inte som element').toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('säger varför koden visas här och ingen annanstans i kontrollrummet', () => {
    const html = renderCase();
    expect(html).toContain(ADMIN_REVIEW_CODE_NOTE);
    expect(html.indexOf(ADMIN_REVIEW_CODE_NOTE)).toBeLessThan(html.indexOf('<pre>'));
  });

  it('nivån och källan står kvar vid koden, så att de finns för ögat när beslutet fattas', () => {
    const html = renderCase();
    expect(html).toContain(CLASSIFICATION_TEXTS['personuppgift'].label);
    expect(html).toContain(CLASSIFICATION_SOURCE_TEXTS['signalord'].label);
  });

  it('har två beslut: en knapp som publicerar och en som avvisar', () => {
    const html = renderCase();
    expect(html).toContain(ADMIN_REVIEW_APPROVE_BUTTON);
    expect(html).toContain(ADMIN_REVIEW_REJECT_BUTTON);
    expect(html).toContain(ADMIN_REVIEW_APPROVE_NOTE);
  });

  it('skälet har en riktig etikett och en riktig ruta — och upplysningen står före den', () => {
    const html = renderCase();
    const field = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(field, 'rutan ska ha en etikett som pekar på den').toBeDefined();
    expect(html).toContain(`id="${field ?? ''}"`);
    expect(html).toContain(ADMIN_REVIEW_REASON_LABEL);
    expect(html).toContain(ADMIN_REVIEW_REASON_NOTE);
    expect(html.indexOf(ADMIN_REVIEW_REASON_NOTE)).toBeLessThan(html.indexOf('<textarea'));
  });

  it('det granskaren skrivit står kvar i rutan, ordagrant', () => {
    const html = renderCase(FILES, 'Ta bort personnumret ur formuläret.');
    expect(html).toContain('Ta bort personnumret ur formuläret.');
  });

  it('ett ärende utan kod går inte att avgöra — då erbjuds inga beslut', () => {
    const html = renderCase({});
    expect(html).toContain(ADMIN_REVIEW_NO_FILES);
    expect(html).not.toContain(ADMIN_REVIEW_APPROVE_BUTTON);
    expect(html).not.toContain(ADMIN_REVIEW_REJECT_BUTTON);
    expect(html).not.toContain('<textarea');
  });

  it('är ingen väg in i appen: ingen länk, inget helt app-id', () => {
    const html = renderCase();
    expect(html).not.toContain('href');
    expect(html).not.toContain(FULL_ID);
  });
});


/**
 * Avvecklade appar i AI-registret.
 *
 * En avvecklad app står KVAR i registret, och raden är då det enda som finns kvar av den. Det gör
 * två saker nödvändiga, och båda låses här.
 *
 * Raden måste gå att skilja från en levande VID EN BLICK — inte genom att läsa en cell — eftersom
 * den som läser registret annars räknar avvecklade appar som appar i bruk.
 *
 * Och att posten står kvar med flit måste stå i ord. Utan den meningen läses en avvecklad rad som
 * ett bevis på att uppgifterna inte raderades, alltså tvärtemot vad som faktiskt hände.
 */
describe('avvecklade appar i AI-registret', () => {
  const GONE: AdminRegisterEntry = {
    appIdPrefix: '01jm9n0p',
    name: 'Enkät om fikat 2024',
    ownerEmail: 'karin@example.se',
    classification: 'personuppgift',
    source: 'signalord',
    classifiedAt: '2026-09-11T09:00:00Z',
    // Appen VAR publicerad när den levde. Raden får ändå aldrig visa den som publicerad.
    published: true,
    decommissionedAt: '2026-09-14T10:12:00Z',
  };

  const withGone = { ...loaded, register: [...REGISTER, GONE] };

  function rows(html: string): readonly string[] {
    const body = /<tbody>([\s\S]*)<\/tbody>/.exec(part(html, 'register'));
    expect(body, 'registret ska vara en tabell med en kropp').not.toBeNull();
    return (body![1] ?? '').split('<tr').slice(1);
  }

  it('går att skilja från en levande rad vid en blick, inte genom att läsa en cell', () => {
    const all = rows(render(withGone));
    const gone = all.at(-1)!;
    expect(gone).toContain('Enkät om fikat 2024');
    expect(gone, 'raden själv bär märket').toContain('admin-decommissioned');
    for (const alive of all.slice(0, -1)) {
      expect(alive, 'en levande rad bär det aldrig').not.toContain('admin-decommissioned');
    }
  });

  it('visar när appen avvecklades, och säger vilken av radens tidpunkter det är', () => {
    const gone = rows(render(withGone)).at(-1)!;
    expect(gone).toContain(ADMIN_REGISTER_DECOMMISSIONED);
    expect(gone, 'datumet i samma form som resten av kontrollrummet').toMatch(/14 sep/);
    expect(gone, 'rå maskintid hör inte hemma i vyn').not.toContain('2026-09-14T10:12:00Z');
    // Klassningens tidpunkt står kvar: raden bär två tidpunkter, och båda betyder något.
    expect(gone).toMatch(/11 sep/);
  });

  it('visar aldrig en avvecklad app som publicerad, hur den än såg ut när den levde', () => {
    const gone = rows(render(withGone)).at(-1)!;
    expect(GONE.published, 'förutsättningen: appen VAR ute').toBe(true);
    expect(gone).not.toContain(ADMIN_REGISTER_PUBLISHED);
    expect(gone).not.toContain(ADMIN_REGISTER_UNPUBLISHED);
    expect(gone).toContain(ADMIN_REGISTER_DECOMMISSIONED);
  });

  it('en levande rad ändras inte av att en avvecklad finns i listan', () => {
    const [first, second] = rows(render(withGone));
    expect(first).toContain(ADMIN_REGISTER_PUBLISHED);
    expect(first).not.toContain(ADMIN_REGISTER_DECOMMISSIONED);
    expect(second).toContain(ADMIN_REGISTER_UNPUBLISHED);
  });

  it('säger varför posten står kvar — annars läses raden som att ingenting raderades', () => {
    const html = part(render(withGone), 'register');
    expect(html).toContain(ADMIN_REGISTER_DECOMMISSIONED_NOTE);
    expect(ADMIN_REGISTER_DECOMMISSIONED_NOTE, 'det är avsiktligt').toMatch(/med flit|avsiktligt/);
    expect(ADMIN_REGISTER_DECOMMISSIONED_NOTE, 'uppgifterna ÄR raderade').toMatch(/raderade/);
    expect(ADMIN_REGISTER_DECOMMISSIONED_NOTE, 'och vad som står kvar').toMatch(/har funnits/);
    // Meningen står före tabellen: den förklarar raderna, inte tvärtom.
    expect(html.indexOf(ADMIN_REGISTER_DECOMMISSIONED_NOTE)).toBeLessThan(html.indexOf('<table'));
  });

  it('är fortfarande ren läsning — registret är ingen väg in i en app som tagits bort', () => {
    const html = part(render(withGone), 'register');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('href');
  });
});
