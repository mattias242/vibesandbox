/**
 * Plattformstjänsten `schedule` (`/_api/schedule`): Schemalagda påminnelser till en apps medlemmar.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=schedule; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
