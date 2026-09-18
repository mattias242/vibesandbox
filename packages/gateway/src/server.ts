/**
 * Det som den som SKAPAR servern behöver, och som en förfrågningshanterare inte kan göra själv.
 *
 *   const server = createServer(RECOMMENDED_SERVER_OPTIONS, createGateway(options));
 *   server.on('clientError', handleClientError);
 *
 * Två luckor täpps till här:
 *
 * 1. Förfrågningar som Nodes HTTP-tolk vägrar (NUL i ett huvud, för stora huvuden, tidsgräns)
 *    når aldrig hanteraren. Nodes eget svar är ett naket `400 Bad Request` UTAN
 *    skyddsreglerna. `handleClientError` svarar i stället med samma huvuden som alla andra svar.
 * 2. Utan tidsgränser kan en klient hålla anslutningar öppna genom att skicka huvuden eller kropp
 *    en byte i taget, och utan storleksgräns kan den fylla minnet med huvuden (ADR 0002,
 *    villkor 4; en app kan dessutom plantera stora kakor för hela domänen — "kakbombning").
 */
import type { ServerOptions } from 'node:http';
import type { Duplex } from 'node:stream';
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import type { ApiErrorBody } from '@vibesandbox/contracts';
import { SECURITY_HEADERS } from './huvuden.ts';

/** Skickas som första argument till `http.createServer`. Värdena är millisekunder resp. byte. */
export const RECOMMENDED_SERVER_OPTIONS = {
  /** Alla huvuden ska ha kommit inom tio sekunder. */
  headersTimeout: 10_000,
  /** Hela förfrågan, inklusive kroppen (högst `MAX_REQUEST_BODY_BYTES`), inom trettio sekunder. */
  requestTimeout: 30_000,
  /** En overksam anslutning hålls öppen i högst fem sekunder. Proxyn framför bör ha ett LÄGRE värde. */
  keepAliveTimeout: 5_000,
  /** Hälften av Nodes standard. Rymmer en sessionskaka och vanliga huvuden med god marginal. */
  maxHeaderSize: 8 * 1024,
  /**
   * Node besvarar annars en HTTP/1.1-förfrågan utan `Host` på egen hand — förbi BÅDE hanteraren
   * och `clientError` — med ett naket 400 utan skyddsreglerna. Avstängt här släpps förfrågan fram
   * till gatewayn, som nekar saknat `Host` precis som varje annat ogiltigt värdnamn (400, med
   * skyddsreglerna). Det är tryggt just för att värdnamnstolkningen är en allowlist: inget `Host`
   * matchar inget mönster.
   */
  requireHostHeader: false,
} as const satisfies ServerOptions;

interface ClientErrorReply {
  readonly statusLine: string;
  readonly message: string;
}

/** Nodes felkoder för de två fall där en annan status än 400 säger något sant och användbart. */
function replyFor(error: Error): ClientErrorReply {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'HPE_HEADER_OVERFLOW') {
    return { statusLine: '431 Request Header Fields Too Large', message: 'Förfrågans huvuden är för stora.' };
  }
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    return { statusLine: '408 Request Timeout', message: 'Förfrågan tog för lång tid.' };
  }
  return { statusLine: `${API_ERROR_STATUS.invalid_request} Bad Request`, message: 'Förfrågan gick inte att tolka.' };
}

/**
 * Hanterare för serverns `clientError`-händelse. Skriver svaret för hand på socketen — det finns
 * inget `ServerResponse` i det här läget — och stänger alltid anslutningen: efter ett tolkningsfel
 * går det inte att veta var nästa förfrågan börjar.
 *
 * Svaret innehåller ingenting ur förfrågan och ingenting ur felet.
 */
export function handleClientError(error: Error, socket: Duplex): void {
  // Klienten har redan försvunnit, eller socketen går inte att skriva på: inget att svara.
  if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }

  const reply = replyFor(error);
  const body: ApiErrorBody = { error: { code: 'invalid_request', message: reply.message } };
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const head = [
    `HTTP/1.1 ${reply.statusLine}`,
    ...SECURITY_HEADERS.map(([name, value]) => `${name}: ${value}`),
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${payload.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), payload]), () => socket.destroy());
}
