/**
 * `POST /_api/extract` `{ fileId }` → `{ text, kind, truncated, hasText, pages?, message? }`.
 *
 * Gatewayn har redan avgjort app, inloggning, åtkomst och CSRF. Filen hämtas ENBART genom
 * `dependencies.files` (tjänsten `files`), som slår upp den inom anroparens app — ett fil-id från
 * en annan app ger `null` och därmed "finns inte". Inget i kroppen avgör vilken app det gäller.
 *
 * Allt arbete sker här inne: filen lämnar aldrig plattformen, ingen leverantör anropas och det
 * kostar ingenting. Kvoterna finns ändå — arbetet kostar tid och minne på servern, och en app
 * som läser samma sak i en slinga ska inte kunna ta hela maskinen.
 *
 * Ordningen är vald så att det som kostar kommer sist: filen hämtas, storleken kontrolleras,
 * typen avgörs ur byten, cachen slås upp — och först därefter packas något upp.
 *
 * Loggen bär aldrig texten, filnamnet eller hela app-id:t.
 */
import { createHash } from 'node:crypto';
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import type {
  ApiErrorBody,
  ApiErrorCode,
  AppService,
  AppServiceDependencies,
  AppServiceInstance,
  AppServiceRequest,
  AppServiceResponse,
} from '@vibesandbox/contracts';
import { looksLikePdf, looksLikeZip, officeKind } from './filtyp.ts';
import type { ExtractKind } from './filtyp.ts';
import { readSettings } from './installningar.ts';
import { openStore } from './lagring.ts';
import type { CacheKey, CachedResult } from './lagring.ts';
import { OfficeError, OfficeTimeout, extractDocx, extractPptx, extractXlsx } from './office.ts';
import { ZipError, openZip } from './zip.ts';
import type { ZipLimits } from './zip.ts';
// Typerna kostar ingenting vid körning (de strippas bort), så pdf.ts laddas inte härifrån.
// Själva läsaren skickas in: tjänsten ska gå att testa utan att PDF-läsaren körs.
import type { PdfLimits, PdfText } from './pdf.ts';

/** Signaturen på `extractPdfText` i ./pdf.ts. Den byggs av en annan del och skickas in. */
export type PdfReader = (bytes: Uint8Array, limits: PdfLimits) => PdfText | null;

export interface ExtractServiceOptions {
  /** PDF-läsaren. Fabriken i index.ts skickar in `extractPdfText`; testerna skickar en fejk. */
  readonly pdf?: PdfReader;
}

/** Kroppen är ett litet JSON-objekt; filen hämtar tjänsten själv. */
const MAX_BODY_BYTES = 4096;

