/**
 * Testdubblar för gatewayens beroenden: `TenantStore`, `AppRegistry`, `AppFiles` och
 * `IdentityProvider`. Alla spelar in vilka anrop de fick (särskilt vilket `TenantContext`
 * och vilken `Identity`) så att tester kan bevisa att fel hyresgäst ALDRIG når lagret —
 * det är poängen med hela testsviten. `@vibesandbox/data-api` är inte implementerat än
 * och importeras aldrig härifrån.
 */
import { createHash } from 'node:crypto';
import type {
  AppFile,
  AppFiles,
  AppAccessRole,
  AppId,
  AppRegistry,
  AuthRequest,
  AuthRouteRequest,
  AuthRouteResponse,
  BuilderHandler,
  CollectionScope,
  DocumentPage,
  Identity,
  IdentityProvider,
  JsonObject,
  PlatformRequest,
  PlatformResponse,
  RegisteredApp,
  StoredDocument,
  TenantContext,
  TenantStore,
} from '@vibesandbox/contracts';
import { DataApiError } from '@vibesandbox/contracts';
import type { GatewayOptions } from '../src/index.ts';

/** Testets appdomän respektive förhandsvisningsdomän — godtyckliga men konsekventa. */
export const APP_DOMAN = 'appar.test';
export const PREVIEW_DOMAN = 'bygg.test';

const ALFABET = '0123456789abcdefghjkmnpqrstvwxyz'; // samma alfabet som APP_ID_PATTERN, Crockford base32

/**
 * Deterministiskt men läsbart 26-tecken app-id, byggt ur ett fritextfrö (t.ex. "bokningar").
 * Alltid giltigt enligt `APP_ID_PATTERN` eftersom det bara använder tecken ur ALFABET.
 */
export function skapaAppId(fro: string): string {
  // SHA-256 av fröet, fem bitar per tecken. Den tidigare varianten tog de LÄGSTA bitarna ur en
  // linjär kongruensgenerator — de har period 32, så hur många frön man än gav fanns bara 32 olika
  // app-id. Två "olika" appar i ett isoleringstest kunde då vara samma värd, och testet prövade
  // ingenting (eller föll slumpvis: en syskonapp som råkade vara offret fick 201 i stället för 403).
  const digest = createHash('sha256').update(fro, 'utf8').digest();
  let tecken = '';
  for (let i = 0; i < 26; i += 1) tecken += ALFABET[(digest[i] ?? 0) & 31];
  return tecken;
}

export function vardnamnForApp(appId: string, appDomain: string = APP_DOMAN): string {
  return `${appId}.${appDomain}`;
}

export function vardnamnForForhandsvisning(appId: string, previewDomain: string = PREVIEW_DOMAN): string {
  return `p-${appId}.${previewDomain}`;
}

// ── Identitet ────────────────────────────────────────────────────────────────────

let nastaAnvandarNummer = 0;

export function skapaIdentitet(overrides: Partial<Identity> = {}): Identity {
  nastaAnvandarNummer += 1;
  return {
    userId: overrides.userId ?? `anvandare-${nastaAnvandarNummer}`,
    email: overrides.email ?? `anvandare.${nastaAnvandarNummer}@exempel.se`,
    roles: overrides.roles ?? ['builder'],
  };
}

export interface FejkadIdentityProvider extends IdentityProvider {
  readonly anrop: AuthRequest[];
  /** Varje anrop till `handleAuthRoute` (alltid tom för en leverantör utan kroken). */
  readonly authRouteAnrop: AuthRouteRequest[];
}

/** En identitetsleverantör vars svar (eller kastade fel) styrs helt av testet. */
export function skapaFejkadIdentityProvider(
  beteende: (request: AuthRequest) => Promise<Identity | null> | Identity | null,
): FejkadIdentityProvider {
  const anrop: AuthRequest[] = [];
  return {
    name: 'fejk',
    anrop,
    authRouteAnrop: [],
    async authenticate(request) {
      anrop.push(request);
      return beteende(request);
    },
  };
}

