import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  AgentEvent,
  AppExport,
  BuilderAppDetail,
  BuilderJobStatus,
  BuilderReviewStatus,
  DecommissionEvidence,
} from '@vibesandbox/contracts';
import { ApiError } from './api.ts';
import { appendToChat, registerChatInput } from './chatInput.ts';
import { api, errorMessage, sessionFlash, sleep } from './client.ts';
import { ToolFeedback } from './Feedback.tsx';
import { lastAssistantIndex } from './feedback.ts';
import { JobSteps } from './JobSteps.tsx';
import { OpenLink } from './OpenLink.tsx';
import { followJob } from './polling.ts';
import { GuideLink } from './ServicesGuide.tsx';
import { SharePanel } from './SharePanel.tsx';
import { summarizeJob } from './steps.ts';
import {
  DECOMMISSION_BUSY,
  DECOMMISSION_BUTTON,
  DECOMMISSION_CONFIRM_LABEL,
  DECOMMISSION_DONE_BODY,
  DECOMMISSION_DONE_HEADING,
  DECOMMISSION_DONE_LINK,
  DECOMMISSION_HEADING,
  DECOMMISSION_LEAD,
  DECOMMISSION_REMAINS,
  DECOMMISSION_WARNING,
  EXPORT_BUSY,
  EXPORT_BUTTON,
  EXPORT_FORMAT_NOTE,
  EXPORT_WHY,
  PUBLISH_REQUEST_AGAIN_BUTTON,
  PUBLISH_REQUEST_AGAIN_HINT,
  PUBLISH_REQUEST_BUTTON,
  PUBLISH_REQUEST_HINT,
  PUBLISH_REQUEST_SENDING,
  REVIEW_REASON_LEAD,
  decommissionConfirmHint,
  decommissionEvidenceText,
  exportFileName,
  reviewOwnerText,
} from './texts.ts';

interface ActiveJob {
  readonly jobId: string;
  readonly status: BuilderJobStatus;
  readonly events: readonly AgentEvent[];
}

