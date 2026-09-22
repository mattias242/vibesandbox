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
 *  - APPLISTAN bär hela app-id:t och adressen till appen, så att den som förvaltar plattformen
 *    kommer åt sina egna och sina delade appar utan att skriva av ett id för hand. Det ändrar
 *    ingenting om åtkomst: rollen `admin` ger enligt kontraktet ingen väg in i någon apps data,
 *    och länken till en app man inte äger eller fått delad leder till samma "finns inte" som en
 *    gissad adress. Övriga vyer — stopplistan, registret, granskningskön — visar fortfarande bara
 *    prefixet: de svarar på hur plattformen mår, inte på vilken app någon vill öppna. Och i
 *    driftloggen står bara prefixet, alltid: en logg läses av fler och sparas längre än ett svar.
 *  - Granskningsbeslutet bär `selfReview` när granskaren också är ägare. Det får bara hända när
 *    hon är plattformens ende administratör (se `finnsAnnanGranskare`), och då ska det synas.
 *  - Ägarens adress går i svaret men aldrig i en loggrad. Därför loggar den här modulen nästan
 *    inget: inte användarlistan, inte en inbjudan, inte ens en misslyckad. UNDANTAGET är
 *    granskningsbeslutet. Ett beslut om att släppa ut en app måste gå att följa i efterhand —
 *    det är hela poängen med en granskning — och raden bär bara det förkortade app-id:t och
 *    beslutet, aldrig granskarens adress, ägarens adress eller granskarens skäl. Skälet är fritext
 *    skriven av en människa om någon annans app, och hör hemma i samtalet, inte i driftloggen.
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
  REVIEW_DECISIONS,
  REVIEW_LIMITS,
  REVIEW_STATES,
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
  AdminReview,
  RedlineCategory,
  ReviewDecision,
  ReviewState,
  Role,
} from '@vibesandbox/contracts';

/**
 * Tak för hur många stopp kontrollrummet hämtar. Listan finns för att upptäcka en för bred regel,
 * inte för att vara ett arkiv — och ett svar utan tak växer med hur mycket någon råkat prova.
 */
const MAX_STOPS = 200;
import type { BuilderUser, BuilderUserDirectory } from './anvandare.ts';
import type { BuilderUrls } from './api.ts';
import { controlErrorCode, storedAppId } from './control.ts';
import type { BuilderAccessEntry, BuilderControl } from './control.ts';
import type { Storage, StoredReview } from './lagring.ts';
import { appIdPrefix } from './logg.ts';
import type { BuilderLogger } from './logg.ts';
import { ApiProblem, invalid, json, notFound } from './svar.ts';

