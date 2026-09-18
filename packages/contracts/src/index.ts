/**
 * Delade kontrakt mellan plattformens moduler.
 *
 * Här finns bara typer, konstanter och rena valideringsfunktioner — ingen I/O och inga
 * beroenden. Allt som passerar en gräns mellan paket eller mellan webbläsare och server
 * beskrivs här, så att paketen kan byggas och testas var för sig.
 */

// ── Hyresgäst (app) ─────────────────────────────────────────────────────────────

/**
 * Ett app-id är samtidigt den hemliga delen av delningslänken: 26 tecken Crockford-base32
 * i gemener = 130 bitar slump. Ingår i värdnamnet och får därför bara innehålla [a-z0-9].
 */
export type AppId = string & { readonly __brand: 'AppId' };

export const APP_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function isAppId(value: string): value is AppId {
  return APP_ID_PATTERN.test(value);
}

/**
 * `published` är en granskad, publicerad version. `draft` är byggarens förhandsvisning:
 * ogranskad kod som därför ALDRIG får dela data med den publicerade appen.
 */
export type TenantKind = 'published' | 'draft';

declare const tenantContextBrand: unique symbol;

/**
 * Bevis på att en förfrågan hör till en viss app. Får BARA skapas av gatewayn, ur ett
 * strikt validerat `Host`-huvud — aldrig ur något klienten skickar i sökväg, fråga eller
 * kropp. Varumärkningen gör att övriga paket inte kan fabricera ett värde av misstag.
 */
export interface TenantContext {
  readonly [tenantContextBrand]: true;
  readonly appId: AppId;
  readonly kind: TenantKind;
}

/** Enda vägen att skapa ett TenantContext. Importeras endast av @vibesandbox/gateway. */
export function unsafeCreateTenantContext(appId: AppId, kind: TenantKind): TenantContext {
  return { appId, kind } as TenantContext;
}

// ── Identitet ───────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'builder' | 'viewer';

export interface Identity {
  /** Stabilt, ogenomskinligt id. Används för `user`-scope och i pseudonymiserade loggar. */
  readonly userId: string;
  /** Finns bara i control-databasen och i identitetsobjektet — aldrig i driftloggar. */
  readonly email: string;
  readonly roles: readonly Role[];
}

/** Det gatewayn ger en identitetsleverantör att arbeta med. Inga Node-typer här. */
export interface AuthRequest {
  readonly host: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Utbytbar inloggning: `test` (endast utanför produktion), `email-otp`, senare `oidc`.
 * `null` betyder "inte inloggad" — gatewayn ska då neka (fail-closed), aldrig gissa.
 */
export interface IdentityProvider {
  readonly name: string;
  authenticate(request: AuthRequest): Promise<Identity | null>;
}

// ── Data-API: dokument ──────────────────────────────────────────────────────────

/**
 * `app`: alla som får öppna appen ser alla dokument.
 * `user`: varje användare ser bara sina egna dokument. Verkställs av servern.
 * Scope bestäms när kollektionen skapas och kan sedan inte ändras.
 */
export type CollectionScope = 'app' | 'user';

export const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const DOCUMENT_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export interface StoredDocument {
  readonly id: string;
  readonly data: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentPage {
  readonly documents: readonly StoredDocument[];
  /** Skickas tillbaka som `cursor` för nästa sida; saknas när listan är slut. */
  readonly nextCursor?: string;
}

/** Gränser som gäller varje app. Kvoterna skyddar värden och de andra apparna. */
export interface TenantLimits {
  readonly maxDocumentBytes: number;
  readonly maxDatabaseBytes: number;
  readonly maxCollections: number;
  readonly maxPageSize: number;
}

export const DEFAULT_TENANT_LIMITS: TenantLimits = {
  maxDocumentBytes: 256 * 1024,
  maxDatabaseBytes: 50 * 1024 * 1024,
  maxCollections: 50,
  maxPageSize: 100,
};

// ── Data-API: HTTP-gränssnitt (det SDK:t talar med) ─────────────────────────────

/**
 * Alla anrop går till appens EGEN origin under detta prefix. Appen anger aldrig vilket
 * app-id den tillhör — det avgörs av värdnamnet.
 *
 *   GET    /_api/whoami
 *   GET    /_api/collections/:name/docs?scope=app|user&limit=&cursor=
 *   POST   /_api/collections/:name/docs?scope=app|user      { data }
 *   GET    /_api/collections/:name/docs/:id
 *   PUT    /_api/collections/:name/docs/:id                 { data }
 *   DELETE /_api/collections/:name/docs/:id
 */
export const API_PREFIX = '/_api';

/** Skrivande anrop måste bära detta huvud; enkelt skydd mot CSRF via formulär. */
export const CSRF_HEADER = 'x-vibesandbox-request';

export interface WhoAmIResponse {
  readonly userId: string;
  /** Visningsnamn härlett ur e-postadressens lokala del; aldrig hela adressen. */
  readonly displayName: string;
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'scope_mismatch'
  | 'quota_exceeded'
  | 'too_large'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    /** Klarspråk på svenska, tryggt att visa för slutanvändare. Inga interna detaljer. */
    readonly message: string;
  };
}

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  scope_mismatch: 409,
  quota_exceeded: 507,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

// ── Data-API: det gatewayn anropar ──────────────────────────────────────────────

/**
 * Lagringsgränssnittet som @vibesandbox/data-api implementerar och gatewayn anropar.
 * Varje metod kräver ett TenantContext; det finns inget sätt att nå data utan ett.
 * Fel signaleras med `DataApiError`.
 */
export interface TenantStore {
  listDocuments(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    scope: CollectionScope,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<DocumentPage>;

  createDocument(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    scope: CollectionScope,
    data: JsonObject,
  ): Promise<StoredDocument>;

  getDocument(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    id: string,
  ): Promise<StoredDocument>;

  replaceDocument(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    id: string,
    data: JsonObject,
  ): Promise<StoredDocument>;

  deleteDocument(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    id: string,
  ): Promise<void>;

  /** Raderar ALL data för en hyresgäst. Används vid avveckling. */
  destroyTenant(tenant: TenantContext): Promise<void>;

  /** Stänger öppna databashandtag. Anropas vid nedstängning och i tester. */
  close(): Promise<void>;
}

export class DataApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'DataApiError';
    this.code = code;
  }
}

// ── Säkerhetshuvuden ────────────────────────────────────────────────────────────

/**
 * CSP för appinnehåll. Sätts av gatewayn på varje svar från en app-origin; appen kan
 * inte påverka den. `connect-src 'self'` är det som hindrar genererad kod från att
 * skicka data till en extern adress.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "manifest-src 'none'",
].join('; ');

// ── Appregister och appfiler (det gatewayn behöver veta om en app) ──────────────

export interface RegisteredApp {
  readonly appId: AppId;
  /** Finns en granskad, publicerad version att servera? */
  readonly published: boolean;
  /** Finns ett utkast att förhandsvisa? */
  readonly draft: boolean;
}

/** Implementeras av control-modulen. Okänt app-id ⇒ `null` ⇒ gatewayn svarar 404. */
export interface AppRegistry {
  find(appId: AppId): Promise<RegisteredApp | null>;
}

export interface AppFile {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * Appens byggda, statiska filer. `path` är redan normaliserad av gatewayn, börjar med `/`
 * och innehåller inga `..`-segment. `null` ⇒ filen finns inte.
 */
export interface AppFiles {
  read(tenant: TenantContext, path: string): Promise<AppFile | null>;
}
