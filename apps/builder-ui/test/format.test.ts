/**
 * "Senast ändrad" i listan över appar: kort och begripligt, i svensk form.
 */
import { describe, expect, it } from 'vitest';
import { formatUpdated } from '../src/format.ts';

describe('formatUpdated', () => {
  const now = new Date(2026, 8, 19, 15, 0); // 19 september 2026, lokal tid

  it('i dag och i går med klockslag', () => {
    expect(formatUpdated(new Date(2026, 8, 19, 9, 5).toISOString(), now)).toBe('i dag 09:05');
    expect(formatUpdated(new Date(2026, 8, 18, 23, 59).toISOString(), now)).toBe('i går 23:59');
  });

  it('tidigare i år: dag och månad', () => {
    expect(formatUpdated(new Date(2026, 2, 3, 12, 0).toISOString(), now)).toBe('3 mars');
  });

  it('ett annat år: med årtal', () => {
    expect(formatUpdated(new Date(2025, 11, 24, 12, 0).toISOString(), now)).toBe('24 dec. 2025');
  });

  it('ett ogiltigt datum ger tom text i stället för "Invalid Date"', () => {
    expect(formatUpdated('inte ett datum', now)).toBe('');
  });
});
