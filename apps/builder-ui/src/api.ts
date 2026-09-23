/**
 * En liten klient för byggverktygets HTTP-gränssnitt (se kontraktet, "Byggverktygets
 * HTTP-gränssnitt"). Allt går till RELATIVA adresser under `/_api/builder` på den egna origin,
 * med samma-origin-kakor. Skrivande anrop bär skyddshuvudet, som gatewayn kräver mot CSRF.
 *
 * Fel blir alltid `ApiError` med ett meddelande som går att visa rakt av för användaren.
 */
import {
  ADMIN_APP_ID_PREFIX_LENGTH,
  BUILDER_API_PREFIX,
  CLASSIFICATION_SOURCES,
  CSRF_HEADER,
  REDLINE_CATEGORIES,
  REVIEW_STATES,
  asClassification,
  isAppId,
  type AdminApp,
  type AdminFailedJob,
  type AdminOverview,
  type AdminRegisterEntry,
  type AdminReview,
  type AdminStop,
  type AdminUser,
  type AppExport,
  type ClassificationSource,
  type DecommissionEvidence,
  type RedlineCategory,
  type ReviewDecision,
  type ReviewState,
  type SourceFiles,
  type ApiErrorCode,
  type BuilderAppDetail,
  type BuilderAppMember,
  type BuilderAppSummary,
  type BuilderFeedback,
  type BuilderJob,
  type BuilderMe,
  type Role,
} from '@vibesandbox/contracts';

export class ApiError extends Error {
  /** HTTP-status, eller 0 när servern inte gick att nå. */
  readonly status: number;
  readonly code: ApiErrorCode | undefined;

  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  readonly fetch: typeof fetch;
  /** Anropas vid 401. I webbläsaren: ladda om, så skickar gatewayn till inloggningssidan. */
  readonly onUnauthenticated: () => void;
}

export type OpenTarget = 'preview' | 'published';

