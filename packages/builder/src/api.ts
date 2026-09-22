/**
 * Byggverktygets HTTP-gränssnitt under `BUILDER_API_PREFIX`, exakt enligt kommentaren i kontraktet.
 *
 * Ordningen i varje anrop: rutt (404) → metod (405) → roll (403) → indata (400) → ägarskap (404)
 * → tillstånd (409). Indata kontrolleras FÖRE ägarskapet, så att ett felaktigt anrop ger samma svar
 * oavsett om appen finns — ägarskapskontrollen är sist av det som kan röja något.
 *
 * Gatewayn har redan gjort inloggning och CSRF-kontroll (`Origin` + skyddshuvud) innan något når
 * hit — för alla skrivande metoder, DELETE inräknat; det här lagret litar på `request.identity`
 * och på inget annat i förfrågan.
 *
 * "Ägare" betyder här den som skapade appen i byggverktyget (byggverktygets databas). Den som fått
 * appen delad med sig har åtkomst i control men äger inget här: för hen "finns" appen inte (404).
 */
import { randomBytes } from 'node:crypto';
import { BUILDER_API_PREFIX, DataApiError, isAppId, REVIEW_STATES } from '@vibesandbox/contracts';
import type {
  AppServiceName,
  BuilderAppDetail,
  BuilderAppMember,
  BuilderAppSummary,
  BuilderJob,
  BuilderMe,
  Identity,
  InvitationService,
  PlatformRequest,
  PlatformResponse,
  ReviewState,
} from '@vibesandbox/contracts';
import { createAdmin } from './admin.ts';
import type { BuilderUserDirectory } from './anvandare.ts';
import { composeFeedbackMail } from './aterkoppling.ts';
import type { FeedbackMailer } from './aterkoppling.ts';
import { controlErrorCode, storedAppId } from './control.ts';
import type { BuilderControl } from './control.ts';
import type { JobRunner } from './ko.ts';
import type { Storage, StoredApp } from './lagring.ts';
import { appIdPrefix, describeError } from './logg.ts';
import type { BuilderLogger } from './logg.ts';
import { ApiProblem, conflict, internal, invalid, json, notFound, problemResponse } from './svar.ts';

export interface BuilderUrls {
  /** Förhandsvisningens adress, t.ex. `https://p-<appId>.<BASE_DOMAIN>/`. */
  preview(appId: string): string;
  /** Den publicerade appens adress, t.ex. `https://<appId>.<BASE_DOMAIN>/`. */
  published(appId: string): string;
}

export interface ApiDependencies {
  readonly storage: Storage;
  readonly runner: JobRunner;
  readonly control: BuilderControl;
  /** Vägen till identiteten, för kontrollrummet. Valfri — se anvandare.ts. */
  readonly users?: BuilderUserDirectory;
  readonly invitations: InvitationService;
  /** Vägen för återkoppling på byggverktyget till plattformens ägare. */
  readonly feedback: FeedbackMailer;
  readonly urls: BuilderUrls;
  readonly openUrl: (identity: Identity, targetUrl: string) => string;
  /** Påslagna plattformstjänster, redan kontrollerade och i plattformens ordning. */
  readonly services: readonly AppServiceName[];
  readonly version?: string;
  readonly log: BuilderLogger;
  readonly now: () => Date;
}

/** 128 bitar slump som hex. Ett jobb-id ger ingen åtkomst i sig — ägarskapet kontrolleras alltid. */
export const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

export function newJobId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Ett granskningsärendes id. Samma form som ett jobb-id och lika ogenomskinligt: det ger ingen
 * åtkomst i sig — rutten kräver plattformsrollen `admin`, precis som resten av kontrollrummet.
 */
export const REVIEW_ID_PATTERN = /^[0-9a-f]{32}$/;

export function newReviewId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Beskedet när ägaren begär publicering av en app som redan väntar på granskning. Det ska läsas
 * som "det är redan igång", inte som ett fel hon gjort.
 */
const REVIEW_ALREADY_PENDING =
  'Appen väntar redan på granskning. Du får besked så snart någon har tittat på den.';

const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 4000;
const MAX_EMAIL_CHARS = 254;
const DEFAULT_NAME = 'Namnlös app';
const NAME_FROM_REQUEST_CHARS = 60;