/**
 * Leverantör MED kroken `handleAuthRoute`. Ruttens svar styrs helt av testet och är medvetet
 * otypat (`unknown`): en fientlig eller slarvig leverantör håller sig inte till kontraktets
 * typer, och gatewayn ska tåla vad som helst utan att släppa igenom det.
 */
export function skapaFejkadAuthRouteProvider(
  rutt: (request: AuthRouteRequest) => unknown,
  beteende: (request: AuthRequest) => Promise<Identity | null> | Identity | null = () => null,
): FejkadIdentityProvider {
  const anrop: AuthRequest[] = [];
  const authRouteAnrop: AuthRouteRequest[] = [];
  return {
    name: 'fejk-med-inloggningsrutter',
    anrop,
    authRouteAnrop,
    async authenticate(request) {
      anrop.push(request);
      return beteende(request);
    },
    async handleAuthRoute(request) {
      authRouteAnrop.push(request);
      return (await rutt(request)) as AuthRouteResponse | null;
    },
  };
}

/** Leverantör som alltid nekar — motsvarar "ingen inloggning". */
export function skapaNekandeIdentityProvider(): FejkadIdentityProvider {
  return skapaFejkadIdentityProvider(() => null);
}

/** Leverantör som alltid kastar. Gatewayn ska ändå vara fail-closed, aldrig släppa igenom. */
export function skapaKrashandeIdentityProvider(
  fel: Error = new Error('identitetsleverantören kraschade'),
): FejkadIdentityProvider {
  return skapaFejkadIdentityProvider(() => {
    throw fel;
  });
}

/**
 * Den som `skapaGodkannandeIdentityProvider()` loggar in när testet inte anger någon. Att vara
 * inloggad ger ingen åtkomst till en app: testet ger den uttryckligen med
 * `register.bevilja(appId, STANDARDANVANDARE.userId, 'owner')`.
 */
export const STANDARDANVANDARE: Identity = Object.freeze(
  skapaIdentitet({ userId: 'anv-standard', email: 'standard.anvandare@exempel.se' }),
);

/** Leverantör som alltid loggar in samma identitet, oavsett förfrågan. */
export function skapaGodkannandeIdentityProvider(identitet: Identity = STANDARDANVANDARE): FejkadIdentityProvider {
  return skapaFejkadIdentityProvider(() => identitet);
}

// ── AppRegistry ──────────────────────────────────────────────────────────────────

export interface InspelatAtkomstAnrop {
  readonly appId: AppId;
  readonly userId: string;
}

export interface FejkatRegister extends AppRegistry {
  /** Varje app-id gatewayn frågade efter med `find`, i ordning. */
  readonly anrop: AppId[];
  /** Varje `accessFor`-anrop, i ordning — så att tester kan bevisa VILKA värden som frågades om. */
  readonly atkomstAnrop: InspelatAtkomstAnrop[];
  registrera(appId: string, app: { readonly published?: boolean; readonly draft?: boolean }): void;
  /**
   * Ger `userId` rollen i appen. Utan en sådan rad har ingen åtkomst — inte ens den som är
   * inloggad eller admin. Testerna ger därför åtkomst UTTRYCKLIGEN; fejken har ingen genväg.
   */
  bevilja(appId: string, userId: string, roll: AppAccessRole): void;
  /** Tar bort raden. Gäller från och med nästa `accessFor`, precis som i det riktiga registret. */
  aterkalla(appId: string, userId: string): void;
  /**
   * Styr `accessFor` helt: kastar ett fel eller returnerar vad som helst (även sådant som inte är
   * en `AppAccessRole` — ett trasigt register följer inte typerna). `null` återställer.
   */
  styrAtkomst(beteende: ((appId: AppId, userId: string) => unknown) | null): void;
}

