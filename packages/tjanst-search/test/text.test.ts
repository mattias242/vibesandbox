/** Vilken text ur ett dokument som bäddas in. */
import { describe, expect, it } from 'vitest';
import { documentText, MAX_DOCUMENT_TEXT_CHARS, withPrefix } from '../src/text.ts';

describe('documentText', () => {
  it('tar alla strängvärden, även nästlade, men inte nycklar, tal eller sanningsvärden', () => {
    const text = documentText({ rubrik: 'Cykel stulen', antal: 3, klar: false, meta: { plats: 'Cykelstället', taggar: ['polis', 7] } });
    expect(text).toBe('Cykel stulen\nCykelstället\npolis');
  });

  it('med fields: bara de namngivna fälten, i angiven ordning', () => {
    const text = documentText({ rubrik: 'Cykel stulen', hemligt: 'nej', beskrivning: { text: 'från stället' } }, ['beskrivning', 'rubrik']);
    expect(text).toBe('från stället\nCykel stulen');
  });

  it('fält som saknas hoppas över', () => {
    expect(documentText({ rubrik: 'x' }, ['finnsinte'])).toBe('');
  });

  it('kapar texten vid längdgränsen', () => {
    const text = documentText({ a: 'x'.repeat(MAX_DOCUMENT_TEXT_CHARS * 3) });
    expect(text.length).toBe(MAX_DOCUMENT_TEXT_CHARS);
  });

  it('kapar inte mitt i ett surrogatpar', () => {
    const text = documentText({ a: 'a' + '😀'.repeat(MAX_DOCUMENT_TEXT_CHARS) });
    expect(text.length).toBeLessThanOrEqual(MAX_DOCUMENT_TEXT_CHARS);
    expect(text.isWellFormed()).toBe(true);
  });

  it('tomma och blanka strängar ger ingen text', () => {
    expect(documentText({ a: '', b: '   ' })).toBe('');
  });

  it('en fientligt djup nästling spräcker inte stacken', () => {
    let djup: unknown = 'botten';
    for (let i = 0; i < 10_000; i += 1) djup = [djup];
    expect(() => documentText({ djup } as never)).not.toThrow();
  });
});

describe('withPrefix', () => {
  it('multilingual-e5 vill ha "query: " och "passage: "', () => {
    expect(withPrefix('intfloat/multilingual-e5-large', 'query', 'cykel')).toBe('query: cykel');
    expect(withPrefix('intfloat/multilingual-e5-large', 'passage', 'cykel')).toBe('passage: cykel');
  });

  it('instruktionsvarianten vill ha en instruktion på frågan och inget på dokumenten', () => {
    expect(withPrefix('intfloat/multilingual-e5-large-instruct', 'query', 'cykel')).toMatch(/^Instruct: .+\nQuery: cykel$/);
    expect(withPrefix('intfloat/multilingual-e5-large-instruct', 'passage', 'cykel')).toBe('cykel');
  });

  it('andra modeller får texten som den är', () => {
    expect(withPrefix('BAAI/bge-m3', 'query', 'cykel')).toBe('cykel');
  });
});
