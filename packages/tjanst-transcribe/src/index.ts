/**
 * Plattformstjänsten `transcribe` (`/_api/transcribe`): tal till text för uppladdade ljudfiler via
 * Berget. Slås på med APP_SERVICES=files,transcribe — den läser ljudet genom tjänsten `files`.
 *
 * Inställningar (alla valfria):
 *   SVC_TRANSCRIBE_MODEL                modell hos Berget (standard KBLab/kb-whisper-large)
 *   SVC_TRANSCRIBE_CONCURRENCY          utskrifter samtidigt, alla appar (standard 2)
 *   SVC_TRANSCRIBE_RETENTION_DAYS       dagar ett resultat sparas (standard 7)
 *   SVC_TRANSCRIBE_MINUTES_PER_APP_DAY  ljudminuter per app och dygn (standard 120)
 *   SVC_TRANSCRIBE_MAX_FILE_BYTES       största fil (standard och tak: Bergets 100 MB)
 *   SVC_TRANSCRIBE_TIMEOUT_SECONDS      längsta väntan på Berget (standard 31 minuter)
 *
 * Dataskydd: ljud går inte att maskera. Det skickas bara till Berget, plattformens godkända svenska
 * personuppgiftsbiträde, och den som spelar in ansvarar för att de inspelade har informerats.
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { readConfig } from './konfig.ts';
import { createTranscribeService } from './tjanst.ts';

export const factory: AppServiceFactory = (dependencies) => {
  if (dependencies.files === undefined) {
    throw new Error('Tjänsten transcribe läser ljudet genom tjänsten files. Slå på den också: APP_SERVICES=files,transcribe.');
  }
  if (dependencies.berget === undefined) {
    throw new Error('Tjänsten transcribe behöver Berget för att göra om tal till text, men ingen nyckel till Berget är inställd.');
  }
  const config = readConfig(dependencies.env);
  return { service: createTranscribeService(dependencies, dependencies.files, dependencies.berget, config) };
};
