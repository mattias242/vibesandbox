/**
 * Plattformstjänsten `notify` (`/_api/notify`): Aviseringar via mejl till en apps medlemmar — aldrig till godtyckliga adresser.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=notify; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
