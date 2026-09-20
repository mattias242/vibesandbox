/**
 * Återkoppling på BYGGVERKTYGET, inte på appen: texterna i rutan och den lilla logiken bakom
 * den. Se kontraktet, `POST /_api/builder/apps/:appId/feedback`.
 *
 * Tumme ner mejlas till den som driver plattformen TILLSAMMANS MED hela konversationen om
 * appen. Det måste stå i rutan innan man skickar — `FEEDBACK_SHARE_NOTICE` är det löftet, och
 * `SAFETY_POINTS` i `texts.ts` säger samma sak på startsidan.
 */
import { ApiError } from './api.ts';
import type { BuilderMessage } from '@vibesandbox/contracts';

export const FEEDBACK_QUESTION = 'Hjälpte byggverktyget dig?';
export const FEEDBACK_UP_LABEL = 'Ja, det hjälpte';
export const FEEDBACK_DOWN_LABEL = 'Nej, det hjälpte inte';
export const FEEDBACK_TEXT_LABEL = 'Vad hjälpte inte?';

export const FEEDBACK_SHARE_NOTICE =
  'När du skickar går det du skriver och hela er konversation om appen till den som driver plattformen. Ingenting av det ändrar din app.';

export const FEEDBACK_TRANSCRIPT_SUMMARY = 'Visa konversationen som följer med';

export const FEEDBACK_THANKS_UP = 'Tack! Vi har räknat din tumme upp.';
export const FEEDBACK_THANKS_DOWN = 'Tack. Din text och er konversation om appen är skickade till den som driver plattformen.';

/**
 * Så mycket text rutan tar emot. Servern har sista ordet — det här är bara ett vänligt besked
 * innan något skickas i onödan.
 */
export const FEEDBACK_MAX_CHARS = 2000;

const EMPTY_MESSAGE = 'Skriv några ord om vad som inte hjälpte, så vet vi vad vi ska laga.';
const TOO_LONG_MESSAGE = 'Texten är för lång. Försök att korta ner den till det viktigaste.';

export type FeedbackValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/**
 * Var tummarna hör hemma. Återkopplingen gäller appens konversation som helhet, inte ett
 * enskilt svar — men den hör ögat hemma vid byggverktygets SENASTE svar. `BuilderMessage` har
 * ingen identitet, så ett radnummer får inte sparas: det räknas om varje gång.
 * Returnerar -1 när byggverktyget inte hunnit svara än.
 */
export function lastAssistantIndex(messages: readonly BuilderMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
}

export function validateFeedbackText(input: string): FeedbackValidation {
  const text = input.trim();
  if (text === '') return { ok: false, message: EMPTY_MESSAGE };
  if (text.length > FEEDBACK_MAX_CHARS) return { ok: false, message: TOO_LONG_MESSAGE };
  return { ok: true, text };
}

export function feedbackErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Något gick fel. Försök igen om en stund.';
  if (error.status === 400) return EMPTY_MESSAGE;
  if (error.status === 413) return TOO_LONG_MESSAGE;
  if (error.status === 429) return 'Du har skickat återkoppling flera gånger på kort tid. Vänta en stund och försök igen.';
  return error.message;
}