export function skapaFejkatRegister(): FejkatRegister {
  const appar = new Map<string, RegisteredApp>();
  const roller = new Map<string, AppAccessRole>();
  const anrop: AppId[] = [];
  const atkomstAnrop: InspelatAtkomstAnrop[] = [];
  let styrning: ((appId: AppId, userId: string) => unknown) | null = null;
  // Nyckeln kan inte krocka: app-id består bara av base32-tecken, aldrig NUL.
  const nyckel = (appId: string, userId: string) => `${appId}\u0000${userId}`;
  return {
    anrop,
    atkomstAnrop,
    registrera(appId, app) {
      appar.set(appId, {
        appId: appId as AppId,
        published: app.published ?? false,
        draft: app.draft ?? false,
      });
    },
    bevilja(appId, userId, roll) {
      roller.set(nyckel(appId, userId), roll);
    },
    aterkalla(appId, userId) {
      roller.delete(nyckel(appId, userId));
    },
    styrAtkomst(beteende) {
      styrning = beteende;
    },
    async find(appId) {
      anrop.push(appId);
      return appar.get(appId) ?? null;
    },
    async accessFor(appId, userId) {
      atkomstAnrop.push({ appId, userId });
      if (styrning !== null) return (await styrning(appId, userId)) as AppAccessRole | null;
      // Som kontraktet: en app som inte finns ger ingen roll, oavsett rader.
      if (!appar.has(appId)) return null;
      return roller.get(nyckel(appId, userId)) ?? null;
    },
  };
}

// ── AppFiles ───────────────────────────────────────────────────────────────────────

export interface InspeladFilLasning {
  readonly appId: string;
  readonly kind: string;
  readonly path: string;
}

export interface FejkadeFiler extends AppFiles {
  readonly anrop: InspeladFilLasning[];
  satt(appId: string, kind: 'published' | 'draft', path: string, fil: AppFile): void;
}

export function skapaFejkadeFiler(): FejkadeFiler {
  const filer = new Map<string, AppFile>();
  const anrop: InspeladFilLasning[] = [];
  const nyckel = (appId: string, kind: string, path: string) => `${appId}:${kind}:${path}`;
  return {
    anrop,
    satt(appId, kind, path, fil) {
      filer.set(nyckel(appId, kind, path), fil);
    },
    async read(tenant, path) {
      anrop.push({ appId: tenant.appId, kind: tenant.kind, path });
      // Testerna bevisar traverseringsskydd genom att KRÄVA att `path` som når hit
      // aldrig innehåller ett `..`-segment, NUL-byte eller bakåtstreck.
      return filer.get(nyckel(tenant.appId, tenant.kind, path)) ?? null;
    },
  };
}

export function textfil(innehall: string, contentType = 'text/html; charset=utf-8'): AppFile {
  return { body: new TextEncoder().encode(innehall), contentType };
}

// ── TenantStore ────────────────────────────────────────────────────────────────────

export interface InspelatStoreAnrop {
  readonly metod:
    | 'listDocuments'
    | 'createDocument'
    | 'getDocument'
    | 'replaceDocument'
    | 'deleteDocument'
    | 'destroyTenant'
    | 'close';
  readonly tenant?: TenantContext;
  readonly identity?: Identity;
  readonly collection?: string;
  readonly extra?: unknown;
}

export interface FejkatTenantStore extends TenantStore {
  readonly anrop: InspelatStoreAnrop[];
  /** Nästa metodanrop (valfri metod) kastar detta fel i stället för att utföras. */
  kastaVidNastaAnrop(fel: Error): void;
}

interface LagratDokument {
  readonly id: string;
  data: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agareUserId?: string;
}

interface Kollektion {
  readonly scope: CollectionScope;
  readonly dokument: Map<string, LagratDokument>;
}

/**
 * En riktig, om än minimal, in-memory-lagring — inte bara en stubb. Isoleringstesterna
 * (hyresgastisolering.feature m.fl.) skriver via en hyresgäst och läser via en annan för
 * att bevisa att bara `TenantContext` som gatewayn själv härlett ur Host styr vad som nås.
 */
