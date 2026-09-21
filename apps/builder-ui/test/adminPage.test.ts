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
import { ADMIN_APP_ID_PREFIX_LENGTH, type AdminApp, type AdminOverview, type AdminUser } from '@vibesandbox/contracts';
import { ADMIN_FORBIDDEN, ADMIN_OWNER_MISSING, ADMIN_SELF_NOTE, ADMIN_TITLE, ROLES, ROLE_TEXTS } from '../src/admin.ts';
import { AdminView } from '../src/AdminPage.tsx';

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

const CALLBACKS = { onInvite: async () => '', onSetRole: async () => '' };

function render(props: Parameters<typeof AdminView>[0]): string {
  return renderToStaticMarkup(createElement(AdminView, props));
}

const loaded = { overview: OVERVIEW, apps: APPS, users: USERS, error: null, ...CALLBACKS };

/** Märkspråket för en av vyns tre delar, så att en del går att pröva utan de andra. */
function part(html: string, name: 'figures' | 'apps' | 'users'): string {
  const starts = { figures: 'admin-figures-heading', apps: 'admin-apps-heading', users: 'admin-users-heading' };
  const order: Array<keyof typeof starts> = ['figures', 'apps', 'users'];
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
    const html = render({ ...CALLBACKS, overview: null, apps: null, users: null, error: null });
    expect(html).toMatch(/Hämtar|Laddar/);
  });

  it('403 möts med klarspråk i stället för en trasig sida', () => {
    const html = render({ ...CALLBACKS, overview: null, apps: null, users: null, error: ADMIN_FORBIDDEN });
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
