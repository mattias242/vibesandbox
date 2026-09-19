/**
 * En fejkad clamd för tester och scenarier: talar INSTREAM-protokollet över TCP och hittar
 * "skadlig kod" i allt som innehåller `FEJKVIRUS_MARKOR`. Vi använder medvetet inte EICAR-strängen:
 * den får riktiga virusskydd på utvecklarnas datorer att sätta repot i karantän.
 *
 * Exporteras som `@vibesandbox/tjanst-files/testing`, så att BDD-stegen kan använda samma fejk.
 */
import { createServer } from 'node:net';
import type { Socket } from 'node:net';

export const FEJKVIRUS_MARKOR = 'VIBESANDBOX-FEJKVIRUS-FOR-TESTER';

export interface FejkClamd {
  /** `127.0.0.1:<port>` — värdet till `SVC_FILES_CLAMD`. */
  readonly adress: string;
  /** Hur många strömmar som skannats. */
  readonly skannade: () => number;
  stang(): Promise<void>;
}

export type FejkLage = 'normal' | 'fel' | 'tyst' | 'stanger';

/**
 * `lage`: `normal` svarar som clamd; `fel` svarar med ett clamd-fel; `tyst` svarar aldrig;
 * `stanger` stänger anslutningen utan svar.
 */
export async function startaFejkClamd(lage: FejkLage = 'normal'): Promise<FejkClamd> {
  let antal = 0;
  const anslutningar = new Set<Socket>();
  const server = createServer((socket) => {
    anslutningar.add(socket);
    socket.on('close', () => anslutningar.delete(socket));
    socket.on('error', () => {});
    let buffert = Buffer.alloc(0);
    let kommando = false;
    const data: Buffer[] = [];
    socket.on('data', (bit: Buffer) => {
      buffert = Buffer.concat([buffert, bit]);
      if (!kommando) {
        const slut = buffert.indexOf(0);
        if (slut === -1) return;
        if (buffert.subarray(0, slut).toString('latin1') !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        kommando = true;
        buffert = buffert.subarray(slut + 1);
      }
      for (;;) {
        if (buffert.length < 4) return;
        const langd = buffert.readUInt32BE(0);
        if (langd === 0) {
          antal += 1;
          if (lage === 'tyst') return;
          if (lage === 'stanger') {
            socket.destroy();
            return;
          }
          if (lage === 'fel') {
            socket.end('INSTREAM size limit exceeded. ERROR\0');
            return;
          }
          const hittad = Buffer.concat(data).includes(FEJKVIRUS_MARKOR);
          socket.end(hittad ? 'stream: Vibesandbox.Fejkvirus FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffert.length < 4 + langd) return;
        data.push(buffert.subarray(4, 4 + langd));
        buffert = buffert.subarray(4 + langd);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adress = server.address();
  if (adress === null || typeof adress === 'string') throw new Error('Den fejkade clamd fick ingen port.');
  return {
    adress: `127.0.0.1:${adress.port}`,
    skannade: () => antal,
    stang: () =>
      new Promise((resolve) => {
        for (const s of anslutningar) s.destroy();
        server.close(() => resolve());
      }),
  };
}
