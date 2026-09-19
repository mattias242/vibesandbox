/**
 * Byggverktyget i testläge (testinloggning, ingen mejltjänst) och startvillkoren för byggverktyget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { signTestIdentity } from '@vibesandbox/gateway';
import type { BuilderJob } from '@vibesandbox/contracts';
import { ConfigError } from '../src/config.ts';
import { todoApp } from './stod/byggkedja.ts';
import { Webblasare } from './stod/webblasare.ts';
import { BYGG, BYGG_ORIGIN, TESTHEMLIGHET, startaPlattform } from './stod/plattform.ts';
import type { Testplattform } from './stod/plattform.ts';

const ANNA = signTestIdentity({ userId: 'anv-anna', email: 'anna@example.org', roles: ['builder'] }, TESTHEMLIGHET);

describe('Byggverktyget i testläge', () => {
  let plattform: Testplattform | undefined;

  afterEach(async () => {
    await plattform?.stang();
    plattform = undefined;
  });

  async function byggApp(p: Testplattform): Promise<string> {
    const webblasare = new Webblasare(p.port);
    const anrop = (method: string, path: string, json?: unknown): ReturnType<Webblasare['skicka']> =>
      webblasare.skicka(BYGG, {
        method,
        path,
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        headers: {
          Authorization: ANNA,
          ...(method === 'GET' ? {} : { 'x-vibesandbox-request': '1', Origin: BYGG_ORIGIN, 'Content-Type': 'application/json' }),
        },
      });
    const { appId } = JSON.parse((await anrop('POST', '/_api/builder/apps', {})).body) as { appId: string };
    const { jobId } = JSON.parse((await anrop('POST', `/_api/builder/apps/${appId}/messages`, { text: 'En todo-lista' })).body) as { jobId: string };
    for (let i = 0; i < 200; i += 1) {
      const jobb = JSON.parse((await anrop('GET', `/_api/builder/jobs/${jobId}`)).body) as BuilderJob;
      if (jobb.status === 'done') return appId;
      if (jobb.status === 'failed') throw new Error('Jobbet misslyckades.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Jobbet blev aldrig klart.');
  }

  it('"öppna" ger en absolut testinloggningsadress på målvärden, som loggar in webbläsaren där', async () => {
    plattform = await startaPlattform({ identitet: 'test', modellsvar: [todoApp('Testlägets lista')] });
    const appId = await byggApp(plattform);
    const webblasare = new Webblasare(plattform.port);

    const svar = await webblasare.skicka(BYGG, { path: `/_api/builder/apps/${appId}/open?target=preview`, headers: { Authorization: ANNA } });
    expect(svar.status).toBe(200);
    const url = new URL((JSON.parse(svar.body) as { url: string }).url);
    expect(url.origin).toBe(`http://p-${appId}.example.org`);
    expect(url.pathname).toBe('/_auth/test-login');
    expect(url.searchParams.get('token')).toBeTruthy();

    const inloggning = await webblasare.oppna(url.host, `${url.pathname}${url.search}`);
    expect(inloggning.status).toBe(303);
    const sida = await webblasare.oppna(url.host, '/');
    expect(sida.status).toBe(200);
    expect(sida.body).toContain('Testlägets lista');
  });

  it('en delning noteras i loggen utan adressen (det finns ingen mejltjänst i testläge)', async () => {
    plattform = await startaPlattform({ identitet: 'test', modellsvar: [todoApp('Delad lista')] });
    const appId = await byggApp(plattform);
    const webblasare = new Webblasare(plattform.port);
    const skriv = { Authorization: ANNA, 'x-vibesandbox-request': '1', Origin: BYGG_ORIGIN, 'Content-Type': 'application/json' };
    expect((await webblasare.skicka(BYGG, { method: 'POST', path: `/_api/builder/apps/${appId}/publish`, headers: skriv })).status).toBe(200);

    const delad = await webblasare.skicka(BYGG, {
      method: 'POST',
      path: `/_api/builder/apps/${appId}/share`,
      body: JSON.stringify({ email: 'bertil@example.org' }),
      headers: skriv,
    });
    expect(delad.status).toBe(200);
    expect(plattform.logg).toContainEqual(expect.objectContaining({ source: 'platform', event: 'invitation_noted', userId: 'anv-anna', role: 'viewer' }));
    expect(JSON.stringify(plattform.logg)).not.toContain('bertil@example.org');

    const ogiltig = await webblasare.skicka(BYGG, {
      method: 'POST',
      path: `/_api/builder/apps/${appId}/share`,
      body: JSON.stringify({ email: 'inte en adress' }),
      headers: skriv,
    });
    expect(ogiltig.status).toBe(400);
  });

  it('agenten får personnummer maskade: inget som lämnar servern innehåller dem', async () => {
    plattform = await startaPlattform({ identitet: 'test', modellsvar: [todoApp('Elever')] });
    const webblasare = new Webblasare(plattform.port);
    const skriv = { Authorization: ANNA, 'x-vibesandbox-request': '1', Origin: BYGG_ORIGIN, 'Content-Type': 'application/json' };
    const { appId } = JSON.parse((await webblasare.skicka(BYGG, { method: 'POST', path: '/_api/builder/apps', body: '{}', headers: skriv })).body) as { appId: string };
    await webblasare.skicka(BYGG, {
      method: 'POST',
      path: `/_api/builder/apps/${appId}/messages`,
      body: JSON.stringify({ text: 'En lista över elever, till exempel 900101-1234' }),
      headers: skriv,
    });
    for (let i = 0; i < 200 && plattform.modell.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const skickat = JSON.stringify(plattform.modell.requests);
    expect(skickat).toContain('elever');
    expect(skickat).not.toContain('900101-1234');
    expect(skickat).not.toContain('9001011234');
  });

  it('agenten får SDK:ts referens och exempelappen ur repot', async () => {
    plattform = await startaPlattform({ identitet: 'test', modellsvar: [todoApp('Kunskap')] });
    await byggApp(plattform);
    const system = plattform.modell.requests[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('@vibesandbox/sdk');
    expect(system).toContain('<vs-file path="src/App.tsx">');
    // Mallens egen startpunkt visas aldrig som något modellen får skriva.
    expect(system).not.toContain('<vs-file path="src/main.tsx">');
  });
});

describe('Startvillkor för byggverktyget', () => {
  it('påslaget byggverktyg utan byggkedja är ett tydligt startfel', async () => {
    await expect(startaPlattform({ identitet: 'test', utanByggkedja: true })).rejects.toThrow(ConfigError);
    await expect(startaPlattform({ identitet: 'test', utanByggkedja: true })).rejects.toThrow(/byggkedjan är inte installerad/);
  });

  it('utan byggverktyg finns ingen byggverktygsvärd (400), men apparna fungerar', async () => {
    const plattform = await startaPlattform({ identitet: 'test', utanByggverktyg: true, utanByggkedja: true });
    try {
      const svar = await new Webblasare(plattform.port).skicka(BYGG, { path: '/_api/builder/me', headers: { Authorization: ANNA } });
      expect(svar.status).toBe(400);
    } finally {
      await plattform.stang();
    }
  });
});
