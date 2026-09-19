/**
 * Plattformstjänsten `files` (`/_api/files`): filer och bilagor för appar — uppladdning,
 * nedladdning, kvot per app och allowlista för filtyper, med valfri virusskanning (ClamAV).
 * Slås på med `APP_SERVICES=files`.
 *
 * Inställningar (alla valfria):
 *   SVC_FILES_MAX_FILE_MB  största fil, heltal MB (standard 20, högst 25)
 *   SVC_FILES_QUOTA_MB     utrymme per app och hyresgästsort, heltal MB (standard 500)
 *   SVC_FILES_CLAMD        värd:port till clamd; saknas ⇒ ingen virusskanning (varning i loggen)
 *
 * Fabriken delar också med sig av en `AppFileReader`, som OCR och tal till text läser filer genom.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { createClamdScanner } from './clamd.ts';
import { readFilesConfig } from './config.ts';
import { openFileStore } from './lagring.ts';
import { createFilesService } from './tjanst.ts';

export type { FileInfo, FilesFileReader } from './tjanst.ts';

export const factory: AppServiceFactory = (dependencies) => {
  const config = readFilesConfig(dependencies.env);
  const scanner = config.clamd === undefined ? undefined : createClamdScanner(config.clamd);
  if (scanner === undefined) {
    dependencies.log({ level: 'warn', event: 'virus_scan_disabled', reason: 'SVC_FILES_CLAMD saknas; uppladdade filer virusskannas inte.' });
  }
  const store = openFileStore(dependencies.dataDir);
  return createFilesService(dependencies, config, store, scanner);
};