/** Högst så många delningar per ägare och timme — varje delning skickar ett mejl. */
export const MAX_SHARES_PER_HOUR = 20;

/**
 * Högst så många återkopplingar per person och timme. Gränsen gäller båda tummarna: en tumme ner
 * mejlar plattformens ägare, och en uppskattning som kan skruvas upp fritt är ingen signal.
 */
export const MAX_FEEDBACK_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Ett medlems-id är ett användar-id: 128 bitar base64url (22 tecken) från identitetspaketet,
 * `test-<22 tecken>` i testläget. Teckenmängden utesluter allt som kan betyda något i en sökväg
 * eller en logg (`/`, `.`, `%`, NUL, blanktecken); längden tar höjd för andra leverantörers id.
 */
export const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `after`: ett heltal ≥ 0 utan inledande nollor eller tecken; nio siffror räcker gott (taket är 500). */
const AFTER_PATTERN = /^(?:0|[1-9][0-9]{0,8})$/;

/**
 * Styrtecken är aldrig meningsfulla i ett namn och kan förvränga hur det visas (NUL, radbrytning,
 * riktningsbyten som vänder texten). I ett önskemål tillåts radbrytning och tabb.
 */
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

const BUILDER_ROLES = new Set(['builder', 'admin']);

function canBuild(identity: Identity): boolean {
  return identity.roles.some((role) => BUILDER_ROLES.has(role));
}

function isAdmin(identity: Identity): boolean {
  return identity.roles.includes('admin');
}

/**
 * Kontrollrummet kräver plattformsrollen `admin`. Rollen `builder` räcker INTE — den som får bygga
 * appar får inte därmed se allas. Kontrollen görs per rutt, inte i `matchRoute`: en rutt som inte
 * finns ska svara likadant oavsett vem som frågar.
 */
function requireAdmin(identity: Identity): void {
  if (!isAdmin(identity)) {
    throw new ApiProblem('forbidden', 'Kontrollrummet är bara för plattformens administratörer.');
  }
}

/** Antal tecken (kodpunkter), inte UTF-16-enheter — så att å och emoji räknas som ett tecken var. */
function characterCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function firstCharacters(value: string, max: number): string {
  const characters = [...value];
  return characters.length > max ? `${characters.slice(0, max).join('').trimEnd()}…` : value;
}

function displayName(identity: Identity): string {
  const local = identity.email.split('@')[0] ?? '';
  const name = firstCharacters(local, 64);
  return name.length > 0 ? name : 'du';
}

type Route =
  | { readonly kind: 'me' }
  | { readonly kind: 'apps' }
  | { readonly kind: 'app'; readonly appId: string }
  | { readonly kind: 'messages'; readonly appId: string }
  | { readonly kind: 'publish'; readonly appId: string }
  | { readonly kind: 'open'; readonly appId: string }
  | { readonly kind: 'share'; readonly appId: string }
  | { readonly kind: 'feedback'; readonly appId: string }
  | { readonly kind: 'members'; readonly appId: string }
  | { readonly kind: 'member'; readonly appId: string; readonly memberId: string }
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'adminOverview' }
  | { readonly kind: 'adminApps' }
  | { readonly kind: 'adminStops' }
  | { readonly kind: 'adminRegister' }
  | { readonly kind: 'adminReviews' }
  | { readonly kind: 'adminReview'; readonly reviewId: string }
  | { readonly kind: 'adminUsers' }
  | { readonly kind: 'adminUser'; readonly userId: string };

const METHODS: Readonly<Record<Route['kind'], readonly string[]>> = {
  me: ['GET'],
  apps: ['GET', 'POST'],
  app: ['GET'],
  messages: ['POST'],
  publish: ['POST'],
  open: ['GET'],
  share: ['POST'],
  feedback: ['POST'],
  members: ['GET'],
  member: ['DELETE'],
  job: ['GET'],
  // Kontrollrummets två vyer är ren läsning: det finns ingen skrivande metod att neka på annat
  // sätt än 405. Användarhanteringen skriver — men bara med POST: en roll sätts, tas aldrig bort.
  adminOverview: ['GET'],
  adminApps: ['GET'],
  adminStops: ['GET'],
  adminRegister: ['GET'],
  adminReviews: ['GET'],
  adminReview: ['GET', 'POST'],
  adminUsers: ['GET', 'POST'],
  adminUser: ['POST'],
};

