import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, CSRF_HEADER, DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import { signTestIdentity } from '@vibesandbox/gateway';
import type { PlatformConfig } from '../src/config.ts';
import { createPlatform } from '../src/server.ts';
import type { Platform } from '../src/server.ts';

const HEMLIGHET = 'en-hemlighet-som-bara-finns-i-testerna-0123456789';
const ANNA = signTestIdentity({ userId: 'anv-anna', email: 'anna@example.org', roles: ['viewer'] }, HEMLIGHET);

interface Svar {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

function anropa(
  port: number,
  options: { host?: string; path?: string; method?: string; headers?: Record<string, string>; json?: unknown },
): Promise<Svar> {
  return new Promise((resolve, reject) => {
    const body = options.json === undefined ? undefined : JSON.stringify(options.json);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        // Eget Host-huvud: det är värdnamnet som avgör vilken app det gäller.
        setHost: false,
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
          Connection: 'close',
          ...options.headers,
        },
      },
      (res) => {
        const bitar: Buffer[] = [];
        res.on('data', (bit: Buffer) => bitar.push(bit));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(bitar).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Skickar råa byte och ger tillbaka allt servern svarar innan den stänger. */
function anropaRatt(port: number, ratt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bitar: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.from(ratt, 'latin1')));
    socket.on('data', (bit: Buffer) => bitar.push(bit));
    socket.on('close', () => resolve(Buffer.concat(bitar).toString('latin1')));
    socket.on('error', reject);
    socket.setTimeout(3000, () => socket.destroy());
  });
}

