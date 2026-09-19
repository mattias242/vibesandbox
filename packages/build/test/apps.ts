/**
 * Appar att bygga i testerna. Som text, eftersom de byggs med mallens konfiguration (DOM, JSX)
 * och inte med repots.
 */

/** En realistisk todo-lista som sparar med SDK:t — det projektets mål handlar om. */
export const TODO_APP = {
  'src/App.tsx': `import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { db, SdkError } from '@vibesandbox/sdk';
import type { Doc } from '@vibesandbox/sdk';
import { Rad } from './components/Rad.tsx';

export interface Uppgift {
  text: string;
  klar: boolean;
}

const uppgifter = db.collection<Uppgift>('uppgifter');

export function App() {
  const [lista, setLista] = useState<Doc<Uppgift>[]>([]);
  const [text, setText] = useState('');
  const [fel, setFel] = useState('');

  useEffect(() => {
    uppgifter
      .list()
      .then((alla) => setLista(alla.sort((a, b) => a.createdAt.localeCompare(b.createdAt))))
      .catch((error: unknown) => setFel(error instanceof SdkError ? error.message : 'Något gick fel.'));
  }, []);

  async function laggTill(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '') return;
    const ny = await uppgifter.add({ text: text.trim(), klar: false });
    setLista((tidigare) => [...tidigare, ny]);
    setText('');
  }

  async function vaxla(uppgift: Doc<Uppgift>) {
    const uppdaterad = await uppgifter.update(uppgift.id, { ...uppgift.data, klar: !uppgift.data.klar });
    setLista((tidigare) => tidigare.map((annan) => (annan.id === uppdaterad.id ? uppdaterad : annan)));
  }

  async function taBort(uppgift: Doc<Uppgift>) {
    await uppgifter.remove(uppgift.id);
    setLista((tidigare) => tidigare.filter((annan) => annan.id !== uppgift.id));
  }

  return (
    <main>
      <h1>Att göra</h1>
      <form onSubmit={laggTill}>
        <label htmlFor="ny">Ny uppgift</label>
        <input id="ny" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
        <button type="submit">Lägg till</button>
      </form>
      {fel !== '' && <p role="alert">{fel}</p>}
      <ul>
        {lista.map((uppgift) => (
          <Rad key={uppgift.id} uppgift={uppgift} onVaxla={() => void vaxla(uppgift)} onTaBort={() => void taBort(uppgift)} />
        ))}
      </ul>
      <p>{lista.filter((u) => !u.data.klar).length} kvar att göra.</p>
    </main>
  );
}
`,
  'src/components/Rad.tsx': `import type { Doc } from '@vibesandbox/sdk';
import type { Uppgift } from '../App.tsx';

export function Rad(props: { uppgift: Doc<Uppgift>; onVaxla: () => void; onTaBort: () => void }) {
  const { uppgift } = props;
  return (
    <li className={uppgift.data.klar ? 'klar' : ''}>
      <label>
        <input type="checkbox" checked={uppgift.data.klar} onChange={props.onVaxla} /> {uppgift.data.text}
      </label>
      <button type="button" onClick={props.onTaBort} aria-label={\`Ta bort \${uppgift.data.text}\`}>
        Ta bort
      </button>
    </li>
  );
}
`,
  'src/styles.css': `main { max-width: 36rem; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; }
li { display: flex; justify-content: space-between; gap: 1rem; }
li.klar label { text-decoration: line-through; color: #555; }
.check { background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>"); }
`,
} as const;

export const TYPE_ERROR_APP = {
  'src/App.tsx': `export function App() {
  const antal: number = 'tre';
  return <p>{antal}</p>;
}
`,
  'src/styles.css': '',
} as const;

export const SYNTAX_ERROR_APP = {
  'src/App.tsx': `export function App() {
  return <p>hej</p
}
`,
  'src/styles.css': '',
} as const;
