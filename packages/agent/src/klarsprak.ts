/**
 * Klarspråk till användaren när policyn stoppar koden.
 *
 * Två sorters regelbrott:
 * - SÄKERHETSBROTT (koden försökte nå ut, köra godtycklig kod eller spara vid sidan av
 *   plattformen): turen avbryts direkt. Modellen får inga fler försök — en modell som bett om
 *   att skicka data utåt ska inte få fler chanser att hitta en väg runt kontrollen, och det är
 *   oftast önskemålet självt som inte går att uppfylla ("mejla svaren till mig").
 * - Övriga regelbrott (t.ex. ett filnamn): återkopplas till modellen som vilket fel som helst.
 *
 * Regel-id:n kommer från byggkedjans policy (`Diagnostic.rule`). Okända id:n behandlas som
 * övriga regelbrott och får en allmän förklaring om de består.
 */

import type { Diagnostic } from '@vibesandbox/contracts';

const SECURITY_RULES: Readonly<Record<string, string>> = {
  'external-url': 'Appen försökte skicka uppgifter till en adress utanför plattformen. Det är inte tillåtet, så jag har inte byggt den.',
  'network-api':
    'Appen försökte kontakta internet direkt i stället för att spara via plattformen. Det är inte tillåtet, så jag har inte byggt den.',
  'dynamic-code': 'Appen försökte köra kod på ett sätt som inte är tillåtet. Därför har jag inte byggt den.',
  'browser-storage':
    'Appen försökte spara uppgifter i webbläsaren i stället för på plattformen, där andra kan se dem. Det är inte tillåtet, så jag har inte byggt den.',
  'window-open': 'Appen försökte öppna andra webbplatser. Det är inte tillåtet, så jag har inte byggt den.',
  'service-worker': 'Appen försökte installera kod som körs i bakgrunden. Det är inte tillåtet, så jag har inte byggt den.',
  // Sätt att lämna appen eller ta med sig uppgifter ut ur den på andra vägar än nätanrop.
  'frame-escape': 'Appen försökte ta sig ut ur sin egen ruta i webbläsaren. Det är inte tillåtet, så jag har inte byggt den.',
  navigation: 'Appen försökte skicka webbläsaren vidare till en annan adress. Det är inte tillåtet, så jag har inte byggt den.',
  'javascript-url': 'Appen försökte köra kod via en länk. Det är inte tillåtet, så jag har inte byggt den.',
  'data-html-url': 'Appen försökte öppna en egen sida vid sidan av plattformen. Det är inte tillåtet, så jag har inte byggt den.',
  'document-domain': 'Appen försökte ändra vilken webbplats den räknas till. Det är inte tillåtet, så jag har inte byggt den.',
  'css-import': 'Appens utseende försökte hämta något från en adress utanför plattformen. Det är inte tillåtet, så jag har inte byggt den.',
  'css-url': 'Appens utseende försökte hämta något från en adress utanför plattformen. Det är inte tillåtet, så jag har inte byggt den.',
  // Omskrivningar som bara behövs för att gömma något av ovanstående för kontrollen.
  'global-access': 'Appen försökte nå webbläsarens funktioner på ett sätt som kringgår kontrollen. Därför har jag inte byggt den.',
  'escape-sequence': 'Appen innehöll kod skriven på ett sätt som döljer vad den gör. Därför har jag inte byggt den.',
  // Samma brott funna i det BYGGDA — koden tog sig förbi källkontrollen.
  'bundle-external-url': 'Den färdiga appen innehöll en adress utanför plattformen. Därför har jag inte publicerat bygget.',
  'bundle-eval': 'Den färdiga appen innehöll kod som körs på ett otillåtet sätt. Därför har jag inte publicerat bygget.',
  'bundle-inline-script': 'Den färdiga appen innehöll kod på ett otillåtet ställe. Därför har jag inte publicerat bygget.',
};

const OTHER_RULES: Readonly<Record<string, string>> = {
  'forbidden-import': 'Appen behövde ett programpaket som inte är godkänt på plattformen, så jag fick inte ihop den.',
};

const GENERIC_POLICY = 'Koden bröt mot plattformens regler för vad en app får göra, så jag har inte byggt den.';

/** Första säkerhetsbrottet bland diagnoserna, som klarspråk — eller null om inget finns. */
export function securityViolation(diagnostics: readonly Diagnostic[]): string | null {
  for (const d of diagnostics) {
    if (d.source === 'policy' && d.rule !== undefined) {
      const text = SECURITY_RULES[d.rule];
      if (text !== undefined) return text;
    }
  }
  return null;
}

/** Klarspråk för ett regelbrott som bestod till sista försöket — eller null om inget fanns. */
export function policyExplanation(diagnostics: readonly Diagnostic[]): string | null {
  const policy = diagnostics.filter((d) => d.source === 'policy');
  if (policy.length === 0) return null;
  for (const d of policy) {
    const known = d.rule === undefined ? undefined : (SECURITY_RULES[d.rule] ?? OTHER_RULES[d.rule]);
    if (known !== undefined) return known;
  }
  return GENERIC_POLICY;
}
