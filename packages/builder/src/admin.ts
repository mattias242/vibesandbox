/**
 * Kontrollrummet (adminvyn): `GET /admin/oversikt`, `GET /admin/appar` och användarhanteringen
 * under `/admin/anvandare`.
 *
 * Läsningarna bryter med flit byggverktygets regel att man bara ser sitt eget, och är den enda
 * platsen som gör det; SQL:en ligger samlad i sql-admin.ts. Grinden sitter i api.ts
 * (`requireAdmin`): plattformsrollen `admin`, inte `builder`.
 *
 * Tre saker svaren aldrig får bära, och som är skälet till att formen ser ut som den gör:
 *
 *  - Hela app-id:t ÄR appens hemliga adress. Kontrollrummet lämnar bara ut de första
 *    `ADMIN_APP_ID_PREFIX_LENGTH` tecknen, och aldrig en länk. Rollen `admin` ger enligt kontraktet
 *    ingen åtkomst till någon apps data; insyn i ATT appar finns är inte en väg IN i dem.
 *  - Ägarens adress går i svaret men aldrig i en loggrad — därför loggar den här modulen inget alls.
 *    Det gäller också adresserna i användarlistan och i en inbjudan: ingen händelse härifrån
 *    hamnar i driftloggen, inte ens en misslyckad.
 *  - Den egna raden går inte att ändra. En administratör som sänker sig själv låser ut sig, och
 *    vägen tillbaka går bara över SSH in i en container.
 *
 * Adresserna och rollerna bor i identiteten, inte här. Vägen dit är `BuilderUserDirectory`
 * (anvandare.ts) och den är valfri: utan den blir `users` nollor och användarrutterna svarar
 * `unavailable`, i stället för att byggverktyget gissar.
 */
import {
  ADMIN_APP_ID_PREFIX_LENGTH,
  ADMIN_TOKEN_WINDOW_DAYS,
  asClassification,
  CLASSIFICATION_SOURCES,
  DataApiError,
  REDLINE_CATEGORIES,
} from '@vibesandbox/contracts';
import type {
  AdminApp,
  AdminOverview,
  AdminRegisterEntry,
  AdminStop,
  AdminUser,
  ClassificationSource,
  Identity,
  PlatformResponse,
  RedlineCategory,
  Role,
} from '@vibesandbox/contracts';

/**
 * Tak för hur många stopp kontrollrummet hämtar. Listan finns för att upptäcka en för bred regel,
 * inte för att vara ett arkiv — och ett svar utan tak växer med hur mycket någon råkat prova.
 */
const MAX_STOPS = 200;
import type { BuilderUser, BuilderUserDirectory } from './anvandare.ts';
import { controlErrorCode, storedAppId } from './control.ts';
import type { BuilderAccessEntry, BuilderControl } from './control.ts';
import type { Storage } from './lagring.ts';
import { ApiProblem, invalid, json, notFound } from './svar.ts';

export interface AdminDependencies {
  readonly storage: Storage;
  readonly control: BuilderControl;
  /** Vägen till identiteten. Saknas den är användarhanteringen inte inkopplad. */
  readonly users?: BuilderUserDirectory;
  readonly now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Högst så många tecken i en adress (RFC 5321). Identiteten prövar adressen på riktigt. */
const MAX_EMAIL_CHARS = 254;

/**
 * Alla roller som en uppslagning. `Record<Role, true>` gör listan uttömmande: får kontraktet en
 * ny roll vägrar typkollen den här raden tills den finns med här också.
 */
const ROLE_NAMES: Readonly<Record<Role, true>> = { admin: true, builder: true, viewer: true };

/** `Object.hasOwn`, inte `in`: `__proto__` och `toString` är inga roller. */
function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.hasOwn(ROLE_NAMES, value);
}

const NO_USERS: Readonly<Record<Role, number>> = { admin: 0, builder: 0, viewer: 0 };

/** Det kontrollrummet skriver i stället för ett namn ägaren aldrig har valt. Se `visatNamn`. */
const NAMNLOS = 'Namnlös app';

