/**
 * `POST /_api/ocr` `{ fileId, language?: 'sv'|'en' }` → `{ text, pages?: [{ number, text }] }`.
 *
 * Gatewayn har redan avgjort app, inloggning, åtkomst och CSRF. Filen hämtas ENBART genom
 * `dependencies.files` (tjänsten `files`), som slår upp den inom anroparens app — ett fil-id från
 * en annan app ger `null` och därmed "finns inte". Inget i kroppen avgör vilken app det gäller.
 *
 * Ordningen är vald så att det som kostar kommer sist: filen kontrolleras (typ ur byten, storlek,
 * upplösning), sedan cachen, sedan kvoten — och först därefter skickas något till Berget.
 *
 * Dataskydd: bilden kan inte maskeras innan den skickas. Berget är plattformens godkända svenska
 * personuppgiftsbiträde; appens byggare uppmanas i dokumentationen att inte skicka känsliga
 * dokument i onödan. Texten som kommer tillbaka är appens egen data och maskeras inte — men den
 * och filen hamnar aldrig i loggen.
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
import { identifyFile } from './filtyp.ts';
import { DOCUMENT_ENGINE, readSettings } from './installningar.ts';
import { openStore } from './lagring.ts';
import type { CacheKey, CachedResult } from './lagring.ts';
import { OcrProviderError, createDocumentEngine, createVisionEngine } from './motor.ts';
import type { OcrEngine, OcrLanguage } from './motor.ts';

export interface OcrServiceOptions {
  /** Bara för tester. */
  readonly fetch?: typeof fetch;
}

/** Kroppen är ett litet JSON-objekt; filen hämtas av tjänsten själv. */
const MAX_BODY_BYTES = 4096;

