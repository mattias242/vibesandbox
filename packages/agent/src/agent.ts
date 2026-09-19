/**
 * Agentloopen: ett önskemål blir källfiler som byggs, och byggfel matas tillbaka till modellen
 * i några tillståndslösa varv.
 *
 *   skriv → tolka → slå ihop (nuvarande ⊕ ändrade) → bygg → grönt ⇒ klart
 *                                                          → rött  ⇒ nästa varv rättar
 *
 * Ett varv = ett anrop till språkmodellen. Ett svar som inte går att använda (avkapat, fel
 * format, otillåten sökväg, utelämning) byggs aldrig; problemet återkopplas i nästa varv.
 */

import type {
  Agent,
  AgentEvent,
  AgentTurnInput,
  AgentTurnResult,
  BuildResult,
  BuildRunner,
  Diagnostic,
  LlmProvider,
  SourceFiles,
} from '@vibesandbox/contracts';
import { policyExplanation, securityViolation } from './klarsprak.ts';
import { buildUserMessage, topDiagnostics } from './meddelande.ts';
import type { Feedback } from './meddelande.ts';
import { parseResponse } from './protokoll.ts';
import { buildSystemPrompt } from './systemprompt.ts';
import type { AgentKnowledge } from './systemprompt.ts';

export interface AgentLimits {
  /** Högst så många anrop till språkmodellen per tur. */
  readonly maxRounds?: number;
  /** Delas mellan modellens tankar och svar hos resonemangsmodeller. */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface AgentOptions {
  readonly provider: LlmProvider;
  readonly buildRunner: BuildRunner;
  readonly knowledge: AgentKnowledge;
  readonly limits?: AgentLimits;
}

const DEFAULT_LIMITS = { maxRounds: 4, maxOutputTokens: 8000, temperature: 0.2 } as const;
/** Framsteg visas högst så här ofta — tillräckligt för att det ska se levande ut. */
const PROGRESS_INTERVAL_MS = 250;
const MAX_SUMMARY_CHARS = 1000;
/** Grov skattning när leverantören inte anger tokens: ungefär fyra tecken per token. */
const CHARS_PER_TOKEN = 4;

const TEXT = {
  writing: 'Skriver koden…',
  building: 'Kontrollerar och bygger…',
  fixing: (round: number, max: number) => `Rättar fel (försök ${round} av ${max})…`,
  truncated:
    'Ditt förra svar blev för långt och kapades. Skriv bara de filer som behöver ändras, och håll koden kortare.',
  defaultSummary: 'Appen är byggd.',
  gaveUp: (rounds: number) =>
    `Jag fick inte appen att fungera på ${rounds} försök, så inget har ändrats. Försök gärna igen, med ett enklare önskemål eller i mindre steg.`,
  aborted: 'Arbetet avbröts. Inget har ändrats.',
  buildFailed: 'Bygget kunde inte genomföras just nu, så inget har ändrats. Försök igen om en stund.',
  providerFailed: 'Språkmodellen kunde inte svara just nu, så inget har ändrats. Försök igen om en stund.',
} as const;

class Aborted extends Error {}

/** Tankar som läckt in först i svaret (`<think>…</think>` eller allt före en ensam `</think>`). */
function stripLeadingThoughts(text: string): string {
  const block = /^\s*<think>[\s\S]*?<\/think>/.exec(text);
  if (block !== null) return text.slice(block[0].length);
  const close = text.indexOf('</think>');
  const firstFile = text.search(/^\s*<vs-file /m);
  if (close !== -1 && (firstFile === -1 || close < firstFile)) return text.slice(close + '</think>'.length);
  return text;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Aborted ||
    (error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'aborted'))
  );
}

/** Leverantörens eget felmeddelande om det är avsett för användare (LlmError), annars ett allmänt. */
function providerMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'LlmError' && error.message !== '') return error.message;
  return TEXT.providerFailed;
}

