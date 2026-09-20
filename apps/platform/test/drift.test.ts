/**
 * En inställning måste ta sig hela vägen: från den lokala `.env`, genom driftsättningens
 * TILLÅTELSELISTA till serverns `.env`, och därifrån genom compose-filens `environment` in i
 * containern. Missas ett av de två sista leden läser plattformen tomt — och beter sig som om
 * inställningen aldrig fanns, utan att något går sönder.
 *
 * Det hände med PLATFORM_OWNER_EMAIL i båda leden: återkopplingen på byggverktyget hamnade tyst
 * som filer på serverns disk i stället för i en inkorg. Testet finns för att nästa inställning
 * inte ska göra samma resa.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, repo)), 'utf8');

const config = read('apps/platform/src/config.ts');
const compose = read('deploy/compose.yml');
const driftsatt = read('deploy/driftsatt.sh');

/**
 * Namnen plattformen läser ur miljön. Fyra former förekommer i config.ts: `env['NAMN']`,
 * `required('NAMN', …)`, `secret('NAMN', …)` och `domain('NAMN', …)`.
 */
function readByPlatform(): readonly string[] {
  const names = new Set<string>();
  for (const match of config.matchAll(/env\[(['"])([A-Z][A-Z0-9_]*)\1\]/g)) names.add(match[2] ?? '');
  for (const match of config.matchAll(/\b(?:required|secret|domain)\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g)) names.add(match[2] ?? '');
  return [...names].sort();
}

/**
 * Inställningar som med flit inte står i compose-filen. Var och en har ett skäl — en ny rad här
 * ska behöva motiveras, annars är undantagslistan bara ett sätt att tysta testet.
 */
const NOT_IN_COMPOSE: Readonly<Record<string, string>> = {
  // Alternativ till Mailgun: skriver mejl till en katalog. Bara lokalt och i test.
  MAIL_OUTBOX_DIR: 'bara lokalt och i test',
  // Har ett standardvärde i koden och sätts bara när någon vill peka om anropen.
  BERGET_BASE_URL: 'valfri omdirigering, standardvärde i koden',
  LLM_API_KEY: 'faller tillbaka på BERGET_API_KEY, som compose skickar',
  // Sökvägen till gränssnittets byggda filer ligger i avbilden, inte i miljön.
  BUILDER_UI_DIR: 'bestäms av avbilden',
  // Testinloggningen vägrar starta i produktion; compose ska inte bjuda in till den.
  TEST_IDENTITY_SECRET: 'testinloggning, aldrig i drift',
  // compose sätter den själv, den kommer inte utifrån.
  NODE_ENV: 'sätts av compose',
};

/** Tjänsternas egna inställningar går en egen väg: hela miljön läses av respektive tjänst. */
const isServiceSetting = (name: string): boolean => name.startsWith('SVC_') || name === 'APP_SERVICES';

describe('inställningar når hela vägen', () => {
  it('parsern hittar det plattformen faktiskt läser', () => {
    const names = readByPlatform();
    // Faller parsern tyst igenom är resten av testet värdelöst.
    expect(names).toContain('PLATFORM_OWNER_EMAIL');
    expect(names).toContain('BASE_DOMAIN');
    expect(names).toContain('MAILGUN_API_KEY');
    expect(names.length).toBeGreaterThan(15);
  });

  it('allt plattformen läser skickas in i containern av compose', () => {
    const missing = readByPlatform().filter(
      (name) => NOT_IN_COMPOSE[name] === undefined && !isServiceSetting(name) && !compose.includes(`${name}:`),
    );
    expect(missing, 'saknas under platform.environment i deploy/compose.yml').toEqual([]);
  });

  it('allt driftsättningen skriver till serverns .env tas emot av compose', () => {
    // Bara heredocen som serverns .env byggs av — inte skriptets egna skalvariabler.
    const heredoc = /cat <<EOF\n([\s\S]*?)\nEOF/.exec(driftsatt)?.[1] ?? '';
    expect(heredoc, 'hittade inte heredocen i driftsatt.sh').not.toEqual('');
    const written = new Set<string>();
    for (const match of heredoc.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) written.add(match[1] ?? '');
    const wasted = [...written].filter((name) => !isServiceSetting(name) && !compose.includes(`${name}:`));
    expect(wasted.sort(), 'skrivs till serverns .env men läses inte av compose — raden är bortkastad').toEqual([]);
  });
});