/** Fil-id som `files` ger ut. Aldrig `..`, snedstreck, NUL eller något som kan bli en sökväg. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const LANGUAGES: ReadonlySet<string> = new Set(['sv', 'en']);
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['fileId', 'language']);

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

const MESSAGES = {
  badRequest: 'Begäran ska vara JSON med fältet fileId (och eventuellt language: "sv" eller "en").',
  notFound: 'Filen finns inte.',
  methodNotAllowed: 'Textigenkänning anropas med POST.',
  unsupportedType: 'Filtypen stöds inte. Textigenkänning fungerar för bilder i PNG, JPEG, WebP och för PDF.',
  pdfNotSupported: 'PDF kan inte läsas med den här plattformens inställning. Ladda upp sidorna som bilder (PNG, JPEG eller WebP) i stället.',
  fileTooLarge: 'Filen är för stor för textigenkänning.',
  imageTooLarge: 'Bilden har för hög upplösning för textigenkänning. Förminska den och försök igen.',
  tooManyPages: 'PDF-filen har för många sidor för textigenkänning. Dela upp den och försök igen.',
  appLimit: 'Appen har nått sin gräns för textigenkänning i dag. Försök igen senare.',
  userLimit: 'Du har nått din gräns för textigenkänning den här timmen. Försök igen senare.',
  unavailable: 'Textigenkänningen är inte tillgänglig just nu. Försök igen om en stund.',
} as const;

function json(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function error(code: ApiErrorCode, message: string, status: number = API_ERROR_STATUS[code]): AppServiceResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return json(status, body);
}

type Parsed = { readonly fileId: string; readonly language: OcrLanguage } | undefined;

function parseBody(request: AppServiceRequest): Parsed {
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
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  const { fileId, language } = record;
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) return undefined;
  if (language !== undefined && (typeof language !== 'string' || !LANGUAGES.has(language))) return undefined;
  return { fileId, language: (language ?? 'sv') as OcrLanguage };
}

function result(cached: CachedResult): unknown {
  return cached.pages === undefined ? { text: cached.text } : { text: cached.text, pages: cached.pages };
}

export function createOcrService(dependencies: AppServiceDependencies, options: OcrServiceOptions = {}): AppServiceInstance {
  const reader = dependencies.files;
  if (reader === undefined) {
    throw new Error('Tjänsten ocr kräver tjänsten files — slå på båda: APP_SERVICES=files,ocr.');
  }
  const berget = dependencies.berget;
  if (berget === undefined) {
    throw new Error('Tjänsten ocr kräver Berget — ange Bergets nyckel i plattformens konfiguration.');
  }
  const settings = readSettings(dependencies.env);
  const engineOptions = {
    baseUrl: berget.baseUrl,
    apiKey: berget.apiKey,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    fetch: options.fetch ?? fetch,
  };
  const engine: OcrEngine = settings.model === DOCUMENT_ENGINE ? createDocumentEngine(engineOptions) : createVisionEngine(engineOptions);
  const store = openStore(dependencies.dataDir);
  const { log, now } = dependencies;
  const files = reader;

  async function handle(request: AppServiceRequest): Promise<AppServiceResponse> {
    if (request.segments.length > 0) return error('not_found', 'Det finns inget här.');
    if (request.method !== 'POST') return error('method_not_allowed', MESSAGES.methodNotAllowed);
    const parsed = parseBody(request);
    if (parsed === undefined) return error('invalid_request', MESSAGES.badRequest);

    const { tenant, identity } = request;
    const app = tenant.appId.slice(0, 8);
    const file = await files.read(tenant, parsed.fileId);
    if (file === null) return error('not_found', MESSAGES.notFound);
    if (file.body.byteLength > settings.maxFileBytes) return error('too_large', MESSAGES.fileTooLarge);

    const identified = identifyFile(file.body);
    if (identified === null) return error('invalid_request', MESSAGES.unsupportedType);
    let pages: number;
    if (identified.kind === 'image') {
      if (identified.width * identified.height > settings.maxPixels) return error('too_large', MESSAGES.imageTooLarge);
      pages = 1;
    } else {
      if (!engine.acceptsPdf) return error('invalid_request', MESSAGES.pdfNotSupported);
      if (identified.estimatedPages > settings.maxPdfPages) return error('too_large', MESSAGES.tooManyPages);
      pages = identified.estimatedPages;
    }

    const key: CacheKey = {
      appId: tenant.appId,
      kind: tenant.kind,
      fileId: parsed.fileId,
      language: parsed.language,
      sha256: createHash('sha256').update(file.body).digest('hex'),
    };
    const cached = store.getCached(key, now().getTime());
    if (cached !== undefined) {
      log({ level: 'info', event: 'ocr_read', app, kind: tenant.kind, cached: true, pages: 0 });
      return json(200, result(cached));
    }

    // Kontroll och reservation i samma synkrona steg (se lagring.ts).
    const reserved = store.reserve(tenant.appId, identity.userId, pages, settings, now().getTime());
    if (!reserved.ok) {
      log({ level: 'info', event: 'ocr_limit', app, kind: tenant.kind, limit: reserved.limit });
      return error('rate_limited', reserved.limit === 'app_day' ? MESSAGES.appLimit : MESSAGES.userLimit);
    }

    const started = Date.now();
    let output;
    try {
      output = await engine.read({ bytes: file.body, file: identified, language: parsed.language });
    } catch (failure) {
      store.release(reserved.reservation);
      if (!(failure instanceof OcrProviderError)) throw failure;
      log({
        level: 'warn',
        event: 'ocr_provider_error',
        app,
        engine: engine.name,
        failure: failure.failure,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
      return error('unavailable', MESSAGES.unavailable, 503);
    }

    store.settle(reserved.reservation, Math.max(pages, output.pageCount));
    const stored: CachedResult = output.pages === undefined ? { text: output.text } : { text: output.text, pages: output.pages };
    store.putCached(key, stored, now().getTime());
    log({
      level: 'info',
      event: 'ocr_read',
      app,
      kind: tenant.kind,
      cached: false,
      engine: engine.name,
      pages: Math.max(pages, output.pageCount),
      ms: Date.now() - started,
    });
    return json(200, result(stored));
  }

  const service: AppService = {
    name: 'ocr',
    maxBodyBytes: MAX_BODY_BYTES,
    handle,
    async close() {
      store.close();
    },
  };
  return { service };
}
