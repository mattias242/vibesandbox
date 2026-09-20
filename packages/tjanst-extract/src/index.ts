/**
 * Plattformstjänsten `extract` (`/_api/extract`): text ur uppladdade filer — Word, Excel,
 * PowerPoint och PDF med textlager. Allt görs på servern: ingen fil och ingen text lämnar
 * plattformen, det kostar ingenting och det fungerar utan nyckel hos någon leverantör.
 *
 * Slås på med `APP_SERVICES=files,extract` — filerna läses genom tjänsten `files`, så den måste
 * vara på. Se tjanst.ts för flödet, zip.ts och office.ts för Office-filerna och pdf.ts för PDF.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { createExtractService } from './tjanst.ts';
import { extractPdfText } from './pdf.ts';

export const factory: AppServiceFactory | undefined = (dependencies) => createExtractService(dependencies, { pdf: extractPdfText });