export interface ApiClient {
  me(): Promise<BuilderMe>;
  listApps(): Promise<readonly BuilderAppSummary[]>;
  createApp(name?: string): Promise<{ appId: string }>;
  getApp(appId: string): Promise<BuilderAppDetail>;
  sendMessage(appId: string, text: string): Promise<{ jobId: string }>;
  /**
   * Ägaren döper sin app. Namnet hon skriver ersätter plattformens avskrift av det första
   * önskemålet, och följer till skillnad från den med till kontrollrummet. Svaret är namnet som
   * det SPARADES (trimmat) — vyn visar serverns svar, aldrig det som hann skrivas i fältet.
   */
  renameApp(appId: string, name: string): Promise<{ name: string }>;
  getJob(jobId: string, after: number): Promise<BuilderJob>;
  /**
   * Ägaren BEGÄR publicering — hon publicerar inte. Rutten heter fortfarande `publish`, för det är
   * vad hon vill göra; svaret är ett väntande ärende, inte en adress. Adressen till den
   * publicerade appen kommer först när en granskare sagt ja, och då genom `getApp`.
   */
  requestReview(appId: string): Promise<{ state: 'vantar'; requestedAt: string }>;
  openUrl(appId: string, target: OpenTarget): Promise<string>;
  share(appId: string, email: string): Promise<void>;
  /**
   * Återkoppling på byggverktyget självt, till den som driver plattformen. `helpful: false`
   * kräver text och mejlas med hela konversationen om appen; `helpful: true` räknas bara.
   */
  sendFeedback(appId: string, feedback: BuilderFeedback): Promise<void>;
  /** Vilka som har åtkomst till appen, ägaren först. */
  listMembers(appId: string): Promise<readonly BuilderAppMember[]>;
  /** Tar bort en persons åtkomst. Gäller direkt. */
  removeMember(appId: string, memberId: string): Promise<void>;
  /**
   * Allt appen bär, som JSON att spara undan. Svaret plockas INTE isär fält för fält, till
   * skillnad från allt annat här. Skälet är att det aldrig ritas: det skrivs rakt till en fil.
   * Att kasta ett fält vi inte känner igen vore att tyst ta bort något ur en export vars hela
   * poäng är att vara fullständig — och den som får filen ska kunna lita på att inget saknas.
   */
  exportApp(appId: string): Promise<AppExport>;
  /**
   * Avvecklar appen: uppgifterna och filerna raderas och adressen slutar svara. `confirm` är
   * appens namn ORDAGRANT. Servern prövar det själv och svarar 400 när det inte stämmer — vyn
   * stänger knappen av omtanke, men kontrollen får aldrig bara sitta i vyn. Svaret är
   * gallringsbeviset: vad som fanns, räknat innan det försvann.
   */
  decommissionApp(appId: string, confirm: string): Promise<DecommissionEvidence>;
  /** Kontrollrummet: plattformens siffror. Kräver rollen `admin`; annars 403 från servern. */
  adminOverview(): Promise<AdminOverview>;
  /** Kontrollrummet: alla appar, senast ändrad först. Aldrig hela app-id:t. */
  adminApps(): Promise<readonly AdminApp[]>;
  /** Kontrollrummet: önskemål som stoppats av en röd linje. Aldrig med texten som stoppades. */
  adminStops(): Promise<readonly AdminStop[]>;
  /**
   * Kontrollrummet: bygg som gick fel, med kontrollens egna fel. Aldrig önskemålet, och aldrig
   * det byggverktyget skrev om det — båda är formulerade ur någons text.
   */
  adminFailedJobs(): Promise<readonly AdminFailedJob[]>;
  /** Kontrollrummet: AI-registret — varje app med sin känslighetsnivå och hur nivån sattes. */
  adminRegister(): Promise<readonly AdminRegisterEntry[]>;
  /** Kontrollrummet: granskningskön, äldst först. Aldrig med koden — den hämtas ett ärende i taget. */
  adminReviews(): Promise<readonly AdminReview[]>;
  /**
   * Kontrollrummet: ETT ärende, med källkoden. Det här är det enda anropet i hela kontrollrummet
   * som ber om innehållet i någons app, och det är avsiktligt: granskningen ÄR att någon läser koden.
   */
  adminReview(reviewId: string): Promise<{ review: AdminReview; files: SourceFiles }>;
  /** Kontrollrummet: granskarens beslut. Ett nej kräver ett skäl — servern avvisar annars med 400. */
  adminDecide(reviewId: string, decision: ReviewDecision, reason?: string): Promise<AdminReview>;
  /** Kontrollrummet: alla adresser som får logga in, och med vilken roll. */
  adminUsers(): Promise<readonly AdminUser[]>;
  /**
   * Bjuder in adressen, eller höjer rollen om den redan finns. Servern svarar likadant i båda
   * fallen, så vyn avgör själv vilket det var genom att se efter i listan den redan har.
   */
  adminInvite(email: string, role: Role): Promise<AdminUser>;
  /** Sätter rollen rakt av — den enda vägen att sänka. Den egna raden avvisas av servern. */
  adminSetRole(userId: string, role: Role): Promise<AdminUser>;
}

export const NETWORK_ERROR_MESSAGE = 'Kunde inte nå servern. Kontrollera uppkopplingen och försök igen.';
const GENERIC_ERROR_MESSAGE = 'Något gick fel hos oss. Försök igen om en stund.';

/** Standardmeddelanden när servern inte skickade ett läsbart fel. */
export function fallbackMessage(status: number): string {
  if (status === 0) return NETWORK_ERROR_MESSAGE;
  if (status === 400) return 'Något i det du skickade stämmer inte. Kontrollera och försök igen.';
  if (status === 401) return 'Du behöver logga in igen.';
  if (status === 403) return 'Du har inte behörighet att göra det här.';
  if (status === 404) return 'Det du letar efter finns inte, eller så har du inte tillgång till det.';
  if (status === 409) return 'Det går inte att göra det just nu. Vänta en stund och försök igen.';
  if (status === 413) return 'Texten är för lång. Försök att korta den.';
  if (status === 429) return 'Du har gjort många försök på kort tid. Vänta en stund och försök igen.';
  // 503 betyder att något plattformen behöver inte svarar — eller inte är inkopplat alls. Texten
  // säger att det inte går NU, aldrig att användaren gjort fel: hon har inte gjort något fel.
  if (status === 503) return 'Den funktionen går inte att använda just nu. Försök igen om en stund.';
  return GENERIC_ERROR_MESSAGE;
}

