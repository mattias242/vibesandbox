/**
 * Virusskanning med ClamAV:s clamd över TCP, med INSTREAM-protokollet:
 *
 *   → "zINSTREAM\0", sedan bitar: <längd, 4 byte big-endian><byte …>, avslutat med fyra nollor
 *   ← "stream: OK\0" | "stream: <signatur> FOUND\0" | "… ERROR\0"
 *
 * Allt som inte är ett tydligt OK eller FOUND — fel, tidsgräns, stängd anslutning, oväntat svar —
 * kastar `ClamdUnavailableError`, och då sparas filen inte (fail closed).
 */
import { connect } from 'node:net';

export interface ClamdAddress {
  readonly host: string;
  readonly port: number;
}

export type ScanResult = { readonly clean: true } | { readonly clean: false; readonly signature: string };

export interface VirusScanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

export class ClamdUnavailableError extends Error {
  constructor(reason: string) {
    super(`clamd: ${reason}`);
    this.name = 'ClamdUnavailableError';
  }
}

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** `värd:port`, t.ex. `clamav:3310`. Allt annat ⇒ `null`. */
export function parseClamdAddress(text: string): ClamdAddress | null {
  const match = /^([^:\s]+):([0-9]{1,5})$/.exec(text.trim());
  if (match === null) return null;
  const host = match[1] ?? '';
  const port = Number(match[2]);
  if (!HOST_PATTERN.test(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Signaturens namn som det får loggas: bara ett begränsat, ofarligt teckenurval. */
function cleanSignature(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 100) || 'okand';
}

const MAX_REPLY_BYTES = 4096;

export function createClamdScanner(
  address: ClamdAddress,
  options: { readonly timeoutMs?: number; readonly chunkBytes?: number } = {},
): VirusScanner {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const chunkBytes = options.chunkBytes ?? 64 * 1024;

  return {
    scan(bytes) {
      return new Promise<ScanResult>((resolve, reject) => {
        const reply: Buffer[] = [];
        let replyLength = 0;
        let settled = false;
        const socket = connect({ host: address.host, port: address.port });

        const finish = (outcome: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          outcome();
        };
        const fail = (reason: string): void => finish(() => reject(new ClamdUnavailableError(reason)));
        const timer = setTimeout(() => fail('tidsgränsen passerades'), timeoutMs);

        const interpret = (): void => {
          const text = Buffer.concat(reply).toString('latin1').replace(/[\0\r\n]+$/, '');
          const found = /^stream: (.+) FOUND$/.exec(text);
          if (text === 'stream: OK') finish(() => resolve({ clean: true }));
          else if (found !== null) finish(() => resolve({ clean: false, signature: cleanSignature(found[1] ?? '') }));
          else fail('oväntat svar');
        };

        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            const chunk = bytes.subarray(offset, offset + chunkBytes);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length, 0);
            socket.write(length);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        });
        socket.on('data', (data: Buffer) => {
          replyLength += data.length;
          if (replyLength > MAX_REPLY_BYTES) {
            fail('för långt svar');
            return;
          }
          reply.push(data);
          // Svaret avslutas med NUL (z-kommandon); vänta inte på att clamd stänger.
          if (data.includes(0)) interpret();
        });
        socket.on('end', () => {
          if (replyLength === 0) fail('stängde utan svar');
          else interpret();
        });
        socket.on('close', () => fail('anslutningen stängdes'));
        socket.on('error', () => fail('gick inte att nå'));
      });
    },
  };
}