export function createAdmin(deps: AdminDependencies): {
  overview(): PlatformResponse;
  apps(): Promise<PlatformResponse>;
  stops(): PlatformResponse;
  register(): Promise<PlatformResponse>;
  users(identity: Identity): PlatformResponse;
  invite(identity: Identity, body: Record<string, unknown>): Promise<PlatformResponse>;
  setRole(identity: Identity, userId: string, body: Record<string, unknown>): PlatformResponse;
} {
  const { storage, control } = deps;

  /** Tidpunkten fönstret börjar vid. Räknas om per förfrågan — det är alltid "de senaste dygnen". */
  function windowStart(): string {
    return new Date(deps.now().getTime() - ADMIN_TOKEN_WINDOW_DAYS * DAY_MS).toISOString();
  }

  /**
   * Åtkomstlistan för en app, ur control. En app som byggverktyget känner men control inte gör
   * (en kvarlämnad rad) ska inte fälla hela listan: då blir ägaren okänd och antalet noll, och
   * resten av kontrollrummet fungerar. Andra fel från control är riktiga fel och kastas vidare.
   */
  async function accessFor(appId: string): Promise<readonly BuilderAccessEntry[]> {
    try {
      return await control.listAccess(storedAppId(appId));
    } catch (error) {
      if (controlErrorCode(error) === 'app_not_found') return [];
      throw error;
    }
  }

  /** Bryggan, eller ett tydligt besked. Aldrig en tom lista som ser ut som ett svar. */
  function directory(): BuilderUserDirectory {
    if (deps.users === undefined) {
      throw new ApiProblem('unavailable', 'Användarhanteringen är inte inkopplad i den här installationen.');
    }
    return deps.users;
  }

  /** Identitetens fel är kontraktets fel; de blir svar med klarspråk, aldrig ett 500. */
  function asProblem(error: unknown): unknown {
    if (error instanceof DataApiError && error.code === 'not_found') return notFound();
    if (error instanceof DataApiError && error.code === 'invalid_request') {
      // Meddelandet kommer härifrån, inte från identiteten: ett fel som når en användare ska
      // aldrig kunna bära med sig något som identiteten råkat lägga i sin text.
      return invalid('Adressen eller rollen går inte att använda.');
    }
    return error;
  }

  function adminUser(user: BuilderUser, identity: Identity): AdminUser {
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      // Gränssnittet ska inte erbjuda att sänka sin egen roll — och rutten vägrar ändå.
      self: user.userId === identity.userId,
    };
  }

  /**
   * Varje app med sin åtkomstlista och ägarens ADRESS. Adressen finns inte i byggverktygets
   * databas: den hämtas ur control (åtkomstlistan) och, för appar från före åtkomstlistan
   * (se atkomst.ts), ur identiteten. Saknas den båda ställena förblir den `null` —
   * kontrollrummet gissar aldrig vems appen är.
   *
   * Ett control-anrop per app. Databasen är en fil på samma maskin och listan är plattformens
   * alla appar — går den någon gång i tusental är det här stället att slå ihop anropen.
   * Uppslagningen i identiteten görs däremot i EN vändning för hela listan, inte en per app.
   *
   * Både applistan och registret går genom den här: de två får aldrig svara olika på frågan om
   * vem som äger en app.
   */
  async function withOwners<T extends { readonly appId: string; readonly ownerUserId: string }>(
    rows: readonly T[],
  ): Promise<{ row: T; access: readonly BuilderAccessEntry[]; ownerEmail: string | null }[]> {
    const listed = rows.map((row) => ({ row, access: [] as readonly BuilderAccessEntry[], ownerEmail: null as string | null }));
    for (const entry of listed) {
      entry.access = await accessFor(entry.row.appId);
      entry.ownerEmail = entry.access.find((a) => a.role === 'owner')?.email ?? null;
    }
    const ownerUserId = (entry: (typeof listed)[number]): string =>
      entry.access.find((a) => a.role === 'owner')?.userId ?? entry.row.ownerUserId;
    const unknown = listed.filter((entry) => entry.ownerEmail === null).map(ownerUserId);
    if (unknown.length > 0) {
      const emails = deps.users?.emails(unknown) ?? new Map<string, string>();
      for (const entry of listed) {
        if (entry.ownerEmail === null) entry.ownerEmail = emails.get(ownerUserId(entry)) ?? null;
      }
    }
    return listed;
  }