/**
 * Id:n sätts in i sökvägen. Ett id som `..` eller `a/b` skulle leda anropet till en annan
 * sökväg (fetch normaliserar punktsegment), så bara ett snävt teckenförråd godtas.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string, message = 'Den här appen finns inte.'): string {
  if (!ID_PATTERN.test(id)) throw new ApiError(400, message);
  return id;
}

/**
 * Åtkomstlistan styr vilka knappar som visas och vilket id som hamnar i en sökväg vid borttagning,
 * så varje rad kontrolleras. En rad som inte stämmer gör hela svaret ogiltigt.
 */
function checkMembers(value: unknown): readonly BuilderAppMember[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    const { memberId, email, role } = item as Record<string, unknown>;
    if (
      typeof memberId !== 'string' ||
      !ID_PATTERN.test(memberId) ||
      typeof email !== 'string' ||
      email === '' ||
      email.length > 254 ||
      (role !== 'owner' && role !== 'user')
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return { memberId, email, role };
  });
}

/** Ett antal från servern: ett helt tal som inte kan vara negativt. Allt annat är ett trasigt svar. */
function checkCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value as Record<string, unknown>;
}

/** Kontrollrummets siffror. Ett fält som saknas blir ett fel, aldrig en nolla som ser ut som ett svar. */
function checkOverview(value: unknown): AdminOverview {
  const body = fields(value);
  const users = fields(body['users']);
  const tokens = fields(body['tokens']);
  return {
    apps: checkCount(body['apps']),
    published: checkCount(body['published']),
    drafts: checkCount(body['drafts']),
    users: {
      admin: checkCount(users['admin']),
      builder: checkCount(users['builder']),
      viewer: checkCount(users['viewer']),
    },
    tokens: {
      input: checkCount(tokens['input']),
      output: checkCount(tokens['output']),
      jobs: checkCount(tokens['jobs']),
    },
    failedJobs: checkCount(body['failedJobs']),
  };
}

/**
 * En kategori servern skickar men kontraktet inte känner kommer från en annan version av vår egen
 * kod. Den avvisas hellre än ritas: kontrollrummet ska aldrig visa ett ord som ingen kan förklara.
 * Fälten plockas ett och ett, så att ett fält för mycket — till exempel önskemålets text — aldrig
 * följer med in i vyn.
 */
function checkAdminStops(value: unknown): readonly AdminStop[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    const { appIdPrefix, category, at } = fields(item);
    if (
      typeof appIdPrefix !== 'string' ||
      appIdPrefix.length === 0 ||
      appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
      !ID_PATTERN.test(appIdPrefix) ||
      typeof category !== 'string' ||
      !REDLINE_CATEGORIES.includes(category as RedlineCategory) ||
      typeof at !== 'string' ||
      at === ''
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return { appIdPrefix, category: category as RedlineCategory, at };
  });
}

/**
 * Bygg som gick fel. Fälten plockas ett och ett, som i de övriga adminvyerna — och här är det
 * viktigare än någon annanstans: servern får inte kunna råka skicka med agentens ord eller
 * önskemålets text och få dem ritade. Det som inte står i listan nedan når aldrig vyn.
 *
 * Diagnosens `source` prövas mot kontraktets tre värden. Ett okänt värde fäller inte raden —
 * felet är fortfarande sant och användbart — men källan ritas då som okänd hellre än med ett ord
 * ingen kan förklara. `rule`, `file` och `line` är frivilliga hos kontraktet och kan alltså saknas.
 */
function checkAdminFailedJobs(value: unknown): readonly AdminFailedJob[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    const { appIdPrefix, name, ownerEmail, failedAt, problems, diagnostics } = fields(item);
    if (
      typeof appIdPrefix !== 'string' ||
      appIdPrefix.length === 0 ||
      appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
      !ID_PATTERN.test(appIdPrefix) ||
      typeof name !== 'string' ||
      (ownerEmail !== null && typeof ownerEmail !== 'string') ||
      typeof failedAt !== 'string' ||
      failedAt === '' ||
      typeof problems !== 'number' ||
      !Number.isInteger(problems) ||
      problems < 0 ||
      !Array.isArray(diagnostics)
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return {
      appIdPrefix,
      name,
      ownerEmail,
      failedAt,
      problems,
      diagnostics: diagnostics.map((rad: unknown) => {
        const { source, rule, file, line, message } = fields(rad);
        if (typeof message !== 'string' || message === '') throw new ApiError(500, GENERIC_ERROR_MESSAGE);
        return {
          source: source === 'policy' || source === 'typecheck' || source === 'build' ? source : 'build',
          ...(typeof rule === 'string' ? { rule } : {}),
          ...(typeof file === 'string' ? { file } : {}),
          ...(typeof line === 'number' && Number.isInteger(line) ? { line } : {}),
          message,
        };
      }),
    };
  });
}

