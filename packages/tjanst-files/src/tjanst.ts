/**
 * Förfrågningarna till `/_api/files`. Gatewayn har redan avgjort hyresgäst, inloggning, åtkomst
 * och CSRF; här avgörs bara vad just den här användaren får se och göra med just den här filen.
 *
 *   GET    /_api/files                          → { files: FileInfo[] }  (gemensamma + mina personliga)
 *   POST   /_api/files?name=<namn>[&personal=true]  (råa byte) → 201 FileInfo
 *   GET    /_api/files/:id                      → FileInfo
 *   GET    /_api/files/:id/content              → innehållet (bilder inline, annat som bilaga)
 *   DELETE /_api/files/:id                      → 204  (den som laddade upp, eller appens ägare)
 *
 * En fil som användaren inte får se — en annan apps, utkastets, någon annans personliga — "finns
 * inte" (404), med exakt samma svar som ett id som aldrig funnits.
 */
import { createHash } from 'node:crypto';
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppFileReader,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  TenantContext,
} from '@vibesandbox/contracts';
import { ClamdUnavailableError } from './clamd.ts';
import type { VirusScanner } from './clamd.ts';
import type { FilesConfig } from './config.ts';
import { asciiFileName, sanitizeFileName } from './filnamn.ts';
import { ALLOWED_TYPES_TEXT, checkFileType } from './filtyper.ts';
import { newRandomId } from './lagring.ts';
import type { FileStore, StoredFile } from './lagring.ts';

/** Det appen får veta om en fil. */
export interface FileInfo {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly createdAt: string;
  /** Användar-id:t för den som laddade upp filen (samma som `whoami().userId`). */
  readonly uploadedBy: string;
  readonly personal: boolean;
}

/**
 * Läsaren som andra tjänster (OCR, tal till text) får. `read` följer kontraktet och ger bara
 * GEMENSAMMA filer: kontraktet säger inte vem som frågar, och en personlig fil får aldrig nå någon
 * annan än den som laddade upp den. `readForUser` läser också användarens egna personliga filer —
 * för en tjänst som vet vem som frågar (se rapporten om en utökning av kontraktet).
 */
export interface FilesFileReader extends AppFileReader {
  readForUser(
    tenant: TenantContext,
    userId: string,
    fileId: string,
  ): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly name: string } | null>;
}

/** Ett rimligt tak för namnet i frågesträngen innan det saneras och kortas. */
const MAX_RAW_NAME_LENGTH = 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const NO_STORE = 'private, no-store';

const MESSAGES = {
  notFound: 'Filen finns inte, eller så har den tagits bort.',
  methodNotAllowed: 'Det här går inte att göra med en fil.',
  empty: 'Filen är tom.',
  badQuery: 'Uppladdningen innehöll ogiltiga uppgifter. Försök igen.',
  nameTooLong: 'Filnamnet är för långt.',
  unsupported: `Den här typen av fil går inte att ladda upp. Det som går är ${ALLOWED_TYPES_TEXT}.`,
  mismatch: 'Filens innehåll stämmer inte med filtypen. Kontrollera att det är rätt fil och försök igen.',
  tooLarge: (mb: number) => `Filen är för stor. Den får vara högst ${mb} MB.`,
  quota: 'Appens utrymme för filer är fullt. Ta bort filer som inte behövs och försök igen.',
  virus: 'Filen innehåller skadlig kod och sparades inte.',
  scanUnavailable: 'Filen kunde inte kontrolleras mot virus just nu och sparades inte. Försök igen om en stund.',
  forbidden: 'Bara den som laddade upp filen, eller appens ägare, kan ta bort den.',
} as const;

function json(status: number, body: unknown): AppServiceResponse {
  return { status, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': NO_STORE }, body: JSON.stringify(body) };
}

function error(code: ApiErrorCode, message: string): AppServiceResponse {
  return json(API_ERROR_STATUS[code], { error: { code, message } });
}

function info(file: StoredFile): FileInfo {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    createdAt: file.createdAt,
    uploadedBy: file.uploadedBy,
    personal: file.scope === 'user',
  };
}

/** Får användaren se filen? En personlig fil ser bara den som laddade upp den — inte ens ägaren. */
function visibleTo(file: StoredFile, userId: string): boolean {
  return file.scope === 'app' || file.uploadedBy === userId;
}

/** Frågesträngen; en parameter som förekommer två gånger gör hela frågan ogiltig. */
function parseQuery(query: string): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(query)) {
    if (result.has(key)) return null;
    result.set(key, value);
  }
  return result;
}

export interface FilesServiceParts {
  readonly service: AppService;
  readonly fileReader: FilesFileReader;
}

