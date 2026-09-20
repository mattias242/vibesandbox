import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentEvent, BuilderAppDetail, BuilderJobStatus } from '@vibesandbox/contracts';
import { ApiError } from './api.ts';
import { appendToChat, registerChatInput } from './chatInput.ts';
import { api, errorMessage, sessionFlash, sleep } from './client.ts';
import { JobSteps } from './JobSteps.tsx';
import { OpenLink } from './OpenLink.tsx';
import { followJob } from './polling.ts';
import { GuideLink } from './ServicesGuide.tsx';
import { SharePanel } from './SharePanel.tsx';
import { summarizeJob } from './steps.ts';

interface ActiveJob {
  readonly jobId: string;
  readonly status: BuilderJobStatus;
  readonly events: readonly AgentEvent[];
}

const BUSY_MESSAGE = 'Appen byggs redan. Vänta tills det pågående arbetet är klart, så kan du skriva nästa önskemål.';
const NOTHING_TO_PUBLISH = 'Det finns ingen färdig version att publicera än. Vänta tills bygget är klart.';

function isRunning(status: BuilderJobStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function Workspace({ appId }: { appId: string }) {
  const [app, setApp] = useState<BuilderAppDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const detail = await api.getApp(appId);
      setApp(detail);
      if (detail.publishedUrl !== undefined) setPublishedUrl(detail.publishedUrl);
      return detail;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    }
  }, [appId]);

  // Första laddningen: fortsätt följa ett jobb som pågick när sidan laddades om.
  useEffect(() => {
    reload().then((detail) => {
      if (detail?.job !== undefined && isRunning(detail.job.status)) {
        setJob({ jobId: detail.job.jobId, status: detail.job.status, events: [] });
      }
    });
  }, [reload]);

  // Följ det aktiva jobbet tills det är klart.
  const jobId = job?.jobId;
  useEffect(() => {
    if (jobId === undefined) return;
    const controller = new AbortController();
    followJob({
      jobId,
      getJob: api.getJob,
      sleep: (ms) => sleep(ms, controller.signal),
      signal: controller.signal,
      onUpdate: (update) => setJob({ jobId, status: update.status, events: update.events }),
    }).then(async (result) => {
      if (result.reason === 'aborted') return;
      if (result.reason === 'unreachable') {
        setJobNote('Vi tappade kontakten med servern. Arbetet kan fortsätta ändå — ladda om sidan om en stund för att se hur det gick.');
      } else if (result.reason === 'gone') {
        setJobNote('Arbetet går inte att följa längre. Ladda om sidan för att se det senaste.');
      }
      await reload();
      if (result.reason === 'done') setPreviewVersion((value) => value + 1);
    });
    return () => controller.abort();
  }, [jobId, reload]);

  if (loadError !== null && app === null) {
    return (
      <div className="page">
        <p>
          <a href="#/">← Mina appar</a>
        </p>
        <p className="notice notice-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (app === null) {
    return (
      <div className="page">
        <p className="muted" aria-live="polite">
          Öppnar appen…
        </p>
      </div>
    );
  }

  const running = job !== null && isRunning(job.status);
  const summary = job === null ? null : summarizeJob(job.events, job.status);

  return (
    <div className="workspace">
      <div className="conversation-column">
        <p className="back">
          <a href="#/">← Mina appar</a>
        </p>
        <h1 className="app-title">{app.name}</h1>

        <Conversation app={app} />

        <div className="job-area" aria-live="polite">
          {summary !== null && <JobSteps summary={summary} />}
          {jobNote !== null && <p className="notice">{jobNote}</p>}
        </div>

        <ChangeForm
          appId={appId}
          running={running}
          onSent={(jobIdSent, text) => {
            setJobNote(null);
            setApp((current) =>
              current === null
                ? current
                : { ...current, messages: [...current.messages, { role: 'user', text, createdAt: new Date().toISOString() }] },
            );
            setJob({ jobId: jobIdSent, status: 'queued', events: [] });
          }}
          onBusy={() => {
            void reload().then((detail) => {
              if (detail?.job !== undefined && isRunning(detail.job.status)) {
                setJob({ jobId: detail.job.jobId, status: detail.job.status, events: [] });
              }
            });
          }}
        />
      </div>

      <div className="preview-column">
        <Preview appId={appId} hasDraft={app.hasDraft} version={previewVersion} />
        <PublishBar
          appId={appId}
          canPublish={app.hasDraft && !running}
          published={app.published}
          onPublished={(url) => {
            setPublishedUrl(url);
            setApp((current) => (current === null ? current : { ...current, published: true }));
          }}
        />
        {publishedUrl !== null && <SharePanel appId={appId} publishedUrl={publishedUrl} />}
      </div>
    </div>
  );
}

