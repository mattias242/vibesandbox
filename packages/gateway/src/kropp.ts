/**
 * Läsning och tolkning av en förfrågans kropp.
 *
 * Gränsen är `MAX_REQUEST_BODY_BYTES` ur kontraktet. Vi litar inte på `Content-Length`: den
 * används bara för att neka tidigt, och bytes räknas ändå medan de kommer (en kropp med
 * `Transfer-Encoding: chunked` har ingen längd alls). Inget över gränsen sparas någonsin i minnet.
 */
import type { IncomingMessage } from 'node:http';
import type { JsonObject } from '@vibesandbox/contracts';
import { invalidRequest, tooLarge } from './fel.ts';

/**
 * När gränsen passerats slutar vi SPARA, men fortsätter en begränsad stund att läsa och kasta
 * bort det som kommer. Skälet är praktiskt: stänger vi anslutningen medan klienten fortfarande
 * skickar får den ett nätverksfel i stället för vårt 413-svar, och användaren får aldrig veta
 * varför det inte gick. Både mängd och tid är hårt begränsade; därefter stängs anslutningen.
 */
const DISCARD_LIMIT_FACTOR = 4;
const DISCARD_TIMEOUT_MS = 5000;

function declaredLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length'];
  if (typeof value !== 'string' || !/^[0-9]{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Läser hela kroppen, högst `maxBytes`. Kastar `too_large` (413) om den är större. */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const discardLimit = maxBytes * DISCARD_LIMIT_FACTOR;
    let received = 0;
    let overLimit = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (outcome: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('close', onClose);
      outcome();
    };

    const giveUpDiscarding = () =>
      settle(() => {
        // Sluta läsa från en avsändare som inte tänker sluta skicka. Svaret bär
        // `Connection: close`, så Node stänger anslutningen när 413 är skrivet.
        request.pause();
        reject(tooLarge());
      });

    const startDiscarding = () => {
      overLimit = true;
      chunks.length = 0;
      timer = setTimeout(giveUpDiscarding, DISCARD_TIMEOUT_MS);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (!overLimit && received > maxBytes) startDiscarding();
      if (!overLimit) {
        chunks.push(chunk);
      } else if (received > discardLimit) {
        giveUpDiscarding();
      }
    };
    const onEnd = () => settle(() => (overLimit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    const onError = () => settle(() => reject(invalidRequest('Förfrågan kunde inte läsas.')));
    const onClose = () => settle(() => reject(invalidRequest('Förfrågan avbröts.')));

    const declared = declaredLength(request);
    if (declared !== undefined && declared > maxBytes) startDiscarding();

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('close', onClose);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Skrivande anrop ska vara JSON. Kravet är också ett CSRF-skydd i sig: ett HTML-formulär kan
 * inte skicka `application/json`, bara `text/plain`, `multipart/form-data` och
 * `application/x-www-form-urlencoded`.
 */
export function assertJsonContentType(request: IncomingMessage): void {
  const value = request.headers['content-type'];
  if (typeof value !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) {
    throw invalidRequest('Innehållet måste skickas som JSON (application/json).');
  }
}

/** Kroppen ska vara exakt `{ "data": { … } }` — se kontraktets beskrivning av HTTP-gränssnittet. */
export function parseDocumentBody(body: Buffer): JsonObject {
  let parsed: unknown;
  try {
    // `fatal` gör att felaktig UTF-8 nekas i stället för att tyst bli ersättningstecken.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    // Fångar även RangeError från extremt djupt nästlad JSON.
    parsed = JSON.parse(text);
  } catch {
    throw invalidRequest('Innehållet är inte giltig JSON.');
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.data)) {
    throw invalidRequest('Innehållet måste vara ett JSON-objekt med fältet "data" som är ett objekt.');
  }
  // Okända fält nekas hellre än ignoreras: ett fält som `appId` eller `scope` i kroppen ska
  // aldrig kunna ge intryck av att betyda något.
  if (Object.keys(parsed).length !== 1) {
    throw invalidRequest('Innehållet får bara ha fältet "data".');
  }
  return parsed.data as JsonObject;
}
