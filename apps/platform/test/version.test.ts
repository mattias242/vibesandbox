/**
 * APP_VERSION: vilken version som är driftsatt. Den visas i byggverktyget, så att man ser om
 * webbläsaren kör något gammalt — och så att ett felsökningssamtal börjar med rätt uppgift.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';

function miljo(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    BASE_DOMAIN: 'example.org',
    APP_DOMAIN: 'appar.example.org',
    DATA_DIR: '/var/lib/vibesandbox',
    PORT: '8787',
    PUBLIC_SCHEME: 'https',
    IDENTITY_PROVIDER: 'test',
    TEST_IDENTITY_SECRET: HEMLIGHET,
    ...extra,
  };
}

describe('APP_VERSION', () => {
  it('läses när den är satt', () => {
    expect(loadConfig(miljo({ APP_VERSION: '0b8dccf' })).version).toBe('0b8dccf');
  });

  it('saknas den finns ingen version — plattformen startar ändå', () => {
    expect(loadConfig(miljo()).version).toBeUndefined();
  });

  it.each(['<script>', 'a'.repeat(41), 'med mellanslag', 'rad\nbrytning'])('vägrar starta med %j', (varde) => {
    expect(() => loadConfig(miljo({ APP_VERSION: varde }))).toThrow(ConfigError);
  });
});
