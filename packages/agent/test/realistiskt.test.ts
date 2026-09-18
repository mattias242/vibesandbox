/**
 * Ett svar i exakt den form modellen gav vid provanropet: en sammanfattningsrad, fil-block utan
 * kodstaket och slutmarkören sist. Kunskapen är den riktiga: SDK:ts README och mallens exempelapp.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '@vibesandbox/llm';
import { createAgent } from '../src/index.ts';
import { fakeRunner } from './stod.ts';

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const knowledge = {
  sdkReference: read('sdk/README.md'),
  exampleFiles: {
    'src/App.tsx': read('app-template/src/App.tsx'),
    'src/styles.css': read('app-template/src/styles.css'),
  },
  starterFiles: {
    'src/App.tsx': read('app-template/src/App.tsx'),
    'src/styles.css': read('app-template/src/styles.css'),
  },
};

const TODO_APP = `import { useEffect, useState } from 'react';
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
    document.title = 'Att göra';
    uppgifter
      .list()
      .then((alla) => setLista(alla.sort((a, b) => a.createdAt.localeCompare(b.createdAt))))
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
      const uppdaterad = await uppgifter.update(uppgift.id, { ...uppgift.data, klar: !uppgift.data.klar });
      setLista((tidigare) => tidigare.map((u) => (u.id === uppdaterad.id ? uppdaterad : u)));
    } catch (error) {
      setFel(felText(error));
    }
  }

  return (
    <main>
      <h1>Att göra</h1>
      <form onSubmit={laggTill}>
        <label htmlFor="ny">Ny uppgift</label>
        <input id="ny" value={text} onChange={(e) => setText(e.target.value)} required maxLength={200} />
        <button type="submit">Lägg till</button>
      </form>
      {fel !== '' && (
        <p role="alert" className="fel">
          {fel}
        </p>
      )}
      {laddar ? (
        <p>Hämtar uppgifter …</p>
      ) : lista.length === 0 ? (
        <p>Inga uppgifter än.</p>
      ) : (
        <ul>
          {lista.map((uppgift) => (
            <li key={uppgift.id} className={uppgift.data.klar ? 'klar' : ''}>
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
}`;

const TODO_CSS = `main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 1.5rem 1rem;
  font-family: system-ui, sans-serif;
}

li.klar {
  text-decoration: line-through;
  color: #4b5563;
}

.fel {
  color: #b91c1c;
}`;

const MODEL_ANSWER = `En att göra-lista där alla som öppnar appen ser samma uppgifter och kan bocka av dem.
<vs-file path="src/App.tsx">
${TODO_APP}
</vs-file>
<vs-file path="src/styles.css">
${TODO_CSS}
</vs-file>
<vs-done/>`;

describe('ett realistiskt svar: en todo-lista med SDK:t', () => {
  it('blir källfiler som byggs, med sammanfattningen till användaren', async () => {
    const provider = createFakeProvider([{ text: MODEL_ANSWER, usage: { inputTokens: 6200, outputTokens: 950 } }], { model: 'zai-org/GLM-5.3-Flash' });
    const runner = fakeRunner([{ ok: true }]);
    const agent = createAgent({ provider, buildRunner: runner, knowledge });

    const result = await agent.runTurn({ request: 'En todo-lista som jag kan dela med en vän', history: [], currentFiles: {} });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('En att göra-lista där alla som öppnar appen ser samma uppgifter och kan bocka av dem.');
    expect(result.files).toEqual({ 'src/App.tsx': TODO_APP, 'src/styles.css': TODO_CSS });
    expect(result.model).toBe('zai-org/GLM-5.3-Flash');
    expect(result.usage).toEqual({ inputTokens: 6200, outputTokens: 950 });

    const [system, user] = provider.requests[0]!.messages;
    // Hela SDK-referensen och exempelappen följer med i systemprompten.
    expect(system!.content).toContain(knowledge.sdkReference);
    expect(system!.content).toContain(knowledge.exampleFiles['src/App.tsx']);
    // Ny app: modellen ser startfilerna och önskemålet.
    expect(user!.content).toContain('En todo-lista som jag kan dela med en vän');
    expect(user!.content).toContain('<vs-file path="src/App.tsx">');
  });
});