/**
 * AI-registret. Formen kontrolleras lika hårt som applistans — samma förkortade app-id, samma
 * ägarfält — men nivån och källan avvisas INTE när de är okända, till skillnad från stopplistans
 * kategori. Skillnaden är avsiktlig: en okänd kategori i stopplistan går att hoppa över utan att
 * något blir osant, medan en okänd nivå i registret läses som den STRÄNGASTE (`asClassification`
 * i kontraktet). Att fälla hela registret på en rad vore att visa en tillsyn ingenting alls, och
 * att rita raden som den är vore att gissa lågt. Fail-closed är det tredje svaret: visa raden,
 * på den strängaste nivån, med källan "det gick inte att avgöra".
 *
 * Fälten plockas ett och ett, så att ett fält för mycket — önskemålets text — aldrig följer med.
 *
 * `decommissionedAt` prövas som `classifiedAt`: en tidpunkt eller `null`, aldrig något däremellan.
 * En avvecklad app står kvar i registret, och raden är det enda som finns kvar av den — då får
 * inte tidpunkten vara ett värde som vyn tvingas gissa om.
 */
function checkAdminRegister(value: unknown): readonly AdminRegisterEntry[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    const row = fields(item);
    const { appIdPrefix, name, ownerEmail, classifiedAt, published, decommissionedAt } = row;
    if (
      typeof appIdPrefix !== 'string' ||
      appIdPrefix.length === 0 ||
      appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
      !ID_PATTERN.test(appIdPrefix) ||
      typeof name !== 'string' ||
      name === '' ||
      name.length > 200 ||
      (ownerEmail !== null && (typeof ownerEmail !== 'string' || ownerEmail === '' || ownerEmail.length > 254)) ||
      (classifiedAt !== null && (typeof classifiedAt !== 'string' || classifiedAt === '')) ||
      typeof published !== 'boolean' ||
      (decommissionedAt !== null && (typeof decommissionedAt !== 'string' || decommissionedAt === ''))
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    const source = row['source'];
    return {
      appIdPrefix,
      name,
      ownerEmail,
      classification: asClassification(row['classification']),
      source: CLASSIFICATION_SOURCES.includes(source as ClassificationSource)
        ? (source as ClassificationSource)
        : 'fail-closed',
      classifiedAt,
      published,
      decommissionedAt,
    };
  });
}

/**
 * Gallringsbeviset, så som ägaren får se det. Siffrorna är hela svaret på frågan "vad försvann?",
 * och de går inte att räkna om i efterhand — det finns inget kvar att räkna. Därför fälls ett svar
 * där de inte är riktiga tal, hellre än att visa en nolla som läses som ett besked om att appen
 * var tom.
 */
function checkEvidence(value: unknown): DecommissionEvidence {
  const row = fields(value);
  const { appIdPrefix, decommissionedAt } = row;
  if (
    typeof appIdPrefix !== 'string' ||
    appIdPrefix.length === 0 ||
    appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
    !ID_PATTERN.test(appIdPrefix) ||
    typeof decommissionedAt !== 'string' ||
    decommissionedAt === ''
  ) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  return {
    appIdPrefix,
    decommissionedAt,
    documentsDeleted: checkCount(row['documentsDeleted']),
    filesDeleted: checkCount(row['filesDeleted']),
  };
}

/**
 * Kontrollrummets applista. Radens fält plockas ett och ett: bara kontraktets fält går vidare, och
 * varje fält prövas mot sin egen form.
 *
 * `appId` och `appUrl` är vägarna in i appen, och därför de två som måste prövas hårdast. Id:t
 * ska vara ett app-id — inte vilket id som helst — för att aldrig kunna bli en annan sökväg när
 * det sätts in i en fragmentadress. Adressen går genom `checkHttpUrl`, som bara släpper igenom
 * http(s): en `javascript:`-adress i ett `href` vore körbar kod från servern.
 *
 * Fälten här och `AdminApp` i kontraktet måste följas åt. Ett fält som saknas här blir `undefined`
 * i vyn utan att något går sönder högljutt — det var precis så `#/app/undefined` uppstod.
 */