export function createAgent(options: AgentOptions): Agent {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const systemPrompt = buildSystemPrompt(options.knowledge);

  return {
    async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      const emit = (event: AgentEvent): void => input.onEvent?.(event);
      const isNewApp = Object.keys(input.currentFiles).length === 0;
      let working: SourceFiles = isNewApp ? options.knowledge.starterFiles : input.currentFiles;
      let feedback: Feedback | undefined;
      let lastDiagnostics: readonly Diagnostic[] = [];
      // Felen från varje underkänt bygge i turen, äldst först — till rättningsvarvens historik.
      const failedRounds: Array<readonly Diagnostic[]> = [];
      const earlierRounds = (): ReadonlyArray<readonly Diagnostic[]> => failedRounds.slice(0, -1);
      let model = options.provider.name;
      let rounds = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };

      const finish = (ok: boolean, summary: string, extra: { files?: SourceFiles; build?: BuildResult } = {}): AgentTurnResult => {
        emit({ type: 'done', ok, message: summary });
        return {
          ok,
          files: extra.files ?? input.currentFiles,
          ...(extra.build === undefined ? {} : { build: extra.build }),
          summary,
          rounds,
          model,
          usage: { ...usage },
        };
      };

      const checkAbort = (): void => {
        if (input.signal?.aborted === true) throw new Aborted();
      };

      let pendingBuild: BuildResult | undefined;
      let phase: 'llm' | 'build' = 'llm';
      try {
        for (let round = 1; round <= limits.maxRounds; round++) {
          checkAbort();
          rounds = round;
          emit({ type: 'status', message: round === 1 ? TEXT.writing : TEXT.fixing(round, limits.maxRounds) });

          const messages = [
            { role: 'system' as const, content: systemPrompt },
            {
              role: 'user' as const,
              content: buildUserMessage({
                files: working,
                isNewApp,
                history: input.history,
                request: input.request,
                round,
                maxRounds: limits.maxRounds,
                ...(feedback === undefined ? {} : { feedback }),
              }),
            },
          ];

          phase = 'llm';
          let outputChars = 0;
          let lastProgress = -Infinity;
          const result = await options.provider.complete({
            messages,
            maxTokens: limits.maxOutputTokens,
            temperature: limits.temperature,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            onText: (chunk) => {
              outputChars += chunk.length;
              const now = Date.now();
              if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
                lastProgress = now;
                emit({ type: 'progress', outputChars });
              }
            },
          });
          emit({ type: 'progress', outputChars: Math.max(outputChars, result.text.length) });
          checkAbort();

          model = result.model;
          if (result.usage !== undefined) {
            usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens;
          } else {
            const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
            usage.inputTokens += Math.ceil(inputChars / CHARS_PER_TOKEN);
            usage.outputTokens += Math.ceil(result.text.length / CHARS_PER_TOKEN);
          }

          // Ett avkapat svar tolkas ALDRIG, hur komplett det än ser ut.
          if (result.finishReason !== 'stop') {
            feedback = { responseProblems: [TEXT.truncated], diagnostics: lastDiagnostics, earlier: earlierRounds() };
            continue;
          }

          const parsed = parseResponse(stripLeadingThoughts(result.text));
          if (!parsed.ok) {
            feedback = { responseProblems: parsed.problems, diagnostics: lastDiagnostics, earlier: earlierRounds() };
            continue;
          }

          const merged: SourceFiles = { ...working, ...parsed.files };
          emit({ type: 'files', paths: Object.keys(parsed.files).sort() });
          emit({ type: 'status', message: TEXT.building });

          phase = 'build';
          pendingBuild = await options.buildRunner.build(merged, input.signal === undefined ? undefined : { signal: input.signal });
          emit(
            pendingBuild.ok
              ? { type: 'check', ok: true, problems: pendingBuild.diagnostics.length }
              : { type: 'check', ok: false, problems: pendingBuild.diagnostics.length, diagnostics: topDiagnostics(pendingBuild.diagnostics) },
          );
          checkAbort();

          if (pendingBuild.ok) {
            const build = pendingBuild;
            pendingBuild = undefined;
            const summary = parsed.summary === '' ? TEXT.defaultSummary : parsed.summary.slice(0, MAX_SUMMARY_CHARS);
            return finish(true, summary, { files: merged, build });
          }

          const diagnostics = pendingBuild.diagnostics;
          await pendingBuild.dispose();
          pendingBuild = undefined;

          const violation = securityViolation(diagnostics);
          if (violation !== null) return finish(false, violation);

          working = merged;
          lastDiagnostics = diagnostics;
          failedRounds.push(diagnostics);
          feedback = { responseProblems: [], diagnostics, earlier: earlierRounds() };
        }

        return finish(false, policyExplanation(lastDiagnostics) ?? TEXT.gaveUp(rounds));
      } catch (error) {
        if (pendingBuild !== undefined) await pendingBuild.dispose().catch(() => undefined);
        if (isAbortError(error) || input.signal?.aborted === true) return finish(false, TEXT.aborted);
        if (phase === 'llm') return finish(false, providerMessage(error));
        // Fel från byggkedjan kan bära sökvägar på servern: de visas aldrig.
        return finish(false, TEXT.buildFailed);
      }
    },
  };
}
