/**
 * Översätter agentens händelser till en lugn stegvisare. Användaren ska se VAD som händer i
 * vardagliga ord — inte filnamn, rundor eller tekniska detaljer.
 */
import type { AgentEvent, BuilderJobStatus, Diagnostic } from '@vibesandbox/contracts';

export type StepKey = 'wait' | 'write' | 'check' | 'fix';
export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface Step {
  readonly key: StepKey;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: string;
}

export interface JobSummary {
  readonly steps: readonly Step[];
  /** Hur mycket kod som skrivits i den pågående omgången — till framstegsmåttet. */
  readonly outputChars: number;
  /** Agentens senaste lägesbesked, i klarspråk. */
  readonly statusMessage: string | undefined;
  /** `null` så länge jobbet pågår. */
  readonly finished: { readonly ok: boolean; readonly message: string } | null;
  /**
   * Felen från den senaste kontrollen som underkände koden — tomt om den senaste kontrollen gick
   * igenom. Visas under "Visa detaljer" när bygget inte gick.
   */
  readonly diagnostics: readonly Diagnostic[];
}

const SOURCE_TEXT: Readonly<Record<Diagnostic['source'], string>> = {
  policy: 'regelkontroll',
  typecheck: 'typkontroll',
  build: 'bygge',
};

/** Ett fel på en rad: var, vad, och vilken kontroll som hittade det. */
export function describeDiagnostic(d: Diagnostic): string {
  const where = d.file === undefined ? '' : d.line === undefined ? `${d.file} — ` : `${d.file}, rad ${d.line} — `;
  const check = d.rule === undefined ? SOURCE_TEXT[d.source] : `${SOURCE_TEXT[d.source]}: ${d.rule}`;
  return `${where}${d.message} (${check})`;
}

const LABELS: Readonly<Record<StepKey, string>> = {
  wait: 'Väntar på sin tur…',
  write: 'Skriver koden…',
  check: 'Kontrollerar och bygger…',
  fix: 'Rättar fel…',
};

const FAILED_FALLBACK = 'Det gick inte att bygga appen den här gången. Försök igen, gärna med en enklare beskrivning.';
const DONE_FALLBACK = 'Appen är klar att prova.';

function problemsText(problems: number): string {
  return problems === 1 ? '1 sak att rätta' : `${problems} saker att rätta`;
}

export function summarizeJob(events: readonly AgentEvent[], status: BuilderJobStatus): JobSummary {
  if (status === 'queued' && events.length === 0) {
    return {
      steps: [{ key: 'wait', label: LABELS.wait, state: 'active' }],
      outputChars: 0,
      statusMessage: undefined,
      finished: null,
      diagnostics: [],
    };
  }

  let write: StepState = 'active';
  let check: StepState = 'pending';
  let fix: StepState | undefined;
  let checkDetail: string | undefined;
  let outputChars = 0;
  let statusMessage: string | undefined;
  let finished: JobSummary['finished'] = null;
  let diagnostics: readonly Diagnostic[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'status':
        statusMessage = event.message;
        break;
      case 'progress':
        outputChars = event.outputChars;
        break;
      case 'files':
        // Koden är skriven (eller rättad) — nu kontrolleras den.
        if (fix === undefined) write = 'done';
        else fix = 'done';
        check = 'active';
        checkDetail = undefined;
        break;
      case 'check':
        check = 'done';
        diagnostics = event.ok ? [] : (event.diagnostics ?? []);
        if (event.ok) {
          checkDetail = undefined;
        } else {
          checkDetail = problemsText(event.problems);
          fix = 'active';
          outputChars = 0;
        }
        break;
      case 'done':
        finished = { ok: event.ok, message: event.message };
        break;
    }
  }

  if (finished === null && (status === 'done' || status === 'failed')) {
    finished = status === 'done' ? { ok: true, message: DONE_FALLBACK } : { ok: false, message: FAILED_FALLBACK };
  }

  if (finished !== null) {
    if (finished.ok) {
      write = 'done';
      check = 'done';
      if (fix !== undefined) fix = 'done';
    } else if (fix === 'active') fix = 'failed';
    else if (check === 'active') check = 'failed';
    else if (write === 'active') write = 'failed';
  }

  const steps: Step[] = [
    { key: 'write', label: LABELS.write, state: write },
    checkDetail === undefined
      ? { key: 'check', label: LABELS.check, state: check }
      : { key: 'check', label: LABELS.check, state: check, detail: checkDetail },
  ];
  if (fix !== undefined) steps.push({ key: 'fix', label: LABELS.fix, state: fix });

  return { steps, outputChars, statusMessage, finished, diagnostics };
}

/**
 * Ett diskret framstegsmått 0…1 för "Skriver koden…". Vi vet inte hur lång koden blir, så måttet
 * närmar sig 95 % utan att nå fram — det visar att något händer, inte hur mycket som återstår.
 */
export function writingProgress(outputChars: number): number {
  if (!Number.isFinite(outputChars) || outputChars <= 0) return 0;
  return (0.95 * outputChars) / (outputChars + 6000);
}