function checkAdminApps(value: unknown): readonly AdminApp[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => {
    const row = fields(item);
    const { appId, appIdPrefix, appUrl, name, ownerEmail, updatedAt, hasDraft, published } = row;
    const tokens = fields(row['tokens']);
    if (
      typeof appId !== 'string' ||
      !isAppId(appId) ||
      typeof appIdPrefix !== 'string' ||
      appIdPrefix.length === 0 ||
      appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
      !ID_PATTERN.test(appIdPrefix) ||
      // Prefixet ska vara början av id:t. En rad där de två inte hör ihop är obegriplig, och att
      // visa den hade satt ett igenkänningsbart prefix bredvid en länk till en annan app.
      !appId.startsWith(appIdPrefix) ||
      typeof name !== 'string' ||
      name === '' ||
      name.length > 200 ||
      (ownerEmail !== null && (typeof ownerEmail !== 'string' || ownerEmail === '' || ownerEmail.length > 254)) ||
      typeof updatedAt !== 'string' ||
      typeof hasDraft !== 'boolean' ||
      typeof published !== 'boolean'
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    return {
      appId,
      appIdPrefix,
      // `null` betyder att appen aldrig byggts och alltså inte har någon adress som svarar. Allt
      // annat ska vara en riktig http(s)-adress.
      appUrl: appUrl === null ? null : checkHttpUrl(appUrl),
      name,
      ownerEmail,
      updatedAt,
      hasDraft,
      published,
      members: checkCount(row['members']),
      tokens: { input: checkCount(tokens['input']), output: checkCount(tokens['output']) },
    };
  });
}

/**
 * Ett granskningsärende. Formen kontrolleras som registrets, och av samma skäl faller nivån och
 * källan åt det stränga hållet i stället för att fälla raden: en app vars nivå inte går att läsa
 * ska inte försvinna ur kön — då hade den aldrig blivit granskad alls.
 *
 * Läget behandlas likadant. Ett ord vi inte känner igen läses som `vantar`, alltså som att ärendet
 * fortfarande behöver en läsare. Det är det försiktiga svaret: värst som kan hända är att en
 * granskare öppnar något som redan är avgjort, och då säger servern ifrån.
 *
 * `reviewId` hamnar i en sökväg när ärendet öppnas eller avgörs, så det prövas mot samma snäva
 * teckenförråd som övriga id:n — innan det kan nå ett anrop.
 */
function checkAdminReview(value: unknown): AdminReview {
  const row = fields(value);
  const { reviewId, appIdPrefix, name, ownerEmail, requestedAt, decidedAt, reason } = row;
  if (
    typeof reviewId !== 'string' ||
    !ID_PATTERN.test(reviewId) ||
    typeof appIdPrefix !== 'string' ||
    appIdPrefix.length === 0 ||
    appIdPrefix.length > ADMIN_APP_ID_PREFIX_LENGTH ||
    !ID_PATTERN.test(appIdPrefix) ||
    typeof name !== 'string' ||
    name === '' ||
    name.length > 200 ||
    (ownerEmail !== null && (typeof ownerEmail !== 'string' || ownerEmail === '' || ownerEmail.length > 254)) ||
    typeof requestedAt !== 'string' ||
    requestedAt === '' ||
    (decidedAt !== null && (typeof decidedAt !== 'string' || decidedAt === '')) ||
    (reason !== null && typeof reason !== 'string')
  ) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  const source = row['classificationSource'];
  const state = row['state'];
  return {
    reviewId,
    appIdPrefix,
    name,
    ownerEmail,
    classification: asClassification(row['classification']),
    classificationSource: CLASSIFICATION_SOURCES.includes(source as ClassificationSource)
      ? (source as ClassificationSource)
      : 'fail-closed',
    state: REVIEW_STATES.includes(state as ReviewState) ? (state as ReviewState) : 'vantar',
    requestedAt,
    decidedAt,
    reason,
  };
}

function checkAdminReviews(value: unknown): readonly AdminReview[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => checkAdminReview(item));
}

/**
 * Källkoden som ska granskas. Innehållet är AI-skriven kod och får vara vad som helst — den visas
 * som text och körs aldrig här. Filnamnen är det som behöver hållas i styr: de blir rubriker i
 * vyn, och ett "namn" med styrtecken eller sökvägsknep hör inte hemma i en lista över filer.
 *
 * En fil som inte går att lita på fäller hela svaret. Det är inte samma avvägning som i registret:
 * där vore en tom sida värre än en sträng rad, här är en HALV kodbas det värsta av allt — en
 * granskare som tror att hon läst appen har då släppt ut det hon inte såg.
 */