export interface AdminDependencies {
  readonly storage: Storage;
  readonly control: BuilderControl;
  /** Appens adresser. Samma som ägaren ser i sin egen vy — kontrollrummet räknar inte ut egna. */
  readonly urls: BuilderUrls;
  /** Vägen till identiteten. Saknas den är användarhanteringen inte inkopplad. */
  readonly users?: BuilderUserDirectory;
  /** Bara granskningsbesluten loggas härifrån — se filhuvudet om varför just de. */
  readonly log: BuilderLogger;
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

/**
 * Beskeden till ägaren när ett ärende avgjorts. De läggs i samtalet om appen, så att hon ser dem
 * där hon redan tittar — och så att de står kvar efter en omladdning.
 *
 * Ett nej bär granskarens SKÄL ordagrant. Det är hela poängen: ett avslag utan skäl lämnar någon
 * med en app hon inte vet vad som är fel på, och nästa försök blir en gissning.
 */
const APPROVED_MESSAGE = 'Granskad och godkänd — appen är publicerad och går att dela.';
const REJECTED_MESSAGE = 'Granskningen säger nej, och så här står det: ';

export function createAdmin(deps: AdminDependencies): {
  overview(): PlatformResponse;
  apps(): Promise<PlatformResponse>;
  stops(): PlatformResponse;
  register(): Promise<PlatformResponse>;
  reviews(): Promise<PlatformResponse>;
  review(reviewId: string): Promise<PlatformResponse>;
  decide(identity: Identity, reviewId: string, body: Record<string, unknown>): Promise<PlatformResponse>;
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

  /**
   * Finns det en ANNAN administratör som kan granska?
   *
   * Frågan avgör om spärren mot att avgöra sin egen app gäller. Den är ställd så med flit: det är
   * inte antalet administratörer som betyder något utan om det finns någon att be. En ensam
   * förvaltare som inte får släppa ut sin egen app har inte granskats strängare — hon har bara
   * ingen väg ut alls, och en spärr utan nyckel är ingen kontroll.
   *
   * Utan bryggan till identiteten går frågan inte att besvara, och då svarar vi `true`: spärren
   * står kvar. Osäkerhet ska falla åt det stränga hållet, precis som klassningen gör. Plattformen
   * kopplar alltid in bryggan, så det fallet är en installation som avviker.
   */
  function finnsAnnanGranskare(identity: Identity): boolean {
    if (deps.users === undefined) return true;
    return deps.users.list().some((user) => user.role === 'admin' && user.userId !== identity.userId);
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
   * För en AVVECKLAD app finns ingen åtkomstlista kvar: `deleteApp` river den tillsammans med
   * appen. Ägaren kan då bara komma ur identiteten, och utan den inkopplad tappar registret
   * precis den uppgift det finns för att bevara. Plattformen kopplar alltid in den
   * (`users: identity.users`); en installation som inte gör det får ett register som inte kan
   * svara på vem som ägde en avvecklad app, och det är värt att veta om.
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

  /**
   * Ett granskningsärende som kontrollrummet visar det. Klass och källa prövas mot kontraktet och
   * faller åt det stränga hållet, precis som i registret: en app vars nivå inte går att läsa ska
   * inte se ofarligare ut för granskaren än den är.
   */
  function adminReview(
    row: StoredReview,
    ownerEmail: string | null,
    decided: { decidedAt: string; reason: string | null } | null,
  ): AdminReview {
    return {
      reviewId: row.reviewId,
      appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      name: visatNamn(row),
      ownerEmail,
      classification: asClassification(row.classification),
      classificationSource: CLASSIFICATION_SOURCES.includes(row.classificationSource as ClassificationSource)
        ? (row.classificationSource as ClassificationSource)
        : 'fail-closed',
      state: REVIEW_STATES.includes(row.state as ReviewState) ? (row.state as ReviewState) : 'vantar',
      requestedAt: row.requestedAt,
      decidedAt: decided?.decidedAt ?? row.decidedAt,
      reason: decided === null ? row.reason : decided.reason,
    };
  }

  /** Beslutet och skälet ur kroppen. Ett nej utan skäl går inte igenom — se `REJECTED_MESSAGE`. */
  function readDecision(body: Record<string, unknown>): { decision: ReviewDecision; reason: string | null } {
    const decision = body['decision'];
    if (!REVIEW_DECISIONS.includes(decision as ReviewDecision)) {
      throw invalid('Ange om appen godkänns eller avvisas.');
    }
    if (decision === 'godkand') return { decision, reason: null };
    const raw = body['reason'];
    const reason = typeof raw === 'string' ? raw.trim() : '';
    if (reason.length === 0) {
      throw invalid('Skriv varför appen inte kan publiceras. Ägaren får skälet ordagrant.');
    }
    if (reason.length > REVIEW_LIMITS.maxReasonChars) {
      throw invalid('Skälet är för långt. Håll det till det som behöver åtgärdas.');
    }
    return { decision: 'avvisad', reason };
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
        appId: row.appId,
        // Prefixet står kvar bredvid hela id:t: det är det man läser för att känna igen en app,
        // och det som en loggrad går att matcha mot.
        appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
        // Den publicerade adressen när den finns, annars ägarens förhandsvisning. En app som
        // aldrig byggts har ingen adress som svarar, och raden hittar inte på en.
        appUrl: row.published ? deps.urls.published(row.appId) : row.hasDraft ? deps.urls.preview(row.appId) : null,
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
        decommissionedAt: row.decommissionedAt,
        published: row.published,
      }));
      return json(200, { entries });
    },

    /**
     * Granskningskön: väntande ärenden, äldst först. Källkoden finns INTE här — kön ska gå att
     * öppna utan att varje apps kod läses ur databasen, och den hämtas för ett ärende i taget.
     *
     * Klassen står med, till skillnad från i applistan: granskaren ska se om nivån är ett omdöme
     * eller ett misslyckande innan hon läser koden. En app vars känslighet ingen kunnat avgöra är
     * inte samma sak att släppa ut som en app som prövats.
     */
    async reviews(): Promise<PlatformResponse> {
      const rows = storage.listPendingReviews(REVIEW_LIMITS.maxQueue);
      const owners = await withOwners(rows);
      const reviews: AdminReview[] = owners.map(({ row, ownerEmail }) => adminReview(row, ownerEmail, null));
      return json(200, { reviews });
    },

    /**
     * Ett ärende MED källkoden. Det här är den enda platsen i kontrollrummet där appens innehåll
     * lämnas ut, och det är avsiktligt: granskningen ÄR att någon läser koden. Allt annat i
     * kontrollrummet svarar på att appar finns, aldrig på vad som står i dem.
     */
    async review(reviewId: string): Promise<PlatformResponse> {
      const row = storage.review(reviewId);
      if (row === null) throw notFound();
      const [listed] = await withOwners([row]);
      const files = storage.reviewFiles(row.appId, row.versionId);
      // Revisionen är borta — då finns ingen kod att granska, och ärendet går inte att avgöra på
      // ett ärligt sätt. Hellre ett tydligt besked än en tom lista som ser ut som en app utan kod.
      if (files === null) throw new ApiProblem('unavailable', 'Koden som skulle granskas finns inte kvar. Be ägaren bygga om appen.');
      return json(200, { review: adminReview(row, listed?.ownerEmail ?? null, null), files });
    },

    /**
     * Beslutet. Godkänt publicerar EXAKT den version som granskades — inte det som råkar vara
     * senast byggt. Ett nej kräver ett skäl, och skälet går ordagrant till ägaren.
     *
     * En granskare får inte avgöra sin egen app SÅ LÄNGE det finns någon annan att be. En
     * administratör som bygger något är i det läget ägare, inte granskare, och ett godkännande av
     * sig själv är ingen granskning alls — men fyraögonsprincipen förutsätter fyra ögon. Se
     * `finnsAnnanGranskare`.
     */
    async decide(identity: Identity, reviewId: string, body: Record<string, unknown>): Promise<PlatformResponse> {
      const row = storage.review(reviewId);
      if (row === null) throw notFound();
      // Två skilda skäl till att ett ärende inte går att avgöra, och de ska inte få samma besked.
      // Ett tillbakadraget ärende är enligt kontraktet INGET beslut: ägaren byggde om, och ingen
      // hann läsa. Att svara "redan avgjort" vore att påstå att någon tagit ställning.
      if (row.state === 'tillbakadragen') {
        throw new ApiProblem('conflict', 'Ägaren har byggt om appen, så det här ärendet gäller inte längre. Ett nytt kommer när hen begär igen.');
      }
      if (row.state !== 'vantar') throw new ApiProblem('conflict', 'Ärendet är redan avgjort.');
      // Egen app: tillåtet bara för den som är ensam. Beslutet bär då `selfReview` i loggen, så
      // att det går att se i efterhand att ingen annan läste.
      const egenApp = row.ownerUserId === identity.userId;
      if (egenApp && finnsAnnanGranskare(identity)) {
        throw invalid('Du kan inte granska din egen app. Be en annan administratör göra det.');
      }
      const { decision, reason } = readDecision(body);

      // Publiceringen sker FÖRE beslutet skrivs. Går den fel har ingen app gått ut, och ärendet
      // står kvar som väntande så att någon kan försöka igen — hellre det än ett godkänt ärende
      // för en app som aldrig publicerades.
      if (decision === 'godkand') {
        try {
          await control.publish(storedAppId(row.appId), row.versionId);
        } catch {
          throw new ApiProblem('unavailable', 'Appen gick inte att publicera just nu. Försök igen om en stund.');
        }
        storage.markPublished(row.appId, row.versionId, deps.now().toISOString());
      }

      const now = deps.now().toISOString();
      // `false` betyder att ärendet slutade vänta medan vi arbetade — ägaren byggde om, eller en
      // annan granskare hann före. Villkoret sitter i SQL:en, inte i kontrollen ovanför.
      if (!storage.decideReview(reviewId, decision, identity.userId, reason, now)) {
        throw new ApiProblem('conflict', 'Ärendet är redan avgjort.');
      }
      storage.addAssistantMessage(row.appId, decision === 'godkand' ? APPROVED_MESSAGE : `${REJECTED_MESSAGE}${reason ?? ''}`, now);
      // Revisionsspåret. `status` är beslutet — ett fast ord ur kontraktet. Granskarens id går med
      // som `userId` (pseudonymt, aldrig adressen), skälet aldrig.
      const base = { appIdPrefix: appIdPrefix(row.appId), userId: identity.userId };
      deps.log({ level: 'info', event: 'review_decided', ...base, status: decision, ...(egenApp ? { selfReview: true } : {}) });
      if (decision === 'godkand') deps.log({ level: 'info', event: 'app_published', ...base });
      return json(200, { review: adminReview({ ...row, state: decision }, null, { decidedAt: now, reason }) });
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