/**
   * Appens namn som kontrollrummet får visa det.
   *
   * En app som ägaren själv har döpt visas med sitt namn. En app som bär PLATTFORMENS standardnamn
   * gör det inte: standardnamnet är de första tecknen ur det första önskemålet (se `defaultName` i
   * api.ts), alltså exakt den text varken stopplistan eller registret får visa. Den texten kan
   * bära personuppgifter, och att den råkar stå i en namnkolumn gör den inte till ett namn.
   *
   * Ägaren ser fortfarande sitt standardnamn i sin egen lista — det är hennes egen text om hennes
   * egen app. Det som ändras är att den inte följer med hit.
   */
  function visatNamn(row: { readonly name: string; readonly nameIsDefault: boolean }): string {
    return row.nameIsDefault ? NAMNLOS : row.name;
  }

  function readRole(body: Record<string, unknown>): Role {
    const role = body['role'];
    if (!isRole(role)) throw invalid('Välj en roll: administratör, byggare eller den som bara tittar.');
    return role;
  }

  return {
    overview(): PlatformResponse {
      const since = windowStart();
      const counts = storage.countAllApps();
      const totals = storage.jobTotalsSince(since);
      const body: AdminOverview = {
        apps: counts.apps,
        published: counts.published,
        drafts: counts.drafts,
        // Utan bryggan till identiteten går siffrorna inte att veta. Nollor då: en tydlig nolla
        // är ärligare än en gissning.
        users: deps.users?.countByRole() ?? { ...NO_USERS },
        tokens: { input: totals.inputTokens, output: totals.outputTokens, jobs: totals.jobs },
        failedJobs: storage.failedJobsSince(since),
      };
      return json(200, body);
    },

    /**
     * Stoppade önskemål. Texten som stoppades finns inte i lagret och byggs inte heller ihop
     * här: kategorin och tidpunkten räcker för att se om en regel är för bred, och önskemålet
     * kan bära personuppgifter.
     */
    stops(): PlatformResponse {
      const stops: AdminStop[] = [];
      for (const row of storage.listStops(MAX_STOPS)) {
        // En kategori som inte finns i kontraktet kommer från en äldre version av vår egen kod.
        // Den utelämnas hellre än renderas: kontrollrummet ska inte visa ord ingen kan förklara.
        if (!REDLINE_CATEGORIES.includes(row.reason as RedlineCategory)) continue;
        stops.push({
          appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
          category: row.reason as RedlineCategory,
          at: row.at,
        });
      }
      return json(200, { stops });
    },

    async apps(): Promise<PlatformResponse> {
      const apps: AdminApp[] = (await withOwners(storage.listAllApps())).map(({ row, access, ownerEmail }) => ({
        // Bara prefixet. Resten av id:t lämnar aldrig det här lagret.
        appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        name: visatNamn(row),
        ownerEmail,
        updatedAt: row.updatedAt,
        hasDraft: row.hasDraft,
        published: row.published,
        members: access.length,
        tokens: { input: row.inputTokens, output: row.outputTokens },
      }));
      return json(200, { apps });
    },

    /**
     * AI-registret: varje app med hur känsliga uppgifter den hanterar, och hur den nivån sattes.
     *
     * Två saker att läsa noga. Klassen ur databasen prövas mot kontraktet och ett okänt eller
     * saknat värde blir den STRÄNGASTE klassen — en app som aldrig klassats, eller en rad skriven
     * av en äldre version av vår egen kod, får alltså aldrig se ofarligare ut än den är. Och
     * önskemålets text finns inte i svaret, av samma skäl som i stopplistan: registret svarar på
     * att appen finns och hur känslig den är, aldrig på vad någon har skrivit i den.
     */
    async register(): Promise<PlatformResponse> {
      const entries: AdminRegisterEntry[] = (await withOwners(storage.listRegister())).map(({ row, ownerEmail }) => ({
        appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        name: visatNamn(row),
        ownerEmail,
        classification: asClassification(row.classification),
        // En källa vi inte känner igen säger inget sant om hur klassen sattes. Då är svaret att vi
        // inte vet — vilket är precis vad `fail-closed` betyder.
        source: CLASSIFICATION_SOURCES.includes(row.source as ClassificationSource)
          ? (row.source as ClassificationSource)
          : 'fail-closed',
        // Tidpunkten följer bara med när klassen faktiskt är satt. En oklassad app läses som den
        // strängaste klassen, men den fick inte den klassen VID någon tidpunkt, och registret ska
        // inte hitta på en.
        classifiedAt: row.classification === null ? null : row.classifiedAt,
        published: row.published,
      }));
      return json(200, { entries });
    },

    users(identity: Identity): PlatformResponse {
      const users: AdminUser[] = directory()
        .list()
        .map((user) => adminUser(user, identity));
      return json(200, { users });
    },

    async invite(identity: Identity, body: Record<string, unknown>): Promise<PlatformResponse> {
      const users = directory();
      const raw = body['email'];
      if (typeof raw !== 'string') throw invalid('Skriv den e-postadress du vill bjuda in.');
      const email = raw.trim();
      if (email.length === 0 || email.length > MAX_EMAIL_CHARS) {
        throw invalid('Adressen ser inte ut att vara en e-postadress.');
      }
      const role = readRole(body);
      // `upsertUser` i identiteten HÖJER men sänker aldrig: en inbjudan kan inte användas för att
      // ta ifrån någon behörighet i smyg. Vill man sänka går det bara via den enskilda raden.
      let user: BuilderUser;
      try {
        user = await users.invite(email, role, deps.now().getTime());
      } catch (error) {
        throw asProblem(error);
      }
      return json(201, { user: adminUser(user, identity) });
    },

    setRole(identity: Identity, userId: string, body: Record<string, unknown>): PlatformResponse {
      const users = directory();
      // FÖRE rollen läses: beskedet ska handla om den egna raden, oavsett vad som stod i kroppen.
      // Rollen sätts rakt av här, så en administratör som pekar på sig själv är alltid på väg att
      // låsa ut sig — vägen tillbaka går bara över SSH in i en container.
      if (userId === identity.userId) {
        throw invalid('Du kan inte ändra din egen roll. Be en annan administratör göra det.');
      }
      const role = readRole(body);
      let user: BuilderUser;
      try {
        user = users.setRole(userId, role, deps.now().getTime());
      } catch (error) {
        throw asProblem(error);
      }
      return json(200, { user: adminUser(user, identity) });
    },
  };
}
