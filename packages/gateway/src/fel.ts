/**
 * Gatewayens egna nekanden och översättningen av ALLA fel till ett svar som är tryggt att visa.
 *
 * Varför en egen fil: regeln "originalfelet får aldrig synas i svaret" ska gå att granska på
 * ett ställe. Varje steg i hanteraren nekar genom att kasta `GatewayError`; allt annat som
 * kastas är per definition oväntat och blir 500 med ett fast meddelande.
 */
import { API_ERROR_STATUS, DataApiError } from '@vibesandbox/contracts';
import type { ApiErrorBody, ApiErrorCode } from '@vibesandbox/contracts';

export interface GatewayErrorOptions {
  /** Extra svarshuvuden, t.ex. `Allow` vid 405. Aldrig något som härrör från klienten. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Stäng anslutningen efter svaret — när förfrågans kropp inte lästs klart (413). */
  readonly closeConnection?: boolean;
}

/** Ett medvetet nekande. Meddelandet är klarspråk och skrivs alltid av gatewayn själv. */
export class GatewayError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly closeConnection: boolean;

  constructor(code: ApiErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    // Status härleds ALLTID ur koden, så att kod och status aldrig kan säga olika saker.
    this.status = API_ERROR_STATUS[code];
    this.headers = options.headers ?? {};
    this.closeConnection = options.closeConnection ?? false;
  }
}

const INTERNAL_MESSAGE = 'Något gick fel hos oss. Försök igen om en stund.';

/** Tak för meddelanden som kommer från data-API:t, så att ett fel där inte kan blåsa upp svaret. */
const MAX_FORWARDED_MESSAGE_LENGTH = 300;

export const invalidHost = () => new GatewayError('invalid_request', 'Adressen är inte en giltig appadress.');
export const invalidRequest = (message: string) => new GatewayError('invalid_request', message);
export const appNotFound = () => new GatewayError('not_found', 'Appen finns inte.');
export const notFound = () => new GatewayError('not_found', 'Sidan eller resursen finns inte.');
export const unauthenticated = () => new GatewayError('unauthenticated', 'Du behöver logga in.');
export const forbidden = (message: string) => new GatewayError('forbidden', message);

export const tooLarge = () =>
  new GatewayError('too_large', 'Förfrågan är för stor.', { closeConnection: true });

/** 405 ska enligt HTTP tala om vilka metoder som går; listan är vår egen, aldrig klientens. */
export const methodNotAllowed = (allowed: readonly string[]) =>
  new GatewayError('method_not_allowed', 'Metoden stöds inte för den här adressen.', {
    headers: { Allow: allowed.join(', ') },
  });

export interface Failure {
  readonly status: number;
  readonly body: ApiErrorBody;
  readonly headers: Readonly<Record<string, string>>;
  readonly closeConnection: boolean;
  /** Sant när felet var oväntat och ska loggas som ett fel, inte som ett vanligt nekande. */
  readonly unexpected: boolean;
}

function isKnownCode(code: unknown): code is ApiErrorCode {
  return typeof code === 'string' && Object.hasOwn(API_ERROR_STATUS, code);
}

/**
 * Gör om vad som helst som kastats till ett svar. Okänt ⇒ 500 `internal` med fast text:
 * ett SQLite-fel eller en stackspårning får aldrig nå en app eller en användare.
 */
export function toFailure(error: unknown): Failure {
  if (error instanceof GatewayError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
      headers: error.headers,
      closeConnection: error.closeConnection,
      unexpected: false,
    };
  }

  // Data-API:ts meddelanden är skrivna för slutanvändare (se kontraktet) och får passera —
  // utom för `internal`, där vi hellre säger för lite än litar på att texten är ofarlig.
  if (error instanceof DataApiError && isKnownCode(error.code) && error.code !== 'internal') {
    return {
      status: API_ERROR_STATUS[error.code],
      body: { error: { code: error.code, message: error.message.slice(0, MAX_FORWARDED_MESSAGE_LENGTH) } },
      headers: {},
      closeConnection: false,
      unexpected: false,
    };
  }

  return {
    status: API_ERROR_STATUS.internal,
    body: { error: { code: 'internal', message: INTERNAL_MESSAGE } },
    headers: {},
    closeConnection: false,
    unexpected: true,
  };
}
