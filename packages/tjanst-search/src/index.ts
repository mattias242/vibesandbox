/**
 * Plattformstjänsten `search` (`/_api/search`): Semantisk sökning i en apps dokument med embeddings från Berget.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=search; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