export function skapaFejkatTenantStore(): FejkatTenantStore {
  const kollektionerPerTenant = new Map<string, Kollektion>();
  const anrop: InspelatStoreAnrop[] = [];
  let nastaFel: Error | null = null;
  let lopnummer = 0;

  const nyckel = (tenant: TenantContext, collection: string) => `${tenant.appId}:${tenant.kind}:${collection}`;

  const hamtaEllerSkapaKollektion = (tenant: TenantContext, collection: string, scope: CollectionScope) => {
    const k = nyckel(tenant, collection);
    const befintlig = kollektionerPerTenant.get(k);
    if (befintlig) return befintlig;
    const ny: Kollektion = { scope, dokument: new Map() };
    kollektionerPerTenant.set(k, ny);
    return ny;
  };

  const kontrolleraFel = () => {
    if (nastaFel) {
      const fel = nastaFel;
      nastaFel = null;
      throw fel;
    }
  };

  return {
    anrop,
    kastaVidNastaAnrop(fel) {
      nastaFel = fel;
    },

    async listDocuments(tenant, identity, collection, scope, options): Promise<DocumentPage> {
      anrop.push({ metod: 'listDocuments', tenant, identity, collection, extra: { scope, options } });
      kontrolleraFel();
      const k = kollektionerPerTenant.get(nyckel(tenant, collection));
      if (!k) return { documents: [] };
      if (k.scope !== scope) {
        throw new DataApiError('scope_mismatch', 'kollektionen har en annan synlighet');
      }
      let dokument = [...k.dokument.values()];
      if (scope === 'user') {
        dokument = dokument.filter((d) => d.agareUserId === identity.userId);
      }
      const limit = options?.limit ?? dokument.length;
      const sida = dokument.slice(0, limit);
      return sida.length < dokument.length
        ? { documents: sida, nextCursor: String(sida.length) }
        : { documents: sida };
    },

    async createDocument(tenant, identity, collection, scope, data): Promise<StoredDocument> {
      anrop.push({ metod: 'createDocument', tenant, identity, collection, extra: { scope, data } });
      kontrolleraFel();
      const k = hamtaEllerSkapaKollektion(tenant, collection, scope);
      if (k.scope !== scope) {
        throw new DataApiError('scope_mismatch', 'kollektionen har en annan synlighet');
      }
      lopnummer += 1;
      const nu = new Date().toISOString();
      const dokument: LagratDokument =
        scope === 'user'
          ? { id: `dok-${lopnummer}`, data, createdAt: nu, updatedAt: nu, agareUserId: identity.userId }
          : { id: `dok-${lopnummer}`, data, createdAt: nu, updatedAt: nu };
      k.dokument.set(dokument.id, dokument);
      return dokument;
    },

    async getDocument(tenant, identity, collection, id): Promise<StoredDocument> {
      anrop.push({ metod: 'getDocument', tenant, identity, collection, extra: { id } });
      kontrolleraFel();
      const k = kollektionerPerTenant.get(nyckel(tenant, collection));
      const dokument = k?.dokument.get(id);
      if (!k || !dokument || (k.scope === 'user' && dokument.agareUserId !== identity.userId)) {
        throw new DataApiError('not_found', 'dokumentet finns inte');
      }
      return dokument;
    },

    async replaceDocument(tenant, identity, collection, id, data): Promise<StoredDocument> {
      anrop.push({ metod: 'replaceDocument', tenant, identity, collection, extra: { id, data } });
      kontrolleraFel();
      const k = kollektionerPerTenant.get(nyckel(tenant, collection));
      const befintligt = k?.dokument.get(id);
      if (!k || !befintligt || (k.scope === 'user' && befintligt.agareUserId !== identity.userId)) {
        throw new DataApiError('not_found', 'dokumentet finns inte');
      }
      const uppdaterat: LagratDokument = { ...befintligt, data, updatedAt: new Date().toISOString() };
      k.dokument.set(id, uppdaterat);
      return uppdaterat;
    },

    async deleteDocument(tenant, identity, collection, id): Promise<void> {
      anrop.push({ metod: 'deleteDocument', tenant, identity, collection, extra: { id } });
      kontrolleraFel();
      const k = kollektionerPerTenant.get(nyckel(tenant, collection));
      const befintligt = k?.dokument.get(id);
      if (!k || !befintligt || (k.scope === 'user' && befintligt.agareUserId !== identity.userId)) {
        throw new DataApiError('not_found', 'dokumentet finns inte');
      }
      k.dokument.delete(id);
    },

    async destroyTenant(tenant): Promise<void> {
      anrop.push({ metod: 'destroyTenant', tenant });
      kontrolleraFel();
      for (const k of [...kollektionerPerTenant.keys()]) {
        if (k.startsWith(`${tenant.appId}:${tenant.kind}:`)) kollektionerPerTenant.delete(k);
      }
    },

    async close(): Promise<void> {
      anrop.push({ metod: 'close' });
      kontrolleraFel();
    },
  };
}

