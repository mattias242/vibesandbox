/**
 * Plattformstjänsten `history` (`/_api/history`): Ändringshistorik för appars dokument: vem ändrade vad och när.
 * Under uppbyggnad. Tjänsten slås på med APP_SERVICES=history; innan den är klar finns ingen fabrik
 * och plattformen vägrar starta med den påslagen.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';

export const factory: AppServiceFactory | undefined = undefined;
