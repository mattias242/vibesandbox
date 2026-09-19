/**
 * Tjänsten `files` för appar (`/_api/files`): ladda upp, lista, visa, ladda ned och ta bort filer.
 *
 *   import { files } from '@vibesandbox/sdk';
 *
 *   const fil = await files.upload(input.files[0]);            // → FileInfo
 *   img.src = files.url(fil.id);                               // bilder visas direkt
 *   const alla = await files.list();                           // gemensamma + mina personliga
 *   await files.remove(fil.id);
 *
 * Anropar tjänsten bara genom `callService`. Dokumentationen för byggagenten står i
 * packages/sdk/tjanster/files.md och visas bara när tjänsten är påslagen.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';

/** En uppladdad fil. Allt sätts av plattformen. */
export interface FileInfo {
  readonly id: string;
  /** Filnamnet, sanerat av plattformen (inga sökvägar, rätt ändelse). */
  readonly name: string;
  /** Typen som plattformen såg i filens innehåll, t.ex. "image/png". */
  readonly contentType: string;
  /** Storlek i byte. */
  readonly size: number;
  /** ISO 8601. */
  readonly createdAt: string;
  /** `userId` för den som laddade upp filen (jämför med `whoami().userId`). */
  readonly uploadedBy: string;
  /** `true`: bara den som laddade upp filen ser den. */
  readonly personal: boolean;
}

export interface UploadOptions {
  /** Filnamnet. Standard: namnet på en `File`, annars "fil". */
  readonly name?: string;
  /** `true`: bara du ser filen. Standard: alla som använder appen ser den. */
  readonly personal?: boolean;
  /** Filtypen. Standard: typen på en `Blob`/`File`. Plattformen kontrollerar den mot innehållet. */
  readonly contentType?: string;
}

const ID_PATTERN = /^[0-9a-f]{32}$/;

function assertId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new SdkError('invalid_request');
}

function isFileInfo(value: unknown): value is FileInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['contentType'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['uploadedBy'] === 'string' &&
    typeof v['personal'] === 'boolean'
  );
}

function expectFileInfo(value: unknown): FileInfo {
  if (!isFileInfo(value)) throw new SdkError('internal');
  return value;
}

/**
 * Laddar upp en fil. Tillåtet: bilder (PNG, JPEG, WebP, GIF), PDF, text och CSV, Word och Excel
 * (docx, xlsx) och ljud (MP3, M4A, WAV, Ogg, WebM). Högst 20 MB (om inget annat är inställt).
 * Kastar `SdkError` — `invalid_request` för fel filtyp, `too_large`, `quota_exceeded` när appens
 * utrymme är fullt — med ett meddelande som går att visa för användaren.
 */
export async function upload(file: Blob | Uint8Array, options: UploadOptions = {}): Promise<FileInfo> {
  let bytes: Uint8Array;
  let type = options.contentType;
  let name = options.name;
  if (file instanceof Uint8Array) {
    bytes = file;
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (type === undefined && file.type !== '') type = file.type;
    const ownName = (file as Blob & { readonly name?: unknown }).name;
    if (name === undefined && typeof ownName === 'string') name = ownName;
  } else {
    throw new SdkError('invalid_request');
  }

  let query = `?name=${encodeURIComponent(name ?? 'fil')}`;
  if (options.personal === true) query += '&personal=true';
  return expectFileInfo(
    await callService('files', 'POST', query, { bytes, contentType: type ?? 'application/octet-stream' }),
  );
}

/** Gemensamma filer och dina personliga, nyaste först (högst 1000). */
export async function list(): Promise<FileInfo[]> {
  const result = await callService('files', 'GET', '');
  const listed = (result as { files?: unknown } | null)?.files;
  if (!Array.isArray(listed) || !listed.every(isFileInfo)) throw new SdkError('internal');
  return listed;
}

/** En fils uppgifter. Kastar `SdkError` med code `not_found` om den inte finns (eller inte är din). */
export async function get(id: string): Promise<FileInfo> {
  assertId(id);
  return expectFileInfo(await callService('files', 'GET', `/${id}`));
}

/**
 * Relativ adress till filens innehåll, för `<img src>`, `<audio src>` eller `<a href download>`.
 * Bilder visas direkt; andra filer laddas ned.
 */
export function url(id: string): string {
  assertId(id);
  return `/_api/files/${id}/content`;
}

/** Filens innehåll som en `Blob`, t.ex. för att läsa en CSV i appen. */
export async function download(id: string): Promise<Blob> {
  assertId(id);
  const result = (await callService('files', 'GET', `/${id}/content`, { expect: 'bytes' })) as {
    bytes: Uint8Array;
    contentType: string;
  };
  return new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.contentType });
}

/** Tar bort filen. Går för den som laddade upp den och för appens ägare. */
export async function remove(id: string): Promise<void> {
  assertId(id);
  await callService('files', 'DELETE', `/${id}`);
}
