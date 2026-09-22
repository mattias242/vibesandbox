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
  /** Värdnamnet UTAN port, härlett ur gatewayns värdnamnstolkning. Porten finns i `headers.host`. */
  readonly host: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * Klientens adress enligt TCP-anslutningen till plattformen (bakom en omvänd proxy: proxyns
   * adress). Aldrig ur `X-Forwarded-For` — ett huvud går att förfalska. För hastighetsbegränsning.
   */
  readonly clientAddress?: string;
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

  /**
   * Sidan under `AUTH_PREFIX` där en webbläsare loggar in på DEN HÄR värden (t.ex. `/_auth/login`).
   * Finns den skickar gatewayn en oinloggad SIDNAVIGERING (inte ett API-anrop) dit med 303 och
   * `?next=<relativ sökväg>`, i stället för att svara 401. Inloggning sker per värd: varje värd får
   * sin egen host-only-kaka, så en app ser aldrig en annan värds session.
   */
  readonly loginPath?: string;
}

/** Sökvägsprefix för inloggningsrutter på en apps egen värd. Appkod kan inte ha filer här. */
export const AUTH_PREFIX = '/_auth';

export interface AuthRouteRequest extends AuthRequest {
  readonly method: string;
  /** Normaliserad sökväg, börjar med `AUTH_PREFIX`. */
  readonly path: string;
  /** Frågeparametrar. En parameter som förekommer flera gånger ger 400 innan leverantören anropas. */
  readonly query: Readonly<Record<string, string>>;
  /**
   * Förfrågningskroppen, rå. Finns bara vid POST. Gatewayn läser den med ett litet tak
   * (`MAX_AUTH_BODY_BYTES`, 413 annars) och tolkar den inte — leverantören tolkar t.ex.
   * `application/x-www-form-urlencoded` själv och kontrollerar `Content-Type`.
   */
  readonly body?: Uint8Array;
}

/** Största kropp till en inloggningsrutt. Ett formulär med e-postadress eller kod ryms med marginal. */
export const MAX_AUTH_BODY_BYTES = 8 * 1024;

/**
 * Statuskoder en inloggningsrutt får svara med. Gatewayn gör allt annat till 500.
 * 403 behövs: leverantören nekar själv POST utan exakt rätt `Origin` (rutterna körs före CSRF-steget).
 */
export const AUTH_ROUTE_STATUSES: readonly number[] = [200, 303, 400, 401, 403, 404, 405, 413, 429];

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
  | 'internal'
  /** En plattformstjänst når inte sin leverantör just nu (t.ex. språkmodellen). Försök igen senare. */
  | 'unavailable';

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
  unavailable: 503,
};

// ── Data-API: det gatewayn anropar ──────────────────────────────────────────────

/** Händelserna i ändringshistoriken (tjänsten `history`). */
export type HistoryEvent = 'create' | 'replace' | 'delete' | 'restore';

