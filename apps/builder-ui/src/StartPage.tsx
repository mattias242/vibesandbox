import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { BuilderAppSummary } from '@vibesandbox/contracts';
import { appendToChat, registerChatInput } from './chatInput.ts';
import { api, errorMessage, sessionFlash } from './client.ts';
import { formatUpdated } from './format.ts';
import { appHash } from './route.ts';
import { GuideLink } from './ServicesGuide.tsx';
import { SAFETY_POINTS, SUGGESTIONS } from './texts.ts';

export function StartPage() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();

  // Guidens knapp "Använd" klistrar in exemplet här, i rutan som syns.
  useEffect(
    () =>
      registerChatInput((example) => {
        setText((current) => appendToChat(current, example));
        setError(null);
        requestAnimationFrame(() => {
          const field = textareaRef.current;
          if (field === null) return;
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        });
      }),
    [],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const wish = text.trim();
    if (wish === '') {
      setError('Skriv först vad appen ska göra.');
      textareaRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { appId } = await api.createApp();
      try {
        await api.sendMessage(appId, wish);
      } catch (sendError) {
        // Appen finns redan — öppna den ändå, så kan önskemålet skickas igen därifrån.
        sessionFlash.set(appId, errorMessage(sendError));
      }
      window.location.hash = appHash(appId);
    } catch (createError) {
      setError(errorMessage(createError));
      setBusy(false);
    }
  }

  return (
    <div className="page page-start">
      {/* Ordningen här är läsordningen, också när spalterna ligger bredvid varandra: CSS:en
          placerar delarna med grid-column/grid-row som speglar DOM, aldrig med order. */}
      <div className="start-columns">
        <form className="wish" onSubmit={submit} noValidate>
          <h1>
            <label htmlFor="wish-text">Vad vill du bygga?</label>
          </h1>
          <p id={hintId} className="hint">
            Skriv i vanligt språk — en mening räcker för att börja.
          </p>
          <p className="guide-cue">
            <GuideLink />
          </p>
          <textarea
            id="wish-text"
            ref={textareaRef}
            className="wish-text"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
            aria-invalid={error !== null}
            disabled={busy}
          />
          {error !== null && (
            <p id={errorId} className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          <div className="wish-actions">
            <button type="submit" className="button button-primary button-large" disabled={busy}>
              {busy ? 'Startar…' : 'Bygg appen'}
            </button>
          </div>
          <div className="suggestions">
            <p className="suggestions-label" id="suggestions-label">
              Eller börja med ett förslag:
            </p>
            <ul aria-labelledby="suggestions-label">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    className="chip"
                    disabled={busy}
                    onClick={() => {
                      setText(suggestion);
                      setError(null);
                      textareaRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </form>

        <MyApps />

        <details className="safety">
          <summary>Trygghet och kontroll</summary>
          <ul>
            {SAFETY_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

function MyApps() {
  const [apps, setApps] = useState<readonly BuilderAppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listApps().then(setApps, (listError: unknown) => setError(errorMessage(listError)));
  }, []);

  return (
    <section className="my-apps" aria-labelledby="my-apps-heading">
      <h2 id="my-apps-heading">Mina appar</h2>
      {error !== null ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : apps === null ? (
        <p className="muted">Hämtar dina appar…</p>
      ) : apps.length === 0 ? (
        <p className="muted">Du har inga appar än. Den första du bygger hamnar här.</p>
      ) : (
        <ul className="app-list">
          {apps.map((app) => (
            <li key={app.appId}>
              <a className="app-link" href={appHash(app.appId)}>
                <span className="app-name">{app.name}</span>
                <span className="app-meta">
                  <span className={app.published ? 'badge badge-published' : 'badge'}>
                    {app.published ? 'Publicerad' : 'Utkast'}
                  </span>
                  <span className="muted">Senast ändrad {formatUpdated(app.updatedAt)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
