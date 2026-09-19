/**
 * Felen i en kontrollhändelse sparas med jobbet och visas under "Visa detaljer".
 *
 *   Givet en kontroll som underkänner appen
 *   När händelsen sparas
 *   Så följer felen med — kapade, rensade och bara med kontraktets fält
 */
import { describe, expect, it } from 'vitest';
import { sanitizeEvent } from '../src/ko.ts';

describe('kontrollhändelsens fel sparas rensade', () => {
  it('ett underkänt bygge behåller källa, regel, fil, rad och meddelande', () => {
    const fel = { source: 'typecheck', rule: 'TS2532', file: 'src/App.tsx', line: 12, message: "Object is possibly 'undefined'." };
    expect(sanitizeEvent({ type: 'check', ok: false, problems: 1, diagnostics: [fel] })).toEqual({
      type: 'check',
      ok: false,
      problems: 1,
      diagnostics: [fel],
    });
  });

  it('kapar antal och längd, och släpper fel som inte följer kontraktet', () => {
    const giltiga = Array.from({ length: 15 }, (_, i) => ({ source: 'build', message: `fel ${i}` }));
    const handelse = sanitizeEvent({
      type: 'check',
      ok: false,
      problems: 20,
      diagnostics: [
        { source: 'okänd', message: 'fel källa' },
        { source: 'build' },
        { source: 'policy', message: 'x'.repeat(5000), file: 'f'.repeat(5000), rule: 'r'.repeat(5000), line: -3, extra: 'smyger' },
        'inte ett objekt',
        ...giltiga,
      ],
    });
    if (handelse?.type !== 'check') throw new Error('ingen kontroll');
    const fel = handelse.diagnostics ?? [];
    expect(fel).toHaveLength(10);
    expect(fel.some((d) => d.message === 'fel källa')).toBe(false);
    const policy = fel[0];
    expect(policy?.source).toBe('policy');
    expect(policy?.message.length).toBeLessThanOrEqual(300);
    expect(policy?.file?.length).toBeLessThanOrEqual(200);
    expect(policy?.rule?.length).toBeLessThanOrEqual(100);
    expect(policy).not.toHaveProperty('line');
    expect(policy).not.toHaveProperty('extra');
  });

  it('ett godkänt bygge, eller en lista utan giltiga fel, sparas utan diagnostics', () => {
    expect(sanitizeEvent({ type: 'check', ok: true, problems: 0, diagnostics: [{ source: 'build', message: 'x' }] })).toEqual({
      type: 'check',
      ok: true,
      problems: 0,
    });
    expect(sanitizeEvent({ type: 'check', ok: false, problems: 1, diagnostics: [{ source: 'nej', message: 'x' }] })).toEqual({
      type: 'check',
      ok: false,
      problems: 1,
    });
    expect(sanitizeEvent({ type: 'check', ok: false, problems: 1, diagnostics: 'inte en lista' })).toEqual({
      type: 'check',
      ok: false,
      problems: 1,
    });
  });
});
