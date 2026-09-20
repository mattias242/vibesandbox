/**
 * Knappen "Använd" i guiden klistrar in en exempelmening i chattrutan — utan att skicka.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appendToChat, hasChatInput, insertIntoChat, registerChatInput } from '../src/chatInput.ts';

describe('appendToChat', () => {
  it('givet en tom chattruta, så blir exemplet hela texten', () => {
    expect(appendToChat('', 'Lägg till en knapp för att bifoga bilder.')).toBe('Lägg till en knapp för att bifoga bilder.');
    expect(appendToChat('  \n', 'Hej.')).toBe('Hej.');
  });

  it('givet att du redan skrivit något, så hamnar exemplet på en ny rad efter det', () => {
    expect(appendToChat('Gör rubriken större.  ', 'Lägg till sökning.')).toBe('Gör rubriken större.\nLägg till sökning.');
  });
});

describe('insertIntoChat', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it('givet att ingen chattruta finns, så händer inget och svaret är falskt', () => {
    expect(hasChatInput()).toBe(false);
    expect(insertIntoChat('Hej.')).toBe(false);
  });

  it('givet en chattruta, så får den texten och svaret är sant', () => {
    const received: string[] = [];
    unregister = registerChatInput((text) => received.push(text));
    expect(hasChatInput()).toBe(true);
    expect(insertIntoChat('Lägg till sökning.')).toBe(true);
    expect(received).toEqual(['Lägg till sökning.']);
  });

  it('den senast visade chattrutan gäller, och en borttagen chattruta får inget', () => {
    const first: string[] = [];
    const second: string[] = [];
    const unregisterFirst = registerChatInput((text) => first.push(text));
    const unregisterSecond = registerChatInput((text) => second.push(text));
    insertIntoChat('A.');
    unregisterSecond();
    insertIntoChat('B.');
    unregisterFirst();
    expect(insertIntoChat('C.')).toBe(false);
    expect(second).toEqual(['A.']);
    expect(first).toEqual(['B.']);
  });
});