describe('Plattformen som en riktig server', () => {
  let dataDir: string;
  let bygge: string;
  let platform: Platform;
  let port: number;
  let appId: AppId;

  function config(extra: Partial<PlatformConfig> = {}): PlatformConfig {
    return {
      baseDomain: 'appar.test',
      appDomain: 'appar.test',
      dataDir,
      port: 0,
      listenHost: '127.0.0.1',
      publicScheme: 'http',
      identity: { provider: 'test', testSecret: HEMLIGHET },
      ...extra,
    };
  }

  async function starta(extra: Partial<PlatformConfig> = {}): Promise<void> {
    platform = createPlatform(config(extra));
    ({ port } = await platform.listen());
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-platform-'));
    bygge = await mkdtemp(join(tmpdir(), 'vibesandbox-bygge-'));
    await mkdir(join(bygge, 'assets'));
    await writeFile(join(bygge, 'index.html'), '<!doctype html><title>Publicerad app</title>');
    await writeFile(join(bygge, 'assets', 'app.js'), 'console.log("app");');

    // Som CLI:t gör: en egen control-instans bredvid servern, mot samma datakatalog.
    const control = createControl({ dataDir });
    try {
      appId = await control.createApp();
      await control.publish(appId, await control.importVersion(appId, bygge));
    } finally {
      await control.close();
    }
  });

  afterEach(async () => {
    await platform?.close();
    await rm(bygge, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serverar den publicerade appen för en inloggad användare, med skyddsreglerna', async () => {
    await starta();

    const svar = await anropa(port, { host: `${appId}.appar.test`, headers: { Authorization: ANNA } });

    expect(svar.status).toBe(200);
    expect(svar.body).toContain('Publicerad app');
    expect(svar.headers['content-type']).toBe('text/html; charset=utf-8');
    // Varje direktiv ur kontraktet, plus gatewayns `frame-ancestors 'none'` för en publicerad app.
    const regler = String(svar.headers['content-security-policy']).split(';').map((del) => del.trim());
    expect([...regler].sort()).toEqual([...APP_CONTENT_SECURITY_POLICY.split('; '), "frame-ancestors 'none'"].sort());
    expect(svar.headers['x-content-type-options']).toBe('nosniff');
  });

  it('nekar den som inte är inloggad, utan att visa något av appen', async () => {
    await starta();

    const svar = await anropa(port, { host: `${appId}.appar.test` });

    expect(svar.status).toBe(401);
    expect(svar.body).not.toContain('Publicerad app');
  });

  it('sparar och listar dokument genom hela kedjan, och lägger appens data under tenants/', async () => {
    await starta();
    const host = `${appId}.appar.test`;

    const sparat = await anropa(port, {
      host,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      headers: { Authorization: ANNA, [CSRF_HEADER]: '1' },
      json: { data: { rum: 'Stora salen' } },
    });
    expect(sparat.status).toBe(201);

    const lista = await anropa(port, { host, path: '/_api/collections/poster/docs', headers: { Authorization: ANNA } });
    expect(lista.status).toBe(200);
    expect(JSON.parse(lista.body).documents.map((d: { data: unknown }) => d.data)).toEqual([{ rum: 'Stora salen' }]);

    expect(await readdir(join(dataDir, 'tenants'))).toEqual([`${appId}-published`]);
  });

  it('ett utkast nås på p-<id> under basdomänen och delar inte data med den publicerade appen', async () => {
    const utkast = await mkdtemp(join(tmpdir(), 'vibesandbox-utkast-'));
    const control = createControl({ dataDir });
    try {
      await writeFile(join(utkast, 'index.html'), '<!doctype html><title>Utkastet</title>');
      await control.setDraft(appId, await control.importVersion(appId, utkast));
    } finally {
      await control.close();
      await rm(utkast, { recursive: true, force: true });
    }
    await starta({ baseDomain: 'bygg.test' });

    const sida = await anropa(port, { host: `p-${appId}.bygg.test`, headers: { Authorization: ANNA } });
    expect(sida.status).toBe(200);
    expect(sida.body).toContain('Utkastet');

    // Förhandsvisningen finns INTE under appdomänen när domänerna är olika.
    const fel = await anropa(port, { host: `p-${appId}.appar.test`, headers: { Authorization: ANNA } });
    expect(fel.status).toBe(400);
  });

  it('en app som skapas medan servern är igång går att nå utan omstart', async () => {
    await starta();
    const control = createControl({ dataDir });
    let ny: AppId;
    try {
      ny = await control.createApp();
      await control.publish(ny, await control.importVersion(ny, bygge));
    } finally {
      await control.close();
    }

    const svar = await anropa(port, { host: `${ny}.appar.test`, headers: { Authorization: ANNA } });
    expect(svar.status).toBe(200);
  });

  it('tillämpar kvoterna ur konfigurationen', async () => {
    await starta({ limits: { ...DEFAULT_TENANT_LIMITS, maxDocumentBytes: 100 } });

    const svar = await anropa(port, {
      host: `${appId}.appar.test`,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      headers: { Authorization: ANNA, [CSRF_HEADER]: '1' },
      json: { data: { fyllnad: 'x'.repeat(500) } },
    });

    expect(svar.status).toBe(413);
  });

  it('svarar med skyddsreglerna även när Node själv vägrar tolka förfrågan', async () => {
    await starta();

    const nul = String.fromCharCode(0);
    const svar = await anropaRatt(port, `GET / HTTP/1.1\r\nHost: ${appId}.appar.test\r\nX-Trasig: a${nul}b\r\n\r\n`);

    expect(svar).toMatch(/^HTTP\/1\.1 400 /);
    expect(svar).toContain(`Content-Security-Policy: ${APP_CONTENT_SECURITY_POLICY}`);
    expect(svar).toContain('X-Content-Type-Options: nosniff');
  });

  it('nekar för stora huvuden med 431 och skyddsreglerna (servern skapas med de rekommenderade gränserna)', async () => {
    await starta();

    const svar = await anropaRatt(
      port,
      `GET / HTTP/1.1\r\nHost: ${appId}.appar.test\r\nX-Fyllnad: ${'x'.repeat(9 * 1024)}\r\n\r\n`,
    );

    expect(svar).toMatch(/^HTTP\/1\.1 431 /);
    expect(svar).toContain(`Content-Security-Policy: ${APP_CONTENT_SECURITY_POLICY}`);
  });

  it('en förfrågan utan Host når gatewayn och får 400 med skyddsreglerna', async () => {
    await starta();

    const svar = await anropaRatt(port, 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n');

    expect(svar).toMatch(/^HTTP\/1\.1 400 /);
    expect(svar).toContain(`Content-Security-Policy: ${APP_CONTENT_SECURITY_POLICY}`);
  });

  it('stänger ordnat: slutar ta emot, väntar inte på overksamma anslutningar, och går att stänga två gånger', async () => {
    await starta();
    // En anslutning som bara ligger öppen får inte hålla kvar nedstängningen.
    const overksam = connect(port, '127.0.0.1');
    // Servern bryter anslutningen vid nedstängningen; det är väntat och inget testfel.
    overksam.on('error', () => {});
    await new Promise<void>((resolve) => overksam.once('connect', () => resolve()));

    const start = Date.now();
    await platform.close();
    await platform.close();

    expect(Date.now() - start).toBeLessThan(3000);
    await expect(anropa(port, { host: `${appId}.appar.test` })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    overksam.destroy();
  });

  it('efter nedstängningen går datakatalogen att öppna av någon annan (inga hängande lås)', async () => {
    await starta();
    await anropa(port, {
      host: `${appId}.appar.test`,
      method: 'POST',
      path: '/_api/collections/poster/docs',
      headers: { Authorization: ANNA, [CSRF_HEADER]: '1' },
      json: { data: { a: 1 } },
    });
    await platform.close();

    expect(existsSync(join(dataDir, 'tenants', `${appId}-published`, 'data.sqlite-wal'))).toBe(false);
    const control = createControl({ dataDir });
    expect((await control.listApps()).length).toBe(1);
    await control.close();
  });

  it('vägrar skapas med en ogiltig domän — felet kommer vid start, inte vid första förfrågan', () => {
    expect(() => createPlatform(config({ appDomain: 'Inte En Domän' }))).toThrow();
    // Inget får ligga kvar öppet efter ett misslyckat försök.
    const control = createControl({ dataDir });
    return control.close();
  });
});