/** En rad i ändringshistoriken. Bär användar-id, aldrig e-postadress. */
export interface HistoryEntry {
  readonly collection: string;
  readonly documentId: string;
  readonly event: HistoryEvent;
  /** ISO-tid, samma värde som dokumentets `updatedAt` efter ändringen. */
  readonly at: string;
  /** Den inloggade som gjorde ändringen. */
  readonly userId: string;
  /** Innehållet EFTER ändringen; vid `delete` innehållet dokumentet hade innan det raderades. */
  readonly data: JsonObject;
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  /** Skickas tillbaka som `cursor` för nästa (äldre) sida; saknas när historiken är slut. */
  readonly nextCursor?: string;
}

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

  /**
   * Ändringshistorik (tjänsten `history`). Metoderna FINNS bara när lagringen skapats med
   * historiken påslagen; annars saknas de, och tjänsten vägrar starta.
   *
   * Historiken skrivs av lagringen själv, i samma transaktion som ändringen: en ändring som
   * sparas har alltid en rad, och en ändring som misslyckas har aldrig någon. Synlighet som för
   * dokumenten: i en `user`-kollektion ser var och en bara historiken för sina egna dokument
   * (någon annans ⇒ `not_found`), i en `app`-kollektion ser alla. Nyast först.
   */
  readDocumentHistory?(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    id: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<HistoryPage>;

  /** Kollektionens händelser, nyast först; `since` (ISO-tid) ger bara det som hänt efter den. */
  readCollectionHistory?(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    options?: { readonly since?: string; readonly limit?: number; readonly cursor?: string },
  ): Promise<HistoryPage>;

  /**
   * Skriver dokumentets innehåll från historikraden med exakt tiden `at` som en ny version
   * (händelsen `restore`, som i sin tur loggas). Samma skrivregler som `replaceDocument`; ett
   * raderat dokument återskapas med samma id. Ingen sådan rad ⇒ `not_found`; en rad som är en
   * radering ⇒ `invalid_request`.
   */
  restoreDocument?(
    tenant: TenantContext,
    identity: Identity,
    collection: string,
    id: string,
    at: string,
  ): Promise<StoredDocument>;

  /**
   * Allt den HÄR användaren får se i appen, kollektion för kollektion. Exporten respekterar
   * synligheten: en `user`-kollektion ger bara hennes egna rader. Se `exportDocuments` i
   * data-api om varför det inte får vara på något annat sätt.
   */
  exportTenant(
    tenant: TenantContext,
    identity: Identity,
    options: { readonly maxDocumentsPerCollection: number },
  ): Promise<{
    readonly collections: Readonly<Record<string, { readonly documents: readonly JsonObject[]; readonly truncated: boolean }>>;
    readonly documentCount: number;
  }>;

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

/**
 * Vad en användare får göra med en app. Ägaren (den som byggde appen) når både utkast och
 * publicerad version; en användare (den som fått appen delad med sig) bara den publicerade.
 * Plattformens roller (`Role`) ger ingen åtkomst till någon app — inte heller `admin`.
 */
export type AppAccessRole = 'owner' | 'user';

/** Implementeras av control-modulen. Okänt app-id ⇒ `null` ⇒ gatewayn svarar 404. */
export interface AppRegistry {
  find(appId: AppId): Promise<RegisteredApp | null>;
  /**
   * Användarens roll i appen, eller `null` om hen saknar åtkomst (eller appen inte finns).
   * Gatewayn frågar vid VARJE förfrågan: en borttagen åtkomst gäller direkt, även för en
   * pågående session. Saknad åtkomst ger samma svar som en app som inte finns.
   */
  accessFor(appId: AppId, userId: string): Promise<AppAccessRole | null>;
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

/**
 * Sökvägar som appens kod får ha. EN regel, använd av både agentens tolk och byggkedjans policy.
 * Bara ASCII (å/ä/ö i filnamn ger normaliseringsfel mellan macOS och Linux), bara .ts/.tsx/.css,
 * inga punktfiler — och därmed ingen `tsconfig.json`, `package.json` eller `*.config.*` i `src/`,
 * som annars kunde påverka bygget.
 */
export const SOURCE_PATH_PATTERN = /^src\/(?:[A-Za-z0-9_-]+\/){0,4}[A-Za-z0-9_-]+\.(?:tsx|ts|css)$/;

/** Filer som mallen äger. Appens kod får inte skriva dem; mallens version vinner alltid. */
export const TEMPLATE_OWNED_SOURCE_PATHS: readonly string[] = ['src/main.tsx'];

export function isAllowedSourcePath(path: string): boolean {
  return SOURCE_PATH_PATTERN.test(path) && !TEMPLATE_OWNED_SOURCE_PATHS.includes(path);
}

export interface Diagnostic {
  /** `policy` = otillåtet innehåll eller filnamn; `typecheck` = TypeScript; `build` = Vite. */
  readonly source: 'policy' | 'typecheck' | 'build';
  /** Policyregelns id (t.ex. `external-url`), så att agenten kan förklara brottet i klarspråk. */
  readonly rule?: string;
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

/** Högst så många fel följer med en kontrollhändelse. */
export const MAX_EVENT_DIAGNOSTICS = 10;
/** Ett fels meddelande kortas till så många tecken i en kontrollhändelse. */
export const MAX_EVENT_DIAGNOSTIC_CHARS = 300;

/** Framsteg under en tur, i klarspråk. Visas för användaren och sparas med jobbet. */
export type AgentEvent =
  | { readonly type: 'status'; readonly message: string }
  | { readonly type: 'progress'; readonly outputChars: number }
  | { readonly type: 'files'; readonly paths: readonly string[] }
  /**
   * `diagnostics` bara när kontrollen underkänner: de viktigaste felen (högst
   * `MAX_EVENT_DIAGNOSTICS`, meddelandena högst `MAX_EVENT_DIAGNOSTIC_CHARS` tecken). Sparas med
   * jobbet och visas under "Visa detaljer" — hamnar aldrig i driftloggen.
   */
  | { readonly type: 'check'; readonly ok: boolean; readonly problems: number; readonly diagnostics?: readonly Diagnostic[] }
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

// ── Plattformstjänster för appar ────────────────────────────────────────────────
//
// Appar når inte internet. Det en app behöver utöver sin egen kod — filer, aviseringar,
// språkmodell, OCR … — är plattformstjänster under `/_api/<namn>/…` på appens egen värd.
// Gatewayn har redan avgjort hyresgäst (ur värdnamnet), inloggning, åtkomst till appen
// (`AppAccessRole`), skyddshuvudena och CSRF (skrivande metoder kräver `CSRF_HEADER`) innan
// tjänsten anropas. En tjänst litar aldrig på något app-id i sökväg, fråga eller kropp.
// Tjänster slås på var för sig i plattformens konfiguration (flagga); en avslagen tjänst
// finns inte (404), så att `main` alltid går att driftsätta.

/** Namn en tjänst inte får ta: data-API:ts egna rutter och byggverktyget. */
export const RESERVED_APP_SERVICE_NAMES: ReadonlySet<string> = new Set(['whoami', 'collections', 'builder', 'auth']);

/** Tjänstens namn är det första segmentet efter `/_api`. */
export const APP_SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/** Övre gräns för en tjänsts förfrågningskropp, oavsett vad tjänsten själv begär. */
export const MAX_APP_SERVICE_BODY_BYTES = 25 * 1024 * 1024;

export interface AppServiceRequest {
  readonly method: string;
  /** Segmenten EFTER `/_api/<namn>`, normaliserade av gatewayn (inga `..`, ingen tom del). */
  readonly segments: readonly string[];
  /** Frågesträngen utan `?`. En parameter som förekommer flera gånger ska tjänsten neka. */
  readonly query: string;
  /** Gemena huvudnamn. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Hela kroppen, högst tjänstens `maxBodyBytes` (större ⇒ 413 innan tjänsten anropas). */
  readonly body?: Uint8Array;
  readonly tenant: TenantContext;
  readonly identity: Identity;
  /** Användarens roll i appen, redan kontrollerad av gatewayn. */
  readonly access: AppAccessRole;
}

export interface AppServiceResponse {
  readonly status: number;
  /**
   * Bara `Content-Type`, `Cache-Control` och `Content-Disposition` släpps igenom; plattformens
   * skyddshuvuden (CSP, nosniff …) vinner alltid. Fel svaras som `ApiErrorBody` i JSON.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface AppService {
  /** Matchar `APP_SERVICE_NAME_PATTERN` och finns inte i `RESERVED_APP_SERVICE_NAMES`. */
  readonly name: string;
  /** Största kropp tjänsten tar emot; högst `MAX_APP_SERVICE_BODY_BYTES`. */
  readonly maxBodyBytes: number;
  handle(request: AppServiceRequest): Promise<AppServiceResponse>;
  /** Stängs när plattformen stängs (bakgrundsjobb, databaser). */
  close?(): Promise<void>;
}

/**
 * Appens åtkomstlista för tjänster som behöver veta vilka som hör till appen (aviseringar,
 * roller i appen). Implementeras av control. E-postadressen lämnas bara ut till tjänster,
 * aldrig till appens kod.
 */
export interface AppMemberDirectory {
  members(appId: AppId): Promise<readonly { readonly userId: string; readonly role: AppAccessRole; readonly email: string | null }[]>;
}

/**
 * Uppladdade filer, som andra tjänster (OCR, tal till text) läser. Implementeras av tjänsten
 * `files`. Filen slås upp inom `tenant` — ett fil-id från en annan app ger `null`.
 */
export interface AppFileReader {
  read(tenant: TenantContext, fileId: string): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly name: string } | null>;
}

/** Mejl ut från plattformen (Mailgun EU i drift, en utkorg i test). Adressen loggas aldrig. */
export interface AppMailer {
  send(message: { readonly to: string; readonly subject: string; readonly text: string }): Promise<void>;
}

/**
 * Aviseringar till en apps medlemmar. Implementeras av tjänsten `notify`; används också av
 * `schedule`. Mottagarna är ALLTID medlemmar i appen — aldrig en godtycklig adress.
 */
export interface AppNotifier {
  notify(
    appId: AppId,
    message: {
      /** Användar-id bland appens medlemmar, eller `'all'`/`'owner'`. Okända id hoppas över. */
      readonly to: readonly string[] | 'all' | 'owner';
      readonly subject: string;
      readonly text: string;
    },
  ): Promise<{ readonly sent: number }>;
}

/** Det plattformen ger en tjänst när den skapas. Allt utom `name`/`dataDir`/`log`/`now` kan saknas. */
export interface AppServiceDependencies {
  /** Tjänstens egen katalog (`<DATA_DIR>/services/<namn>`), skapad av plattformen. */
  readonly dataDir: string;
  /**
   * Miljövariablerna. En tjänst läser bara sina egna (`SVC_<NAMN>_…`) och kastar vid start
   * med ett begripligt meddelande om något saknas.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (entry: { readonly level: 'info' | 'warn' | 'error'; readonly event: string } & Readonly<Record<string, string | number | boolean>>) => void;
  readonly now: () => Date;
  readonly members: AppMemberDirectory;
  readonly store: TenantStore;
  /** Berget (OpenAI-kompatibelt API). Saknas om ingen nyckel är inställd. */
  readonly berget?: { readonly baseUrl: string; readonly apiKey: string };
  readonly mailer?: AppMailer;
  /** Finns när tjänsten `files` är påslagen. */
  readonly files?: AppFileReader;
  /** Finns när tjänsten `notify` är påslagen. */
  readonly notifier?: AppNotifier;
  /** Plattformens adresser, t.ex. för länkar i mejl. */
  readonly publishedUrl: (appId: AppId) => string;
}

/** Det en tjänstefabrik ger tillbaka. `files` och `notify` delar med sig till andra tjänster. */
export interface AppServiceInstance {
  readonly service: AppService;
  readonly fileReader?: AppFileReader;
  readonly notifier?: AppNotifier;
}

/**
 * Synkron: plattformen skapas synkront och ett konfigurationsfel ska synas vid start. Det som
 * måste vänta (nätverk, uppvärmning) görs vid första förfrågan. Kastar ⇒ plattformen startar inte.
 */
export type AppServiceFactory = (dependencies: AppServiceDependencies) => AppServiceInstance;

/**
 * Alla tjänster plattformen känner till, i den ordning de skapas (en tjänst kan bara använda
 * det som skapats före den). Namnet är också sökvägen: `/_api/<namn>`.
 */
export const APP_SERVICE_NAMES = ['files', 'notify', 'roles', 'llm', 'extract', 'ocr', 'history', 'schedule', 'transcribe', 'search'] as const;
export type AppServiceName = (typeof APP_SERVICE_NAMES)[number];

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
//   POST /_api/builder/apps/:appId/namn { name }   → { name }
//        Ägaren döper sin app. Namnet är hennes eget val och ersätter plattformens avskrift av det
//        första önskemålet — och till skillnad från avskriften följer det med till kontrollrummet
//        och granskningskön. Går att ändra hur många gånger som helst. Ett tomt namn är inget namn
//        (400): vägen tillbaka till plattformens avskrift finns inte, och ska inte finnas.
//   GET  /_api/builder/jobs/:jobId?after=<n>       → BuilderJob  (händelser från index n)
//   POST /_api/builder/apps/:appId/publish         → { publishedUrl }  (409 om inget grönt utkast)
//   GET  /_api/builder/apps/:appId/open?target=preview|published → { url }
//        Absolut adress som loggar in webbläsaren på den värden och landar på `/`.
//   POST /_api/builder/apps/:appId/share { email }  → { shared: true }  (409 om appen inte är publicerad)
//        Bjuder in adressen (rollen `viewer`) och mejlar länken till den publicerade appen. Svaret är
//        detsamma oavsett om adressen redan var inbjuden — det röjer inget om vilka som har konto.
//        Adressen får samtidigt åtkomst till appen (`AppAccessRole` `user`).
//   GET  /_api/builder/apps/:appId/members         → { members: BuilderAppMember[] }  (ägaren först)
//   DELETE /_api/builder/apps/:appId/members/:memberId → { removed: true }
//        Upphör direkt. Okänd medlem ⇒ samma svar (idempotent). Ägarens egen rad ⇒ 400 `invalid_request`.
//   POST /_api/builder/apps/:appId/feedback { helpful, text? } → { received: true }
//        Återkoppling på byggverktyget självt, till plattformens ägare — aldrig till språkmodellen,
//        och den ändrar inte appen. `helpful: false` kräver `text` och mejlas med hela konversationen
//        om appen; `helpful: true` räknas bara. Gräns per ägare och timme ⇒ 429 `rate_limited`.
//
// Bara appens ÄGARE når dessa rutter; för alla andra "finns" appen inte (404) — även för den som
// fått appen delad med sig. Undantaget är kontrollrummet under `/_api/builder/admin/…`, som
// kräver rollen `admin` och medvetet ser över alla appar (se "Kontrollrummet" längre ned).
//
// Övriga sökvägar på byggverktygets värd serverar byggverktygets egna statiska filer (SPA).

export const BUILDER_API_PREFIX = '/_api/builder';

export interface BuilderMe {
  readonly displayName: string;
  readonly canBuild: boolean;
  /**
   * Bär rollen `admin`. Gränssnittet visar länken till kontrollrummet först då — men det är
   * bara för att slippa visa en länk som ändå nekas. Grinden sitter på servern, i varje rutt.
   */
  readonly isAdmin: boolean;
  /**
   * Plattformstjänsterna som är påslagna, i plattformens ordning. Byggverktygets guide "Vad kan
   * min app göra?" visar bara dem — ingen ska bli lovad något som svarar 404.
   */
  readonly services: readonly AppServiceName[];
  /**
   * Versionen som är driftsatt, när driftsättningen angett en (`APP_VERSION`). Visas i
   * byggverktyget: en webbläsare som kör något gammalt ska gå att upptäcka direkt.
   */
  readonly version?: string;
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

/** En rad i åtkomstlistan. `memberId` är användar-id:t; ägarens `email` är ägarens egen adress. */
export interface BuilderAppMember {
  readonly memberId: string;
  readonly email: string;
  readonly role: AppAccessRole;
}

/**
 * Återkoppling på byggverktyget, inte på appen. Den gäller appens konversation som helhet och
 * inte ett enskilt svar: `BuilderMessage` har ingen identitet, och gränssnittet lägger till
 * meddelanden innan servern svarat, så ett radnummer skulle peka fel. Hela konversationen följer
 * ändå med i mejlet, så sammanhanget går inte förlorat.
 */
export interface BuilderFeedback {
  /** Uppskattning räknas bara. Är den false krävs `text`, och återkopplingen mejlas. */
  readonly helpful: boolean;
  /** Vad som inte hjälpte, med Annas egna ord. Krävs när `helpful` är false. */
  readonly text?: string;
}

export type BuilderJobStatus = 'queued' | 'running' | 'done' | 'failed';

// ── Kontrollrummet (adminvyn) ───────────────────────────────────────────────────
//
// Under `/_api/builder/admin/…`, på samma värd som resten av byggverktyget. Kräver rollen
// `admin` — inte bara `builder`. Den som saknar rollen får 403, och gränssnittet visar ingen
// länk dit. Rutterna bryter MEDVETET byggverktygets vanliga regel att man bara ser sitt eget.
//
//   GET /_api/builder/admin/oversikt → AdminOverview
//   GET /_api/builder/admin/appar    → { apps: AdminApp[] }   (senast ändrad först)
//
// Hela app-id:t ÄR den hemliga delen av appens adress. Kontrollrummet visar därför bara ett
// förkortat id, aldrig en delningslänk — samma regel som driftloggarna följer.

/** Så många tecken av app-id:t kontrollrummet visar. Samma längd som i driftloggarna. */
export const ADMIN_APP_ID_PREFIX_LENGTH = 8;

/** Så många dygn bakåt `AdminOverview.tokens` summerar. */
export const ADMIN_TOKEN_WINDOW_DAYS = 30;

export interface AdminOverview {
  /** Alla appar i byggverktyget, oavsett ägare. */
  readonly apps: number;
  readonly published: number;
  /** Appar med ett utkast som ännu inte publicerats. */
  readonly drafts: number;
  /** Adresser som får logga in, per roll. */
  readonly users: { readonly admin: number; readonly builder: number; readonly viewer: number };
  /** Summerade tokens de senaste `ADMIN_TOKEN_WINDOW_DAYS` dygnen, och antalet jobb bakom dem. */
  readonly tokens: { readonly input: number; readonly output: number; readonly jobs: number };
  /** Jobb som misslyckats inom samma fönster — byggverktygets egen felbild. */
  readonly failedJobs: number;
}

// ── Klassning: hur känsligt det appen ska göra är ───────────────────────────────
//
// Klassen sätts ÅT den som bygger — hen väljer den aldrig själv. Språkmodellen läser önskemålet,
// signalord sätter ett golv som modellsvaret bara får HÖJA, och ett svar som inte går att tolka
// ger den strängaste klassen. Det är den bärande regeln: den som bygger ska inte kunna välja bort
// sitt eget skydd, och ett fel i klassningen ska falla åt det försiktiga hållet.
//
//   GET /_api/builder/admin/register → { entries: AdminRegisterEntry[] }
//
// Klasserna står i STIGANDE stränghet. Ordningen är betydelsebärande: `CLASSIFICATIONS.indexOf`
// används för att jämföra två klasser, och ett okänt värde ur databasen läses som den strängaste.
//
// Appens klass HÖJS men sänks aldrig. Varje nytt önskemål klassas, och beskriver det känsligare
// uppgifter än det förra följer klassen med uppåt. Den som märker att "namn och adress" väckte en
// strängare klass ska inte kunna backa tillbaka genom att skriva om sig. Följden att stå för:
// en klassning som gick fel åt det stränga hållet (`fail-closed`) sitter kvar tills någon prövar
// den på nytt, och den prövningen finns ännu inte — därför står källan i registret.

export const CLASSIFICATIONS = ['oppen', 'intern', 'personuppgift', 'kanslig'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** Den strängaste klassen. Svaret när klassningen inte gick att göra, och när värdet är okänt. */
export const STRICTEST_CLASSIFICATION: Classification = 'kanslig';

/**
 * Hur strängt ett värde är, som ett tal att jämföra med. Högre tal = strängare.
 *
 * Finns här, och bara här, för att ordningen inte ska stå avskriven på fyra ställen. Allt som inte
 * ÄR en känd klass — `null` ur en kolumn som aldrig klassats, ett ord ur en äldre version av vår
 * egen kod, något som råkat bli ett tal — ger den strängaste klassens tal. Det är fail-closed
 * uttryckt i en jämförelse: den som inte vet vinner aldrig över den som vet.
 */
export function classificationRank(value: unknown): number {
  const index = CLASSIFICATIONS.indexOf(value as Classification);
  return index === -1 ? CLASSIFICATIONS.indexOf(STRICTEST_CLASSIFICATION) : index;
}

/** Den kända klassen, eller den strängaste. Samma regel som `classificationRank`, som ett värde. */
export function asClassification(value: unknown): Classification {
  return CLASSIFICATIONS[classificationRank(value)] ?? STRICTEST_CLASSIFICATION;
}

/** Hur appens klass blev vad den blev. Står i registret, så att en fail-closed går att se. */
export const CLASSIFICATION_SOURCES = [
  /** Språkmodellen läste önskemålet och svarade med en klass. */
  'modell',
  /** Ett signalord i önskemålet satte ett golv som modellens svar inte fick underskrida. */
  'signalord',
  /** Modellen svarade otolkbart, anropet misslyckades eller tog för lång tid. */
  'fail-closed',
] as const;

export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

/**
 * En rad i AI-registret: en app med sin känslighetsnivå och hur den nivån sattes.
 *
 * Registret svarar på frågan en tillsyn ställer — vilka appar finns, vem äger dem, hur känsliga
 * är de. Önskemålets text finns inte här, av samma skäl som i `AdminStop`.
 */
export interface AdminRegisterEntry {
  readonly appIdPrefix: string;
  readonly name: string;
  readonly ownerEmail: string | null;
  readonly classification: Classification;
  readonly source: ClassificationSource;
  /** När klassen sattes. `null` för en app som ännu aldrig beskrivits — då gissar registret inte. */
  readonly classifiedAt: string | null;
  readonly published: boolean;
  /**
   * När appen avvecklades, eller `null` för en app som lever. En avvecklad app står KVAR i
   * registret: uppgifterna i den är raderade, men att den har funnits, vem som ägde den och hur
   * känslig den var är just det en tillsyn frågar efter.
   */
  readonly decommissionedAt: string | null;
}

// ── Granskning: en människa prövar koden innan appen går ut ────────────────────
//
// Den som bygger publicerar inte längre själv. Hon BEGÄR publicering, och en granskare läser
// koden och avgör. Det är den sista spärren i kedjan, och den enda som är en människa:
// mönsterregler och en språkmodell fångar det förutsägbara, en läsare fångar resten.
//
//   POST /_api/builder/apps/<id>/publish        → begär granskning
//   GET  /_api/builder/admin/granskning         → { reviews: AdminReview[] }   (äldst först — en kö)
//   GET  /_api/builder/admin/granskning/<id>    → { review: AdminReview, files: SourceFiles }
//   POST /_api/builder/admin/granskning/<id>    → { decision: 'godkand' | 'avvisad', reason? }
//
// Granskningen gäller en VERSION, inte en app. Två regler håller det, och de överlappar med flit:
//
//   1. Bygger ägaren om medan ärendet väntar dras det tillbaka. Granskaren ska inte läsa kod som
//      redan är ersatt, och ägaren ska inte tro att någon läser.
//   2. Godkännandet publicerar den version ärendet PEKAR PÅ, aldrig `latestRevision()`.
//
// Regel 1 gör att regel 2 i praktiken aldrig behöver rädda något: ett väntande ärende kan inte
// samexistera med ett nyare bygge. Regel 2 står ändå kvar, för den är det som håller om regel 1
// någon gång inte gör det — en transaktion som inte gick igenom, en väg in i lagret som inte
// finns än. Den dyra egenskapen är att kod som ingen läst aldrig går ut, och den får inte vila
// på ett enda villkor.

export const REVIEW_STATES = [
  /** Begärd, ingen har avgjort den än. Högst en per app åt gången. */
  'vantar',
  /** En granskare läste koden och släppte ut den. Appen publicerades i samma ögonblick. */
  'godkand',
  /** En granskare läste koden och sa nej. Skälet går till ägaren i klarspråk. */
  'avvisad',
  /** Ägaren byggde om innan någon hann avgöra. Ingen läste den, och ingen ska tro att någon gjorde det. */
  'tillbakadragen',
] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];

/** De två beslut en granskare kan fatta. `tillbakadragen` är inget beslut — den händer av sig själv. */
export const REVIEW_DECISIONS = ['godkand', 'avvisad'] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Ett granskningsärende, så som kontrollrummet visar det i kön.
 *
 * Till skillnad från stopplistan och registret står här `classification` och
 * `classificationSource` med flit: granskaren ska se om nivån är ett omdöme eller ett
 * misslyckande INNAN hon läser koden. En app vars känslighet ingen kunnat avgöra är inte samma
 * sak att släppa ut som en app som prövats och blivit `oppen`.
 *
 * Önskemålets text står inte här, av samma skäl som i `AdminStop`. Koden gör det — men bara i
 * svaret för ETT ärende, aldrig i kön, och det är hela poängen med granskningen.
 */
export interface AdminReview {
  readonly reviewId: string;
  readonly appIdPrefix: string;
  readonly name: string;
  readonly ownerEmail: string | null;
  readonly classification: Classification;
  readonly classificationSource: ClassificationSource;
  readonly state: ReviewState;
  readonly requestedAt: string;
  /**
   * När ärendet avgjordes. `null` så länge det väntar.
   *
   * VEM som avgjorde står inte här. Det finns i databasen och i driftloggen, men ingen vy visar
   * avgjorda ärenden än — och ett fält som aldrig kan vara annat än `null` är värre än inget fält,
   * för någon bygger gränssnitt mot det. Det läggs till när vyn finns.
   */
  readonly decidedAt: string | null;
  /** Skälet en granskare gav när hon sa nej. Går ordagrant till ägaren. */
  readonly reason: string | null;
}

/** Hur ägaren ser sin egen begäran. Samma ärende, men utan något om vem granskaren är. */
export interface BuilderReviewStatus {
  readonly state: ReviewState;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

export const REVIEW_LIMITS = {
  /** Så långt skäl en granskare får skriva. Det går ordagrant till ägaren och ska vara läsbart. */
  maxReasonChars: 2000,
  /** Så många ärenden kön hämtar. Kön ska gå att beta av, inte vara ett arkiv. */
  maxQueue: 200,
} as const;

// ── Avveckling och export: när en app ska sluta finnas ─────────────────────────
//
// En app som ingen längre behöver ska gå att ta bort — på riktigt, och så att någon i efterhand
// kan visa ATT den togs bort. Två rutter, i den ordning de måste komma:
//
//   GET  /_api/builder/apps/<id>/export   → allt appen bär, som en fil att spara
//   POST /_api/builder/apps/<id>/avveckla → { confirm: <appens namn> }
//
// Exporten FÖRST, och det är inte en artighet. Appdata i en kommun kan vara allmän handling, och
// då får den inte försvinna bara för att den som byggde appen tröttnat. Plattformen kan inte
// avgöra om just de här uppgifterna är det — men den kan se till att det alltid finns en väg ut
// som inte kräver att någon läser databasen på servern.
//
// Avvecklingen raderar appens DATA och FILER, och tar bort appen ur control så att adressen slutar
// svara. Men registerposten ARKIVERAS, den raderas inte: att appen har funnits, vem som ägde den
// och hur känslig den var är själva svaret en tillsyn behöver. Raderingen gäller uppgifterna i
// appen, inte spåret av att appen fanns.
//
// Bekräftelsen är appens namn, ordagrant. Ett `{ confirm: true }` klickas bort; ett namn måste
// skrivas, och den som skriver fel namn har inte den app hon tror framför sig.

export const DECOMMISSION_LIMITS = {
  /** Så många dokument exporten tar med per kollektion. Över det kapas den, och svaret säger det. */
  maxDocumentsPerCollection: 10_000,
  /**
   * Tak på hela exportens kropp, mätt i byte på det färdiga svaret. En app som spränger det måste
   * hämtas ur backupen i stället — plattformen kör på två kärnor och ska inte serialisera en
   * kropp i den storleksordningen bara för att någon sparat mycket. Svaret blir `too_large`.
   */
  maxExportBytes: 64 * 1024 * 1024,
} as const;

/**
 * Det appen bar, som en fil att spara. JSON och inte CSV: en app kan ha kollektioner med olika
 * form, och en CSV per kollektion hade tappat nästlade värden utan att säga till. Den som behöver
 * CSV kan göra den ur det här; den som gör tvärtom kan inte få tillbaka det som gick förlorat.
 */
export interface AppExport {
  /** Formatets version. Står först, så att en läsare vet vad hen har innan hen tolkar resten. */
  readonly format: 1;
  readonly exportedAt: string;
  readonly app: {
    readonly name: string;
    readonly classification: Classification;
    readonly classificationSource: ClassificationSource;
    readonly published: boolean;
  };
  /**
   * Dokumenten per kollektion, ur den PUBLICERADE appen. Förhandsvisningen har en egen databas
   * med egen data, och den följer inte med: utkastet är ogranskad kod och det som ligger där är
   * testmaterial, inte handlingar. Avvecklingen raderar däremot BÅDA — det som ska bort ska bort,
   * även om det aldrig var värt att spara.
   *
   * `truncated` är sant när taket slog till — aldrig tyst kapning.
   */
  readonly collections: Readonly<Record<string, { readonly documents: readonly JsonObject[]; readonly truncated: boolean }>>;
  /** Filerna appen sparat: namn och storlek. Innehållet hämtas var för sig, se `files`-tjänsten. */
  readonly files: readonly { readonly id: string; readonly name: string; readonly size: number }[];
  /** Samtalet som byggde appen. Hör till handlingen: det visar VARFÖR appen ser ut som den gör. */
  readonly conversation: readonly BuilderMessage[];
}

/**
 * Beviset på att appen avvecklades. Skrivs i audit och går inte att ändra i efterhand.
 *
 * `documentsDeleted` och `filesDeleted` räknas FÖRE raderingen och sparas — efteråt finns inget
 * att räkna. Det är hela poängen med ett gallringsbevis: det ska gå att visa vad som försvann.
 */
export interface DecommissionEvidence {
  readonly appIdPrefix: string;
  readonly decommissionedAt: string;
  readonly documentsDeleted: number;
  readonly filesDeleted: number;
}

// ── Röda linjer: förbjuden användning stoppas innan något byggs ─────────────────
//
// Ett önskemål prövas mot de röda linjerna INNAN språkmodellen får skriva en rad kod. Träff
// betyder att jobbet aldrig startar: ingen kod genereras, inget utkast ändras, och den som bad
// om det får veta varför i klarspråk. Det är en spärr, inte en varning att klicka förbi.
//
//   GET /_api/builder/admin/stopp → { stops: AdminStop[] }   (senast först)
//
// Kategorierna följer EU:s AI-förordnings förbjudna användningar, plus plattformens egna
// gränser. Koden är fast text ur vår egen kod — aldrig något som kommit in med önskemålet.

export const REDLINE_CATEGORIES = [
  /** Poängsättning av människor utifrån beteende eller egenskaper. */
  'social-poangsattning',
  /** Känsloigenkänning på arbetsplats eller i skola. */
  'kansloigenkanning',
  /** Biometrisk identifiering eller kategorisering av människor. */
  'biometri',
  /** Förutsäga att en enskild person ska begå brott. */
  'prediktiv-brottsbekampning',
  /** Beslut som rör en enskild och fattas utan att en människa prövar det. */
  'automatiskt-beslut-om-enskild',
  /** Utnyttja någons sårbarhet, eller påverka utan att personen märker det. */
  'manipulation',
] as const;

export type RedlineCategory = (typeof REDLINE_CATEGORIES)[number];

/**
 * Ett stoppat önskemål, så som kontrollrummet visar det.
 *
 * Här står ALDRIG önskemålets text. Den kan innehålla personuppgifter, och ett stopp får inte
 * bli vägen som sparar undan just det någon inte borde ha skrivit. Kategorin och tidpunkten
 * räcker för att se om en regel är för bred.
 */
export interface AdminStop {
  readonly appIdPrefix: string;
  readonly category: RedlineCategory;
  readonly at: string;
}

// ── Kontrollrummet: adresser och roller ─────────────────────────────────────────
//
//   GET  /_api/builder/admin/anvandare              → { users: AdminUser[] }
//   POST /_api/builder/admin/anvandare  { email, role }   → 201 { user: AdminUser }
//        Bjuder in adressen eller HÖJER dess roll. Samma svar oavsett vilket.
//   POST /_api/builder/admin/anvandare/:userId { role }   → 200 { user: AdminUser }
//        Sätter rollen rakt av — den enda vägen att SÄNKA en roll. Den egna raden avvisas
//        med `invalid_request`: en administratör som sänker sig själv låser ut sig, och
//        vägen tillbaka går bara över SSH.
//
// Adresserna i svaren är personuppgifter. De går till den som förvaltar plattformen och
// får aldrig hamna i en driftlogg — samma regel som `AdminApp.ownerEmail`.

export interface AdminUser {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /**
   * När adressen lades in. `null` bara om värdet inte gick att läsa ur databasen — användaren
   * tas med ändå, eftersom den som inte syns i kontrollrummet inte heller går att ändra rollen
   * på, och en osynlig behörighet är farligare än ett saknat datum.
   */
  readonly createdAt: string | null;
  /** Sant för den som frågar. Gränssnittet ska inte erbjuda att sänka sin egen roll. */
  readonly self: boolean;
}

/** En rad i kontrollrummets applista. Aldrig hela app-id:t, aldrig en länk till appen. */
export interface AdminApp {
  /** De första `ADMIN_APP_ID_PREFIX_LENGTH` tecknen av app-id:t. Räcker för att känna igen en app. */
  readonly appIdPrefix: string;
  readonly name: string;
  /** Ägarens adress. Bara kontrollrummet ser den; den loggas aldrig. */
  readonly ownerEmail: string | null;
  readonly updatedAt: string;
  readonly hasDraft: boolean;
  readonly published: boolean;
  /** Antal personer med åtkomst till appen, ägaren inräknad. */
  readonly members: number;
  /** Summerade tokens för appens alla jobb, sedan den skapades. */
  readonly tokens: { readonly input: number; readonly output: number };
}

export interface BuilderAppDetail extends BuilderAppSummary {
  /** Den publicerade appens adress — finns när `published`, så att delningslänken syns efter omladdning. */
  readonly publishedUrl?: string;
  readonly messages: readonly BuilderMessage[];
  /** Pågående eller senaste jobb, så att en omladdad sida kan fortsätta följa det. */
  readonly job?: { readonly jobId: string; readonly status: BuilderJobStatus };
  /**
   * Ägarens senaste begäran om publicering. Saknas den har hon aldrig begärt någon. Det är den
   * enda vägen ut: appen publiceras inte av att hon trycker, utan av att en granskare säger ja.
   */
  readonly review?: BuilderReviewStatus;
}

export interface BuilderJob {
  readonly jobId: string;
  readonly appId: string;
  readonly status: BuilderJobStatus;
  readonly events: readonly AgentEvent[];
  /** Skicka som `after` i nästa anrop. */
  readonly next: number;
}

// ── Inbjudningar ────────────────────────────────────────────────────────────────

/**
 * Bara uttryckligen inbjudna adresser kan logga in. Byggverktyget bjuder in när en ägare delar en app;
 * implementeras av identitetspaketet, som också skickar mejlet. Adressen normaliseras (gemener,
 * blanktecken borttagna) och valideras av implementationen; ogiltig adress ⇒ `DataApiError('invalid_request')`.
 */
export interface InvitationService {
  invite(request: {
    readonly email: string;
    readonly role: Role;
    readonly invitedBy: Identity;
    /** Mejlet innehåller länken och appens namn. Ingen länk ⇒ en allmän inbjudan. */
    readonly app?: { readonly name: string; readonly url: string };
  }): Promise<InvitedUser>;
}

/** Den inbjudna adressens användare — ny eller befintlig. Samma svar i båda fallen. */
export interface InvitedUser {
  readonly userId: string;
  /** Normaliserad adress (gemener, utan blanktecken). */
  readonly email: string;
}
