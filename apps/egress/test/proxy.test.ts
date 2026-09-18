import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEgressProxy, isPublicAddress, parseAllowList } from '../src/index.ts';
import type { EgressLogEntry } from '../src/index.ts';

/** En "extern" tjänst som svarar med det den tar emot — för att se att en tunnel faktiskt bär data. */
async function startaEko(): Promise<{ server: TcpServer; port: number }> {
  const server = createTcpServer((socket) => socket.pipe(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

async function startaProxy(options: Parameters<typeof createEgressProxy>[0]): Promise<{ server: Server; port: number }> {
  const server = createEgressProxy(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

/** Skickar en CONNECT och ger statusraden, samt socketen om tunneln öppnades. */
async function begarTunnel(proxyPort: number, target: string): Promise<{ status: number; socket?: Socket }> {
  const socket = connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let buffer = '';
  while (!buffer.includes('\r\n\r\n')) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    buffer += chunk.toString('latin1');
  }
  const status = Number(buffer.slice(9, 12));
  if (status === 200) return { status, socket };
  socket.destroy();
  return { status };
}

const oppnade: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const s of oppnade.splice(0)) await new Promise((r) => (s as Server).close(() => r(undefined)));
});

describe('Allowlistan', () => {
  it('tolkar värdnamn:port, gemener, och avvisar skräp', () => {
    expect(parseAllowList('api.example.org:443, MAIL.example.org:443')).toEqual(
      new Set(['api.example.org:443', 'mail.example.org:443']),
    );
    for (const skrap of ['example.org', 'example.org:0', 'example.org:99999', '*.example.org:443', 'a b:443', 'http://x:443', '']) {
      expect(() => parseAllowList(skrap), skrap).toThrow();
    }
  });
});

describe('Offentliga adresser', () => {
  it('godtar vanliga offentliga adresser', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('avvisar allt som leder in i privata, lokala eller interna nät', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '100.127.255.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1',
      'inte-en-adress',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('Tunnlar', () => {
  it('öppnar en tunnel till ett tillåtet mål och bär data åt båda hållen', async () => {
    const eko = await startaEko();
    oppnade.push(eko.server);
    const proxy = await startaProxy({
      allow: parseAllowList(`api.example.org:${eko.port}`),
      resolve: async () => ['127.0.0.1'],
      isPermittedAddress: () => true,
    });
    oppnade.push(proxy.server);

    const { status, socket } = await begarTunnel(proxy.port, `api.example.org:${eko.port}`);
    expect(status).toBe(200);
    socket!.write('hej');
    const [svar] = (await once(socket!, 'data')) as [Buffer];
    expect(svar.toString()).toBe('hej');
    socket!.destroy();
  });

  it('nekar ett mål som inte står på listan — utan att ens slå upp namnet', async () => {
    let uppslag = 0;
    const loggar: EgressLogEntry[] = [];
    const proxy = await startaProxy({
      allow: parseAllowList('api.example.org:443'),
      resolve: async () => {
        uppslag += 1;
        return ['93.184.216.34'];
      },
      logger: (entry) => loggar.push(entry),
    });
    oppnade.push(proxy.server);

    for (const mal of ['evil.example.net:443', 'api.example.org:80', 'API.example.org.evil.net:443', 'api.example.org.:443']) {
      expect((await begarTunnel(proxy.port, mal)).status, mal).toBe(403);
    }
    expect(uppslag).toBe(0);
    expect(loggar.every((l) => l.decision === 'deny')).toBe(true);
  });

  it('nekar ett tillåtet namn som pekar in i ett privat nät (DNS-ombindning)', async () => {
    const proxy = await startaProxy({
      allow: parseAllowList('api.example.org:443'),
      resolve: async () => ['93.184.216.34', '10.0.0.5'],
    });
    oppnade.push(proxy.server);
    expect((await begarTunnel(proxy.port, 'api.example.org:443')).status).toBe(403);
  });

  it('nekar IP-adresser som mål, även offentliga — bara namn på listan', async () => {
    const proxy = await startaProxy({ allow: parseAllowList('api.example.org:443'), resolve: async () => ['93.184.216.34'] });
    oppnade.push(proxy.server);
    for (const mal of ['93.184.216.34:443', '[2606:4700::1]:443', '127.0.0.1:443']) {
      expect((await begarTunnel(proxy.port, mal)).status, mal).toBe(403);
    }
  });

  it('svarar 502 när namnet inte går att slå upp eller målet inte svarar', async () => {
    const proxy = await startaProxy({
      allow: parseAllowList('borta.example.org:443,tyst.example.org:9'),
      resolve: async (host) => {
        if (host === 'borta.example.org') throw new Error('ENOTFOUND');
        return ['127.0.0.1'];
      },
      isPermittedAddress: () => true,
      connectTimeoutMs: 500,
    });
    oppnade.push(proxy.server);
    expect((await begarTunnel(proxy.port, 'borta.example.org:443')).status).toBe(502);
    expect((await begarTunnel(proxy.port, 'tyst.example.org:9')).status).toBe(502);
  });
});

describe('Allt som inte är CONNECT', () => {
  it('vanliga HTTP-förfrågningar genom proxyn nekas — ingen okrypterad vidarebefordran', async () => {
    const proxy = await startaProxy({ allow: parseAllowList('api.example.org:443'), resolve: async () => ['93.184.216.34'] });
    oppnade.push(proxy.server);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, path: 'http://api.example.org/', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});

describe('Loggen', () => {
  it('innehåller beslut, värd och port — aldrig data ur tunneln', async () => {
    const eko = await startaEko();
    oppnade.push(eko.server);
    const loggar: EgressLogEntry[] = [];
    const proxy = await startaProxy({
      allow: parseAllowList(`api.example.org:${eko.port}`),
      resolve: async () => ['127.0.0.1'],
      isPermittedAddress: () => true,
      logger: (entry) => loggar.push(entry),
    });
    oppnade.push(proxy.server);
    const { socket } = await begarTunnel(proxy.port, `api.example.org:${eko.port}`);
    socket!.write('HEMLIG-NYCKEL-123');
    await once(socket!, 'data');
    socket!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(loggar.some((l) => l.decision === 'allow' && l.host === 'api.example.org')).toBe(true);
    expect(JSON.stringify(loggar)).not.toContain('HEMLIG');
  });
});

// Hindrar att en oanvänd import av createServer ger typfel om testerna ändras.
void createServer;