const SOURCE_PATH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]|\/(?=[A-Za-z0-9]))*$/;

function checkSourceFiles(value: unknown): SourceFiles {
  const row = fields(value);
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(row)) {
    if (
      path.length === 0 ||
      path.length > 200 ||
      !SOURCE_PATH_PATTERN.test(path) ||
      path.includes('..') ||
      typeof content !== 'string'
    ) {
      throw new ApiError(500, GENERIC_ERROR_MESSAGE);
    }
    files[path] = content;
  }
  return files;
}

/**
 * En rad ur kontrollrummets adresslista. Hårdare än den ser ut: `userId` hamnar i sökvägen när en
 * roll sätts, och `role` styr vilken knapp vyn visar — en roll utanför kontraktet skulle lämna
 * vyn i ett läge den inte kan rita. `self` avgör om raden får en knapp alls, så en rad utan det
 * fältet är inte ett tomt värde utan ett trasigt svar.
 */
function checkAdminUser(value: unknown): AdminUser {
  const row = fields(value);
  const { userId, email, role, createdAt, self } = row;
  if (
    typeof userId !== 'string' ||
    !ID_PATTERN.test(userId) ||
    typeof email !== 'string' ||
    email === '' ||
    email.length > 254 ||
    (role !== 'admin' && role !== 'builder' && role !== 'viewer') ||
    typeof createdAt !== 'string' ||
    createdAt === '' ||
    typeof self !== 'boolean'
  ) {
    throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  }
  return { userId, email, role, createdAt, self };
}

function checkAdminUsers(value: unknown): readonly AdminUser[] {
  if (!Array.isArray(value)) throw new ApiError(500, GENERIC_ERROR_MESSAGE);
  return value.map((item: unknown) => checkAdminUser(item));
}

/** Adresser från servern hamnar i en iframe eller en länk — bara http(s) godtas, aldrig `javascript:`. */
function checkHttpUrl(value: unknown): string {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // faller igenom till felet nedan
    }
  }
  throw new ApiError(500, GENERIC_ERROR_MESSAGE);
}

