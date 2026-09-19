import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_BUILDER_UI_DIR, loadConfig, platformAddresses } from '../src/config.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';
const APP = '0123456789abcdefghjkmnpqrs';

function giltig(): Record<string, string | undefined> {
  return {
    BASE_DOMAIN: 'example.org',
    APP_DOMAIN: 'appar.example.org',
    DATA_DIR: '/var/lib/vibesandbox',
    PORT: '8787',
    PUBLIC_SCHEME: 'https',
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
      publicScheme: 'https',
      identity: { provider: 'test', testSecret: HEMLIGHET },
    });
  });

  it('lyssnar på 127.0.0.1 om inget annat sägs, och godtar en annan adress', () => {
    expect(loadConfig(giltig()).listenHost).toBe('127.0.0.1');
    expect(loadConfig({ ...giltig(), LISTEN_HOST: '0.0.0.0' }).listenHost).toBe('0.0.0.0');
    expect(loadConfig({ ...giltig(), LISTEN_HOST: '::1' }).listenHost).toBe('::1');
  });

  it.each(['BASE_DOMAIN', 'APP_DOMAIN', 'DATA_DIR', 'PORT', 'PUBLIC_SCHEME', 'IDENTITY_PROVIDER', 'TEST_IDENTITY_SECRET'])(
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
    for (const namn of ['BASE_DOMAIN', 'APP_DOMAIN', 'DATA_DIR', 'PORT', 'PUBLIC_SCHEME', 'IDENTITY_PROVIDER']) {
      expect(fel.message).toContain(namn);
    }
    expect(fel.problems.length).toBeGreaterThanOrEqual(6);
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

  it.each(['oidc', 'none', 'TEST', 'test ', 'Email-otp', 'email-otp '])('avvisar identitetsleverantören %j', (varde) => {
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
    expect(loadConfig({ ...giltig(), TEST_IDENTITY_SECRET: 'x'.repeat(32) }).identity).toEqual({ provider: 'test', testSecret: 'x'.repeat(32) });
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

describe('Konfigurationen: den publika adressen', () => {
  it.each(['http', 'https'])('godtar PUBLIC_SCHEME=%s', (schema) => {
    expect(loadConfig({ ...giltig(), PUBLIC_SCHEME: schema }).publicScheme).toBe(schema);
  });

  it.each(['HTTPS', 'ftp', 'https://', ' https', 'http:'])('avvisar PUBLIC_SCHEME=%j', (varde) => {
    expect(felFor({ ...giltig(), PUBLIC_SCHEME: varde }).message).toContain('PUBLIC_SCHEME');
  });

  it('PUBLIC_PORT är valfri: tom eller saknad betyder schemats standardport', () => {
    expect(loadConfig(giltig()).publicPort).toBeUndefined();
    expect(loadConfig({ ...giltig(), PUBLIC_PORT: '' }).publicPort).toBeUndefined();
    expect(loadConfig({ ...giltig(), PUBLIC_PORT: '8443' }).publicPort).toBe(8443);
  });

  it('schemats egen standardport räknas som ingen port, så att adresserna blir som webbläsaren skriver dem', () => {
    expect(loadConfig({ ...giltig(), PUBLIC_SCHEME: 'https', PUBLIC_PORT: '443' }).publicPort).toBeUndefined();
    expect(loadConfig({ ...giltig(), PUBLIC_SCHEME: 'http', PUBLIC_PORT: '80' }).publicPort).toBeUndefined();
    expect(loadConfig({ ...giltig(), PUBLIC_SCHEME: 'http', PUBLIC_PORT: '443' }).publicPort).toBe(443);
  });

  it.each(['0', '65536', '-1', '0x50', '1e3', ' 443', 'åtta'])('avvisar PUBLIC_PORT=%j', (varde) => {
    expect(felFor({ ...giltig(), PUBLIC_PORT: varde }).message).toContain('PUBLIC_PORT');
  });

  it('härleder byggverktygets origin och apparnas adresser ur schema, port och domäner', () => {
    const utanPort = platformAddresses(loadConfig({ ...giltig(), PUBLIC_SCHEME: 'https' }));
    expect(utanPort.builderOrigin).toBe('https://bygg.example.org');
    expect(utanPort.preview(APP)).toBe(`https://p-${APP}.example.org/`);
    expect(utanPort.published(APP)).toBe(`https://${APP}.appar.example.org/`);

    const medPort = platformAddresses(loadConfig({ ...giltig(), PUBLIC_SCHEME: 'http', PUBLIC_PORT: '8787' }));
    expect(medPort.builderOrigin).toBe('http://bygg.example.org:8787');
    expect(medPort.preview(APP)).toBe(`http://p-${APP}.example.org:8787/`);
    expect(medPort.published(APP)).toBe(`http://${APP}.appar.example.org:8787/`);
  });
});

describe('Konfigurationen: e-postinloggning', () => {
  const IDENTITETSHEMLIGHET = 'identitetens-hemlighet-bara-i-testerna-0123456789';

  function epost(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      ...giltig(),
      TEST_IDENTITY_SECRET: undefined,
      IDENTITY_PROVIDER: 'email-otp',
      IDENTITY_SECRET: IDENTITETSHEMLIGHET,
      MAILGUN_API_KEY: 'mailgun-nyckel-bara-i-testerna',
      MAILGUN_DOMAIN: 'mg.example.org',
      MAIL_FROM: 'Vibesandbox <noreply@example.org>',
      ...extra,
    };
  }

  it('läser Mailgun-inställningarna', () => {
    expect(loadConfig(epost()).identity).toEqual({
      provider: 'email-otp',
      secret: IDENTITETSHEMLIGHET,
      mail: {
        kind: 'mailgun',
        apiKey: 'mailgun-nyckel-bara-i-testerna',
        domain: 'mg.example.org',
        from: 'Vibesandbox <noreply@example.org>',
      },
    });
  });

  it('fungerar i produktion (till skillnad från testinloggningen)', () => {
    expect(loadConfig(epost({ NODE_ENV: 'production' })).identity.provider).toBe('email-otp');
  });

  it('kräver IDENTITY_SECRET på minst 32 byte, utan standardvärde och utan att skriva ut det', () => {
    expect(felFor(epost({ IDENTITY_SECRET: undefined })).message).toContain('IDENTITY_SECRET');
    const kort = felFor(epost({ IDENTITY_SECRET: 'x'.repeat(31) }));
    expect(kort.message).toContain('IDENTITY_SECRET');
    expect(kort.message).not.toContain('x'.repeat(31));
    expect(loadConfig(epost({ IDENTITY_SECRET: 'å'.repeat(16) })).identity.provider).toBe('email-otp');
  });

  it('behöver inte testinloggningens hemlighet', () => {
    expect(loadConfig(epost({ TEST_IDENTITY_SECRET: undefined })).identity.provider).toBe('email-otp');
  });

  it('kräver ett sätt att skicka mejl', () => {
    const fel = felFor(epost({ MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, MAIL_FROM: undefined }));
    expect(fel.message).toContain('MAILGUN_API_KEY');
    expect(fel.message).toContain('MAIL_OUTBOX_DIR');
  });

  it.each(['MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'MAIL_FROM'])('en halv Mailgun-inställning utan %s är ett fel som nämner den', (namn) => {
    expect(felFor(epost({ [namn]: undefined })).message).toContain(namn);
  });

  it('avvisar en Mailgun-domän som inte är ett värdnamn', () => {
    expect(felFor(epost({ MAILGUN_DOMAIN: 'https://mg.example.org' })).message).toContain('MAILGUN_DOMAIN');
  });

  it('avvisar en avsändare med radbrytning (en väg till extra mejlhuvuden)', () => {
    expect(felFor(epost({ MAIL_FROM: 'a@example.org\nBcc: b@example.org' })).message).toContain('MAIL_FROM');
  });

  it('skriver aldrig ut Mailgun-nyckeln', () => {
    const fel = felFor(epost({ MAILGUN_DOMAIN: undefined, PORT: 'fel' }));
    expect(fel.message).not.toContain('mailgun-nyckel-bara-i-testerna');
    expect(fel.message).not.toContain(IDENTITETSHEMLIGHET);
  });

  it('utkorgen (mejl som filer) godtas utanför produktion', () => {
    const config = loadConfig(
      epost({ MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, MAIL_FROM: undefined, MAIL_OUTBOX_DIR: '/tmp/utkorg' }),
    );
    expect(config.identity).toEqual({ provider: 'email-otp', secret: IDENTITETSHEMLIGHET, mail: { kind: 'outbox', directory: '/tmp/utkorg' } });
  });

  it('utkorgen vägras i produktion: koderna skulle hamna på disk i stället för hos mottagaren', () => {
    const fel = felFor(
      epost({ NODE_ENV: 'production', MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, MAIL_FROM: undefined, MAIL_OUTBOX_DIR: '/tmp/utkorg' }),
    );
    expect(fel.message).toContain('MAIL_OUTBOX_DIR');
    expect(fel.message).toContain('production');
  });

  it('utkorgen ska vara en absolut sökväg', () => {
    const fel = felFor(epost({ MAILGUN_API_KEY: undefined, MAILGUN_DOMAIN: undefined, MAIL_FROM: undefined, MAIL_OUTBOX_DIR: 'utkorg' }));
    expect(fel.message).toContain('MAIL_OUTBOX_DIR');
  });

  it('både Mailgun och utkorg är tvetydigt och vägras', () => {
    expect(felFor(epost({ MAIL_OUTBOX_DIR: '/tmp/utkorg' })).message).toContain('MAIL_OUTBOX_DIR');
  });
});

describe('Konfigurationen: byggverktyget', () => {
  function bygg(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      ...giltig(),
      LLM_BASE_URL: 'https://api.example.org/v1',
      LLM_MODEL: 'leverantor/modell-1',
      LLM_API_KEY: 'llm-nyckel-bara-i-testerna',
      BUILD_DRIVER: 'docker',
      ...extra,
    };
  }

  it('är avstängt när LLM_MODEL inte är satt', () => {
    expect(loadConfig(giltig()).builder).toBeUndefined();
    expect(loadConfig({ ...giltig(), LLM_MODEL: '' }).builder).toBeUndefined();
  });

  it('slås på av LLM_MODEL och läser resten', () => {
    expect(loadConfig(bygg({ LLM_REASONING_EFFORT: 'low' })).builder).toEqual({
      llm: {
        baseUrl: 'https://api.example.org/v1',
        model: 'leverantor/modell-1',
        apiKey: 'llm-nyckel-bara-i-testerna',
        reasoningEffort: 'low',
      },
      build: { driver: 'docker' },
      uiDirectory: DEFAULT_BUILDER_UI_DIR,
    });
  });

  it('standardkatalogen för webbgränssnittet är apps/builder-ui/dist i repots rot', () => {
    expect(isAbsolute(DEFAULT_BUILDER_UI_DIR)).toBe(true);
    expect(DEFAULT_BUILDER_UI_DIR.endsWith(join('apps', 'builder-ui', 'dist'))).toBe(true);
    expect(loadConfig(bygg({ BUILDER_UI_DIR: '/srv/ui' })).builder?.uiDirectory).toBe('/srv/ui');
    expect(felFor(bygg({ BUILDER_UI_DIR: 'ui' })).message).toContain('BUILDER_UI_DIR');
  });

  it('godtar BERGET_API_KEY som alias för LLM_API_KEY', () => {
    const config = loadConfig(bygg({ LLM_API_KEY: undefined, BERGET_API_KEY: 'berget-nyckel-bara-i-testerna' }));
    expect(config.builder?.llm.apiKey).toBe('berget-nyckel-bara-i-testerna');
    // Samma värde i båda är inte tvetydigt.
    expect(loadConfig(bygg({ BERGET_API_KEY: 'llm-nyckel-bara-i-testerna' })).builder?.llm.apiKey).toBe('llm-nyckel-bara-i-testerna');
  });

  it('två OLIKA nycklar är tvetydigt och vägras, utan att någon av dem skrivs ut', () => {
    const fel = felFor(bygg({ BERGET_API_KEY: 'en-annan-nyckel-bara-i-testerna' }));
    expect(fel.message).toContain('LLM_API_KEY');
    expect(fel.message).toContain('BERGET_API_KEY');
    expect(fel.message).not.toContain('llm-nyckel-bara-i-testerna');
    expect(fel.message).not.toContain('en-annan-nyckel-bara-i-testerna');
  });

  it('påslaget utan nyckel är ett konfigurationsfel som nämner båda namnen', () => {
    const fel = felFor(bygg({ LLM_API_KEY: undefined }));
    expect(fel.message).toContain('LLM_API_KEY');
    expect(fel.message).toContain('BERGET_API_KEY');
  });

  it.each(['LLM_BASE_URL', 'BUILD_DRIVER'])('påslaget utan %s är ett konfigurationsfel', (namn) => {
    expect(felFor(bygg({ [namn]: undefined })).message).toContain(namn);
  });

  it.each(['api.example.org/v1', 'ftp://api.example.org', 'https://nyckel:hemlig@api.example.org/v1', 'https://api.example.org/v1?x=1', 'inte en adress'])(
    'avvisar LLM_BASE_URL=%j',
    (varde) => {
      const fel = felFor(bygg({ LLM_BASE_URL: varde }));
      expect(fel.message).toContain('LLM_BASE_URL');
      expect(fel.message).not.toContain('hemlig');
    },
  );

  it('kräver https mot språkmodellen i produktion', () => {
    const env = { ...bygg({ LLM_BASE_URL: 'http://api.example.org/v1', NODE_ENV: 'production' }) };
    expect(felFor(env).message).toContain('LLM_BASE_URL');
    expect(loadConfig(bygg({ LLM_BASE_URL: 'http://127.0.0.1:8000/v1' })).builder?.llm.baseUrl).toBe('http://127.0.0.1:8000/v1');
  });

  it.each(['medium', 'high'])('godtar LLM_REASONING_EFFORT=%s', (varde) => {
    expect(loadConfig(bygg({ LLM_REASONING_EFFORT: varde })).builder?.llm.reasoningEffort).toBe(varde);
  });

  it.each(['max', 'LOW', ' low'])('avvisar LLM_REASONING_EFFORT=%j', (varde) => {
    expect(felFor(bygg({ LLM_REASONING_EFFORT: varde })).message).toContain('LLM_REASONING_EFFORT');
  });

  it('LLM_REASONING_EFFORT är valfri', () => {
    expect(loadConfig(bygg()).builder?.llm).not.toHaveProperty('reasoningEffort');
  });

  it.each(['Docker', 'podman', 'lokal'])('avvisar BUILD_DRIVER=%j', (varde) => {
    expect(felFor(bygg({ BUILD_DRIVER: varde })).message).toContain('BUILD_DRIVER');
  });

  it('spool kräver en absolut BUILD_JOBS_DIR', () => {
    expect(felFor(bygg({ BUILD_DRIVER: 'spool' })).message).toContain('BUILD_JOBS_DIR');
    expect(felFor(bygg({ BUILD_DRIVER: 'spool', BUILD_JOBS_DIR: 'jobb' })).message).toContain('BUILD_JOBS_DIR');
    expect(loadConfig(bygg({ BUILD_DRIVER: 'spool', BUILD_JOBS_DIR: '/jobs' })).builder?.build).toEqual({
      driver: 'spool',
      jobsDir: '/jobs',
    });
  });

  it('local (opålitlig kod direkt på värden, utan sandlåda) vägras i produktion', () => {
    const produktion = { NODE_ENV: 'production', IDENTITY_PROVIDER: 'email-otp', IDENTITY_SECRET: 'x'.repeat(32), MAIL_OUTBOX_DIR: undefined };
    const fel = felFor(
      bygg({ ...produktion, BUILD_DRIVER: 'local', MAILGUN_API_KEY: 'mailgun-nyckel', MAILGUN_DOMAIN: 'mg.example.org', MAIL_FROM: 'a@example.org' }),
    );
    expect(fel.message).toContain('BUILD_DRIVER');
    expect(loadConfig(bygg({ BUILD_DRIVER: 'local' })).builder?.build).toEqual({ driver: 'local' });
  });

  it('skriver aldrig ut nyckeln, hur mycket annat som än är fel', () => {
    const fel = felFor(bygg({ LLM_BASE_URL: 'fel', BUILD_DRIVER: 'fel', PORT: 'fel' }));
    expect(fel.message).not.toContain('llm-nyckel-bara-i-testerna');
    expect(fel.problems.length).toBeGreaterThanOrEqual(3);
  });

  it('en nyckel med styrtecken avvisas (den skulle bli ett extra HTTP-huvud)', () => {
    expect(felFor(bygg({ LLM_API_KEY: 'abc\r\nX-Evil: 1' })).message).toContain('LLM_API_KEY');
  });
});
