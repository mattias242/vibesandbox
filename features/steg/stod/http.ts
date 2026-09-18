/**
 * Rå HTTP för stegdefinitionerna.
 *
 * Vi använder inte `fetch`: den normaliserar och validerar `Host`-huvudet och adressen, och just
 * de delarna är vad isoleringsscenarierna prövar (ett värdnamn som `../../etc.appar.test`, en
 * sökväg med `..`). Här skrivs förfrågan byte för byte på en TCP-socket, och svaret tolkas utan
 * Nodes HTTP-klient — scenarierna ser alltså exakt det en fientlig klient skulle se.
 */
import { connect } from 'node:net';

export interface Svar {
  readonly status: number;
  /** Huvudnamn i gemener → ALLA värden det förekom med, i ordning. */
  readonly huvuden: Readonly<Record<string, readonly string[]>>;
  readonly kropp: string;
  /** Hela svaret som det kom, huvuden och kropp — för kontroller av typen "nämns X någonstans?". */
  readonly ratt: string;
}

export interface Anrop {
  readonly port: number;
  readonly metod?: string;
  /** Skickas exakt som den står, utan kodning eller normalisering. */
  readonly sokvag?: string;
  /** Värdet på `Host`. Utelämnas det skickas inget `Host`-huvud alls. */
  readonly host?: string;
  readonly huvuden?: Readonly<Record<string, string>>;
  /** JSON-kodas och får `Content-Type: application/json`. */
  readonly json?: unknown;
}

const TIDSGRANS_MS = 10_000;

function tolka(ratt: Buffer): Svar {
  const text = ratt.toString('latin1');
  const grans = text.indexOf('\r\n\r\n');
  const huvuddel = grans === -1 ? text : text.slice(0, grans);
  const kropp = grans === -1 ? '' : ratt.subarray(grans + 4).toString('utf8');
  const [statusrad = '', ...rader] = huvuddel.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusrad)?.[1] ?? 0);

  const huvuden: Record<string, string[]> = {};
  for (const rad of rader) {
    const kolon = rad.indexOf(':');
    if (kolon === -1) continue;
    (huvuden[rad.slice(0, kolon).trim().toLowerCase()] ??= []).push(rad.slice(kolon + 1).trim());
  }
  return { status, huvuden, kropp, ratt: `${huvuddel}\r\n\r\n${kropp}` };
}

export function anropa(anrop: Anrop): Promise<Svar> {
  const kropp = anrop.json === undefined ? undefined : Buffer.from(JSON.stringify(anrop.json), 'utf8');
  const rader = [`${anrop.metod ?? 'GET'} ${anrop.sokvag ?? '/'} HTTP/1.1`];
  if (anrop.host !== undefined) rader.push(`Host: ${anrop.host}`);
  for (const [namn, varde] of Object.entries(anrop.huvuden ?? {})) rader.push(`${namn}: ${varde}`);
  if (kropp !== undefined) rader.push('Content-Type: application/json', `Content-Length: ${kropp.length}`);
  // En anslutning per anrop: svaret är slut när servern stänger, och inget tillstånd delas mellan anrop.
  rader.push('Connection: close', '', '');

  return new Promise((resolve, reject) => {
    const bitar: Buffer[] = [];
    let klar = false;
    const socket = connect(anrop.port, '127.0.0.1', () => {
      socket.write(Buffer.concat([Buffer.from(rader.join('\r\n'), 'latin1'), kropp ?? Buffer.alloc(0)]));
    });
    const avsluta = (): void => {
      if (klar) return;
      klar = true;
      clearTimeout(vakt);
      if (bitar.length === 0) reject(new Error('Servern stängde anslutningen utan att svara.'));
      else resolve(tolka(Buffer.concat(bitar)));
    };
    const vakt = setTimeout(() => {
      socket.destroy();
      if (!klar) {
        klar = true;
        reject(new Error(`Inget svar från servern inom ${TIDSGRANS_MS} ms.`));
      }
    }, TIDSGRANS_MS);
    socket.on('data', (bit: Buffer) => bitar.push(bit));
    socket.on('close', avsluta);
    socket.on('error', (fel) => {
      // Servern får stänga en anslutning den nekat; har vi redan ett svar är det svaret som gäller.
      if (bitar.length > 0) avsluta();
      else if (!klar) {
        klar = true;
        clearTimeout(vakt);
        reject(fel);
      }
    });
  });
}

/** Enda värdet för ett huvud. Kastar om huvudet förekom flera gånger — det ska aldrig ske tyst. */
export function huvud(svar: Svar, namn: string): string | undefined {
  const varden = svar.huvuden[namn.toLowerCase()] ?? [];
  if (varden.length > 1) throw new Error(`Huvudet ${namn} förekom ${varden.length} gånger i svaret.`);
  return varden[0];
}

export function jsonKropp(svar: Svar): unknown {
  try {
    return JSON.parse(svar.kropp);
  } catch {
    throw new Error(`Svaret (status ${svar.status}) var inte JSON: ${svar.kropp.slice(0, 200)}`);
  }
}
