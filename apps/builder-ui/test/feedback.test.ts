/**
 * Logiken bakom återkopplingen på BYGGVERKTYGET: var tummarna hör hemma, vad som får skickas
 * och vilket klarspråk ett fel ska bli. Ingen webbläsare behövs — se `feedbackPanel.test.ts`
 * för själva rutan.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderMessage } from '@vibesandbox/contracts';
import { ApiError } from '../src/api.ts';
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_SHARE_NOTICE,
  feedbackErrorMessage,
  lastAssistantIndex,
  validateFeedbackText,
} from '../src/feedback.ts';

function message(role: BuilderMessage['role'], text: string): BuilderMessage {
  return { role, text, createdAt: '2026-09-20T10:00:00Z' };
}

describe('var tummarna hör hemma', () => {
  it('finns ingen plats för dem innan byggverktyget har svarat', () => {
    expect(lastAssistantIndex([])).toBe(-1);
    expect(lastAssistantIndex([message('user', 'En todo-lista')])).toBe(-1);
  });

  it('pekar ut byggverktygets senaste svar', () => {
    const messages = [message('user', 'En todo-lista'), message('assistant', 'Klart!')];
    expect(lastAssistantIndex(messages)).toBe(1);
  });

  it('stannar kvar vid det senaste svaret även när man hunnit skriva en ny rad', () => {
    const messages = [
      message('user', 'En todo-lista'),
      message('assistant', 'Första versionen är klar.'),
      message('user', 'Lägg till en knapp'),
    ];
    expect(lastAssistantIndex(messages)).toBe(1);
  });

  it('väljer det sista av flera svar', () => {
    const messages = [
      message('assistant', 'Första'),
      message('user', 'Mer'),
      message('assistant', 'Andra'),
    ];
    expect(lastAssistantIndex(messages)).toBe(2);
  });
});

describe('texten som mejlas', () => {
  it('måste innehålla något — annars finns det inget att skicka', () => {
    for (const input of ['', '   ', '\n\t ']) {
      const checked = validateFeedbackText(input);
      expect(checked.ok).toBe(false);
      expect(checked.ok === false && checked.message).toMatch(/[Ss]kriv/);
    }
  });

  it('putsas från blanktecken i kanterna', () => {
    const checked = validateFeedbackText('  Den förstod inte vad jag menade.  ');
    expect(checked).toEqual({ ok: true, text: 'Den förstod inte vad jag menade.' });
  });

  it('säger vänligt till när den blivit för lång, i stället för att servern gör det', () => {
    const checked = validateFeedbackText('a'.repeat(FEEDBACK_MAX_CHARS + 1));
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.message).toMatch(/för lång/);
  });

  it('släpper igenom en text som är precis så lång som den får vara', () => {
    expect(validateFeedbackText('a'.repeat(FEEDBACK_MAX_CHARS)).ok).toBe(true);
  });
});

describe('fel i klarspråk', () => {
  it('429 säger att man skickat många gånger, inte "rate_limited"', () => {
    const message429 = feedbackErrorMessage(new ApiError(429, 'rate_limited', 'rate_limited'));
    expect(message429).toMatch(/[Vv]änta en stund/);
    expect(message429).not.toMatch(/rate|limit/i);
  });

  it('400 ber om en text i stället för att skylla på formatet', () => {
    expect(feedbackErrorMessage(new ApiError(400, 'Ogiltig begäran.', 'invalid_request'))).toMatch(/[Ss]kriv/);
  });

  it('andra fel behåller serverns klarspråk', () => {
    expect(feedbackErrorMessage(new ApiError(503, 'Tjänsten är nere just nu.'))).toBe('Tjänsten är nere just nu.');
  });

  it('något som inte alls är ett svar blir ett vanligt vänligt besked', () => {
    expect(feedbackErrorMessage(new TypeError('boom'))).toMatch(/[Nn]ågot gick fel/);
  });
});

describe('löftet i rutan', () => {
  it('säger rakt ut att hela konversationen följer med, och till vem', () => {
    expect(FEEDBACK_SHARE_NOTICE).toMatch(/hela (?:er|din) konversation/i);
    expect(FEEDBACK_SHARE_NOTICE).toMatch(/plattformen/i);
  });
});