function readErrorBody(body: unknown): { code: ApiErrorCode; message: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || typeof message !== 'string' || message.trim() === '' || message.length > 500) {
    return undefined;
  }
  return { code: code as ApiErrorCode, message };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    // Alla skrivande anrop behandlas lika: skyddshuvud och en JSON-kropp (tom när inget skickas).
    if (method !== 'GET') {
      headers[CSRF_HEADER] = '1';
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await options.fetch(`${BUILDER_API_PREFIX}${path}`, init);
    } catch {
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      if (response.status === 401) options.onUnauthenticated();
      const error = readErrorBody(parsed);
      throw new ApiError(response.status, error?.message ?? fallbackMessage(response.status), error?.code);
    }
    if (parsed === undefined) throw new ApiError(response.status, GENERIC_ERROR_MESSAGE);
    return parsed as T;
  }

  return {
    me: () => request<BuilderMe>('GET', '/me'),

    listApps: async () => (await request<{ apps: readonly BuilderAppSummary[] }>('GET', '/apps')).apps,

    createApp: (name) => request('POST', '/apps', name === undefined ? {} : { name }),

    getApp: async (appId) => request<BuilderAppDetail>('GET', `/apps/${checkId(appId)}`),

    sendMessage: async (appId, text) => request('POST', `/apps/${checkId(appId)}/messages`, { text }),

    renameApp: async (appId, name) => request('POST', `/apps/${checkId(appId)}/namn`, { name }),

    getJob: async (jobId, after) => {
      if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, fallbackMessage(400));
      return request<BuilderJob>('GET', `/jobs/${checkId(jobId)}?after=${after}`);
    },

    requestReview: async (appId) => {
      const result = await request<{ review?: unknown }>('POST', `/apps/${checkId(appId)}/publish`);
      const review = fields(result.review);
      const requestedAt = review['requestedAt'];
      // Det enda ärliga svaret på en begäran är att den väntar. Säger servern något annat — ett
      // godkännande i samma andetag — är det inte ett svar vyn ska visa som om hon publicerat.
      if (review['state'] !== 'vantar' || typeof requestedAt !== 'string' || requestedAt === '') {
        throw new ApiError(500, GENERIC_ERROR_MESSAGE);
      }
      return { state: 'vantar', requestedAt };
    },

    openUrl: async (appId, target) => {
      const result = await request<{ url?: unknown }>('GET', `/apps/${checkId(appId)}/open?target=${target}`);
      return checkHttpUrl(result.url);
    },

    share: async (appId, email) => {
      await request('POST', `/apps/${checkId(appId)}/share`, { email });
    },

    sendFeedback: async (appId, feedback) => {
      // Kroppen byggs fält för fält: bara kontraktets två fält går iväg, aldrig något som
      // råkat följa med objektet. Texten utelämnas helt när den saknas (tumme upp).
      const body: { helpful: boolean; text?: string } = { helpful: feedback.helpful };
      if (feedback.text !== undefined) body.text = feedback.text;
      await request('POST', `/apps/${checkId(appId)}/feedback`, body);
    },

    listMembers: async (appId) => {
      const result = await request<{ members?: unknown }>('GET', `/apps/${checkId(appId)}/members`);
      return checkMembers(result.members);
    },

    removeMember: async (appId, memberId) => {
      const path = `/apps/${checkId(appId)}/members/${checkId(memberId, 'Den personen finns inte i listan.')}`;
      await request('DELETE', path);
    },

    exportApp: async (appId) => {
      const body = await request<unknown>('GET', `/apps/${checkId(appId)}/export`);
      // Bara att svaret ÄR ett objekt prövas, av skälet som står vid gränssnittet ovan: exporten
      // skrivs till en fil och ritas aldrig, så ett okänt fält ska följa med — inte kastas bort.
      fields(body);
      return body as AppExport;
    },

    decommissionApp: async (appId, confirm) => {
      const path = `/apps/${checkId(appId)}/avveckla`;
      // Kroppen byggs fält för fält: bara namnet ägaren skrev går iväg.
      const result = await request<{ evidence?: unknown }>('POST', path, { confirm });
      return checkEvidence(result.evidence);
    },

    adminOverview: async () => checkOverview(await request<unknown>('GET', '/admin/oversikt')),

    adminApps: async () => checkAdminApps((await request<{ apps?: unknown }>('GET', '/admin/appar')).apps),
    adminStops: async () => checkAdminStops((await request<{ stops?: unknown }>('GET', '/admin/stopp')).stops),

    adminFailedJobs: async () =>
      checkAdminFailedJobs((await request<{ jobs?: unknown }>('GET', '/admin/byggfel')).jobs),

    adminRegister: async () =>
      checkAdminRegister((await request<{ entries?: unknown }>('GET', '/admin/register')).entries),

    adminReviews: async () =>
      checkAdminReviews((await request<{ reviews?: unknown }>('GET', '/admin/granskning')).reviews),

    adminReview: async (reviewId) => {
      const path = `/admin/granskning/${checkId(reviewId, 'Det här ärendet finns inte.')}`;
      const result = await request<{ review?: unknown; files?: unknown }>('GET', path);
      return { review: checkAdminReview(result.review), files: checkSourceFiles(result.files) };
    },

    adminDecide: async (reviewId, decision, reason) => {
      const path = `/admin/granskning/${checkId(reviewId, 'Det här ärendet finns inte.')}`;
      // Kroppen byggs fält för fält: beslutet alltid, skälet bara när det finns. Ett godkännande
      // bär aldrig med sig text som råkat stå kvar i rutan.
      const body: { decision: ReviewDecision; reason?: string } = { decision };
      if (reason !== undefined) body.reason = reason;
      return checkAdminReview((await request<{ review?: unknown }>('POST', path, body)).review);
    },

    adminUsers: async () => checkAdminUsers((await request<{ users?: unknown }>('GET', '/admin/anvandare')).users),

    adminInvite: async (email, role) => {
      // Kroppen byggs fält för fält: bara adressen och rollen går iväg.
      const result = await request<{ user?: unknown }>('POST', '/admin/anvandare', { email, role });
      return checkAdminUser(result.user);
    },

    adminSetRole: async (userId, role) => {
      const path = `/admin/anvandare/${checkId(userId, 'Den personen finns inte i listan.')}`;
      return checkAdminUser((await request<{ user?: unknown }>('POST', path, { role })).user);
    },
  };
}