const BUSY_MESSAGE = 'Appen byggs redan. Vänta tills det pågående arbetet är klart, så kan du skriva nästa önskemål.';

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
  // Begäran om publicering, så som servern senast beskrev den. Den ändras på två sätt: en ny
  // hämtning (granskaren har avgjort, eller ett nytt bygge drog tillbaka ärendet) och ägarens egen
  // begäran. Båda kommer från servern — vyn hittar aldrig på ett läge.
  const [review, setReview] = useState<BuilderReviewStatus | null>(null);
  // Gallringsbeviset, när appen har avvecklats. Så länge det är `null` finns appen; när det inte
  // är det finns den inte längre, och då är arbetsytan inte en yta som går att visa.
  const [decommissioned, setDecommissioned] = useState<DecommissionEvidence | null>(null);

  const reload = useCallback(async () => {
    try {
      const detail = await api.getApp(appId);
      setApp(detail);
      if (detail.publishedUrl !== undefined) setPublishedUrl(detail.publishedUrl);
      setReview(detail.review ?? null);
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

  // Avvecklad: ingenting av arbetsytan går att visa längre — förhandsvisningen har ingen adress
  // att hämta, och att låta konversationen stå kvar hade sagt att appen finns. Kvar blir beskedet
  // och vägen tillbaka till listan.
  if (decommissioned !== null) {
    return (
      <div className="page">
        <DecommissionDone evidence={decommissioned} />
      </div>
    );
  }

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

        <Conversation appId={appId} app={app} />

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
          // Ett ärende som väntar stänger knappen: servern svarar ändå att appen redan ligger i kö,
          // och en knapp som bara kan misslyckas är ett löfte vyn inte kan hålla.
          canRequest={app.hasDraft && !running && review?.state !== 'vantar'}
          published={app.published}
          review={review}
          onRequested={(status) => setReview(status)}
        />
        {publishedUrl !== null && <SharePanel appId={appId} publishedUrl={publishedUrl} />}
        <DecommissionBar appId={appId} appName={app.name} onDone={setDecommissioned} />
      </div>
    </div>
  );
}

function Conversation({ appId, app }: { appId: string; app: BuilderAppDetail }) {
  if (app.messages.length === 0) {
    return <p className="muted">Här syns det du skriver och vad som händer med appen.</p>;
  }
  // Tummarna gäller byggverktyget som helhet, men hör ögat hemma vid det senaste svaret.
  // Platsen räknas om varje gång: meddelanden läggs till optimistiskt och har inget id.
  const feedbackAt = lastAssistantIndex(app.messages);
  return (
    <ol className="messages" aria-label="Konversationen">
      {app.messages.map((message, index) => (
        <li key={`${index}-${message.createdAt}`} className={`message message-${message.role}`}>
          <span className="message-who">{message.role === 'user' ? 'Du' : 'Byggverktyget'}</span>
          <span className="message-text">{message.text}</span>
          {index === feedbackAt && <ToolFeedback appId={appId} messages={app.messages} />}
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

/**
 * Knappen som förut publicerade. Nu BEGÄR den publicering: ägaren släpper inte ut appen själv,
 * utan en granskare läser koden och avgör. Anropet går till samma rutt som förut, men svaret är
 * ett väntande ärende — och det är läget, inte knappen, som är den viktiga delen av den här ytan.
 */
function PublishBar({
  appId,
  canRequest,
  published,
  review,
  onRequested,
}: {
  appId: string;
  canRequest: boolean;
  published: boolean;
  review: BuilderReviewStatus | null;
  onRequested: (review: BuilderReviewStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      const requested = await api.requestReview(appId);
      // Läget kommer från servern, inte från att knappen trycktes: står det inget ärende där
      // ska vyn inte påstå att det gör det.
      onRequested({ state: requested.state, requestedAt: requested.requestedAt, decidedAt: null, reason: null });
    } catch (caught) {
      // 409 betyder numera två saker: inget färdigt utkast, eller ett ärende som redan väntar.
      // Servern skriver vilket i klarspråk, så dess egen text går före vår.
      setError(caught instanceof ApiError ? caught.message : errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return <PublishPanel canRequest={canRequest} published={published} review={review} busy={busy} error={error} onRequest={() => void request()} />;
}

/**
 * Ytan i sig, utan något eget minne: allt den visar kommer utifrån. Då går ägarens fyra lägen att
 * pröva var för sig — och `tillbakadragen` är det som måste prövas, eftersom det är det enda läget
 * som ser ut som ett avslag utan att vara det.
 */
export function PublishPanel({
  canRequest,
  published,
  review,
  busy,
  error,
  onRequest,
}: {
  canRequest: boolean;
  published: boolean;
  review: BuilderReviewStatus | null;
  busy: boolean;
  error: string | null;
  onRequest: () => void;
}) {
  const state = reviewOwnerText(review?.state ?? 'vantar');
  return (
    <div className="publish">
      <button type="button" className="button button-primary" onClick={onRequest} disabled={busy || !canRequest}>
        {busy ? PUBLISH_REQUEST_SENDING : published ? PUBLISH_REQUEST_AGAIN_BUTTON : PUBLISH_REQUEST_BUTTON}
      </button>
      <p className="hint">{published ? PUBLISH_REQUEST_AGAIN_HINT : PUBLISH_REQUEST_HINT}</p>

      {/* Läget läses upp när det ändras: hon kan stå kvar på sidan i timmar utan att titta. */}
      <div aria-live="polite">
        {review !== null && (
          <div className={review.state === 'godkand' ? 'notice notice-ok' : 'notice'}>
            <strong>{state.heading}</strong>
            <p>{state.body}</p>
            {/* Granskarens ord står ordagrant och för sig, så att det syns vad som är hennes text
                och vad som är plattformens. Vyn sammanfattar den aldrig. */}
            {review.state === 'avvisad' && review.reason !== null && review.reason !== '' && (
              <>
                <p className="hint">{REVIEW_REASON_LEAD}</p>
                <blockquote className="message-text">{review.reason}</blockquote>
              </>
            )}
          </div>
        )}
      </div>

      <p className={error === null ? 'status-line' : 'status-line status-error'} aria-live="polite">
        {error ?? ''}
      </p>
    </div>
  );
}

// ── Avveckling och export ─────────────────────────────────────────────────────
//
// Exporten först, avvecklingen sedan, i samma ruta. Ordningen är inte en artighet: det appen bär
// kan vara allmän handling, och en väg ut ska finnas innan vägen bort erbjuds.

export interface ExportFile {
  /** Namnet filen får i hämtningsmappen. */
  readonly name: string;
  readonly type: string;
  readonly contents: string;
}

/**
 * Exporten som en fil. Ren funktion, och tidpunkten skickas in, så att det som faktiskt hamnar i
 * filen går att pröva utan webbläsare — själva sparandet nedan är bara några rader DOM.
 *
 * Innehållet skrivs med indrag. Filen är gjord för att läsas av ett program, men den som öppnar
 * den för att se efter vad som fanns i appen ska inte mötas av en enda oändlig rad.
 */
export function exportFile(appName: string, data: AppExport, at: Date): ExportFile {
  return {
    name: exportFileName(appName, at),
    type: 'application/json',
    contents: `${JSON.stringify(data, null, 2)}\n`,
  };
}

/**
 * Sparar filen i webbläsaren: en länk som aldrig syns, ett klick, och bort igen. Ingenting går via
 * servern — exporten är redan hämtad och ligger i minnet.
 *
 * Adressen pekar på den kopian och frigörs inte av sig själv; utan `revokeObjectURL` ligger hela
 * exporten kvar i minnet tills fliken stängs. Den frigörs i en timeout och inte direkt efter
 * klicket, eftersom hämtningen i vissa webbläsare hinner starta först efter att anropet återvänt.
 */
function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.contents], { type: file.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Rutan med sitt eget minne: vad ägaren skrivit i bekräftelserutan, och vad servern svarat.
 * Anropen bor här, texterna och knapparna i `DecommissionPanel` nedan.
 */
function DecommissionBar({ appId, appName, onDone }: { appId: string; appName: string; onDone: (evidence: DecommissionEvidence) => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [decommissioning, setDecommissioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setExportError(null);
    try {
      saveFile(exportFile(appName, await api.exportApp(appId), new Date()));
    } catch (caught) {
      setExportError(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  }

  async function decommission() {
    setDecommissioning(true);
    setError(null);
    try {
      // Namnet skickas som ägaren skrev det. Servern prövar det själv, och gör den en annan
      // bedömning än vyn är det serverns som gäller — vyn stänger knappen av omtanke, inte i stället.
      onDone(await api.decommissionApp(appId, confirmText));
    } catch (caught) {
      setError(errorMessage(caught));
      setDecommissioning(false);
    }
    // Inget `finally`: lyckades det finns appen inte längre, och då ska knappen inte gå att trycka
    // igen medan vyn byts ut.
  }

  return (
    <DecommissionPanel
      appName={appName}
      confirmText={confirmText}
      onConfirmText={setConfirmText}
      onExport={() => void download()}
      exporting={exporting}
      exportError={exportError}
      onDecommission={() => void decommission()}
      decommissioning={decommissioning}
      error={error}
    />
  );
}

/**
 * Ytan i sig, utan eget minne: allt den visar kommer utifrån, precis som `PublishPanel`. Då går
 * det som är svårt att pröva var för sig — framför allt att knappen är STÄNGD tills appens namn
 * står ordagrant i rutan, fel skiftläge inräknat.
 *
 * Jämförelsen är avsiktligt en rak likhet. Ingen trimning, ingen normalisering av versaler: den
 * som skriver "bokning av mötesrum" om appen heter "Bokning av mötesrum" har inte läst namnet, och
 * den som inte läst namnet har inte den app hon tror framför sig.
 */
export function DecommissionPanel({
  appName,
  confirmText,
  onConfirmText,
  onExport,
  exporting,
  exportError,
  onDecommission,
  decommissioning,
  error,
}: {
  appName: string;
  confirmText: string;
  onConfirmText: (value: string) => void;
  onExport: () => void;
  exporting: boolean;
  exportError: string | null;
  onDecommission: () => void;
  decommissioning: boolean;
  error: string | null;
}) {
  const headingId = useId();
  const confirmId = useId();
  const confirmHintId = useId();
  const matches = confirmText === appName;

  return (
    <section className="decommission" aria-labelledby={headingId}>
      <h2 id={headingId}>{DECOMMISSION_HEADING}</h2>
      <p className="hint">{DECOMMISSION_LEAD}</p>

      {/* Exporten står först i rutan, och det är hela poängen med att den står här alls. */}
      <div className="decommission-export">
        <p className="hint">{EXPORT_WHY}</p>
        <button type="button" className="button" onClick={onExport} disabled={exporting}>
          {exporting ? EXPORT_BUSY : EXPORT_BUTTON}
        </button>
        <p className="hint">{EXPORT_FORMAT_NOTE}</p>
        <p className={exportError === null ? 'status-line' : 'status-line status-error'} aria-live="polite">
          {exportError ?? ''}
        </p>
      </div>

      {/* Vad som raderas, och vad som blir kvar. Två stycken, inte ett: det som står kvar gör det
          med flit, och den meningen får inte gömmas i slutet av varningen.

          Varningen är avsiktligt INTE `notice-error`. Ingenting har gått fel — det är ägaren som
          är på väg att göra något som inte går att ångra, och de två sakerna ska inte se likadana
          ut. Stilmallen hör till en annan del av gränssnittet; `.decommission-warning` är kroken. */}
      <p className="notice decommission-warning">{DECOMMISSION_WARNING}</p>
      <p className="hint">{DECOMMISSION_REMAINS}</p>

      <label className="field-label" htmlFor={confirmId}>
        {DECOMMISSION_CONFIRM_LABEL}
      </label>
      <p id={confirmHintId} className="hint">
        {decommissionConfirmHint(appName)}
      </p>
      <input
        id={confirmId}
        className="input"
        type="text"
        value={confirmText}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={confirmHintId}
        onChange={(event) => onConfirmText(event.target.value)}
        disabled={decommissioning}
      />

      <div className="form-actions">
        <button type="button" className="button button-danger" onClick={onDecommission} disabled={!matches || decommissioning}>
          {decommissioning ? DECOMMISSION_BUSY : DECOMMISSION_BUTTON}
        </button>
      </div>

      <p className={error === null ? 'status-line' : 'status-line status-error'} aria-live="polite">
        {error ?? ''}
      </p>
    </section>
  );
}

/**
 * Beskedet efteråt. Det säger samma två saker som varningen gjorde — vad som är borta och vad som
 * står kvar — men nu i förfluten tid, plus siffrorna ur gallringsbeviset. Utan dem är "appen är
 * borta" ett påstående ägaren inte kan pröva.
 */
export function DecommissionDone({ evidence }: { evidence: DecommissionEvidence }) {
  return (
    <div className="notice" role="status">
      <h1>{DECOMMISSION_DONE_HEADING}</h1>
      <p>{DECOMMISSION_DONE_BODY}</p>
      <p className="hint">{decommissionEvidenceText(evidence.documentsDeleted, evidence.filesDeleted)}</p>
      <p>
        <a className="button button-primary" href="#/">
          {DECOMMISSION_DONE_LINK}
        </a>
      </p>
    </div>
  );
}
