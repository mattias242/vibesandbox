/**
 * Användarmeddelandet i varje varv. Varven är TILLSTÅNDSLÖSA: modellen får varje gång en färsk
 * bild av läget — nuvarande filer, tidigare önskemål, det nya önskemålet och eventuella fel — men
 * aldrig sina egna tidigare svar. Det håller prompten liten och förutsägbar, och en modell som
 * gjort fel en gång blir inte "låst" av sitt eget felaktiga svar.
 *
 * Principen "ingen appdata i prompten": här finns bara källkod och önskemål, aldrig det som
 * användarna sparat i appen.
 */

import type { ConversationEntry, Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { formatFiles } from './protokoll.ts';

const MAX_HISTORY = 10;
const MAX_HISTORY_CHARS = 300;
const MAX_DIAGNOSTICS = 10;
const MAX_DIAGNOSTIC_CHARS = 300;

export interface Feedback {
  /** Varför förra svaret inte kunde användas (tolkfel, avkapat). */
  readonly responseProblems: readonly string[];
  /** Felen från senaste bygget av filerna som visas. */
  readonly diagnostics: readonly Diagnostic[];
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

/** De viktigaste diagnoserna först (regelbrott, sedan typfel, sedan byggfel), utan dubbletter. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string[] {
  const sorted = diagnostics
    .map((d, index) => ({ d, index }))
    .sort((a, b) => SOURCE_ORDER[a.d.source] - SOURCE_ORDER[b.d.source] || a.index - b.index)
    .map(({ d }) => d);
  const lines: string[] = [];
  for (const d of sorted) {
    const where = d.file === undefined ? '' : d.line === undefined ? `${d.file}: ` : `${d.file}, rad ${d.line}: `;
    const line = `- ${neutralize(where)}(${SOURCE_NAME[d.source]}${d.rule === undefined ? '' : `, ${neutralize(d.rule)}`}) ${neutralize(oneLine(d.message, MAX_DIAGNOSTIC_CHARS))}`;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length === MAX_DIAGNOSTICS) break;
  }
  return lines;
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
  if (feedback !== undefined && (feedback.responseProblems.length > 0 || feedback.diagnostics.length > 0)) {
    const lines: string[] = [`# Rätta felen (försök ${input.round} av ${input.maxRounds})`];
    if (feedback.responseProblems.length > 0) {
      lines.push('', 'Ditt förra svar kunde inte användas:', ...feedback.responseProblems.map((p) => `- ${neutralize(p)}`));
    }
    if (feedback.diagnostics.length > 0) {
      lines.push('', 'Filerna ovan gick inte att bygga. Rätta de här felen:', ...formatDiagnostics(feedback.diagnostics));
    }
    lines.push('', 'Skriv de filer som behöver ändras för att rätta felen, hela, och uppfyll fortfarande önskemålet.');
    parts.push(lines.join('\n'));
  }

  parts.push('Svara enligt svarsformatet: sammanfattning, ändrade filer hela, sist <vs-done/>.');
  return parts.join('\n\n');
}