const APP_ACTIONS = new Set(['messages', 'publish', 'open', 'share', 'feedback', 'members'] as const);

/** Sökvägen efter prefixet, segment för segment, med exakta jämförelser. Ingen normalisering. */
function matchRoute(path: string): Route | null {
  if (!path.startsWith(`${BUILDER_API_PREFIX}/`)) return null;
  const segments = path.slice(BUILDER_API_PREFIX.length + 1).split('/');
  const [first, second, third, fourth, ...rest] = segments;
  if (rest.length > 0) return null;
  if (fourth !== undefined) {
    // Det enda med fyra segment: apps/:appId/members/:memberId. Ett tomt medlems-id är ingen rutt.
    if (first === 'apps' && second !== undefined && second.length > 0 && third === 'members' && fourth.length > 0) {
      return { kind: 'member', appId: second, memberId: fourth };
    }
    return null;
  }
  if (first === 'me' && second === undefined) return { kind: 'me' };
  if (first === 'apps' && second === undefined) return { kind: 'apps' };
  if (first === 'apps' && second !== undefined && second.length > 0) {
    if (third === undefined) return { kind: 'app', appId: second };
    for (const action of APP_ACTIONS) if (third === action) return { kind: action, appId: second };
    return null;
  }
  if (first === 'jobs' && second !== undefined && second.length > 0 && third === undefined) {
    return { kind: 'job', jobId: second };
  }
  // Kontrollrummet: fasta sökvägar, och ett användar-id som enda rörliga del. Jämförelsen är
  // exakt, så `/admin`, `/admin/`, `/admin/Oversikt` och `/admin/oversikt/extra` är alla lika
  // mycket "ingen rutt". Rollen kontrolleras i `dispatch`, inte här. Formen på användar-id:t
  // prövas också där, med `MEMBER_ID_PATTERN` — det är indata, inte en del av rutten.
  if (first === 'admin') {
    if (second === 'oversikt' && third === undefined) return { kind: 'adminOverview' };
    if (second === 'appar' && third === undefined) return { kind: 'adminApps' };
    if (second === 'stopp' && third === undefined) return { kind: 'adminStops' };
    if (second === 'register' && third === undefined) return { kind: 'adminRegister' };
    if (second === 'granskning') {
      if (third === undefined) return { kind: 'adminReviews' };
      // Id:t prövas mot sitt mönster HÄR, inte i lagret: ett värde som inte kan vara ett ärende
      // ska aldrig nå en SQL-parameter, och "finns inte" och "ser inte ut som ett id" ska ge
      // samma svar utåt.
      if (REVIEW_ID_PATTERN.test(third)) return { kind: 'adminReview', reviewId: third };
    }
    if (second === 'anvandare') {
      if (third === undefined) return { kind: 'adminUsers' };
      if (third.length > 0) return { kind: 'adminUser', userId: third };
    }
    return null;
  }
  return null;
}

function parseBody(request: PlatformRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body.byteLength === 0) return {};
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw invalid('Förfrågan kunde inte läsas.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('Förfrågan kunde inte läsas.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('Förfrågan kunde inte läsas.');
  }
  return parsed as Record<string, unknown>;
}

function summary(app: StoredApp): BuilderAppSummary {
  return {
    appId: app.appId,
    name: app.name,
    updatedAt: app.updatedAt,
    hasDraft: app.hasDraft,
    published: app.publishedVersion !== null,
  };
}

