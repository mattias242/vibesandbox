import { useId, useRef, useState, type FormEvent } from 'react';
import { api } from './client.ts';
import { MembersList } from './MembersList.tsx';
import { OpenLink } from './OpenLink.tsx';
import { SHARE_SUCCESS_MESSAGE, shareErrorMessage, validateEmail } from './share.ts';

/** Visas när appen är publicerad: adressen, kopiera/öppna och "Dela med en kollega". */
export function SharePanel({ appId, publishedUrl }: { appId: string; publishedUrl: string }) {
  const [copyStatus, setCopyStatus] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Ökas efter en lyckad inbjudan: den inbjudna har då fått åtkomst, och listan hämtas om.
  const [membersVersion, setMembersVersion] = useState(0);
  const emailId = useId();
  const resultId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(publishedUrl);
      setCopyStatus('Länken är kopierad.');
    } catch {
      // Urklipp kan vara spärrat. Markera adressen så att den går att kopiera för hand.
      urlRef.current?.select();
      setCopyStatus('Det gick inte att kopiera automatiskt. Adressen är markerad — kopiera den med Ctrl+C (Cmd+C på Mac).');
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    const checked = validateEmail(email);
    if (!checked.ok) {
      setResult({ ok: false, message: checked.message });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      await api.share(appId, checked.email);
      setResult({ ok: true, message: SHARE_SUCCESS_MESSAGE });
      setEmail('');
      setMembersVersion((version) => version + 1);
    } catch (error) {
      setResult({ ok: false, message: shareErrorMessage(error) });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="share" aria-labelledby="share-heading">
      <h2 id="share-heading">Dela appen</h2>
      <p>Bara de du bjuder in kommer åt appen, och de behöver logga in först.</p>

      <label className="field-label" htmlFor="published-url">
        Appens adress
      </label>
      <div className="url-row">
        <input id="published-url" ref={urlRef} className="input url" type="text" readOnly value={publishedUrl} />
        <button type="button" className="button" onClick={copy}>
          Kopiera länk
        </button>
        <OpenLink appId={appId} target="published" className="button">
          Öppna
        </OpenLink>
      </div>
      <p className="status-line" aria-live="polite">
        {copyStatus}
      </p>

      <form className="invite" onSubmit={invite} noValidate>
        <h3>Dela med en kollega</h3>
        <label className="field-label" htmlFor={emailId}>
          Kollegans e-postadress
        </label>
        <div className="url-row">
          <input
            id={emailId}
            className="input"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={result !== null && !result.ok}
            aria-describedby={resultId}
            disabled={sending}
          />
          <button type="submit" className="button button-primary" disabled={sending}>
            {sending ? 'Skickar…' : 'Skicka inbjudan'}
          </button>
        </div>
        <p id={resultId} className={result?.ok === false ? 'status-line status-error' : 'status-line'} aria-live="polite">
          {result?.message ?? ''}
        </p>
      </form>

      <MembersList appId={appId} refreshKey={membersVersion} />
    </section>
  );
}
