/**
 * Plattformstjänsten `files` (`/_api/files`): Filer och bilagor för appar: uppladdning, nedladdning, kvot per app och allowlista för filtyper.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=files; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
