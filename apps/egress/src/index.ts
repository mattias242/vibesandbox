/**
 * Egress-proxy: plattformens ENDA väg ut på internet.
 *
 * Plattformen står på ett internt Docker-nät utan utgång. Den enda tjänst den når är den här
 * proxyn, och proxyn öppnar bara krypterade tunnlar (HTTP CONNECT) till värdnamn som står på en
 * uttrycklig lista — i dag modelleverantören och mejltjänsten. Allt annat nekas.
 *
 * Varför en egen liten proxy i stället för Squid e.d.: hela beteendet ryms i en fil som går att
 * läsa vid en säkerhetsgranskning, och den har inga beroenden. Den gör exakt tre saker:
 *   1. släpper bara CONNECT till `värdnamn:port` som står på listan (aldrig IP-adresser);
 *   2. slår upp namnet och vägrar om NÅGON adress pekar in i ett privat, lokalt eller internt nät
 *      (skydd mot DNS-ombindning: ett tillåtet namn får inte bli en väg in i värdens nät);
 *   3. kopplar ihop strömmarna — den ser aldrig innehållet, som är TLS-krypterat hela vägen.
 * Vanliga HTTP-förfrågningar genom proxyn nekas: ingen okrypterad vidarebefordran.
 */
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { isIP, connect as connectTcp } from 'node:net';
import type { Socket } from 'node:net';

// ── Allowlistan ─────────────────────────────────────────────────────────────────

/** Ett DNS-namn med minst två etiketter. Inga jokertecken, ingen avslutande punkt, inga IP-adresser. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `host:port, host:port` → mängd av `host:port` i gemener. Kastar vid minsta tvekan. */
export function parseAllowList(text: string): Set<string> {
  const entries = text
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error('Listan över tillåtna mål är tom.');
  const allow = new Set<string>();
  for (const entry of entries) {
    const target = parseTarget(entry);
    if (target === null) throw new Error(`Ogiltigt mål i listan: ${entry} (väntade värdnamn:port)`);
    allow.add(`${target.host}:${target.port}`);
  }
  return allow;
}

/** Tolkar `värdnamn:port` strikt. IP-adresser, jokertecken och allt annat ger `null`. */
function parseTarget(text: string): { host: string; port: number } | null {
  const match = /^([^:\s]+):([0-9]{1,5})$/.exec(text);
  if (match === null) return null;
  const host = (match[1] ?? '').toLowerCase();
  const port = Number(match[2]);
  if (!HOSTNAME.test(host) || isIP(host) !== 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

// ── Offentliga adresser ─────────────────────────────────────────────────────────

/** Nät som aldrig får vara mål, även om ett tillåtet namn pekar dit. */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 — "detta nät"
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 — CGNAT, bl.a. tailnetet
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 — länklokalt, bl.a. molnens metadatatjänst
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24 — IETF-protokoll
  [0xc0000200, 24], // 192.0.2.0/24 — dokumentation
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 — mätning
  [0xc6336400, 24], // 198.51.100.0/24 — dokumentation
  [0xcb007100, 24], // 203.0.113.0/24 — dokumentation
  [0xe0000000, 3], // 224.0.0.0/3 — multicast och reserverat
];

function v4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isPublicV4(ip: string): boolean {
  const value = v4ToNumber(ip);
  if (value === null) return false;
  for (const [network, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((value & mask) >>> 0) === network) return false;
  }
  return true;
}

/** Expanderar en IPv6-adress till åtta 16-bitarsgrupper. Inbäddad IPv4 i slutet hanteras. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) return null; // zonindex = länklokalt
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Tail !== null) {
    const v4 = v4ToNumber(v4Tail[1] ?? '');
    if (v4 === null) return null;
    text = text.slice(0, -(v4Tail[1] ?? '').length) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const groups: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups.length === 8 ? groups : null;
}

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (g === null) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h = 0, i = 0] = g;
  // IPv4-mappad (::ffff:a.b.c.d) och IPv4-kompatibel: bedöm den inbäddade IPv4-adressen.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    if (f === 0 && h === 0 && (i === 0 || i === 1)) return false; // :: och ::1
    return isPublicV4(`${h >> 8}.${h & 0xff}.${i >> 8}.${i & 0xff}`);
  }
  if (a === 0x64 && b === 0xff9b) return false; // 64:ff9b::/96 — NAT64, kan leda in i IPv4-nät
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 — unika lokala
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 — länklokala
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8 — multicast
  if (a === 0x2001 && b === 0x0db8) return false; // dokumentation
  return (a & 0xe000) === 0x2000; // bara 2000::/3 är globalt routat unicast
}

/** Sant bara för adresser på det publika internet. Allt tveksamt ⇒ falskt. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version === 6) return isPublicV6(ip);
  return false;
}

// ── Proxyn ──────────────────────────────────────────────────────────────────────

export interface EgressLogEntry {
  readonly event: 'tunnel';
  readonly decision: 'allow' | 'deny' | 'error';
  readonly host: string;
  readonly port: number;
  /** Kort orsak vid nekande eller fel. Aldrig data ur tunneln. */
  readonly reason?: string;
}

