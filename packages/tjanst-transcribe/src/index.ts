/**
 * Plattformstjänsten `transcribe` (`/_api/transcribe`): Tal till text för uppladdade ljudfiler via Berget.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=transcribe; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
