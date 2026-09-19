/**
 * Tjänstens inställningar ur miljön (`SVC_FILES_…`). Ett felaktigt värde stoppar starten med ett
 * begripligt meddelande — hellre det än att tjänsten tyst kör med en annan gräns än den avsedda.
 */
import { MAX_APP_SERVICE_BODY_BYTES } from '@vibesandbox/contracts';
import { parseClamdAddress } from './clamd.ts';
import type { ClamdAddress } from './clamd.ts';

const MB = 1024 * 1024;
export const DEFAULT_MAX_FILE_MB = 20;
export const DEFAULT_QUOTA_MB = 500;
/** Ett rimlighetstak för kvoten, så att ett skrivfel (t.ex. en nolla för mycket) syns direkt. */
const MAX_QUOTA_MB = 1024 * 1024;

export interface FilesConfig {
  readonly maxFileBytes: number;
  readonly quotaBytes: number;
  /** Saknas ⇒ ingen virusskanning (varnas för i loggen vid start). */
  readonly clamd?: ClamdAddress;
}

function wholeMegabytes(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]{1,7}$/.test(raw.trim())) {
    throw new Error(`${name} ska vara ett heltal (antal megabyte), men är "${raw.slice(0, 40)}".`);
  }
  const value = Number(raw.trim());
  if (value < 1 || value > max) throw new Error(`${name} ska vara mellan 1 och ${max} (megabyte), men är ${value}.`);
  return value;
}

export function readFilesConfig(env: Readonly<Record<string, string | undefined>>): FilesConfig {
  const maxFileMb = wholeMegabytes(env, 'SVC_FILES_MAX_FILE_MB', DEFAULT_MAX_FILE_MB, Math.floor(MAX_APP_SERVICE_BODY_BYTES / MB));
  const quotaMb = wholeMegabytes(env, 'SVC_FILES_QUOTA_MB', DEFAULT_QUOTA_MB, MAX_QUOTA_MB);

  const clamdText = env['SVC_FILES_CLAMD'];
  let clamd: ClamdAddress | undefined;
  if (clamdText !== undefined && clamdText.trim() !== '') {
    const parsed = parseClamdAddress(clamdText);
    if (parsed === null) {
      throw new Error(`SVC_FILES_CLAMD ska vara värd:port för clamd (t.ex. "clamav:3310"), men är "${clamdText.slice(0, 80)}".`);
    }
    clamd = parsed;
  }

  return { maxFileBytes: maxFileMb * MB, quotaBytes: quotaMb * MB, ...(clamd === undefined ? {} : { clamd }) };
}
