/**
 * Plattformen startar med `APP_SERVICES=files` ur miljön — som i drift — med den RIKTIGA fabriken,
 * och en fil går att ladda upp och hämta genom gatewayn.
 *
 * Importerar `@vibesandbox/platform` för att pröva hela kedjan; plattformen i sin tur beror på
 * det här paketet. Det är bara testet som går åt det hållet.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import { signTestIdentity } from '@vibesandbox/gateway';
import { createPlatform, loadConfig } from '@vibesandbox/platform';
import type { Platform } from '@vibesandbox/platform';
import { PNG } from './exempelfiler.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';
const ANNA = signTestIdentity({ userId: 'anv-anna', email: 'anna@example.org', roles: ['viewer'] }, HEMLIGHET);

let dataDir: string;
let platform: Platform | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-files-plattform-'));
});

afterEach(async () => {
  await platform?.close();
  platform = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

function miljo(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    BASE_DOMAIN: 'appar.test',
    APP_DOMAIN: 'appar.test',
    DATA_DIR: dataDir,
    PORT: '0',
    LISTEN_HOST: '127.0.0.1',
    PUBLIC_SCHEME: 'http',
    IDENTITY_PROVIDER: 'test',
    TEST_IDENTITY_SECRET: HEMLIGHET,
    APP_SERVICES: 'files',
    ...extra,
  };
}

async function publiceradApp(): Promise<AppId> {
  const control = createControl({ dataDir });
  try {
    const appId = await control.createApp();
    const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bygge-'));
    await writeFile(join(katalog, 'index.html'), '<!doctype html><title>App</title>');
    await control.publish(appId, await control.importVersion(appId, katalog));
    await control.grantAccess(appId, 'anv-anna', 'owner', 'anna@example.org');
    await rm(katalog, { recursive: true, force: true });
    return appId;
  } finally {
    await control.close();
  }
}

function anropa(
  port: number,
  host: string,
  metod: string,
  sokvag: string,
  kropp?: { bytes: Uint8Array; typ: string },
): Promise<{ status: number; huvuden: Record<string, string | string[] | undefined>; bytes: Buffer }> {
  const huvuden: Record<string, string> = { Host: host, Authorization: ANNA, Connection: 'close' };
  if (metod !== 'GET') huvuden[CSRF_HEADER] = '1';
  if (kropp !== undefined) huvuden['Content-Type'] = kropp.typ;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: metod, path: sokvag, headers: huvuden }, (res) => {
      const bitar: Buffer[] = [];
      res.on('data', (b: Buffer) => bitar.push(b));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, huvuden: res.headers, bytes: Buffer.concat(bitar) }));
    });
    req.on('error', reject);
    req.end(kropp === undefined ? undefined : Buffer.from(kropp.bytes));
  });
}

describe('plattformen med APP_SERVICES=files', () => {
  it('startar, och en bild går att ladda upp och visa genom gatewayn', async () => {
    const appId = await publiceradApp();
    platform = createPlatform(loadConfig(miljo()));
    const { port } = await platform.listen();
    const host = `${appId}.appar.test:${port}`;

    const uppladdning = await anropa(port, host, 'POST', '/_api/files?name=bild.png', { bytes: PNG, typ: 'image/png' });
    expect(uppladdning.status).toBe(201);
    const { id } = JSON.parse(uppladdning.bytes.toString('utf8')) as { id: string };

    const innehall = await anropa(port, host, 'GET', `/_api/files/${id}/content`);
    expect(innehall.status).toBe(200);
    expect(innehall.bytes.equals(Buffer.from(PNG))).toBe(true);
    expect(innehall.huvuden['content-type']).toBe('image/png');
    expect(innehall.huvuden['content-disposition']).toBe('inline; filename="bild.png"');
    expect(innehall.huvuden['x-content-type-options']).toBe('nosniff');

    // Tjänstens data ligger i plattformens katalog för tjänsten.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dataDir, 'services', 'files', 'files.sqlite'))).toBe(true);
  });

  it('en ogiltig inställning stoppar starten', () => {
    expect(() => createPlatform(loadConfig(miljo({ SVC_FILES_QUOTA_MB: 'mycket' })))).toThrow(/SVC_FILES_QUOTA_MB/);
  });
});
