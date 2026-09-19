/**
 * Plattformstjänsten `roles` (`/_api/roles`): Roller inuti en app, definierade av appen och tilldelade av ägaren.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=roles; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
