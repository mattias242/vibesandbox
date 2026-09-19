/**
 * Plattformstjänsten `roles` (`/_api/roles`): roller inuti en app, definierade av appen och
 * tilldelade av ägaren.
 *
 *   GET  /members            alla medlemmar: { userId, displayName, access, roles }[]
 *   GET  /me                 den inloggade:  { userId, access, roles }
 *   GET  /definitions        appens roller:  { id, name }[]
 *   PUT  /definitions        ersätter rollerna (bara ägaren)
 *   PUT  /members/<userId>   ersätter en medlems roller (bara ägaren) → medlemmen
 *
 * VIKTIGT — vad en roll är och inte är: en roll är INFORMATION till appens gränssnitt (vad som
 * visas för vem). Plattformen tvingar inte rollerna någonstans, inte heller i data-API:t: den som
 * kommer åt appen kommer åt appens gemensamma kollektioner oavsett roll, och appens kod kan göra
 * vilka anrop den vill. Det som skyddar data är personliga kollektioner (`scope=user`).
 *
 * Medlemskapet är control:s (`dependencies.members`) — tjänsten sparar bara vilka roller ett
 * användar-id fått. Varje läsning filtreras mot aktuell medlemslista och aktuella definitioner,
 * så en borttagen medlem eller en borttagen roll gäller direkt.
 *
 * Utkast och publicerad app har EGNA roller (nycklade på `tenant.kind`), som all annan data på
 * plattformen. Skälet: utkastet är ogranskad kod som körs automatiskt i ägarens webbläsare med
 * ägarens rättigheter. Delade de roller skulle ett utkast — genom en bugg eller en illasinnad
 * instruktion — kunna skriva om den publicerade appens roller bara genom att förhandsvisas.
 * Priset är litet: ägaren provar roller i förhandsvisningen och inför dem i den publicerade appen.
 */
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import type {
  ApiErrorBody,
  ApiErrorCode,
  AppAccessRole,
  AppService,
  AppServiceDependencies,
  AppServiceFactory,
  AppServiceRequest,
  AppServiceResponse,
} from '@vibesandbox/contracts';
import { openRoleStore } from './lagring.ts';
import type { RoleStore } from './lagring.ts';
import { InvalidInput, parseAssignment, parseDefinitions } from './validering.ts';

export { MAX_ROLES, ROLE_ID_PATTERN } from './validering.ts';
export type { RoleDefinition } from './validering.ts';

/** 20 roller × (id + namn på 60 tecken) ryms med god marginal. */
const MAX_BODY_BYTES = 16 * 1024;

/** Ett användar-id i sökvägen längre än så kan inte vara en medlem. Skyddar bara mot slöseri. */
const MAX_USER_ID_LENGTH = 200;

export interface RoleMember {
  readonly userId: string;
  readonly displayName: string;
  readonly access: AppAccessRole;
  readonly roles: readonly string[];
}

export interface RoleMe {
  readonly userId: string;
  readonly access: AppAccessRole;
  readonly roles: readonly string[];
}

class ServiceError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function json(status: number, value: unknown): AppServiceResponse {
  return {
    status,
    // Roller ändras när ägaren vill; ett cachat svar kunde visa en adminvy för den som just förlorat rollen.
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(value),
  };
}

function error(code: ApiErrorCode, message: string): AppServiceResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return json(API_ERROR_STATUS[code], body);
}

/**
 * Samma regel som `whoami` i data-API:t (packages/gateway/src/api.ts): bara den lokala delen av
 * adressen, aldrig domänen — appen behöver ett namn att visa, inte en kontaktuppgift.
 */
function displayName(email: string | null): string {
  if (email === null) return 'Användare';
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : 'Användare';
}

function readJson(request: AppServiceRequest): unknown {
  const type = request.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new ServiceError('invalid_request', 'Innehållet måste skickas som JSON (application/json).');
  }
  try {
    // `fatal`: felaktig UTF-8 nekas i stället för att tyst bli ersättningstecken.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body ?? new Uint8Array()));
  } catch {
    throw new ServiceError('invalid_request', 'Innehållet är inte giltig JSON.');
  }
}

function requireOwner(access: AppAccessRole): void {
  // `access` är avgjort av gatewayn för just den här förfrågan — ingenting i kroppen påverkar det.
  if (access !== 'owner') throw new ServiceError('forbidden', 'Bara appens ägare kan ändra roller.');
}