export function createFilesService(
  dependencies: AppServiceDependencies,
  config: FilesConfig,
  store: FileStore,
  scanner: VirusScanner | undefined,
): FilesServiceParts {
  const appTag = (tenant: TenantContext): string => tenant.appId.slice(0, 8);

  async function upload(request: AppServiceRequest): Promise<AppServiceResponse> {
    const query = parseQuery(request.query);
    if (query === null) return error('invalid_request', MESSAGES.badQuery);
    const personal = query.get('personal');
    if (personal !== undefined && personal !== 'true' && personal !== 'false') return error('invalid_request', MESSAGES.badQuery);
    const rawName = query.get('name') ?? '';
    if (rawName.length > MAX_RAW_NAME_LENGTH) return error('invalid_request', MESSAGES.nameTooLong);

    const body = request.body ?? new Uint8Array(0);
    // Gatewayn har redan nekat större kroppar; kontrollen här gör tjänsten säker även utan den.
    if (body.length > config.maxFileBytes) return error('too_large', MESSAGES.tooLarge(config.maxFileBytes / (1024 * 1024)));
    const checked = checkFileType(body, request.headers['content-type']);
    if (!checked.ok) {
      return error('invalid_request', checked.reason === 'empty' ? MESSAGES.empty : checked.reason === 'mismatch' ? MESSAGES.mismatch : MESSAGES.unsupported);
    }

    // Tidig kontroll, så att en full app inte skannar och skriver 20 MB i onödan. Den som avgör
    // görs ändå först när raden skrivs (se insertWithinQuota).
    if (store.usedBytes(request.tenant) + body.length > config.quotaBytes) return error('quota_exceeded', MESSAGES.quota);

    if (scanner !== undefined) {
      try {
        const result = await scanner.scan(body);
        if (!result.clean) {
          dependencies.log({ level: 'warn', event: 'virus_found', app: appTag(request.tenant), signature: result.signature });
          return error('invalid_request', MESSAGES.virus);
        }
      } catch (cause) {
        if (!(cause instanceof ClamdUnavailableError)) throw cause;
        dependencies.log({ level: 'error', event: 'virus_scan_unavailable', app: appTag(request.tenant) });
        return error('internal', MESSAGES.scanUnavailable);
      }
    }

    const storageKey = await store.writeContent(body);
    const file: StoredFile = {
      id: newRandomId(),
      appId: request.tenant.appId,
      kind: request.tenant.kind,
      scope: personal === 'true' ? 'user' : 'app',
      uploadedBy: request.identity.userId,
      name: sanitizeFileName(rawName, checked.type),
      contentType: checked.type.contentType,
      size: body.length,
      storageKey,
      sha256: createHash('sha256').update(body).digest('hex'),
      createdAt: dependencies.now().toISOString(),
    };
    let outcome: 'ok' | 'quota';
    try {
      outcome = store.insertWithinQuota(file, config.quotaBytes);
    } catch (cause) {
      await store.deleteContent(storageKey);
      throw cause;
    }
    if (outcome === 'quota') {
      await store.deleteContent(storageKey);
      return error('quota_exceeded', MESSAGES.quota);
    }
    dependencies.log({
      level: 'info',
      event: 'file_uploaded',
      app: appTag(request.tenant),
      kind: request.tenant.kind,
      size: file.size,
      contentType: file.contentType,
      personal: file.scope === 'user',
    });
    return json(201, info(file));
  }

  /** Innehållet, eller `null` om filen togs bort medan förfrågan pågick. */
  async function readContentIfPresent(file: StoredFile): Promise<Uint8Array | null> {
    try {
      return await store.readContent(file.storageKey);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  }

  async function content(file: StoredFile): Promise<AppServiceResponse> {
    const body = await readContentIfPresent(file);
    if (body === null) return error('not_found', MESSAGES.notFound);
    const disposition = `${file.contentType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${asciiFileName(file.name)}"`;
    return {
      status: 200,
      headers: { 'Content-Type': file.contentType, 'Content-Disposition': disposition, 'Cache-Control': NO_STORE },
      body,
    };
  }

  async function remove(request: AppServiceRequest, file: StoredFile): Promise<AppServiceResponse> {
    if (file.uploadedBy !== request.identity.userId && request.access !== 'owner') return error('forbidden', MESSAGES.forbidden);
    const removed = store.remove(request.tenant, file.id);
    if (removed !== undefined) {
      await store.deleteContent(removed.storageKey);
      dependencies.log({ level: 'info', event: 'file_deleted', app: appTag(request.tenant), kind: request.tenant.kind, size: removed.size });
    }
    return { status: 204, headers: {} };
  }

  async function handle(request: AppServiceRequest): Promise<AppServiceResponse> {
    const { method, segments } = request;
    const reading = method === 'GET' || method === 'HEAD';

    if (segments.length === 0) {
      if (reading) return json(200, { files: store.list(request.tenant, request.identity.userId).map(info) });
      if (method === 'POST') return upload(request);
      return error('method_not_allowed', MESSAGES.methodNotAllowed);
    }

    const [id = '', sub, ...rest] = segments;
    if (rest.length > 0 || (sub !== undefined && sub !== 'content')) return error('not_found', MESSAGES.notFound);
    const file = store.find(request.tenant, id);
    if (file === undefined || !visibleTo(file, request.identity.userId)) return error('not_found', MESSAGES.notFound);

    if (sub === 'content') return reading ? content(file) : error('method_not_allowed', MESSAGES.methodNotAllowed);
    if (reading) return json(200, info(file));
    if (method === 'DELETE') return remove(request, file);
    return error('method_not_allowed', MESSAGES.methodNotAllowed);
  }

  async function readVisible(tenant: TenantContext, userId: string | undefined, fileId: string) {
    const file = store.find(tenant, fileId);
    if (file === undefined) return null;
    if (file.scope === 'user' && (userId === undefined || file.uploadedBy !== userId)) return null;
    const body = await readContentIfPresent(file);
    return body === null ? null : { body, contentType: file.contentType, name: file.name };
  }

  return {
    service: {
      name: 'files',
      maxBodyBytes: config.maxFileBytes,
      handle,
      async close() {
        store.close();
      },
    },
    fileReader: {
      read: (tenant, fileId) => readVisible(tenant, undefined, fileId),
      readForUser: (tenant, userId, fileId) => readVisible(tenant, userId, fileId),
    },
  };
}