export interface EgressProxyOptions {
  readonly allow: ReadonlySet<string>;
  /** Namnuppslag; standard: operativsystemets resolver, alla adresser. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Standard: `isPublicAddress`. Bara tester byter ut den. */
  readonly isPermittedAddress?: (ip: string) => boolean;
  readonly logger?: (entry: EgressLogEntry) => void;
  readonly connectTimeoutMs?: number;
  /** En tunnel utan trafik stängs efter så här lång tid. */
  readonly idleTimeoutMs?: number;
  readonly maxTunnels?: number;
}

async function resolveAll(host: string): Promise<readonly string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

function reply(socket: Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  const resolve = options.resolve ?? resolveAll;
  const isPermitted = options.isPermittedAddress ?? isPublicAddress;
  const log = options.logger ?? (() => {});
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  const maxTunnels = options.maxTunnels ?? 64;
  let open = 0;

  const server = createServer((request, response) => {
    // Allt som inte är CONNECT: ingen okrypterad vidarebefordran, inget annat att erbjuda.
    request.resume();
    response.writeHead(405, { Allow: 'CONNECT', Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  server.on('connect', (request, clientSocket: Socket, head: Buffer) => {
    clientSocket.on('error', () => {});
    const target = parseTarget((request.url ?? '').toLowerCase());
    const host = target?.host ?? '(ogiltigt)';
    const port = target?.port ?? 0;
    const deny = (status: number, text: string, reason: string, decision: 'deny' | 'error' = 'deny'): void => {
      log({ event: 'tunnel', decision, host, port, reason });
      reply(clientSocket, status, text);
    };

    if (target === null || !options.allow.has(`${target.host}:${target.port}`)) {
      deny(403, 'Forbidden', target === null ? 'ogiltigt mål' : 'inte på listan');
      return;
    }
    if (open >= maxTunnels) {
      deny(503, 'Service Unavailable', 'för många tunnlar', 'error');
      return;
    }

    open += 1;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        open -= 1;
      }
    };
    clientSocket.once('close', release);

    void (async () => {
      let addresses: readonly string[];
      try {
        addresses = await resolve(target.host);
      } catch {
        deny(502, 'Bad Gateway', 'namnet gick inte att slå upp', 'error');
        return;
      }
      // ALLA adresser måste vara offentliga — annars kan en angripare som styr namnets DNS
      // växla in en intern adress mellan två uppslag.
      if (addresses.length === 0 || !addresses.every((ip) => isPermitted(ip))) {
        deny(403, 'Forbidden', 'namnet pekar in i ett internt nät');
        return;
      }

      const upstream = connectTcp({ host: addresses[0] ?? '', port: target.port });
      // Egen flagga: `upstream.connecting` har redan hunnit ändras när ett anslutningsfel rapporteras.
      let established = false;
      const timer = setTimeout(() => upstream.destroy(new Error('tidsgräns')), connectTimeoutMs);
      upstream.once('connect', () => {
        established = true;
        clearTimeout(timer);
        log({ event: 'tunnel', decision: 'allow', host, port });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        clientSocket.setTimeout(idleTimeoutMs, () => clientSocket.destroy());
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('error', () => {
        clearTimeout(timer);
        if (!established && !clientSocket.writableEnded) {
          deny(502, 'Bad Gateway', 'målet svarade inte', 'error');
        } else {
          clientSocket.destroy();
        }
      });
      upstream.once('close', () => {
        if (established) clientSocket.destroy();
      });
      clientSocket.once('close', () => upstream.destroy());
    })();
  });

  return server;
}