function Conversation({ app }: { app: BuilderAppDetail }) {
  if (app.messages.length === 0) {
    return <p className="muted">Här syns det du skriver och vad som händer med appen.</p>;
  }
  return (
    <ol className="messages" aria-label="Konversationen">
      {app.messages.map((message, index) => (
        <li key={`${index}-${message.createdAt}`} className={`message message-${message.role}`}>
          <span className="message-who">{message.role === 'user' ? 'Du' : 'Byggverktyget'}</span>
          <span className="message-text">{message.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ChangeForm({
  appId,
  running,
  onSent,
  onBusy,
}: {
  appId: string;
  running: boolean;
  onSent: (jobId: string, text: string) => void;
  onBusy: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(() => sessionFlash.get(appId) ?? null);
  // Rensas i en effekt, inte i initieringen: StrictMode kör initieringen två gånger.
  useEffect(() => {
    sessionFlash.delete(appId);
  }, [appId]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();

  // Guidens knapp "Använd" klistrar in exemplet här, i rutan som syns. Inget skickas.
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
      setError('Skriv först vad du vill ändra.');
      textareaRef.current?.focus();
      return;
    }
    if (running) {
      setError(BUSY_MESSAGE);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { jobId } = await api.sendMessage(appId, wish);
      setText('');
      onSent(jobId, wish);
    } catch (sendError) {
      if (sendError instanceof ApiError && sendError.status === 409) {
        setError(BUSY_MESSAGE);
        onBusy();
      } else {
        setError(errorMessage(sendError));
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="change" onSubmit={submit} noValidate>
      <label className="field-label" htmlFor="change-text">
        Vad vill du ändra?
      </label>
      <p id={hintId} className="hint">
        {running ? 'Du kan skriva nästa önskemål medan appen byggs, och skicka det när den är klar.' : 'Beskriv ändringen i vanligt språk.'}
      </p>
      <p className="guide-cue">
        <GuideLink />
      </p>
      <textarea
        id="change-text"
        ref={textareaRef}
        className="wish-text"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
        aria-invalid={error !== null}
      />
      {error !== null && (
        <p id={errorId} className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={sending || running}>
          {sending ? 'Skickar…' : running ? 'Vänta, appen byggs…' : 'Skicka'}
        </button>
      </div>
    </form>
  );
}

function Preview({ appId, hasDraft, version }: { appId: string; hasDraft: boolean; version: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  useEffect(() => {
    if (!hasDraft) return;
    let current = true;
    setError(null);
    // Adressen är en engångslänk som loggar in förhandsfönstret. Den gamla är förbrukad: visa inte
    // ramen igen förrän den nya har kommit, annars laddas den om med en länk som inte längre gäller.
    setUrl(null);
    api.openUrl(appId, 'preview').then(
      (value) => {
        if (current) setUrl(value);
      },
      (openError: unknown) => {
        if (current) setError(errorMessage(openError));
      },
    );
    return () => {
      current = false;
    };
  }, [appId, hasDraft, version]);

  return (
    <section className="preview" aria-labelledby={labelId}>
      <div className="preview-head">
        <h2 id={labelId} className="preview-label">
          Förhandsvisning — bara du ser den
        </h2>
        {hasDraft && (
          <OpenLink appId={appId} target="preview" version={version} className="button button-small">
            Öppna i ny flik
          </OpenLink>
        )}
      </div>
      {!hasDraft ? (
        <div className="preview-empty">
          <p>Här visas appen när den första versionen är klar.</p>
        </div>
      ) : error !== null ? (
        <div className="preview-empty">
          <p className="notice notice-error">{error}</p>
        </div>
      ) : url === null ? (
        <div className="preview-empty">
          <p className="muted">Laddar förhandsvisningen…</p>
        </div>
      ) : (
        // Appens kod är skriven av en AI-modell: den får köra skript och formulär, men aldrig
        // öppna fönster eller styra byggverktygets flik (inga allow-popups/allow-top-navigation).
        // allow-same-origin gäller appens EGEN origin (förhandsvisningsvärden), inte byggverktygets.
        <iframe
          key={`${url}-${version}`}
          className="preview-frame"
          title="Förhandsvisning av appen"
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

function PublishBar({
  appId,
  canPublish,
  published,
  onPublished,
}: {
  appId: string;
  canPublish: boolean;
  published: boolean;
  onPublished: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function publish() {
    setBusy(true);
    setMessage(null);
    try {
      const { publishedUrl } = await api.publish(appId);
      onPublished(publishedUrl);
      setMessage({ ok: true, text: 'Appen är publicerad. Nu kan du dela den med dina kollegor.' });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof ApiError && error.status === 409 ? NOTHING_TO_PUBLISH : errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="publish">
      <button type="button" className="button button-primary" onClick={publish} disabled={busy || !canPublish}>
        {busy ? 'Publicerar…' : published ? 'Publicera senaste versionen' : 'Publicera'}
      </button>
      <p className="hint">
        {published
          ? 'Ändringar syns för andra först när du publicerar igen.'
          : 'När du publicerar kan du dela appen med kollegor.'}
      </p>
      <p className={message?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
        {message?.text ?? ''}
      </p>
    </div>
  );
}
