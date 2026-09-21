/**
 * Kontrollrummet renderat till märkspråk (ingen webbläsare behövs), efter samma mönster som
 * `startPage.test.ts`. Testfilen är .ts, inte .tsx, så vyn skapas med createElement.
 *
 * Det som låses här är löftet vyn bär: kontrollrummet visar ATT appar finns, aldrig en väg in i
 * dem. Hela app-id:t är appens hemliga adress — syns det, eller byggs en länk av det, har vyn
 * gett bort nyckeln till någon annans app.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ADMIN_APP_ID_PREFIX_LENGTH, type AdminApp, type AdminOverview } from '@vibesandbox/contracts';
import { ADMIN_FORBIDDEN, ADMIN_OWNER_MISSING, ADMIN_TITLE } from '../src/admin.ts';
import { AdminView } from '../src/AdminPage.tsx';

/** Ett riktigt app-id. Bara de första tecknen får nå märkspråket. */
const FULL_ID = '01jabcdefghjkmnpqrstvwxyz0';
const OTHER_ID = '01kzyxwvutsrqponmlkjihgfe1';

const OVERVIEW: AdminOverview = {
  apps: 2,
  published: 1,
  drafts: 1,
  users: { admin: 0, builder: 0, viewer: 0 },
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

function render(props: Parameters<typeof AdminView>[0]): string {
  return renderToStaticMarkup(createElement(AdminView, props));
}

const loaded = { overview: OVERVIEW, apps: APPS, error: null };

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
    const html = render(loaded);
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
    expect(html.replace(/ | /g, ' ')).toContain('1 234 567');
  });

  it('hittar inte på siffror för inloggningsadresser utan säger att de inte räknas än', () => {
    const html = render(loaded);
    expect(html).toMatch(/räknas inte i den här versionen/);
    // Panelen med nollor vore en lögn i siffror: den får inte finnas.
    expect(html).not.toMatch(/(Administratörer|Byggare|Läsare)/);
  });

  it('tomt läge är en vänlig mening, inte en tom yta', () => {
    const html = render({ overview: { ...OVERVIEW, apps: 0, published: 0, drafts: 0 }, apps: [], error: null });
    expect(html).toMatch(/Inga appar ännu/);
    expect(html).not.toContain('<table');
  });

  it('väntar man på svaret syns det', () => {
    const html = render({ overview: null, apps: null, error: null });
    expect(html).toMatch(/Hämtar|Laddar/);
  });

  it('403 möts med klarspråk i stället för en trasig sida', () => {
    const html = render({ overview: null, apps: null, error: ADMIN_FORBIDDEN });
    expect(html).toContain(ADMIN_FORBIDDEN);
    expect(html).toContain('notice-error');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<table');
  });

  it('har inga knappar: skivan är ren läsning', () => {
    const html = render(loaded);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });
});
