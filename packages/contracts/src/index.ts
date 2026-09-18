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

  /**
   * Rutter under `AUTH_PREFIX` på en apps EGEN värd, som körs FÖRE inloggningskontrollen —
   * det är här en värd byter en engångsbiljett mot sin egen host-only-kaka. `null` ⇒ rutten
   * finns inte (404). Leverantören får aldrig se eller påverka vilken app förfrågan hör till.
   *
   * Krav på implementationen: omdirigera bara till relativa sökvägar på samma värd (ingen
   * öppen omdirigering), sätt aldrig `Domain=` på en kaka och alltid `HttpOnly`, och läck inget
   * ur förfrågan i svaret. Gatewayn verkställer detta och svarar 500 om en leverantör bryter mot det.
   *
   * Det gatewayn INTE kan verkställa, och som därför är leverantörens ansvar:
   * - Rutterna körs före gatewayns CSRF-kontroll. En POST-rutt måste själv kräva att `origin`
   *   är exakt den förväntade värden — `SameSite` skyddar inte mellan subdomäner.
   * - En inloggningsbiljett i adressen ska vara ENGÅNGS, kortlivad och BUNDEN TILL DEN WEBBLÄSARE
   *   som begärde den (t.ex. via en tillståndskaka). Annars kan en syskonapp navigera offret till
   *   appens inloggningsrutt med ANGRIPARENS biljett, så att offret skriver sina uppgifter i
   *   angriparens personliga data (inloggnings-CSRF / sessionsfixering).
   * - Utloggning ska inte kunna utlösas av en ren länk.
   * - Riktiga leverantörer använder kakor med `__Host-`-prefix och `Secure`; de kan inte planteras
   *   av en syskonvärd.
   */
  handleAuthRoute?(request: AuthRouteRequest): Promise<AuthRouteResponse | null>;
}

/** Sökvägsprefix för inloggningsrutter på en apps egen värd. Appkod kan inte ha filer här. */
export const AUTH_PREFIX = '/_auth';

export interface AuthRouteRequest extends AuthRequest {
  readonly method: string;
  /** Normaliserad sökväg, börjar med `AUTH_PREFIX`. */
  readonly path: string;
  /** Frågeparametrar. En parameter som förekommer flera gånger ger 400 innan leverantören anropas. */
  readonly query: Readonly<Record<string, string>>;
}