export function createRolesService(dependencies: AppServiceDependencies): AppService {
  const store: RoleStore = openRoleStore(dependencies.dataDir);

  function log(event: string, appId: string, extra: Readonly<Record<string, string | number>> = {}): void {
    // App-id förkortat; aldrig användar-id med adress, roll-namn eller e-post.
    dependencies.log({ level: 'info', event, app: appId.slice(0, 8), ...extra });
  }

  /** Aktuella medlemmar med sina roller. Tilldelningar för den som inte längre är medlem glöms. */
  async function members(request: AppServiceRequest): Promise<RoleMember[]> {
    const current = await dependencies.members.members(request.tenant.appId);
    // Glöms, inte bara filtreras: annars skulle rollerna komma tillbaka om personen bjuds in igen.
    store.forgetOthers(request.tenant, new Set(current.map((m) => m.userId)));
    const assigned = store.assignments(request.tenant);
    return current.map((m) => ({
      userId: m.userId,
      displayName: displayName(m.email),
      access: m.role,
      roles: assigned.get(m.userId) ?? [],
    }));
  }

  async function route(request: AppServiceRequest): Promise<AppServiceResponse> {
    // Tjänsten tar inga frågeparametrar. En okänd parameter är hellre ett fel än något som ignoreras.
    if (request.query !== '') throw new ServiceError('invalid_request', 'Tjänsten tar inga frågeparametrar.');
    const [first, second, ...rest] = request.segments;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const methodNotAllowed = (): never => {
      throw new ServiceError('method_not_allowed', 'Det här går inte att göra på det sättet.');
    };

    if (first === 'members' && second === undefined) {
      if (method !== 'GET') methodNotAllowed();
      return json(200, await members(request));
    }

    if (first === 'me' && second === undefined) {
      if (method !== 'GET') methodNotAllowed();
      const me = (await members(request)).find((m) => m.userId === request.identity.userId);
      // Gatewayn har redan släppt in personen; saknas hen i listan har åtkomsten just tagits bort.
      const result: RoleMe = { userId: request.identity.userId, access: request.access, roles: me?.roles ?? [] };
      return json(200, result);
    }

    if (first === 'definitions' && second === undefined) {
      if (method === 'GET') return json(200, store.definitions(request.tenant));
      if (method !== 'PUT') methodNotAllowed();
      requireOwner(request.access);
      const definitions = parseDefinitions(readJson(request));
      store.replaceDefinitions(request.tenant, definitions);
      log('roles_defined', request.tenant.appId, { count: definitions.length, kind: request.tenant.kind });
      return json(200, store.definitions(request.tenant));
    }

    if (first === 'members' && second !== undefined && rest.length === 0) {
      if (method !== 'PUT') methodNotAllowed();
      requireOwner(request.access);
      const body = readJson(request);
      const userId = second;
      const current = userId.length <= MAX_USER_ID_LENGTH ? await members(request) : [];
      // Exakt jämförelse mot control:s lista — ett id som inte står där (`..`, `__proto__`, fel
      // skiftläge, NUL) är ingen medlem. Samma svar som för ett okänt id: "finns inte".
      const member = current.find((m) => m.userId === userId);
      if (member === undefined) throw new ServiceError('not_found', 'Personen är inte medlem i appen.');
      const roles = parseAssignment(body, new Set(store.definitions(request.tenant).map((d) => d.id)));
      store.replaceAssignment(request.tenant, userId, roles);
      log('roles_assigned', request.tenant.appId, { count: roles.length, kind: request.tenant.kind });
      const updated: RoleMember = { ...member, roles: store.assignments(request.tenant).get(userId) ?? [] };
      return json(200, updated);
    }

    throw new ServiceError('not_found', 'Det du letar efter finns inte.');
  }

  return {
    name: 'roles',
    maxBodyBytes: MAX_BODY_BYTES,
    async handle(request) {
      try {
        return await route(request);
      } catch (caught) {
        if (caught instanceof ServiceError) return error(caught.code, caught.message);
        if (caught instanceof InvalidInput) return error('invalid_request', caught.message);
        // Allt annat blir gatewayns fasta 500 — utan att meddelandet lämnar tjänsten.
        throw caught;
      }
    },
    async close() {
      store.close();
    },
  };
}

export const factory: AppServiceFactory = (dependencies) => ({ service: createRolesService(dependencies) });
