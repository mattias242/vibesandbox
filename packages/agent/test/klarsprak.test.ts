import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@vibesandbox/contracts';
import { policyExplanation, securityViolation } from '../src/klarsprak.ts';

const brott = (rule: string): Diagnostic => ({ source: 'policy', rule, file: 'src/App.tsx', line: 1, message: 'x' });

describe('Säkerhetsbrott avbryter turen direkt', () => {
  // Varje regel som gäller ett försök att få ut data, köra godtycklig kod eller gömma sådan kod.
  // Ett sådant brott ger inga nya försök: modellen ska inte få chansen att leta en väg runt kontrollen.
  it.each([
    'external-url', 'network-api', 'dynamic-code', 'browser-storage', 'window-open', 'service-worker',
    'frame-escape', 'navigation', 'javascript-url', 'data-html-url', 'document-domain', 'global-access',
    'escape-sequence', 'css-import', 'css-url', 'bundle-external-url', 'bundle-eval', 'bundle-inline-script',
  ])('%s är ett säkerhetsbrott med en förklaring i klarspråk', (rule) => {
    const text = securityViolation([brott(rule)]);
    expect(text).not.toBeNull();
    expect(text).not.toContain(rule);
  });

  it.each(['url-in-comment', 'path-not-allowed', 'too-many-files', 'forbidden-import', 'css-plugin'])(
    '%s är inget säkerhetsbrott — modellen får rätta det',
    (rule) => {
      expect(securityViolation([brott(rule)])).toBeNull();
    },
  );

  it('ett okänt regel-id ger ändå en allmän förklaring om det består', () => {
    expect(policyExplanation([brott('ny-regel')])).toMatch(/regler/);
  });
});
