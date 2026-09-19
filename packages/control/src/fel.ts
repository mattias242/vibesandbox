/**
 * Fel från control-modulen. Koden är till för anroparen (CLI, kommande byggverktyg); meddelandet
 * är klarspråk på svenska och innehåller aldrig sökvägar på servern — bara namn ur byggarens
 * eget bygge, som hen behöver för att kunna rätta felet.
 */
export type ControlErrorCode =
  | 'app_not_found'
  | 'version_not_found'
  | 'import_rejected'
  | 'access_rejected'
  | 'invalid_tenant'
  | 'closed'
  | 'internal';

export class ControlError extends Error {
  readonly code: ControlErrorCode;

  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}
