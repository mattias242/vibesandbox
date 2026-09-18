import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { db, SdkError, whoami } from '@vibesandbox/sdk';
import type { Doc } from '@vibesandbox/sdk';

interface Bokning {
  rum: string;
  datum: string; // "2026-10-01"
  vem: string;
}

// Gemensam kollektion: alla som får öppna appen ser alla bokningar.
const bokningar = db.collection<Bokning>('bokningar');

function sortera(lista: Doc<Bokning>[]): Doc<Bokning>[] {
  return [...lista].sort((a, b) => a.data.datum.localeCompare(b.data.datum));
}

function felText(error: unknown): string {
  // SdkError.message är redan klarspråk på svenska.
  return error instanceof SdkError ? error.message : 'Något gick fel. Försök igen.';
}

export function App() {
  const [lista, setLista] = useState<Doc<Bokning>[]>([]);
  const [laddar, setLaddar] = useState(true);
  const [fel, setFel] = useState('');
  const [inloggad, setInloggad] = useState('');

  const [rum, setRum] = useState('');
  const [datum, setDatum] = useState('');
  const [vem, setVem] = useState('');

  const rumRef = useRef<HTMLInputElement>(null);
  const listRubrikRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = 'Bokningar';
    Promise.all([bokningar.list(), whoami()])
      .then(([alla, jag]) => {
        setLista(sortera(alla));
        setInloggad(jag.displayName);
        setVem(jag.displayName);
      })
      .catch((error: unknown) => setFel(felText(error)))
      .finally(() => setLaddar(false));
  }, []);

  async function laggTill(event: FormEvent) {
    event.preventDefault();
    setFel('');
    try {
      const ny = await bokningar.add({ rum: rum.trim(), datum, vem: vem.trim() });
      setLista((tidigare) => sortera([...tidigare, ny]));
      setRum('');
      setDatum('');
      rumRef.current?.focus();
    } catch (error) {
      setFel(felText(error));
    }
  }

  async function taBort(bokning: Doc<Bokning>) {
    setFel('');
    try {
      await bokningar.remove(bokning.id);
      setLista((tidigare) => tidigare.filter((annan) => annan.id !== bokning.id));
      // Knappen som hade fokus försvinner; flytta fokus till något som finns kvar.
      listRubrikRef.current?.focus();
    } catch (error) {
      setFel(felText(error));
    }
  }

  return (
    <main>
      <h1>Bokningar</h1>
      {inloggad !== '' && <p>Inloggad som {inloggad}.</p>}

      <form onSubmit={laggTill}>
        <h2>Ny bokning</h2>
        <label htmlFor="rum">Rum</label>
        <input id="rum" ref={rumRef} value={rum} onChange={(e) => setRum(e.target.value)} required maxLength={100} />

        <label htmlFor="datum">Datum</label>
        <input id="datum" type="date" value={datum} onChange={(e) => setDatum(e.target.value)} required />

        <label htmlFor="vem">Vem bokar?</label>
        <input id="vem" value={vem} onChange={(e) => setVem(e.target.value)} required maxLength={100} />

        <button type="submit">Lägg till bokning</button>
      </form>

      {/* role="alert" gör att skärmläsare läser upp felet direkt. */}
      {fel !== '' && (
        <p role="alert" className="fel">
          {fel}
        </p>
      )}

      <section aria-labelledby="listrubrik">
        <h2 id="listrubrik" ref={listRubrikRef} tabIndex={-1}>
          Kommande bokningar
        </h2>
        {laddar ? (
          <p>Hämtar bokningar …</p>
        ) : lista.length === 0 ? (
          <p>Det finns inga bokningar än.</p>
        ) : (
          <ul>
            {lista.map((bokning) => (
              <li key={bokning.id}>
                <span>
                  <strong>{bokning.data.rum}</strong> · {bokning.data.datum} · {bokning.data.vem}
                </span>
                <button
                  type="button"
                  className="sekundar"
                  aria-label={`Ta bort bokningen av ${bokning.data.rum} ${bokning.data.datum}`}
                  onClick={() => taBort(bokning)}
                >
                  Ta bort
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
