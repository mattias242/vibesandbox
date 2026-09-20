import { useId, useState } from 'react';
import type { BuilderFeedback, BuilderMessage } from '@vibesandbox/contracts';
import { api } from './client.ts';
import {
  FEEDBACK_DOWN_LABEL,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_QUESTION,
  FEEDBACK_SHARE_NOTICE,
  FEEDBACK_TEXT_LABEL,
  FEEDBACK_THANKS_DOWN,
  FEEDBACK_THANKS_UP,
  FEEDBACK_TRANSCRIPT_SUMMARY,
  FEEDBACK_UP_LABEL,
  feedbackErrorMessage,
  validateFeedbackText,
} from './feedback.ts';

/**
 * Tummarna vid byggverktygets senaste svar. De gäller BYGGVERKTYGET, inte appen — och tumme ner
 * mejlar det man skriver till den som driver plattformen, tillsammans med hela konversationen
 * om appen. Det står i rutan, och konversationen går att fälla ut och läsa innan man skickar.
 */
export function ToolFeedback({ appId, messages }: { appId: string; messages: readonly BuilderMessage[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const questionId = useId();

  async function send(feedback: BuilderFeedback, thanks: string) {
    setSending(true);
    setFormError(null);
    setResult(null);
    try {
      await api.sendFeedback(appId, feedback);
      setResult({ ok: true, message: thanks });
      setOpen(false);
      setText('');
    } catch (error) {
      // Felet hör hemma där man står: i rutan när det finns en ruta — där ligger också texten
      // man höll på med, och den ska inte försvinna — annars på kvittoraden vid tummarna.
      const message = feedbackErrorMessage(error);
      if (feedback.helpful) setResult({ ok: false, message });
      else setFormError(message);
    } finally {
      setSending(false);
    }
  }

  const answered = result?.ok === true;

  return (
    <div className="feedback">
      <p className="feedback-question" id={questionId}>
        {FEEDBACK_QUESTION}
      </p>

      {!answered && (
        <div className="feedback-buttons" role="group" aria-labelledby={questionId}>
          <button
            type="button"
            className="button feedback-thumb"
            disabled={sending}
            onClick={() => {
              void send({ helpful: true }, FEEDBACK_THANKS_UP);
            }}
          >
            <Thumb />
            {FEEDBACK_UP_LABEL}
          </button>
          <button
            type="button"
            className="button feedback-thumb"
            aria-expanded={open}
            disabled={sending}
            onClick={() => {
              setResult(null);
              setFormError(null);
              setOpen((current) => !current);
            }}
          >
            <Thumb down />
            {FEEDBACK_DOWN_LABEL}
          </button>
        </div>
      )}

      {open && !answered && (
        <FeedbackForm
          messages={messages}
          text={text}
          sending={sending}
          error={formError}
          onTextChange={(value) => {
            setText(value);
            if (formError !== null) setFormError(null);
          }}
          onSubmit={() => {
            const checked = validateFeedbackText(text);
            if (!checked.ok) {
              setFormError(checked.message);
              return;
            }
            void send({ helpful: false, text: checked.text }, FEEDBACK_THANKS_DOWN);
          }}
          onCancel={() => {
            setOpen(false);
            setFormError(null);
          }}
        />
      )}

      <p className={result?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
        {result?.message ?? ''}
      </p>
    </div>
  );
}

export interface FeedbackFormProps {
  /** Hela konversationen om appen — den som följer med i mejlet, och som går att läsa här. */
  readonly messages: readonly BuilderMessage[];
  readonly text: string;
  readonly sending: boolean;
  readonly error: string | null;
  readonly onTextChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

/** Rutan som öppnas av tumme ner. Egen komponent, så att den går att pröva utan webbläsare. */
export function FeedbackForm({ messages, text, sending, error, onTextChange, onSubmit, onCancel }: FeedbackFormProps) {
  const textId = useId();
  const noticeId = useId();
  const errorId = useId();

  return (
    <form
      className="feedback-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="field-label" htmlFor={textId}>
        {FEEDBACK_TEXT_LABEL}
      </label>
      {/* Löftet står FÖRE knappen att skicka, och pekas ut av fältet: den som lyssnar i stället
          för att se ska höra det tillsammans med fältet, inte efteråt. */}
      <p className="hint" id={noticeId}>
        {FEEDBACK_SHARE_NOTICE}
      </p>
      <details className="feedback-transcript">
        <summary>{FEEDBACK_TRANSCRIPT_SUMMARY}</summary>
        <ol className="feedback-transcript-list">
          {messages.map((message, index) => (
            <li key={`${index}-${message.createdAt}`}>
              <span className="message-who">{message.role === 'user' ? 'Du' : 'Byggverktyget'}</span>
              <span className="message-text">{message.text}</span>
            </li>
          ))}
        </ol>
      </details>
      <textarea
        id={textId}
        className="wish-text"
        rows={3}
        value={text}
        maxLength={FEEDBACK_MAX_CHARS}
        onChange={(event) => onTextChange(event.target.value)}
        aria-describedby={error === null ? noticeId : `${noticeId} ${errorId}`}
        aria-invalid={error !== null}
        disabled={sending}
      />
      {error !== null && (
        <p id={errorId} className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? 'Skickar…' : 'Skicka'}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={sending}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

/**
 * En tumme ritad i märkspråk. Inga ikoner utifrån (CSP), och den är stum för uppläsning:
 * knappens egen text säger vad den gör. Tumme ner är samma form, vänd ett halvt varv.
 */
function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg className="thumb-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <g fill="currentColor" transform={down ? 'rotate(180 12 12)' : undefined}>
        <rect x="2.5" y="10" width="4.5" height="10.5" rx="1.3" />
        <path d="M9 20.5V9.6l4.2-6.1a1.7 1.7 0 0 1 3 1.4L15.2 9h4.5a2.1 2.1 0 0 1 2 2.6l-1.6 6.8a3 3 0 0 1-2.9 2.1H9z" />
      </g>
    </svg>
  );
}