// ── Ihopsatta GatewayOptions ────────────────────────────────────────────────────────

export interface TestUppsattning {
  readonly options: GatewayOptions;
  readonly register: FejkatRegister;
  readonly filer: FejkadeFiler;
  readonly store: FejkatTenantStore;
  readonly identityProvider: FejkadIdentityProvider;
}

/**
 * Spelar in anropen till vilken leverantör som helst — även en riktig, som
 * `createTestIdentityProvider` — och släpper igenom både svar och kastade fel oförändrade.
 */
export function spelaInIdentityProvider(inre: IdentityProvider): FejkadIdentityProvider {
  const anrop: AuthRequest[] = [];
  const authRouteAnrop: AuthRouteRequest[] = [];
  const inspelad: FejkadIdentityProvider = {
    name: inre.name,
    anrop,
    authRouteAnrop,
    async authenticate(request) {
      anrop.push(request);
      return inre.authenticate(request);
    },
  };
  // Kroken och inloggningssidan förs vidare BARA om den inre leverantören har dem — annars skulle
  // inpackningen få en leverantör utan inloggningsrutter att se ut att ha dem.
  const medSida: FejkadIdentityProvider =
    inre.loginPath === undefined ? inspelad : { ...inspelad, loginPath: inre.loginPath };
  if (inre.handleAuthRoute === undefined) return medSida;
  return {
    ...medSida,
    async handleAuthRoute(request) {
      authRouteAnrop.push(request);
      return inre.handleAuthRoute?.(request) ?? null;
    },
  };
}

// ── BuilderHandler ─────────────────────────────────────────────────────────────────

export interface FejkadBuilderHandler extends BuilderHandler {
  /** Varje förfrågan gatewayn lämnade vidare, i ordning. Tom = handlern nåddes aldrig. */
  readonly anrop: PlatformRequest[];
}

export const BYGGVERKTYGETS_SIDA = '<h1>Byggverktyget</h1>';

/**
 * Byggverktygets handler som spelar in anrop. Svaret styrs av testet och är medvetet otypat:
 * gatewayn ska tåla vad som helst från handlern utan att släppa igenom det.
 */
export function skapaFejkadBuilderHandler(
  svar: (request: PlatformRequest) => unknown = () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: BYGGVERKTYGETS_SIDA,
  }),
): FejkadBuilderHandler {
  const anrop: PlatformRequest[] = [];
  return {
    anrop,
    async handle(request) {
      anrop.push(request);
      return (await svar(request)) as PlatformResponse;
    },
  };
}

/**
 * Bygger fungerande GatewayOptions med färska fejkar. Varje del kan skrivas över.
 *
 * `identityProvider` i resultatet är ALLTID den leverantör gatewayn faktiskt använder — även när
 * den skrivits över via `overrides` — inpackad så att anropen spelas in. (Tidigare lämnades den
 * oanvända standardleverantören ut, så att `identityProvider.anrop` alltid var tom och ett
 * påstående om att leverantören "aldrig tillfrågades" alltid var sant.)
 */
export function skapaTestUppsattning(overrides: Partial<GatewayOptions> = {}): TestUppsattning {
  const register = skapaFejkatRegister();
  const filer = skapaFejkadeFiler();
  const store = skapaFejkatTenantStore();
  const identityProvider = spelaInIdentityProvider(overrides.identityProvider ?? skapaNekandeIdentityProvider());

  return {
    register,
    filer,
    store,
    identityProvider,
    options: {
      appDomain: APP_DOMAN,
      previewDomain: PREVIEW_DOMAN,
      registry: register,
      files: filer,
      store,
      ...overrides,
      // Sist, så att en överskriven leverantör ändå går via inspelningen.
      identityProvider,
    },
  };
}
