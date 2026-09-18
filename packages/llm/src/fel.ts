/**
 * Fel från språkmodellsleverantören.
 *
 * Meddelandet är alltid en av de fasta texterna nedan — aldrig något som kommit från
 * leverantören. Skälet: leverantörens felkroppar kan eka tillbaka prompten (med användarens
 * text) och i värsta fall rubriker med nyckeln. Därför sätts heller aldrig `cause`: ett
 * ursprungligt fel kan bära samma sak vidare till loggar.
 */

export type LlmErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'bad_response'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'masking_failed'
  | 'config'
  | 'script_exhausted';

const MESSAGES: Readonly<Record<LlmErrorCode, string>> = {
  auth: 'Språkmodellen nekade åtkomst. Plattformens nyckel till språkmodellen behöver kontrolleras.',
  rate_limited: 'Språkmodellen har för många förfrågningar just nu. Försök igen om en stund.',
  unavailable: 'Språkmodellen svarar inte just nu. Försök igen om en stund.',
  bad_request: 'Språkmodellen kunde inte ta emot förfrågan. Inställningarna för språkmodellen behöver kontrolleras.',
  bad_response: 'Språkmodellen gav ett svar som inte gick att läsa. Försök igen.',
  network: 'Förbindelsen med språkmodellen bröts. Försök igen.',
  timeout: 'Språkmodellen tog för lång tid på sig. Försök igen, gärna med ett mindre önskemål.',
  aborted: 'Arbetet med språkmodellen avbröts.',
  masking_failed: 'Texten kunde inte kontrolleras för personuppgifter, så inget skickades till språkmodellen.',
  config: 'Språkmodellen är inte rätt inställd på servern.',
  script_exhausted: 'Den inspelade språkmodellen har inga fler svar.',
};

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** HTTP-status från leverantören, när felet kom därifrån. */
  readonly status: number | undefined;

  constructor(code: LlmErrorCode, options: { readonly status?: number } = {}) {
    super(MESSAGES[code]);
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status;
  }
}