/** Fil-id som `files` ger ut. Aldrig `..`, snedstreck, NUL eller något som kan bli en sökväg. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['fileId']);

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

const MESSAGES = {
  badRequest: 'Begäran ska vara JSON med fältet fileId.',
  notFound: 'Filen finns inte.',
  methodNotAllowed: 'Texthämtning anropas med POST.',
  unsupportedType:
    'Det går inte att hämta text ur den här filen. Det fungerar för Word (docx), Excel (xlsx), PowerPoint (pptx) och PDF.',
  broken: 'Filen går inte att läsa. Den kan vara skadad eller sparad i ett äldre format — spara om den och försök igen.',
  fileTooLarge: 'Filen är för stor för att hämta text ur.',
  unpackedTooLarge: 'Filen innehåller mer än vad som går att läsa på en gång. Dela upp den och försök igen.',
  tooSlow: 'Det tog för lång tid att läsa filen. Dela upp den och försök igen.',
  appLimit: 'Appen har nått sin gräns för texthämtning i dag. Försök igen senare.',
  userLimit: 'Du har nått din gräns för texthämtning den här timmen. Försök igen om en stund.',
  noPdfReader: 'PDF går inte att läsa i den här versionen av plattformen.',
  scanned:
    'Filen innehåller ingen text att hämta. Den är troligen inskannad, alltså en bild av ett papper. Använd tjänsten för att läsa text i bilder i stället.',
  empty: 'Filen innehåller ingen text att hämta.',
} as const;

function json(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function error(code: ApiErrorCode, message: string, status: number = API_ERROR_STATUS[code]): AppServiceResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return json(status, body);
}

function parseBody(request: AppServiceRequest): string | undefined {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' || request.body === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // Ett okänt fält (t.ex. ett appId någon hoppas att tjänsten läser) gör hela begäran ogiltig.
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  const { fileId } = record;
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) return undefined;
  return fileId;
}

function body(result: CachedResult): unknown {
  return {
    text: result.text,
    kind: result.kind,
    truncated: result.truncated,
    hasText: result.hasText,
    ...(result.pages === undefined ? {} : { pages: result.pages }),
    ...(result.hasText ? {} : { message: result.kind === 'pdf' ? MESSAGES.scanned : MESSAGES.empty }),
  };
}

function result(kind: ExtractKind, text: string, truncated: boolean, pages?: number): CachedResult {
  return { text, kind, truncated, hasText: text !== '', ...(pages === undefined ? {} : { pages }) };
}

export function createExtractService(dependencies: AppServiceDependencies, options: ExtractServiceOptions = {}): AppServiceInstance {
  const reader = dependencies.files;
  if (reader === undefined) {
    throw new Error('Tjänsten extract kräver tjänsten files — slå på båda: APP_SERVICES=files,extract.');
  }
  const settings = readSettings(dependencies.env);
  const zipLimits: ZipLimits = {
    maxEntries: settings.maxZipEntries,
    maxUnpackedBytes: settings.maxUnpackedBytes,
    maxExpansion: settings.maxExpansion,
  };
  const store = openStore(dependencies.dataDir);
  const { log, now } = dependencies;
  const files = reader;
  const pdf = options.pdf;

  /** Läser filen. Kastar `ZipError`, `OfficeError` eller `OfficeTimeout` — inget annat når appen. */
  function extract(kind: ExtractKind, bytes: Uint8Array, deadline: number): CachedResult {
    if (kind === 'pdf') {
      if (pdf === undefined) throw new OfficeError(MESSAGES.noPdfReader);
      const limits: PdfLimits = {
        maxBytes: settings.maxFileBytes,
        maxPages: settings.maxPdfPages,
        maxChars: settings.maxChars,
        maxMs: settings.timeoutMs,
      };
      let text: PdfText | null;
      try {
        text = pdf(bytes, limits);
      } catch {
        // Allt PDF-läsaren kastar är "den här filen går inte att läsa". Skälet stannar här.
        throw new OfficeError(MESSAGES.broken);
      }
      // `null` = inget textlager: filen är inskannad och det finns ingen text att hämta.
      if (text === null) return result('pdf', '', false);
      return result('pdf', text.text, text.truncated, text.pages);
    }

    const zip = openZip(bytes, zipLimits);
    const limits = { maxChars: settings.maxChars, deadline };
    if (kind === 'docx') {
      const text = extractDocx(zip, limits);
      return result('docx', text.text, text.truncated);
    }
    if (kind === 'xlsx') {
      const text = extractXlsx(zip, limits);
      return result('xlsx', text.text, text.truncated);
    }
    const text = extractPptx(zip, limits);
    return result('pptx', text.text, text.truncated, text.pages);
  }

  /** Vilken sorts fil det är, ur filens egna byte. `null` ⇒ ingen tjänsten kan läsa. */
  function identify(bytes: Uint8Array): ExtractKind | null {
    if (looksLikePdf(bytes)) return 'pdf';
    if (!looksLikeZip(bytes)) return null;
    // Kan kasta ZipError (trasigt eller för stort arkiv) — det är ett tydligare besked än "okänd typ".
    return officeKind(openZip(bytes, zipLimits).names());
  }

  async function handle(request: AppServiceRequest): Promise<AppServiceResponse> {
    if (request.segments.length > 0) return error('not_found', 'Det finns inget här.');
    if (request.method !== 'POST') return error('method_not_allowed', MESSAGES.methodNotAllowed);
    const fileId = parseBody(request);
    if (fileId === undefined) return error('invalid_request', MESSAGES.badRequest);

    const { tenant, identity } = request;
    const app = tenant.appId.slice(0, 8);
    const file = await files.read(tenant, fileId);
    // Också när texten redan finns i cachen: en borttagen fil finns inte.
    if (file === null) return error('not_found', MESSAGES.notFound);
    if (file.body.byteLength === 0) return error('invalid_request', MESSAGES.unsupportedType);
    if (file.body.byteLength > settings.maxFileBytes) return error('too_large', MESSAGES.fileTooLarge);

    let kind: ExtractKind | null;
    try {
      kind = identify(file.body);
    } catch (failure) {
      return failed(failure, app, tenant.kind);
    }
    if (kind === null) return error('invalid_request', MESSAGES.unsupportedType);

    const key: CacheKey = {
      appId: tenant.appId,
      kind: tenant.kind,
      fileId,
      sha256: createHash('sha256').update(file.body).digest('hex'),
    };
    const cached = store.getCached(key, now().getTime());
    if (cached !== undefined) {
      log({ level: 'info', event: 'extract_read', app, kind: tenant.kind, format: cached.kind, cached: true, chars: cached.text.length });
      return json(200, body(cached));
    }

    // Kontroll och reservation i samma synkrona steg (se lagring.ts).
    const reserved = store.reserve(tenant.appId, identity.userId, settings, now().getTime());
    if (!reserved.ok) {
      log({ level: 'info', event: 'extract_limit', app, kind: tenant.kind, limit: reserved.limit });
      return error('rate_limited', reserved.limit === 'app_day' ? MESSAGES.appLimit : MESSAGES.userLimit);
    }

    const started = Date.now();
    let extracted: CachedResult;
    try {
      extracted = extract(kind, file.body, started + settings.timeoutMs);
    } catch (failure) {
      // Ett misslyckat anrop kostar ingen kvot.
      store.release(reserved.reservation);
      return failed(failure, app, tenant.kind);
    }

    store.putCached(key, extracted, now().getTime());
    log({
      level: 'info',
      event: 'extract_read',
      app,
      kind: tenant.kind,
      format: extracted.kind,
      cached: false,
      chars: extracted.text.length,
      truncated: extracted.truncated,
      ms: Date.now() - started,
    });
    return json(200, body(extracted));
  }

  /** Gör ett fel under läsningen till ett svar. Inget av det som kastades når appen. */
  function failed(failure: unknown, app: string, kind: string): AppServiceResponse {
    if (failure instanceof ZipError) {
      log({ level: 'info', event: 'extract_rejected', app, kind, reason: failure.failure });
      return failure.failure === 'too_large'
        ? error('too_large', MESSAGES.unpackedTooLarge)
        : error('invalid_request', MESSAGES.broken);
    }
    if (failure instanceof OfficeTimeout) {
      log({ level: 'warn', event: 'extract_timeout', app, kind });
      return error('too_large', MESSAGES.tooSlow);
    }
    if (failure instanceof OfficeError) {
      log({ level: 'info', event: 'extract_rejected', app, kind, reason: 'broken' });
      return error('invalid_request', MESSAGES.broken);
    }
    throw failure;
  }

  const service: AppService = {
    name: 'extract',
    maxBodyBytes: MAX_BODY_BYTES,
    handle,
    async close() {
      store.close();
    },
  };
  return { service };
}