export interface AuthRouteResponse {
  readonly status: number;
  /**
   * Gatewayns skyddshuvuden ligger alltid kvar; dessa läggs till men kan inte ersätta dem.
   * Bara en liten allowlist släpps igenom (`Location`, `Set-Cookie`, `Content-Type`, `Allow`).
   * `Set-Cookie` får vara en lista — kakor kan inte slås ihop med komma.
   */
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string;
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

/**
 * Största tillåtna förfrågningskropp. Gatewayn avbryter läsningen när gränsen passeras
 * (413) i stället för att buffra hela kroppen. Större än `maxDocumentBytes` med marginal,
 * så att ett för stort dokument ger det begripligare felet `too_large` från data-API:t.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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
  | 'method_not_allowed'
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
  method_not_allowed: 405,
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
 *
 * Ordning: `listDocuments` ger dokumenten i skapandeordning, äldst först. Ordningen är stabil
 * mellan sidor och mellan anrop.
 *
 * Regler för scope:
 * - En kollektion skapas — och dess scope låses — vid första `createDocument`. ENDAST då.
 * - En läsning skapar eller låser aldrig något: `listDocuments` mot en kollektion som inte
 *   finns ger en tom sida oavsett angivet scope. (Annars kunde en användare låsa en kollektion
 *   som gemensam innan appen hunnit skapa den som personlig.)
 * - `listDocuments`/`createDocument` med annat scope än det låsta ⇒ `scope_mismatch`.
 * - `getDocument`/`replaceDocument`/`deleteDocument` tar inget scope; det härleds ur
 *   kollektionens låsta scope. I en `user`-kollektion ger någon annans dokument `not_found`
 *   (aldrig `forbidden` — existensen ska inte röjas).
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
 *
 * KRAV på implementationen: slå upp `path` som en EXAKT nyckel i ett manifest över de filer
 * bygget producerade — bygg aldrig en disksökväg av den. Gatewayn tillåter Unicode-bokstäver i
 * segment, och en kompatibilitetsnormalisering (NFKC) gör t.ex. `．．` till `..`. Normalisera
 * därför aldrig `path`; en sökväg som inte finns ordagrant i manifestet ger `null`.
 */
export interface AppFiles {
  read(tenant: TenantContext, path: string): Promise<AppFile | null>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Byggverktyget
// ═══════════════════════════════════════════════════════════════════════════════
//
// Flödet: en användare skriver vad appen ska göra → agenten ber språkmodellen om HELA
// källfiler → byggkedjan kontrollerar (policy, typer) och bygger dem i en sandlåda utan nät →
// fel matas tillbaka till modellen i några varv → ett grönt bygge blir appens UTKAST, som
// förhandsvisas på `p-<appId>.<BASE_DOMAIN>` → användaren publicerar.

/** Byggverktygets värd: `bygg.<BASE_DOMAIN>`. Kan aldrig krocka med ett app-id (26 tecken). */
export const BUILDER_HOST_LABEL = 'bygg';

// ── Språkmodell ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly signal?: AbortSignal;
  /** Anropas med varje ny textbit när leverantören strömmar — för framstegsvisning, inte för tolkning. */
  readonly onText?: (chunk: string) => void;
}

export interface CompletionResult {
  readonly text: string;
  /** `length` ⇒ svaret kapades och får ALDRIG tolkas som komplett. */
  readonly finishReason: 'stop' | 'length' | 'other';
  /** Kan saknas hos vissa leverantörer; räkna då själv som reserv. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Modellens fullständiga id som faktiskt svarade — till AI-registret. */
  readonly model: string;
}

/**
 * Utbytbar leverantör: `complete(messages) → text`. Inget beroende av leverantörens verktygsanrop
 * (tool calling), som är den största felkällan hos öppna modeller. Leverantören ansvarar för
 * PII-maskning FAIL-CLOSED av användarens text innan något lämnar servern.
 */
export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// ── Byggkedjan ──────────────────────────────────────────────────────────────────

/** Appens egna källfiler: sökväg (`src/…`) → innehåll. Mallens filer ingår INTE och vinner alltid. */
export type SourceFiles = Readonly<Record<string, string>>;

export interface Diagnostic {
  /** `policy` = otillåtet innehåll eller filnamn; `typecheck` = TypeScript; `build` = Vite. */
  readonly source: 'policy' | 'typecheck' | 'build';
  readonly file?: string;
  readonly line?: number;
  /** Kort och konkret — matas tillbaka till modellen. Inga absoluta sökvägar från värden. */
  readonly message: string;
}

export interface BuildResult {
  readonly ok: boolean;
  /**
   * Katalog med byggda filer, redo för `control.importVersion`. Finns bara när `ok`.
   * Katalogen tillhör anroparen tills `dispose` anropas.
   */
  readonly outputDirectory?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
  dispose(): Promise<void>;
}

/**
 * Bygger appens källfiler tillsammans med den låsta mallen. Ordning: policy → typkontroll →
 * bygge → kontroll av det byggda. Opålitlig kod: i drift sker allt i en engångscontainer utan nät.
 * Högst ETT bygge åt gången (VPS XS); fler köas.
 */
export interface BuildRunner {
  build(files: SourceFiles, options?: { readonly signal?: AbortSignal }): Promise<BuildResult>;
}

// ── Agenten ─────────────────────────────────────────────────────────────────────

/** Framsteg under en tur, i klarspråk. Visas för användaren och sparas med jobbet. */
export type AgentEvent =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'progress'; readonly outputChars: number }
  | { readonly type: 'files'; readonly paths: readonly string[] }
  | { readonly type: 'check'; readonly ok: boolean; readonly problems: number }
  | { readonly type: 'done'; readonly ok: boolean; readonly message: string };

