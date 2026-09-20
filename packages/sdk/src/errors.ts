import type { ApiErrorCode } from '@vibesandbox/contracts';

/** Plattformens felkoder, plus `network` för när plattformen inte gick att nå alls. */
export type SdkErrorCode = ApiErrorCode | 'network';

/**
 * Alla fel från SDK:t. `message` är klarspråk på svenska och går att visa för användaren
 * som det är. Använd `code` om appen ska göra olika saker vid olika fel.
 */
export class SdkError extends Error {
  readonly code: SdkErrorCode;

  constructor(code: SdkErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'SdkError';
    this.code = code;
  }
}

/** Används när plattformen inte skickade ett eget meddelande. Inga interna detaljer här. */
export const DEFAULT_MESSAGES: Readonly<Record<SdkErrorCode, string>> = {
  unauthenticated: 'Du är inte inloggad. Logga in och försök igen.',
  forbidden: 'Du har inte behörighet att göra det här.',
  not_found: 'Det du letar efter finns inte, eller så har det tagits bort.',
  method_not_allowed: 'Det här går inte att göra på det sättet.',
  invalid_request: 'Begäran är ogiltig. Kontrollera uppgifterna och försök igen.',
  scope_mismatch: 'Kollektionen har en annan synlighet (gemensam eller personlig) än den som angavs.',
  quota_exceeded: 'Appens lagringsutrymme är slut. Ta bort något och försök igen.',
  too_large: 'Det du försöker spara är för stort.',
  rate_limited: 'Det blev för många anrop på kort tid. Vänta en stund och försök igen.',
  internal: 'Något gick fel hos plattformen. Försök igen om en stund.',
  unavailable: 'Tjänsten svarar inte just nu. Försök igen om en stund.',
  network: 'Det gick inte att nå plattformen. Kontrollera din anslutning och försök igen.',
};
