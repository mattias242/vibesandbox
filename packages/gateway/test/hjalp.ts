/**
 * Testhjälpare för gatewayens HTTP-gränssnitt.
 *
 * Vi använder INTE `fetch`: den normaliserar och validerar Host-huvudet, tillåter inte
 * dubbla huvuden och kan inte skicka rå, felaktigt kodad sökväg. Fientliga indata (se
 * docs/konventioner.md) kräver att vi själva bygger den råa HTTP-förfrågan byte för byte.
 *
 * `anropaRatt` är primitiven: den skriver en rå HTTP/1.1-förfrågan på en TCP-socket och
 * tolkar svaret utan att gå via Node:s http-klient. `anropa` är en bekväm inpackning för
 * det vanliga fallet (giltiga huvuden, JSON-kropp).
 */
import { connect } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { RequestHandler } from '../src/index.ts';

export interface Testserver {
  readonly port: number;
  stang(): Promise<void>;
}

/** Startar en riktig `node:http`-server på en ledig port på 127.0.0.1. */
export function startaTestserver(hanterare: RequestHandler): Promise<Testserver> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(hanterare);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const adress = server.address();
      if (adress === null || typeof adress === 'string') {
        reject(new Error('kunde inte läsa ut testserverns port'));
        return;
      }
      resolve({
        port: adress.port,
        stang: () =>
          new Promise<void>((res, rej) => {
            server.close((fel) => (fel ? rej(fel) : res()));
          }),
      });
    });
  });
}

export interface AnropSvar {
  readonly status: number;
  /** Varje huvudnamn (gemener) mappat till ALLA värden det förekom med, i ordning. */
  readonly huvuden: Readonly<Record<string, readonly string[]>>;
  readonly kropp: string;
}

/** Enda värdet för ett huvud, eller undefined om det saknas. Kastar om det förekom flera gånger. */
export function enHuvud(svar: AnropSvar, namn: string): string | undefined {
  const varden = svar.huvuden[namn.toLowerCase()];
  if (varden === undefined || varden.length === 0) return undefined;
  if (varden.length > 1) {
    throw new Error(`huvudet "${namn}" förekom ${varden.length} gånger i svaret: ${varden.join(' | ')}`);
  }
  return varden[0];
}

/** Alla värden ett huvud förekom med (tom lista om det saknas). */
export function allaHuvuden(svar: AnropSvar, namn: string): readonly string[] {
  return svar.huvuden[namn.toLowerCase()] ?? [];
}

function tolkaRattSvar(ratt: Buffer): AnropSvar {
  const text = ratt.toString('latin1');
  const skiljetecken = text.indexOf('\r\n\r\n');
  const huvudDel = skiljetecken === -1 ? text : text.slice(0, skiljetecken);
  const kroppDel = skiljetecken === -1 ? '' : ratt.slice(Buffer.byteLength(huvudDel, 'latin1') + 4).toString('utf8');
  const rader = huvudDel.split('\r\n');
  const statusrad = rader[0] ?? '';
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusrad);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const huvuden: Record<string, string[]> = {};
  for (const rad of rader.slice(1)) {
    const kolon = rad.indexOf(':');
    if (kolon === -1) continue;
    const namn = rad.slice(0, kolon).trim().toLowerCase();
    const varde = rad.slice(kolon + 1).trim();
    (huvuden[namn] ??= []).push(varde);
  }

  return { status, huvuden, kropp: kroppDel };
}

export interface RattAnropOptions {
  readonly port: number;
  /** T.ex. "GET /_api/whoami HTTP/1.1". Skickas exakt så här, utan omtolkning. */
  readonly requestrad: string;
  /** Rå huvudrader i ordning, t.ex. ["Host: a.test", "Host: b.test"]. Host läggs INTE till automatiskt. */
  readonly huvuden?: readonly string[];
  readonly kropp?: string;
  /** Millisekunder innan anropet ger upp och antar att servern stängde/vägrade anslutningen. */
  readonly tidsgrans?: number;
}

