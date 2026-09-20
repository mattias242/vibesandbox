/**
 * Plattformstjänsterna kopplas in: `APP_SERVICES` väljer vilka, fabrikerna skapas i en fast
 * ordning och får sina beroenden, och en avslagen tjänst finns inte.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppId, AppServiceDependencies, AppServiceFactory, AppServiceName } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import { signTestIdentity } from '@vibesandbox/gateway';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { PlatformConfig } from '../src/config.ts';
import { createPlatform } from '../src/server.ts';
import type { Platform } from '../src/server.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';
const ANNA = signTestIdentity({ userId: 'anv-anna', email: 'anna@example.org', roles: ['viewer'] }, HEMLIGHET);

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

describe('APP_SERVICES i konfigurationen', () => {
  it('ingen tjänst är påslagen om inget sägs', () => {
    expect(loadConfig(miljo()).appServices?.enabled ?? []).toEqual([]);
  });

  it('läser en kommaseparerad lista, i plattformens fasta ordning och utan dubbletter', () => {
    const config = loadConfig(miljo({ APP_SERVICES: ' ocr, files ,ocr' }));
    expect(config.appServices?.enabled).toEqual(['files', 'ocr']);
  });

  it('en okänd tjänst är ett fel som nämner namnet', () => {
    let fel: unknown;
    try {
      loadConfig(miljo({ APP_SERVICES: 'files,bitcoin' }));
    } catch (e) {
      fel = e;
    }
    expect(fel).toBeInstanceOf(ConfigError);
    expect(String((fel as Error).message)).toContain('bitcoin');
  });

  it('tjänsterna får miljön, så att var och en kan läsa sina egna inställningar', () => {
    const config = loadConfig(miljo({ APP_SERVICES: 'llm', SVC_LLM_MODEL: 'modell-x' }));
    expect(config.appServices?.env['SVC_LLM_MODEL']).toBe('modell-x');
  });
});

describe('Plattformstjänsterna i en riktig server', () => {
  let dataDir: string;
  let platform: Platform | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-tjanster-'));
  });

  afterEach(async () => {
    await platform?.close();
    platform = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  function config(enabled: readonly AppServiceName[]): PlatformConfig {
    return {
      baseDomain: 'appar.test',
      appDomain: 'appar.test',
      dataDir,
      port: 0,
      listenHost: '127.0.0.1',
      publicScheme: 'http',
      identity: { provider: 'test', testSecret: HEMLIGHET },
      appServices: { enabled, env: {} },
    };
  }

  async function publiceradApp(): Promise<AppId> {
    const control = createControl({ dataDir });
    try {
      const appId = await control.createApp();
      const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bygge-'));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(katalog, 'index.html'), '<!doctype html><title>App</title>');
      await control.publish(appId, await control.importVersion(appId, katalog));
      await control.grantAccess(appId, 'anv-anna', 'owner', 'anna@example.org');
      await rm(katalog, { recursive: true, force: true });
      return appId;
    } finally {
      await control.close();
    }
  }

  function hamta(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { Host: host, Authorization: ANNA, Connection: 'close' } }, (res) => {
        const bitar: Buffer[] = [];
        res.on('data', (b: Buffer) => bitar.push(b));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(bitar).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('en påslagen tjänst nås under /_api/<namn> och får appen, användaren och sina beroenden', async () => {
    const appId = await publiceradApp();
    let beroenden: AppServiceDependencies | undefined;
    const filer: AppServiceFactory = (deps) => {
      beroenden = deps;
      return {
        service: {
          name: 'files',
          maxBodyBytes: 0,
          async handle(req) {
            const medlemmar = await deps.members.members(req.tenant.appId);
            return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: req.tenant.appId, medlemmar: medlemmar.length }) };
          },
        },
      };
    };
    platform = createPlatform(config(['files']), { appServiceFactories: { files: filer } });
    const { port } = await platform.listen();

    const svar = await hamta(port, `${appId}.appar.test`, '/_api/files/x');

    expect(svar.status).toBe(200);
    expect(JSON.parse(svar.body)).toEqual({ app: appId, medlemmar: 1 });
    expect(beroenden?.dataDir).toBe(join(dataDir, 'services', 'files'));
    expect(existsSync(join(dataDir, 'services', 'files'))).toBe(true);
    expect(beroenden?.publishedUrl(appId)).toBe(`http://${appId}.appar.test/`);
  });

  it('en tjänst som inte är påslagen finns inte, även om den är byggd', async () => {
    const appId = await publiceradApp();
    let skapad = false;
    platform = createPlatform(config([]), {
      appServiceFactories: {
        files: () => {
          skapad = true;
          return { service: { name: 'files', maxBodyBytes: 0, handle: async () => ({ status: 200, headers: {} }) } };
        },
      },
    });
    const { port } = await platform.listen();

    const svar = await hamta(port, `${appId}.appar.test`, '/_api/files/x');

    expect(svar.status).toBe(404);
    expect(skapad).toBe(false);
  });

  it('plattformen vägrar starta med en påslagen tjänst som inte är byggd', () => {
    expect(() => createPlatform(config(['files']), { appServiceFactories: {} })).toThrow(/files/);
  });

  it('plattformen vägrar starta om fabriken ger en tjänst med fel namn', () => {
    expect(() =>
      createPlatform(config(['files']), {
        appServiceFactories: { files: () => ({ service: { name: 'ocr', maxBodyBytes: 0, handle: async () => ({ status: 200, headers: {} }) } }) },
      }),
    ).toThrow(/files/);
  });

  it('tjänsterna skapas i fast ordning: ocr får filläsaren från files, schedule får aviseringarna från notify', () => {
    const ordning: string[] = [];
    const sett: Record<string, AppServiceDependencies> = {};
    const fabrik =
      (namn: AppServiceName, extra: object = {}): AppServiceFactory =>
      (deps) => {
        ordning.push(namn);
        sett[namn] = deps;
        return { service: { name: namn, maxBodyBytes: 0, handle: async () => ({ status: 204, headers: {} }) }, ...extra };
      };
    const lasare = { read: async () => null };
    const aviserare = { notify: async () => ({ sent: 0 }) };
    platform = createPlatform(config(['schedule', 'ocr', 'notify', 'files']), {
      appServiceFactories: {
        files: fabrik('files', { fileReader: lasare }),
        notify: fabrik('notify', { notifier: aviserare }),
        ocr: fabrik('ocr'),
        schedule: fabrik('schedule'),
      },
    });

    expect(ordning).toEqual(['files', 'notify', 'ocr', 'schedule']);
    expect(sett['ocr']?.files).toBe(lasare);
    expect(sett['schedule']?.notifier).toBe(aviserare);
    expect(sett['files']?.files).toBeUndefined();
  });

  it('tjänsterna stängs när plattformen stängs', async () => {
    let stangd = false;
    platform = createPlatform(config(['files']), {
      appServiceFactories: {
        files: () => ({
          service: {
            name: 'files',
            maxBodyBytes: 0,
            handle: async () => ({ status: 204, headers: {} }),
            close: async () => {
              stangd = true;
            },
          },
        }),
      },
    });
    await platform.listen();
    await platform.close();
    platform = undefined;
    expect(stangd).toBe(true);
  });
});

describe('Berget för tjänsterna', () => {
  it('BERGET_API_KEY räcker — tjänsterna behöver inte byggverktyget', () => {
    const config = loadConfig(miljo({ BERGET_API_KEY: 'berget-nyckel-123456' }));
    expect(config.builder).toBeUndefined();
    expect(config.berget).toEqual({ baseUrl: 'https://api.berget.ai/v1', apiKey: 'berget-nyckel-123456' });
  });

  it('BERGET_BASE_URL byter adress, och måste vara https i drift', () => {
    expect(loadConfig(miljo({ BERGET_API_KEY: 'berget-nyckel-123456', BERGET_BASE_URL: 'https://eu.example.org/v1' })).berget?.baseUrl).toBe(
      'https://eu.example.org/v1',
    );
    let text = '';
    try {
      loadConfig(miljo({ NODE_ENV: 'production', BERGET_API_KEY: 'berget-nyckel-123456', BERGET_BASE_URL: 'http://eu.example.org/v1' }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      text = String((e as Error).message);
    }
    expect(text).toMatch(/BERGET_BASE_URL.*https/);
  });

  it('utan nyckel finns ingen Berget', () => {
    expect(loadConfig(miljo()).berget).toBeUndefined();
  });

  it('nyckeln syns aldrig i ett felmeddelande', () => {
    let text = '';
    try {
      loadConfig(miljo({ BERGET_API_KEY: 'berget-nyckel-123456', BERGET_BASE_URL: 'inte en adress' }));
    } catch (e) {
      text = String((e as Error).message);
    }
    expect(text).not.toBe('');
    expect(text).not.toContain('berget-nyckel-123456');
  });
});