export function createApi(deps: ApiDependencies): { handle(request: PlatformRequest): Promise<PlatformResponse> } {
  const { storage, runner, control, invitations, feedback, urls, log } = deps;
  const iso = (): string => deps.now().toISOString();
  const admin = createAdmin({ storage, control, ...(deps.users === undefined ? {} : { users: deps.users }), log, now: deps.now });

  /** Delningar som har börjat men inte sparats än, per ägare — så att samtidiga anrop inte slinker förbi taket. */
  const pendingShares = new Map<string, number>();
  /** Samma sak för återkopplingen: mejlet är på väg men raden finns ännu inte. */
  const pendingFeedback = new Map<string, number>();

  function ownedApp(appId: string, identity: Identity): StoredApp {
    // Ett felformat id och en app som ägs av någon annan ger exakt samma svar som en som inte finns.
    if (!isAppId(appId)) throw notFound();
    const app = storage.findOwnedApp(appId, identity.userId);
    if (app === null) throw notFound();
    return app;
  }

  async function createApp(request: PlatformRequest): Promise<PlatformResponse> {
    const body = parseBody(request);
    let name = DEFAULT_NAME;
    let nameIsDefault = true;
    if (body['name'] !== undefined) {
      const raw = body['name'];
      if (typeof raw !== 'string') throw invalid('Namnet måste vara text.');
      const trimmed = raw.trim();
      if (characterCount(trimmed) > MAX_NAME_CHARS) throw invalid(`Namnet får vara högst ${MAX_NAME_CHARS} tecken.`);
      if (NAME_FORBIDDEN.test(trimmed)) throw invalid('Namnet innehåller tecken som inte är tillåtna.');
      if (trimmed.length > 0) {
        name = trimmed;
        nameIsDefault = false;
      }
    }
    const appId = await control.createApp();
    // Ägaren ges åtkomst i control FÖRE appen sparas här: misslyckas det finns ingen app i
    // byggverktyget som ägaren skulle vara utelåst från.
    await control.grantAccess(appId, request.identity.userId, 'owner', request.identity.email);
    storage.insertApp(appId, request.identity.userId, name, nameIsDefault, iso());
    log({ level: 'info', event: 'app_created', appIdPrefix: appIdPrefix(appId), userId: request.identity.userId });
    return json(201, { appId });
  }

  function appDetail(app: StoredApp): BuilderAppDetail {
    const job = storage.latestJob(app.appId);
    const review = storage.latestReview(app.appId);
    return {
      ...summary(app),
      ...(app.publishedVersion === null ? {} : { publishedUrl: urls.published(app.appId) }),
      messages: storage.listMessages(app.appId),
      ...(job === null ? {} : { job }),
      // Läget läses ur kontraktet, inte rakt ur kolumnen: ett ord ur en äldre version av vår egen
      // kod ska inte nå gränssnittet som om det vore ett läge.
      ...(review === null || !REVIEW_STATES.includes(review.state as ReviewState)
        ? {}
        : {
            review: {
              state: review.state as ReviewState,
              requestedAt: review.requestedAt,
              decidedAt: review.decidedAt,
              reason: review.reason,
            },
          }),
    };
  }

  function postMessage(request: PlatformRequest, appId: string): PlatformResponse {
    const body = parseBody(request);
    const raw = body['text'];
    if (typeof raw !== 'string') throw invalid('Skriv vad appen ska göra.');
    const text = raw.trim();
    if (text.length === 0) throw invalid('Skriv vad appen ska göra.');
    if (characterCount(text) > MAX_TEXT_CHARS) throw invalid(`Ett önskemål får vara högst ${MAX_TEXT_CHARS} tecken.`);
    if (TEXT_FORBIDDEN.test(text)) throw invalid('Texten innehåller tecken som inte är tillåtna.');

    const app = ownedApp(appId, request.identity);
    const jobId = newJobId();
    const defaultName = firstCharacters(text.replace(/\s+/g, ' '), NAME_FROM_REQUEST_CHARS);
    // Kontrollen "pågår redan ett jobb?" och skapandet sker i samma transaktion (se lagring.ts).
    if (!storage.enqueueRequest(app.appId, jobId, text, defaultName, iso())) {
      throw conflict('Ett arbete pågår redan för den här appen. Vänta tills det är klart.');
    }
    log({ level: 'info', event: 'job_queued', appIdPrefix: appIdPrefix(app.appId), userId: request.identity.userId });
    runner.enqueue(jobId);
    return json(202, { jobId });
  }

  function getJob(request: PlatformRequest, jobId: string): PlatformResponse {
    const afterRaw = request.query['after'];
    let after = 0;
    if (afterRaw !== undefined) {
      if (!AFTER_PATTERN.test(afterRaw)) throw invalid('after måste vara ett heltal som är 0 eller större.');
      after = Number(afterRaw);
    }
    if (!JOB_ID_PATTERN.test(jobId)) throw notFound();
    const job = storage.findOwnedJob(jobId, request.identity.userId);
    if (job === null) throw notFound();
    const { events, next } = storage.eventsAfter(jobId, after);
    const response: BuilderJob = { jobId: job.jobId, appId: job.appId, status: job.status, events, next };
    return json(200, response);
  }

  /**
   * Ägaren BEGÄR publicering. Hon publicerar inte.
   *
   * Det är den sista spärren i kedjan och den enda som är en människa: de röda linjerna prövar
   * önskemålet, policyreglerna prövar koden, klassningen prövar känsligheten — men bara en läsare
   * ser vad appen faktiskt gör. Rutten heter fortfarande `publish`, för det är vad ägaren vill
   * göra; det som ändrats är vad som händer.
   *
   * Versionen låses fast här. Bygger hon om medan ärendet väntar dras det tillbaka
   * (`completeGreenJob`), så en granskare läser aldrig kod som redan är ersatt.
   */
  function publish(request: PlatformRequest, appId: string): PlatformResponse {
    const app = ownedApp(appId, request.identity);
    const revision = storage.latestRevision(app.appId);
    if (revision === null) throw conflict('Det finns inget färdigt utkast att publicera ännu.');
    const base = { appIdPrefix: appIdPrefix(app.appId), userId: request.identity.userId };
    const reviewId = storage.requestReview(app.appId, newReviewId(), revision.versionId, request.identity.userId, iso());
    if (reviewId === null) throw conflict(REVIEW_ALREADY_PENDING);
    log({ level: 'info', event: 'review_requested', ...base });
    return json(202, { review: { state: 'vantar' satisfies ReviewState, requestedAt: iso() } });
  }

  function open(request: PlatformRequest, appId: string): PlatformResponse {
    const target = request.query['target'];
    if (target !== 'preview' && target !== 'published') {
      throw invalid('Ange vad som ska öppnas: förhandsvisningen eller den publicerade appen.');
    }
    const app = ownedApp(appId, request.identity);
    if (target === 'preview') {
      if (!app.hasDraft) throw conflict('Det finns ingen förhandsvisning ännu.');
      return json(200, { url: deps.openUrl(request.identity, urls.preview(app.appId)) });
    }
    if (app.publishedVersion === null) throw conflict('Appen är inte publicerad ännu.');
    return json(200, { url: deps.openUrl(request.identity, urls.published(app.appId)) });
  }

  async function share(request: PlatformRequest, appId: string): Promise<PlatformResponse> {
    const body = parseBody(request);
    const raw = body['email'];
    if (typeof raw !== 'string') throw invalid('Skriv den e-postadress du vill dela med.');
    const email = raw.trim();
    if (email.length === 0 || email.length > MAX_EMAIL_CHARS) {
      throw invalid('Adressen ser inte ut att vara en e-postadress.');
    }
    const app = ownedApp(appId, request.identity);
    if (app.publishedVersion === null) throw conflict('Appen behöver publiceras innan den kan delas.');

    const userId = request.identity.userId;
    const base = { appIdPrefix: appIdPrefix(app.appId), userId };
    const since = new Date(deps.now().getTime() - HOUR_MS).toISOString();
    const pending = pendingShares.get(userId) ?? 0;
    if (storage.sharesSince(userId, since) + pending >= MAX_SHARES_PER_HOUR) {
      log({ level: 'warn', event: 'share_rate_limited', ...base });
      throw new ApiProblem('rate_limited', 'Du har delat många gånger på kort tid. Vänta en stund och försök igen.');
    }

    pendingShares.set(userId, pending + 1);
    try {
      const invited = await invitations.invite({
        email,
        role: 'viewer',
        invitedBy: request.identity,
        app: { name: app.name, url: urls.published(app.appId) },
      });
      // Att dela med sig själv är ofarligt: control nedgraderar aldrig ägaren till användare.
      await control.grantAccess(storedAppId(app.appId), invited.userId, 'user', invited.email);
      storage.recordShare(app.appId, userId, email, iso());
    } catch (error) {
      if (error instanceof DataApiError && error.code === 'invalid_request') {
        throw invalid('Adressen ser inte ut att vara en e-postadress.');
      }
      log({ level: 'error', event: 'share_failed', ...base, ...describeError(error) });
      throw internal();
    } finally {
      const left = (pendingShares.get(userId) ?? 1) - 1;
      if (left <= 0) pendingShares.delete(userId);
      else pendingShares.set(userId, left);
    }
    log({ level: 'info', event: 'app_shared', ...base });
    // Samma svar oavsett om adressen redan var inbjuden: det röjer inget om vilka som har konto.
    return json(200, { shared: true });
  }

  /**
   * Återkoppling på byggverktyget. Den når ALDRIG språkmodellen och ändrar aldrig appen: inget
   * jobb köas, inget meddelande läggs i samtalet och ingen revision skapas. Tumme ner mejlas till
   * plattformens ägare med hela konversationen; tumme upp räknas bara.
   */
  async function postFeedback(request: PlatformRequest, appId: string): Promise<PlatformResponse> {
    const body = parseBody(request);
    const helpful = body['helpful'];
    if (typeof helpful !== 'boolean') throw invalid('Säg om svaret hjälpte eller inte.');

    const missingText = 'Skriv vad som inte hjälpte, så vet vi vad vi ska göra bättre.';
    let text = '';
    if (!helpful) {
      const raw = body['text'];
      if (typeof raw !== 'string') throw invalid(missingText);
      text = raw.trim();
      if (text.length === 0) throw invalid(missingText);
      if (characterCount(text) > MAX_TEXT_CHARS) throw invalid(`Återkopplingen får vara högst ${MAX_TEXT_CHARS} tecken.`);
      if (TEXT_FORBIDDEN.test(text)) throw invalid('Texten innehåller tecken som inte är tillåtna.');
    }

    const app = ownedApp(appId, request.identity);
    const userId = request.identity.userId;
    const base = { appIdPrefix: appIdPrefix(app.appId), userId };
    const since = new Date(deps.now().getTime() - HOUR_MS).toISOString();
    const pending = pendingFeedback.get(userId) ?? 0;
    if (storage.feedbackSince(userId, since) + pending >= MAX_FEEDBACK_PER_HOUR) {
      log({ level: 'warn', event: 'feedback_rate_limited', ...base });
      throw new ApiProblem('rate_limited', 'Du har lämnat återkoppling många gånger på kort tid. Vänta en stund och försök igen.');
    }

    pendingFeedback.set(userId, pending + 1);
    try {
      if (!helpful) {
        // Mejlet FÖRST: går det inte fram är signalen borta, och då ska hon få veta det i stället
        // för ett kvitto på något som ingen kommer att läsa.
        await feedback.send(
          composeFeedbackMail({
            from: request.identity,
            appName: app.name,
            appIdPrefix: appIdPrefix(app.appId),
            text,
            conversation: storage.listMessages(app.appId),
            at: iso(),
          }),
        );
      }
      storage.recordFeedback(app.appId, userId, helpful, iso());
    } catch (error) {
      log({ level: 'error', event: 'feedback_failed', ...base, ...describeError(error) });
      throw internal();
    } finally {
      const left = (pendingFeedback.get(userId) ?? 1) - 1;
      if (left <= 0) pendingFeedback.delete(userId);
      else pendingFeedback.set(userId, left);
    }
    // Händelsen loggas, aldrig texten: en driftlogg ska inte gå att läsa som ett samtal.
    log({ level: 'info', event: helpful ? 'feedback_liked' : 'feedback_sent', ...base });
    return json(200, { received: true });
  }

  async function listMembers(request: PlatformRequest, appId: string): Promise<PlatformResponse> {
    const app = ownedApp(appId, request.identity);
    const entries = await control.listAccess(storedAppId(app.appId));
    const owner = request.identity;
    const members: BuilderAppMember[] = [];
    for (const entry of entries) {
      if (entry.role === 'owner') {
        // Appar från före åtkomstlistan har ägaren utan adress i control; ägaren är den som frågar.
        const email = entry.email ?? (entry.userId === owner.userId ? owner.email : '');
        members.unshift({ memberId: entry.userId, email, role: 'owner' });
      } else {
        members.push({ memberId: entry.userId, email: entry.email ?? '', role: 'user' });
      }
    }
    return json(200, { members });
  }

  async function removeMember(request: PlatformRequest, appId: string, memberId: string): Promise<PlatformResponse> {
    if (!MEMBER_ID_PATTERN.test(memberId)) throw invalid('Personen du vill ta bort finns inte i listan.');
    const app = ownedApp(appId, request.identity);
    const ownMessage = 'Du äger appen och kan inte ta bort din egen åtkomst.';
    if (memberId === request.identity.userId) throw invalid(ownMessage);
    try {
      await control.revokeAccess(storedAppId(app.appId), memberId);
    } catch (error) {
      // Control vägrar ta bort appens ägare — samma sak som ovan, om control och byggverktyget
      // någon gång skulle vara oense om vem som äger appen.
      if (controlErrorCode(error) === 'access_rejected') throw invalid(ownMessage);
      throw error;
    }
    log({ level: 'info', event: 'access_revoked', appIdPrefix: appIdPrefix(app.appId), userId: request.identity.userId });
    // Samma svar oavsett om personen hade åtkomst: borttagningen är idempotent.
    return json(200, { removed: true });
  }

  async function dispatch(request: PlatformRequest): Promise<PlatformResponse> {
    const route = matchRoute(request.path);
    if (route === null) throw notFound();
    if (!METHODS[route.kind].includes(request.method)) {
      throw new ApiProblem('method_not_allowed', 'Metoden stöds inte här.');
    }
    const identity = request.identity;

    if (route.kind === 'me') {
      const me: BuilderMe = {
        displayName: displayName(identity),
        canBuild: canBuild(identity),
        isAdmin: isAdmin(identity),
        services: deps.services,
        ...(deps.version === undefined ? {} : { version: deps.version }),
      };
      return json(200, me);
    }
    // Kontrollrummet har sin egen grind, och den prövas före byggrätten: den som är admin får
    // förstås också bygga, men den som bara är byggare ska få veta att det är adminrollen som
    // saknas — inte ett besked om att hen inte får bygga appar.
    if (
      route.kind === 'adminOverview' ||
      route.kind === 'adminApps' ||
      route.kind === 'adminStops' ||
      route.kind === 'adminRegister' ||
      route.kind === 'adminReviews' ||
      route.kind === 'adminReview' ||
      route.kind === 'adminUsers' ||
      route.kind === 'adminUser'
    ) {
      requireAdmin(identity);
      switch (route.kind) {
        case 'adminOverview':
          return admin.overview();
        case 'adminApps':
          return admin.apps();
        case 'adminStops':
          return admin.stops();
        case 'adminRegister':
          return admin.register();
        case 'adminReviews':
          return admin.reviews();
        case 'adminReview':
          return request.method === 'GET'
            ? admin.review(route.reviewId)
            : admin.decide(identity, route.reviewId, parseBody(request));
        case 'adminUsers':
          return request.method === 'GET' ? admin.users(identity) : admin.invite(identity, parseBody(request));
        case 'adminUser':
          // Ett användar-id är ett användar-id: samma form som ett medlems-id. Ett felformat id
          // når aldrig identiteten — `__proto__`, NUL och överlånga strängar stannar här.
          if (!MEMBER_ID_PATTERN.test(route.userId)) throw invalid('Personen du vill ändra finns inte i listan.');
          return admin.setRole(identity, route.userId, parseBody(request));
      }
    }
    if (!canBuild(identity)) throw new ApiProblem('forbidden', 'Du har inte behörighet att bygga appar.');

    switch (route.kind) {
      case 'apps':
        if (request.method === 'POST') return createApp(request);
        return json(200, { apps: storage.listOwnedApps(identity.userId).map(summary) });
      case 'app':
        return json(200, appDetail(ownedApp(route.appId, identity)));
      case 'messages':
        return postMessage(request, route.appId);
      case 'publish':
        return publish(request, route.appId);
      case 'open':
        return open(request, route.appId);
      case 'share':
        return share(request, route.appId);
      case 'feedback':
        return postFeedback(request, route.appId);
      case 'members':
        return listMembers(request, route.appId);
      case 'member':
        return removeMember(request, route.appId, route.memberId);
      case 'job':
        return getJob(request, route.jobId);
    }
  }

  return {
    async handle(request) {
      try {
        return await dispatch(request);
      } catch (error) {
        if (error instanceof ApiProblem) return problemResponse(error);
        log({ level: 'error', event: 'internal_error', userId: request.identity.userId, ...describeError(error) });
        return problemResponse(internal());
      }
    },
  };
}
