import type { JobSummary } from './steps.ts';
import { describeDiagnostic, writingProgress } from './steps.ts';

const STATE_TEXT = {
  pending: 'kommer sedan',
  active: 'pågår',
  done: 'klart',
  failed: 'gick inte',
} as const;

/** Den lugna stegvisaren. Texterna läses upp via en aria-live-region i föräldern. */
export function JobSteps({ summary }: { summary: JobSummary }) {
  return (
    <div className="job">
      <ol className="steps">
        {summary.steps.map((step) => (
          <li key={step.key} className={`step step-${step.state}`}>
            <span className="step-icon" aria-hidden="true">
              {step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : ''}
            </span>
            <span className="step-text">
              <span className="step-label">{step.label}</span>
              <span className="visually-hidden"> ({STATE_TEXT[step.state]})</span>
              {step.detail !== undefined && <span className="step-detail">{step.detail}</span>}
              {step.state === 'active' && (step.key === 'write' || step.key === 'fix') && (
                <span className="meter" aria-hidden="true">
                  <span className="meter-fill" style={{ width: `${Math.round(writingProgress(summary.outputChars) * 100)}%` }} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {/* Agentens sammanfattning hamnar också i konversationen. Här räcker ett kort besked vid
          lyckat bygge; ett misslyckande förklaras här, där blicken redan är. */}
      {summary.finished !== null &&
        (summary.finished.ok ? (
          <p className="notice notice-ok">✓ Klart — förhandsvisningen är uppdaterad.</p>
        ) : (
          <>
            <p className="notice notice-error">{summary.finished.message}</p>
            {/* Tekniska detaljer för den som vill förstå — eller skicka dem vidare. Samma fel som
                modellen fick se i sista rättningsvarvet. */}
            {summary.diagnostics.length > 0 && (
              <details className="job-details">
                <summary>Visa detaljer</summary>
                <ul>
                  {summary.diagnostics.map((d, index) => (
                    <li key={index}>
                      <code>{describeDiagnostic(d)}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ))}
    </div>
  );
}