export interface ConversationEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface AgentTurnInput {
  /** Det användaren just bad om. */
  readonly request: string;
  /** Tidigare önskemål och svar i samma app — ALDRIG appens körtidsdata. */
  readonly history: readonly ConversationEntry[];
  /** Appens nuvarande källfiler (senaste gröna). Tom för en ny app. */
  readonly currentFiles: SourceFiles;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface AgentTurnResult {
  readonly ok: boolean;
  /** Vid `ok`: de nya källfilerna. Annars de oförändrade `currentFiles`. */
  readonly files: SourceFiles;
  /** Vid `ok`: det gröna bygget. Anroparen importerar och anropar sedan `dispose`. */
  readonly build?: BuildResult;
  /** Klarspråk till användaren: vad som gjordes, eller varför det inte gick. */
  readonly summary: string;
  readonly rounds: number;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface Agent {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

// ── Byggverktygets värd i gatewayn ──────────────────────────────────────────────

/**
 * Det gatewayn lämnar till byggverktyget för ALLA förfrågningar på `bygg.<BASE_DOMAIN>`, utom
 * `/_auth/…` — EFTER skyddshuvuden, formkontroll, service worker-spärr, inloggning och en STRIKT
 * CSRF-kontroll (skrivande metoder kräver skyddshuvudet OCH `Origin` exakt lika med byggverktygets
 * origin; `SameSite` skyddar inte mellan subdomäner, mätt i spik S1).
 */
export interface PlatformRequest {
  readonly method: string;
  /** Normaliserad av gatewayn, börjar med `/`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Högst `MAX_REQUEST_BODY_BYTES`. */
  readonly body?: Uint8Array;
  readonly identity: Identity;
}

export interface PlatformResponse {
  readonly status: number;
  /** Bara `Content-Type` och `Cache-Control` släpps igenom; skyddshuvudena vinner alltid. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface BuilderHandler {
  handle(request: PlatformRequest): Promise<PlatformResponse>;
}

/**
 * CSP för byggverktyget. Förhandsvisningen ramas in från `frame-src`, som gatewayn fyller i med
 * mönstret för förhandsvisningsvärdar (`<schema>://*.<BASE_DOMAIN>[:port]`). Byggverktyget självt
 * får aldrig ramas in av någon.
 */
export function builderContentSecurityPolicy(previewFrameSource: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${previewFrameSource}`,
    "frame-ancestors 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

// ── Byggverktygets HTTP-gränssnitt (det builder-ui talar med) ───────────────────
//
// Allt under `/_api/builder` på byggverktygets egen origin. Kräver rollen `builder` eller `admin`.
// En app som inte ägs av den som frågar "finns inte" (404) — existensen röjs aldrig.
// Skrivande anrop: skyddshuvudet `CSRF_HEADER: 1` och exakt `Origin`.
//
//   GET  /_api/builder/me                          → BuilderMe
//   GET  /_api/builder/apps                        → { apps: BuilderAppSummary[] }
//   POST /_api/builder/apps        { name? }       → 201 { appId }
//   GET  /_api/builder/apps/:appId                 → BuilderAppDetail
//   POST /_api/builder/apps/:appId/messages { text } → 202 { jobId }   (409 om ett jobb redan pågår)
//   GET  /_api/builder/jobs/:jobId?after=<n>       → BuilderJob  (händelser från index n)
//   POST /_api/builder/apps/:appId/publish         → { publishedUrl }  (409 om inget grönt utkast)
//   GET  /_api/builder/apps/:appId/open?target=preview|published → { url }
//        Absolut adress som loggar in webbläsaren på den värden och landar på `/`.
//
// Övriga sökvägar på byggverktygets värd serverar byggverktygets egna statiska filer (SPA).

export const BUILDER_API_PREFIX = '/_api/builder';

export interface BuilderMe {
  readonly displayName: string;
  readonly canBuild: boolean;
}

export interface BuilderAppSummary {
  readonly appId: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly hasDraft: boolean;
  readonly published: boolean;
}

export interface BuilderMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
}

export type BuilderJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface BuilderAppDetail extends BuilderAppSummary {
  readonly messages: readonly BuilderMessage[];
  /** Pågående eller senaste jobb, så att en omladdad sida kan fortsätta följa det. */
  readonly job?: { readonly jobId: string; readonly status: BuilderJobStatus };
}

export interface BuilderJob {
  readonly jobId: string;
  readonly appId: string;
  readonly status: BuilderJobStatus;
  readonly events: readonly AgentEvent[];
  /** Skicka som `after` i nästa anrop. */
  readonly next: number;
}
