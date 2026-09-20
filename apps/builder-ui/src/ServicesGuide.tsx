/**
 * Guiden "Vilka tjänster finns som appen kan använda?" som en panel ovanpå byggverktyget.
 *
 * En panel i stället för en egen vy: den som är mitt i ett bygge ska kunna läsa utan att lämna
 * arbetsytan — det som står i chattrutan och bygget som pågår ligger kvar under panelen.
 * `<dialog>` med `showModal()` ger fokusfälla, Esc och en inaktiv bakgrund utan egen kod.
 * Innehållet är data i formagor.ts; här finns bara uppställningen.
 */
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import type { AppServiceName } from '@vibesandbox/contracts';
import { hasChatInput, insertIntoChat } from './chatInput.ts';
import {
  BASE_HEADING,
  CLOSE_LABEL,
  EXAMPLES_LABEL,
  GOOD_TO_KNOW_LABEL,
  GUIDE_INTRO,
  GUIDE_LINK_SHORT,
  GUIDE_TITLE,
  HOW_TO_LABEL,
  LIMITS_HEADING,
  SERVICES_HEADING,
  SERVICES_NONE,
  USE_LABEL,
  guideFor,
  type Capability,
} from './formagor.ts';

/** Öppnar guiden. Null när guiden inte går att visa (t.ex. innan inloggningen är klar). */
const OpenGuideContext = createContext<(() => void) | null>(null);

export function OpenGuideProvider({ open, children }: { open: (() => void) | null; children: ReactNode }) {
  return <OpenGuideContext.Provider value={open}>{children}</OpenGuideContext.Provider>;
}

/** Länken vid chattrutan. Visas inte om guiden inte går att öppna. */
export function GuideLink({ short = false }: { short?: boolean }) {
  const open = useContext(OpenGuideContext);
  if (open === null) return null;
  return (
    <button type="button" className="link-button" aria-haspopup="dialog" onClick={open}>
      {short ? GUIDE_LINK_SHORT : GUIDE_TITLE}
    </button>
  );
}

export function ServicesGuide({
  open,
  services,
  onClose,
}: {
  open: boolean;
  services: readonly AppServiceName[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const guide = guideFor(services);
  const canUse = open && hasChatInput();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Börja läsa från rubriken, inte från första knappen.
      headingRef.current?.focus();
      dialog.scrollTop = 0;
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function use(example: string) {
    // Stäng först: dialogen lämnar tillbaka fokus till knappen som öppnade den, och chattrutan
    // ska få fokus efter det.
    dialogRef.current?.close();
    onClose();
    insertIntoChat(example);
  }

  return (
    <dialog
      ref={dialogRef}
      className="guide"
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(event) => {
        // Klick på den mörka bakgrunden (utanför panelen) stänger.
        if (event.target === dialogRef.current) dialogRef.current.close();
      }}
    >
      <div className="guide-inner">
        <div className="guide-head">
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {GUIDE_TITLE}
          </h2>
          <button type="button" className="button button-small" onClick={() => dialogRef.current?.close()}>
            {CLOSE_LABEL}
          </button>
        </div>

        {GUIDE_INTRO.map((paragraph, index) =>
          // Andra stycket handlar om knappen Använd — det gäller bara när det finns en chattruta.
          index === 1 && !canUse ? null : (
            <p key={paragraph} className="guide-intro">
              {paragraph}
            </p>
          ),
        )}

        <section aria-labelledby={`${headingId}-base`}>
          <h3 id={`${headingId}-base`} className="guide-section">
            {BASE_HEADING}
          </h3>
          {guide.base.map((capability) => (
            <CapabilityCard key={capability.key} capability={capability} canUse={canUse} onUse={use} />
          ))}
        </section>

        <section aria-labelledby={`${headingId}-services`}>
          <h3 id={`${headingId}-services`} className="guide-section">
            {SERVICES_HEADING}
          </h3>
          {guide.services.length === 0 ? (
            <p>{SERVICES_NONE}</p>
          ) : (
            guide.services.map((capability) => (
              <CapabilityCard key={capability.key} capability={capability} canUse={canUse} onUse={use} />
            ))
          )}
        </section>

        <section aria-labelledby={`${headingId}-limits`}>
          <h3 id={`${headingId}-limits`} className="guide-section">
            {LIMITS_HEADING}
          </h3>
          <ul className="guide-limits">
            {guide.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>

        <div className="guide-foot">
          <button type="button" className="button" onClick={() => dialogRef.current?.close()}>
            {CLOSE_LABEL}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function CapabilityCard({
  capability,
  canUse,
  onUse,
}: {
  capability: Capability;
  canUse: boolean;
  onUse: (example: string) => void;
}) {
  const id = useId();
  return (
    <article className="capability" aria-labelledby={id}>
      <h4 id={id}>{capability.title}</h4>
      <p>{capability.about}</p>
      {capability.examples.length > 0 ? (
        <>
          <p className="capability-label">{EXAMPLES_LABEL}</p>
          <ul className="examples">
            {capability.examples.map((example) => (
              <li key={example} className="example">
                <span className="example-text">”{example}”</span>
                {canUse && (
                  <button
                    type="button"
                    className="button button-small"
                    // Synlig text först i namnet (WCAG 2.5.3); resten säger vilket exempel.
                    aria-label={`${USE_LABEL}: ${example}`}
                    onClick={() => onUse(example)}
                  >
                    {USE_LABEL}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : capability.howTo !== undefined ? (
        <p>
          <span className="capability-label-inline">{HOW_TO_LABEL}</span> {capability.howTo}
        </p>
      ) : null}
      <p className="capability-label">{GOOD_TO_KNOW_LABEL}</p>
      <ul className="good-to-know">
        {capability.goodToKnow.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </article>
  );
}
