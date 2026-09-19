/**
 * Agentens händelser → stegvisaren som användaren ser: "Skriver koden…", "Kontrollerar och
 * bygger…", "Rättar fel…" och till sist ✓ eller en förklaring.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@vibesandbox/contracts';
import { describeDiagnostic, summarizeJob, writingProgress } from '../src/steps.ts';

function view(events: readonly AgentEvent[], status: 'queued' | 'running' | 'done' | 'failed' = 'running') {
  const summary = summarizeJob(events, status);
  return { ...summary, compact: summary.steps.map((step) => `${step.key}:${step.state}`) };
}

describe('stegvisaren', () => {
  it('ett köat jobb utan händelser väntar på sin tur', () => {
    const { compact, steps } = view([], 'queued');
    expect(compact).toEqual(['wait:active']);
    expect(steps[0]?.label).toBe('Väntar på sin tur…');
  });

  it('ett startat jobb utan händelser skriver koden', () => {
    expect(view([], 'running').compact).toEqual(['write:active', 'check:pending']);
  });

  it('skriver koden → kontrollerar och bygger → klart', () => {
    const events: AgentEvent[] = [
      { type: 'status', message: 'Jag skriver koden.' },
      { type: 'progress', outputChars: 1200 },
    ];
    let summary = view(events);
    expect(summary.compact).toEqual(['write:active', 'check:pending']);
    expect(summary.steps.map((step) => step.label)).toEqual(['Skriver koden…', 'Kontrollerar och bygger…']);
    expect(summary.outputChars).toBe(1200);
    expect(summary.statusMessage).toBe('Jag skriver koden.');

    events.push({ type: 'files', paths: ['src/App.tsx'] });
    summary = view(events);
    expect(summary.compact).toEqual(['write:done', 'check:active']);

    events.push({ type: 'check', ok: true, problems: 0 });
    events.push({ type: 'done', ok: true, message: 'Appen är klar att prova.' });
    summary = view(events, 'done');
    expect(summary.compact).toEqual(['write:done', 'check:done']);
    expect(summary.finished).toEqual({ ok: true, message: 'Appen är klar att prova.' });
  });

  it('en kontroll med fel ger steget "Rättar fel…", som blir klart när de nya filerna kommer', () => {
    const events: AgentEvent[] = [
      { type: 'progress', outputChars: 3000 },
      { type: 'files', paths: ['src/App.tsx'] },
      { type: 'check', ok: false, problems: 2 },
    ];
    let summary = view(events);
    expect(summary.compact).toEqual(['write:done', 'check:done', 'fix:active']);
    expect(summary.steps[2]?.label).toBe('Rättar fel…');
    expect(summary.steps[1]?.detail).toBe('2 saker att rätta');
    // Framstegsmåttet gäller den pågående omgången.
    expect(summary.outputChars).toBe(0);

    events.push({ type: 'progress', outputChars: 500 });
    expect(view(events).outputChars).toBe(500);

    events.push({ type: 'files', paths: ['src/App.tsx'] });
    summary = view(events);
    expect(summary.compact).toEqual(['write:done', 'check:active', 'fix:done']);

    events.push({ type: 'check', ok: true, problems: 0 }, { type: 'done', ok: true, message: 'Klart.' });
    summary = view(events, 'done');
    expect(summary.compact).toEqual(['write:done', 'check:done', 'fix:done']);
    expect(summary.steps[1]?.detail).toBeUndefined();
  });

  it('ett problem i singular', () => {
    const summary = view([{ type: 'files', paths: [] }, { type: 'check', ok: false, problems: 1 }]);
    expect(summary.steps[1]?.detail).toBe('1 sak att rätta');
  });

  it('ett misslyckat jobb markerar det pågående steget och visar förklaringen', () => {
    const summary = view(
      [
        { type: 'files', paths: ['src/App.tsx'] },
        { type: 'check', ok: false, problems: 1 },
        { type: 'done', ok: false, message: 'Appen försökte skicka uppgifter till en annan adress, och det är inte tillåtet.' },
      ],
      'failed',
    );
    expect(summary.compact).toEqual(['write:done', 'check:done', 'fix:failed']);
    expect(summary.finished).toEqual({
      ok: false,
      message: 'Appen försökte skicka uppgifter till en annan adress, och det är inte tillåtet.',
    });
  });

  it('ett jobb som slutat utan done-händelse får ändå ett slut', () => {
    expect(view([], 'failed').finished).toMatchObject({ ok: false });
    expect(view([], 'failed').finished?.message).toMatch(/gick inte/);
    expect(view([{ type: 'files', paths: [] }], 'done').finished).toMatchObject({ ok: true });
  });

  it('pågående jobb har inget slut', () => {
    expect(view([{ type: 'progress', outputChars: 10 }]).finished).toBeNull();
  });
});

describe('framstegsmåttet', () => {
  it('börjar på noll, växer med texten och når aldrig ända fram innan jobbet är klart', () => {
    expect(writingProgress(0)).toBe(0);
    let previous = 0;
    for (const chars of [100, 1000, 5000, 20000, 100000, 10_000_000]) {
      const value = writingProgress(chars);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it('tål konstiga värden', () => {
    expect(writingProgress(-5)).toBe(0);
    expect(writingProgress(Number.NaN)).toBe(0);
  });
});

describe('stegvisaren: detaljer när bygget inte gick', () => {
  const typfel = { source: 'typecheck' as const, file: 'src/App.tsx', line: 12, message: "Object is possibly 'undefined'." };
  const annat = { source: 'build' as const, message: 'Could not resolve "./saknas"' };

  it('ett misslyckat jobb bär felen från den SISTA kontrollen', () => {
    const events: AgentEvent[] = [
      { type: 'files', paths: ['src/App.tsx'] },
      { type: 'check', ok: false, problems: 2, diagnostics: [annat, typfel] },
      { type: 'files', paths: ['src/App.tsx'] },
      { type: 'check', ok: false, problems: 1, diagnostics: [typfel] },
      { type: 'done', ok: false, message: 'Jag fick inte appen att fungera på 4 försök.' },
    ];
    expect(summarizeJob(events, 'failed').diagnostics).toEqual([typfel]);
  });

  it('ett lyckat jobb har inga detaljer att visa, även om ett tidigare varv hade fel', () => {
    const events: AgentEvent[] = [
      { type: 'files', paths: ['src/App.tsx'] },
      { type: 'check', ok: false, problems: 1, diagnostics: [typfel] },
      { type: 'files', paths: ['src/App.tsx'] },
      { type: 'check', ok: true, problems: 0 },
      { type: 'done', ok: true, message: 'Klart.' },
    ];
    expect(summarizeJob(events, 'done').diagnostics).toEqual([]);
  });

  it('äldre jobb utan sparade fel ger en tom lista', () => {
    expect(summarizeJob([{ type: 'check', ok: false, problems: 1 }, { type: 'done', ok: false, message: 'Nej.' }], 'failed').diagnostics).toEqual([]);
  });

  it('ett fel beskrivs med fil, rad, vilken kontroll och meddelandet', () => {
    expect(describeDiagnostic(typfel)).toBe("src/App.tsx, rad 12 — Object is possibly 'undefined'. (typkontroll)");
    expect(describeDiagnostic(annat)).toBe('Could not resolve "./saknas" (bygge)');
    expect(describeDiagnostic({ source: 'policy', rule: 'external-url', file: 'src/App.tsx', message: 'Extern adress' })).toBe(
      'src/App.tsx — Extern adress (regelkontroll: external-url)',
    );
  });
});
