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
import { BUILDER_API_PREFIX, DataApiError, isAppId } from '@vibesandbox/contracts';
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
} from '@vibesandbox/contracts';
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
  readonly invitations: InvitationService;
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

const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 4000;
const MAX_EMAIL_CHARS = 254;
const DEFAULT_NAME = 'Namnlös app';
const NAME_FROM_REQUEST_CHARS = 60;

/** Högst så många delningar per ägare och timme — varje delning skickar ett mejl. */
export const MAX_SHARES_PER_HOUR = 20;
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
  | { readonly kind: 'members'; readonly appId: string }
  | { readonly kind: 'member'; readonly appId: string; readonly memberId: string }
  | { readonly kind: 'job'; readonly jobId: string };

const METHODS: Readonly<Record<Route['kind'], readonly string[]>> = {
  me: ['GET'],
  apps: ['GET', 'POST'],
  app: ['GET'],
  messages: ['POST'],
  publish: ['POST'],
  open: ['GET'],
  share: ['POST'],
  members: ['GET'],
  member: ['DELETE'],
  job: ['GET'],
};

const APP_ACTIONS = new Set(['messages', 'publish', 'open', 'share', 'members'] as const);

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
  const { storage, runner, control, invitations, urls, log } = deps;
  const iso = (): string => deps.now().toISOString();

  /** Delningar som har börjat men inte sparats än, per ägare — så att samtidiga anrop inte slinker förbi taket. */
  const pendingShares = new Map<string, number>();

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
    return {
      ...summary(app),
      ...(app.publishedVersion === null ? {} : { publishedUrl: urls.published(app.appId) }),
      messages: storage.listMessages(app.appId),
      ...(job === null ? {} : { job }),
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

  async function publish(request: PlatformRequest, appId: string): Promise<PlatformResponse> {
    const app = ownedApp(appId, request.identity);
    const revision = storage.latestRevision(app.appId);
    if (revision === null) throw conflict('Det finns inget färdigt utkast att publicera ännu.');
    const base = { appIdPrefix: appIdPrefix(app.appId), userId: request.identity.userId };
    try {
      await control.publish(storedAppId(app.appId), revision.versionId);
    } catch (error) {
      log({ level: 'error', event: 'publish_failed', ...base, ...describeError(error) });
      throw internal();
    }
    storage.markPublished(app.appId, revision.versionId, iso());
    log({ level: 'info', event: 'app_published', ...base });
    return json(200, { publishedUrl: urls.published(app.appId) });
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
        services: deps.services,
        ...(deps.version === undefined ? {} : { version: deps.version }),
      };
      return json(200, me);
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
