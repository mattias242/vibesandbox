/**
 * Användarmeddelandet i varje varv. Varven är TILLSTÅNDSLÖSA: modellen får varje gång en färsk
 * bild av läget — nuvarande filer, tidigare önskemål, det nya önskemålet och eventuella fel — men
 * aldrig sina egna tidigare svar. Det håller prompten liten och förutsägbar, och en modell som
 * gjort fel en gång blir inte "låst" av sitt eget felaktiga svar.
 *
 * Principen "ingen appdata i prompten": här finns bara källkod och önskemål, aldrig det som
 * användarna sparat i appen.
 */

import { MAX_EVENT_DIAGNOSTICS, MAX_EVENT_DIAGNOSTIC_CHARS } from '@vibesandbox/contracts';
import type { ConversationEntry, Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { formatFiles } from './protokoll.ts';

const MAX_HISTORY = 10;
const MAX_HISTORY_CHARS = 300;
const MAX_DIAGNOSTICS = MAX_EVENT_DIAGNOSTICS;
const MAX_DIAGNOSTIC_CHARS = MAX_EVENT_DIAGNOSTIC_CHARS;
/** Tidigare varvs fel visas kortare: de är bakgrund, inte det som ska rättas nu. */
const MAX_EARLIER_PER_ROUND = 5;

export interface Feedback {
  /** Varför förra svaret inte kunde användas (tolkfel, avkapat). */
  readonly responseProblems: readonly string[];
  /** Felen från senaste bygget av filerna som visas. */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Felen från de varv i samma tur som kom FÖRE det senaste, äldst först. Modellen ser dem för
   * att inte gå i cirklar: ett fel som kommer tillbaka pekas ut.
   */
  readonly earlier?: ReadonlyArray<readonly Diagnostic[]>;
}

export interface UserMessageInput {
  readonly files: SourceFiles;
  readonly isNewApp: boolean;
  readonly history: readonly ConversationEntry[];
  readonly request: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly feedback?: Feedback;
}

/**
 * Text från användaren (eller från ett felmeddelande som kan citera kod) får aldrig kunna bli en
 * protokolltagg: då kunde den låtsas vara en fil, eller smita förbi maskningen av personuppgifter,
 * som lämnar hela fil-block orörda.
 */
export function neutralize(text: string): string {
  return text.replace(/<(\/?)vs-/gi, '<$1 vs-');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SOURCE_ORDER: Readonly<Record<Diagnostic['source'], number>> = { policy: 0, typecheck: 1, build: 2 };
const SOURCE_NAME: Readonly<Record<Diagnostic['source'], string>> = { policy: 'regelkontroll', typecheck: 'typkontroll', build: 'bygge' };

/**
 * De viktigaste diagnoserna först (regelbrott, sedan typfel, sedan byggfel), utan dubbletter,
 * högst `max` stycken och med meddelandet på en rad och kortat. Samma urval matas tillbaka till
 * modellen och sparas med jobbet (kontrollhändelsen), så att det man ser är det modellen såg.
 */
export function topDiagnostics(diagnostics: readonly Diagnostic[], max = MAX_DIAGNOSTICS): Diagnostic[] {
  const sorted = diagnostics
    .map((d, index) => ({ d, index }))
    .sort((a, b) => SOURCE_ORDER[a.d.source] - SOURCE_ORDER[b.d.source] || a.index - b.index)
    .map(({ d }) => d);
  const picked: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const d of sorted) {
    const message = oneLine(d.message, MAX_DIAGNOSTIC_CHARS);
    const key = `${d.source}|${d.rule ?? ''}|${d.file ?? ''}|${d.line ?? ''}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({
      source: d.source,
      ...(d.rule === undefined ? {} : { rule: d.rule }),
      ...(d.file === undefined ? {} : { file: d.file }),
      ...(d.line === undefined ? {} : { line: d.line }),
      message,
    });
    if (picked.length === max) break;
  }
  return picked;
}

/** Samma fel oavsett rad: rättningen flyttar ofta felet några rader utan att ta bort det. */
function recurrenceKey(d: Diagnostic): string {
  return `${d.source}|${d.rule ?? ''}|${d.file ?? ''}|${oneLine(d.message, MAX_DIAGNOSTIC_CHARS)}`;
}

function formatOne(d: Diagnostic): string {
  const where = d.file === undefined ? '' : d.line === undefined ? `${d.file}: ` : `${d.file}, rad ${d.line}: `;
  return `- ${neutralize(where)}(${SOURCE_NAME[d.source]}${d.rule === undefined ? '' : `, ${neutralize(d.rule)}`}) ${neutralize(oneLine(d.message, MAX_DIAGNOSTIC_CHARS))}`;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string[] {
  return topDiagnostics(diagnostics).map(formatOne);
}

export function buildUserMessage(input: UserMessageInput): string {
  const parts: string[] = [];

  parts.push(
    input.isNewApp
      ? '# Appens filer\n\nAppen är ny. Det här är startfilerna; ändra eller ersätt dem så att appen gör det som önskas.'
      : '# Appens nuvarande filer',
  );
  parts.push(formatFiles(input.files));

  const earlier = input.history
    .filter((entry) => entry.role === 'user')
    .slice(-MAX_HISTORY)
    .map((entry) => `- ${neutralize(oneLine(entry.text, MAX_HISTORY_CHARS))}`);
  if (earlier.length > 0) {
    parts.push(`# Tidigare önskemål för appen (äldst först)\n\n${earlier.join('\n')}`);
  }

  parts.push(`# Nytt önskemål\n\n${neutralize(input.request.trim())}`);

  const feedback = input.feedback;
  const earlierRounds = (feedback?.earlier ?? []).filter((round) => round.length > 0);
  if (earlierRounds.length > 0) {
    const lines: string[] = ['# Tidigare försök i den här omgången', '', 'De här felen kom i tidigare försök. Upprepa inte samma rättning om den inte hjälpte.'];
    feedback?.earlier?.forEach((round, index) => {
      if (round.length === 0) return;
      lines.push('', `Försök ${index + 1}:`, ...topDiagnostics(round, MAX_EARLIER_PER_ROUND).map(formatOne));
    });
    parts.push(lines.join('\n'));
  }

  if (feedback !== undefined && (feedback.responseProblems.length > 0 || feedback.diagnostics.length > 0)) {
    const lines: string[] = [`# Rätta felen (försök ${input.round} av ${input.maxRounds})`];
    if (feedback.responseProblems.length > 0) {
      lines.push('', 'Ditt förra svar kunde inte användas:', ...feedback.responseProblems.map((p) => `- ${neutralize(p)}`));
    }
    if (feedback.diagnostics.length > 0) {
      // Hur många gånger felet har kommit, räknat över tidigare varv plus det senaste.
      const times = (d: Diagnostic): number =>
        1 + earlierRounds.filter((round) => round.some((e) => recurrenceKey(e) === recurrenceKey(d))).length;
      const current = topDiagnostics(feedback.diagnostics).map((d) => {
        const n = times(d);
        return n > 1 ? `${formatOne(d)} — det här felet har kommit tillbaka ${n} gånger; byt angreppssätt i stället för att upprepa samma rättning` : formatOne(d);
      });
      lines.push('', 'Filerna ovan gick inte att bygga. Rätta de här felen:', ...current);
    }
    lines.push('', 'Skriv de filer som behöver ändras för att rätta felen, hela, och uppfyll fortfarande önskemålet.');
    parts.push(lines.join('\n'));
  }

  parts.push('Svara enligt svarsformatet: sammanfattning, ändrade filer hela, sist <vs-done/>.');
  return parts.join('\n\n');
}
