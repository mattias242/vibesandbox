/**
 * Plattformstjänsten `ocr` (`/_api/ocr`): textigenkänning i uppladdade filer via Berget.
 * Slås på med APP_SERVICES=files,ocr — filerna läses genom tjänsten `files`, så den måste vara på.
 * Se tjanst.ts för flödet och motor.ts för motorerna hos Berget.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { createOcrService } from './tjanst.ts';

export const factory: AppServiceFactory | undefined = (dependencies) => createOcrService(dependencies);
