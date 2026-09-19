/**
 * Plattformstjänsten `ocr` (`/_api/ocr`): Textigenkänning (OCR) i uppladdade filer via Berget.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=ocr; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