/**
 * Skickar en helt rå HTTP-förfrågan över en TCP-socket. Om servern stänger anslutningen
 * (t.ex. för att Node:s egen HTTP-parser vägrar tolka en trasig förfrågan) tolkas det som
 * ett giltigt "avvisat"-resultat: status 0 och tomma huvuden, inte ett testfel.
 */
export function anropaRatt(options: RattAnropOptions): Promise<AnropSvar> {
  return new Promise((resolve, reject) => {
    const bitar: Buffer[] = [];
    const socket = connect(options.port, '127.0.0.1', () => {
      // Huvudblocket kodas byte-transparent (latin1) så att fientliga rå bytes i huvuden
      // (t.ex. NUL) går igenom oförändrade. Kroppen kodas separat som UTF-8, så att den
      // stämmer med ett `Content-Length` beräknat med `Buffer.byteLength(kropp, 'utf8')`.
      const huvudrader = options.huvuden ?? [];
      const huvudblock = [options.requestrad, ...huvudrader, '', ''].join('\r\n');
      const kroppBuffer = Buffer.from(options.kropp ?? '', 'utf8');
      socket.write(Buffer.concat([Buffer.from(huvudblock, 'latin1'), kroppBuffer]));
    });

    let avgjord = false;
    const avgorMedSvar = () => {
      if (avgjord) return;
      avgjord = true;
      clearTimeout(vakt);
      const ratt = Buffer.concat(bitar);
      resolve(ratt.length === 0 ? { status: 0, huvuden: {}, kropp: '' } : tolkaRattSvar(ratt));
    };

    const vakt = setTimeout(() => {
      socket.destroy();
      avgorMedSvar();
    }, options.tidsgrans ?? 2000);

    socket.on('data', (chunk: Buffer) => bitar.push(chunk));
    socket.on('end', avgorMedSvar);
    socket.on('close', avgorMedSvar);
    socket.on('error', (fel) => {
      // ECONNRESET m.fl. är ett giltigt sätt för servern att avvisa en trasig förfrågan.
      if (bitar.length > 0 || avgjord) {
        avgorMedSvar();
      } else {
        clearTimeout(vakt);
        reject(fel);
      }
    });
  });
}

export interface AnropOptions {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  /** Värdet på Host-huvudet. Utelämna för att testa en förfrågan UTAN Host-huvud. */
  readonly host?: string;
  /** Ytterligare huvuden. Ange en array som värde för att skicka samma huvud flera gånger. */
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string;
  /** JSON-kodar `body` och sätter Content-Type automatiskt. Utelämna `body` när denna används. */
  readonly json?: unknown;
}

/** Bekväm inpackning av `anropaRatt` för det vanliga fallet. */
export function anropa(options: AnropOptions): Promise<AnropSvar> {
  const metod = options.method ?? 'GET';
  const vag = options.path ?? '/';
  const kropp = options.json !== undefined ? JSON.stringify(options.json) : options.body;

  const huvudrader: string[] = [];
  if (options.host !== undefined) huvudrader.push(`Host: ${options.host}`);
  if (options.json !== undefined) huvudrader.push('Content-Type: application/json');
  for (const [namn, varde] of Object.entries(options.headers ?? {})) {
    const varden = Array.isArray(varde) ? varde : [varde];
    for (const v of varden) huvudrader.push(`${namn}: ${v}`);
  }
  if (kropp !== undefined) {
    huvudrader.push(`Content-Length: ${Buffer.byteLength(kropp, 'utf8')}`);
  }
  huvudrader.push('Connection: close');

  return anropaRatt({
    port: options.port,
    requestrad: `${metod} ${vag} HTTP/1.1`,
    huvuden: huvudrader,
    ...(kropp !== undefined ? { kropp } : {}),
  });
}

/** Tolkar en JSON-kropp; kastar tydligt om svaret inte var giltig JSON. */
export function json<T = unknown>(svar: AnropSvar): T {
  try {
    return JSON.parse(svar.kropp) as T;
  } catch (fel) {
    throw new Error(`svarskroppen var inte giltig JSON: ${svar.kropp.slice(0, 200)}\n${String(fel)}`);
  }
}
