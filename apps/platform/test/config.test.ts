import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';

function giltig(): Record<string, string | undefined> {
  return {
    BASE_DOMAIN: 'example.org',
    APP_DOMAIN: 'appar.example.org',
    DATA_DIR: '/var/lib/vibesandbox',
    PORT: '8787',
    IDENTITY_PROVIDER: 'test',
    TEST_IDENTITY_SECRET: HEMLIGHET,
  };
}

function felFor(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (fel) {
    expect(fel).toBeInstanceOf(ConfigError);
    return fel as ConfigError;
  }
  throw new Error('konfigurationen godtogs');
}

describe('Konfigurationen: hellre vägra starta än starta fel', () => {
  it('läser en fullständig miljö', () => {
    expect(loadConfig(giltig())).toEqual({
      baseDomain: 'example.org',
      appDomain: 'appar.example.org',
      dataDir: '/var/lib/vibesandbox',
      port: 8787,
      listenHost: '127.0.0.1',
      identity: { provider: 'test', testSecret: HEMLIGHET },
    });
  });

  it('lyssnar på 127.0.0.1 om inget annat sägs, och godtar en annan adress', () => {
    expect(loadConfig(giltig()).listenHost).toBe('127.0.0.1');
    expect(loadConfig({ ...giltig(), LISTEN_HOST: '0.0.0.0' }).listenHost).toBe('0.0.0.0');
    expect(loadConfig({ ...giltig(), LISTEN_HOST: '::1' }).listenHost).toBe('::1');
  });

  it.each(['BASE_DOMAIN', 'APP_DOMAIN', 'DATA_DIR', 'PORT', 'IDENTITY_PROVIDER', 'TEST_IDENTITY_SECRET'])(
    'vägrar starta utan %s, och säger vilken inställning det gäller',
    (namn) => {
      const saknas = felFor({ ...giltig(), [namn]: undefined });
      expect(saknas.message).toContain(namn);
      const tom = felFor({ ...giltig(), [namn]: '' });
      expect(tom.message).toContain(namn);
    },
  );

  it('rapporterar ALLA fel på en gång, så att man slipper rätta ett i taget', () => {
    const fel = felFor({});
    for (const namn of ['BASE_DOMAIN', 'APP_DOMAIN', 'DATA_DIR', 'PORT', 'IDENTITY_PROVIDER']) {
      expect(fel.message).toContain(namn);
    }
    expect(fel.problems.length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    'Example.org',
    'example.org.',
    'example.org:8080',
    'https://example.org',
    ' example.org',
    '*.example.org',
    'exa mple.org',
    '-example.org',
    'a'.repeat(64) + '.org',
  ])('avvisar domänen %j', (varde) => {
    expect(felFor({ ...giltig(), BASE_DOMAIN: varde }).message).toContain('BASE_DOMAIN');
    expect(felFor({ ...giltig(), APP_DOMAIN: varde }).message).toContain('APP_DOMAIN');
  });

  it.each(['data', './data', '../data', 'C:data', ''])('avvisar den relativa datakatalogen %j', (varde) => {
    expect(felFor({ ...giltig(), DATA_DIR: varde }).message).toContain('DATA_DIR');
  });

  it('avvisar en datakatalog med NUL-tecken', () => {
    expect(felFor({ ...giltig(), DATA_DIR: `/var/lib/x${String.fromCharCode(0)}y` }).message).toContain('DATA_DIR');
  });

  it.each(['-1', '65536', '80.5', '8787 ', '0x50', 'åtta', '1e3', '٨٠'])('avvisar porten %j', (varde) => {
    expect(felFor({ ...giltig(), PORT: varde }).message).toContain('PORT');
  });

  it('godtar port 0 (operativsystemet väljer) och 65535', () => {
    expect(loadConfig({ ...giltig(), PORT: '0' }).port).toBe(0);
    expect(loadConfig({ ...giltig(), PORT: '65535' }).port).toBe(65535);
  });

  it.each(['localhost', 'example.org', '127.0.0.1:80', '256.0.0.1', ' 127.0.0.1'])(
    'avvisar lyssningsadressen %j — bara en IP-adress duger',
    (varde) => {
      expect(felFor({ ...giltig(), LISTEN_HOST: varde }).message).toContain('LISTEN_HOST');
    },
  );

  it.each(['email-otp', 'oidc', 'none', 'TEST', 'test '])('avvisar identitetsleverantören %j', (varde) => {
    expect(felFor({ ...giltig(), IDENTITY_PROVIDER: varde }).message).toContain('IDENTITY_PROVIDER');
  });

  it('vägrar testinloggningen när NODE_ENV=production', () => {
    const fel = felFor({ ...giltig(), NODE_ENV: 'production' });
    expect(fel.message).toContain('IDENTITY_PROVIDER');
    expect(fel.message).toContain('production');
  });

  it('kräver en hemlighet på minst 32 byte och har inget standardvärde', () => {
    expect(felFor({ ...giltig(), TEST_IDENTITY_SECRET: 'kort' }).message).toContain('TEST_IDENTITY_SECRET');
    expect(felFor({ ...giltig(), TEST_IDENTITY_SECRET: 'x'.repeat(31) }).message).toContain('TEST_IDENTITY_SECRET');
    expect(loadConfig({ ...giltig(), TEST_IDENTITY_SECRET: 'x'.repeat(32) }).identity.testSecret).toBe('x'.repeat(32));
  });

  it('skriver aldrig ut hemligheten i ett felmeddelande', () => {
    const hemlig = 'superhemligt-varde-0123456789-abcdefghij';
    const fel = felFor({ ...giltig(), TEST_IDENTITY_SECRET: hemlig, PORT: 'fel', NODE_ENV: 'production' });
    expect(fel.message).not.toContain(hemlig);
    const kort = felFor({ ...giltig(), TEST_IDENTITY_SECRET: 'kort-hemlis' });
    expect(kort.message).not.toContain('kort-hemlis');
  });

  it('felmeddelandet är på svenska och går att förstå utan att läsa koden', () => {
    const fel = felFor({ ...giltig(), PORT: 'fel' });
    expect(fel.message).toMatch(/startar inte/i);
    expect(fel.message).toMatch(/PORT.*heltal/);
  });
});
