/**
 * Plattformstjänsten `llm` (`/_api/llm`): Språkmodell för appar via Berget, med maskning av personuppgifter och tokenkvot per app.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=llm; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
