/**
 * Identitetsleverantören `email-otp`: inloggning med engångskod via mejl, bara för uttryckligen
 * inbjudna adresser. Inloggning sker PER VÄRD — varje app, förhandsvisning och byggverktyget har
 * sin egen sida `/_auth/login` och sin egen host-only-kaka. Det finns alltså ingen biljett som
 * färdas mellan värdar, och därmed ingen inloggnings-CSRF via en biljett i adressen.
 *
 *   GET  /_auth/login?next=/x   formulär för e-postadressen
 *   POST /_auth/login           skapar en utmaning (kaka + mejlad kod), visar formuläret för koden
 *   POST /_auth/verify          rätt kod ⇒ ny session, 303 till `next`
 *   POST /_auth/logout          tar bort sessionen, 303 till `/_auth/login`
 *
 * Det gatewayn INTE gör åt oss (kontraktets jsdoc för `handleAuthRoute`), och som därför görs här:
 * - Rutterna körs före gatewayns CSRF-kontroll. Varje POST kräver att `Origin` är EXAKT den här
 *   värdens origin — `SameSite` skyddar inte mellan subdomäner (ADR 0002, spik S1).
 * - Koden är bunden till webbläsaren som begärde den, via en utmaningskaka: en kod som någon
 *   annan får tag på fungerar inte i en annan webbläsare.
 * - Utloggning kräver POST; en länk kan inte logga ut någon.
 * - Kakorna har `__Host-` och `Secure` över https, aldrig `Domain=`, alltid `HttpOnly`.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { DataApiError } from '@vibesandbox/contracts';
import type {
  AuthRequest,
  AuthRouteRequest,
  AuthRouteResponse,
  Identity,
  IdentityProvider,
  InvitationService,
  Role,
} from '@vibesandbox/contracts';
import { normalizeEmail } from './adress.ts';
import { ROLE_RANK, findUserByEmail, isRole, rowToUser, upsertUser } from './anvandare.ts';
import type { UpsertResult } from './anvandare.ts';
import { SQL, openIdentityDatabase } from './databas.ts';
import { createRateLimiter } from './hastighet.ts';
import {
  challengeCookie,
  clearChallengeCookie,
  clearSessionCookie,
  cookieNames,
  readSingleCookie,
  sessionCookie,
} from './kakor.ts';
import { safeLogger } from './logg.ts';
import type { IdentityEvent, IdentityLogEntry, IdentityLogger, LoginFailure } from './logg.ts';
import type { MailSender } from './mejl.ts';
import { safeNext } from './nasta.ts';
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  VERIFY_PATH,
  badRequestPage,
  codePage,
  expiredPage,
  forbiddenPage,
  loginPage,
  methodNotAllowedPage,
  rateLimitedPage,
} from './sidor.ts';

export const MIN_SECRET_BYTES = 32;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const CODE_LIFETIME_MS = 10 * MINUTE;
const MAX_CODE_ATTEMPTS = 5;
const DEFAULT_SESSION_LIFETIME_MS = 12 * HOUR;
/** Inget av formulären är i närheten av så här stort. */
const MAX_FORM_BYTES = 4096;
/**
 * Städningen är en bisak: utgångna koder och sessioner nekas ändå av sina egna kontroller, oavsett
 * om raden finns kvar. Den håller bara tabellerna små.
 */
const CLEANUP_INTERVAL_MS = HOUR;
const EVENT_RETENTION_MS = 90 * 24 * HOUR;

/** 32 slumpbyte i base64url, utan utfyllnad: exakt 43 tecken. Allt annat är inte vårt. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[0-9]{6}$/;

export interface IdentityLimits {
  /** Koder per adress och timme — lika för inbjudna och ej inbjudna. */
  readonly challengesPerAddressPerHour: number;
  /** Koder per klientadress och timme (bara när `clientAddress` ger en). */
  readonly challengesPerClientPerHour: number;
  /** Koder totalt per timme; taket när klientens adress är okänd. */
  readonly challengesGlobalPerHour: number;
  readonly verifyAttemptsPerClientPerHour: number;
  readonly verifyAttemptsGlobalPerHour: number;
  /** Inbjudningar (= mejl) per inbjudare och timme. */
  readonly invitationsPerInviterPerHour: number;
}

export const DEFAULT_IDENTITY_LIMITS: IdentityLimits = {
  challengesPerAddressPerHour: 5,
  challengesPerClientPerHour: 20,
  challengesGlobalPerHour: 300,
  verifyAttemptsPerClientPerHour: 60,
  verifyAttemptsGlobalPerHour: 1500,
  invitationsPerInviterPerHour: 30,
};

export interface EmailOtpProviderOptions {
  /** Katalogen där `identity.sqlite` ligger (skapas vid behov). */
  readonly dataDirectory: string;
  /** Minst 32 byte. Nyckel för alla HMAC:ar; byts den blir alla sessioner och koder ogiltiga. */
  readonly secret: string | Uint8Array;
  /** Schemat webbläsaren ser. Avgör kaknamn och `Secure` — aldrig förfrågan. */
  readonly publicScheme: 'http' | 'https';
  /**
   * Porten webbläsaren ser, om den inte är schemats standardport. `AuthRouteRequest.host` saknar
   * port, men `Origin` har den — så den måste anges här för att Origin-kontrollen ska gå igenom.
   */
  readonly publicPort?: number;
  readonly mailSender: MailSender;
  /** Millisekunder sedan 1970. För tester. */
  readonly clock?: () => number;
  readonly logger?: IdentityLogger;
  readonly limits?: Partial<IdentityLimits>;
  /**
   * Klientens adress för hastighetsbegränsning. Gatewayn skickar inte med den i dag; utan den
   * begränsas per e-postadress och globalt. Får ALDRIG läsa ett huvud som klienten själv styr
   * (t.ex. `X-Forwarded-For`) om det inte sätts av en betrodd proxy.
   */
  readonly clientAddress?: (request: AuthRequest) => string | undefined;
  readonly sessionLifetimeMs?: number;
}

export interface AddedUser {
  readonly userId: string;
  readonly role: Role;
}

export interface EmailOtpProvider extends IdentityProvider, InvitationService {
  readonly name: 'email-otp';
  readonly loginPath: string;
  handleAuthRoute(request: AuthRouteRequest): Promise<AuthRouteResponse | null>;
  /** Administrativ: lägger till adressen eller höjer dess roll. Skickar inget mejl. */
  addUser(email: string, role: Role): Promise<AddedUser>;
  /** Väntar in mejl som skickas i bakgrunden och stänger databasen. */
  close(): Promise<void>;
}

const HTML = 'text/html; charset=utf-8';

function html(status: number, body: string, extra: Record<string, string | readonly string[]> = {}): AuthRouteResponse {
  return { status, headers: { 'Content-Type': HTML, ...extra }, body };
}

function secretBytes(secret: unknown): Buffer {
  if (typeof secret === 'string') return Buffer.from(secret, 'utf8');
  if (secret instanceof Uint8Array) return Buffer.from(secret);
  throw new Error('Identitetsleverantörens hemlighet saknas.');
}

/** `body` finns inte i kontraktet ännu (se slutrapporten); läses defensivt om gatewayn skickar den. */
function readFormBody(request: AuthRouteRequest): URLSearchParams | null {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string') return null;
  if ((contentType.split(';', 1)[0] ?? '').trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;

  const raw: unknown = (request as AuthRouteRequest & { readonly body?: unknown }).body;
  let text: string;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_FORM_BYTES) return null;
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_FORM_BYTES) return null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const form = new URLSearchParams(text);
  // Ett fält som förekommer två gånger har två svar på vad det är — då gäller inget.
  const seen = new Set<string>();
  for (const name of form.keys()) {
    if (seen.has(name)) return null;
    seen.add(name);
  }
  return form;
}

export function createEmailOtpProvider(options: EmailOtpProviderOptions): EmailOtpProvider {
  const secret = secretBytes(options.secret);
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`Identitetsleverantörens hemlighet måste vara minst ${MIN_SECRET_BYTES} byte.`);
  }
  if (options.publicScheme !== 'http' && options.publicScheme !== 'https') {
    throw new Error('publicScheme måste vara http eller https.');
  }
  const port = options.publicPort;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('publicPort måste vara ett portnummer.');
  }
  if (typeof options.mailSender?.send !== 'function') throw new Error('mailSender saknas.');

  const scheme = options.publicScheme;
  const defaultPort = scheme === 'https' ? 443 : 80;
  // Webbläsare utelämnar standardporten i `Origin`.
  const originSuffix = port === undefined || port === defaultPort ? '' : `:${port}`;
  const names = cookieNames(scheme);
  const now = options.clock ?? Date.now;
  const log = safeLogger(options.logger);
  const limits: IdentityLimits = { ...DEFAULT_IDENTITY_LIMITS, ...options.limits };
  const sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
  const sessionMaxAge = Math.floor(sessionLifetimeMs / 1000);
  const mailSender = options.mailSender;

  const db = openIdentityDatabase(options.dataDirectory);
  const limiter = createRateLimiter(HOUR);
  const pendingMail = new Set<Promise<void>>();
  let lastCleanup = Number.NEGATIVE_INFINITY;
  let closed = false;

  // ── Nycklar ─────────────────────────────────────────────────────────────────
  // En egen härledd nyckel per ändamål, så att en HMAC från ett sammanhang aldrig kan användas
  // i ett annat (en sessionshash kan inte bli en giltig utmaningshash).
  function subkey(label: string): Buffer {
    return createHmac('sha256', secret).update(`vibesandbox-identity.v1.${label}`).digest();
  }
  const keys = {
    challenge: subkey('challenge-id'),
    code: subkey('code'),
    session: subkey('session'),
    email: subkey('email'),
    client: subkey('client'),
  };
  function mac(key: Buffer, ...parts: ReadonlyArray<string | Buffer>): Buffer {
    const h = createHmac('sha256', key);
    for (const part of parts) {
      // Längdprefix, så att ("ab","c") och ("a","bc") aldrig ger samma HMAC.
      const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      h.update(length).update(bytes);
    }
    return h.digest();
  }

  // ── Hjälp ───────────────────────────────────────────────────────────────────

  function record(event: IdentityEvent, userId: string | null, entry: Omit<IdentityLogEntry, 'event'>): void {
    log({ event, ...entry, ...(userId === null ? {} : { userId }) });
    try {
      db.statement(SQL.insertEvent).run({ type: event, user_id: userId, at: now() });
    } catch {
      // Händelseloggen är till för uppföljning; den får inte fälla en inloggning.
    }
  }

  function cleanup(): void {
    const at = now();
    if (at - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = at;
    try {
      const challenges = db.statement(SQL.deleteExpiredChallenges).run({ now: at }).changes;
      const sessions = db.statement(SQL.deleteExpiredSessions).run({ now: at }).changes;
      db.statement(SQL.deleteOldEvents).run({ before: at - EVENT_RETENTION_MS });
      const count = Number(challenges) + Number(sessions);
      if (count > 0) log({ level: 'info', event: 'cleanup', count });
    } catch (error) {
      log({ level: 'error', event: 'cleanup', errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  function originMatches(request: AuthRouteRequest): boolean {
    const origin = request.headers['origin'];
    return typeof origin === 'string' && origin === `${scheme}://${request.host}${originSuffix}`;
  }

  function clientKey(request: AuthRequest): string | null {
    if (options.clientAddress === undefined) return null;
    let address: string | undefined;
    try {
      address = options.clientAddress(request);
    } catch {
      address = undefined;
    }
    if (typeof address !== 'string' || address.length === 0 || address.length > 64) return null;
    return mac(keys.client, address).toString('hex');
  }

  /** Alla gränser prövas först, och räknas bara om ALLA rymmer händelsen. */
  function consumeAll(buckets: ReadonlyArray<readonly [key: string, limit: number]>): boolean {
    const at = now();
    if (!buckets.every(([key, limit]) => limiter.wouldAllow(key, limit, at))) return false;
    for (const [key, limit] of buckets) limiter.tryConsume(key, limit, at);
    return true;
  }

  function readToken(cookieHeader: unknown, name: string): { token: string } | { failure: LoginFailure } {
    const cookie = readSingleCookie(cookieHeader, name);
    if (cookie.outcome === 'ambiguous') return { failure: 'ambiguous_cookie' };
    if (cookie.outcome !== 'found' || !TOKEN_PATTERN.test(cookie.value)) return { failure: 'no_challenge' };
    return { token: cookie.value };
  }

  function sendInBackground(message: { to: string; subject: string; text: string }, userId: string): void {
    // Mejlet skickas UTANFÖR svaret: annars skulle svarstiden röja om adressen är inbjuden.
    const sending = mailSender
      .send(message)
      .catch((error: unknown) => {
        record('mail_failed', userId, { level: 'error', errorName: error instanceof Error ? error.name : typeof error });
      })
      .finally(() => pendingMail.delete(sending));
    pendingMail.add(sending);
  }

  // ── Rutterna ────────────────────────────────────────────────────────────────

  function showLogin(request: AuthRouteRequest): AuthRouteResponse {
    return html(200, loginPage(safeNext(request.query['next'])));
  }

  function requestCode(request: AuthRouteRequest): AuthRouteResponse {
    const form = readFormBody(request);
    if (form === null) {
      log({ level: 'warn', event: 'bad_request' });
      return html(400, badRequestPage());
    }
    const next = safeNext(form.get('next'));
    const email = normalizeEmail(form.get('email'));
    if (email === null) return html(400, loginPage(next, 'Skriv en giltig e-postadress.'));

    const emailKey = mac(keys.email, email);
    const buckets: Array<readonly [string, number]> = [
      [`address:${emailKey.toString('hex')}`, limits.challengesPerAddressPerHour],
      ['global:challenge', limits.challengesGlobalPerHour],
    ];
    const client = clientKey(request);
    if (client !== null) buckets.push([`client:challenge:${client}`, limits.challengesPerClientPerHour]);
    if (!consumeAll(buckets)) {
      record('rate_limited', null, { level: 'warn', reason: 'address' });
      return html(429, rateLimitedPage());
    }

    // Samma arbete för inbjudna och ej inbjudna: slumpa, HMAC:a, skriv en rad. Det enda som skiljer
    // är att mejlet bara skickas till en inbjuden — och det sker efter svaret.
    const user = findUserByEmail(db, email);
    const challengeId = randomBytes(32).toString('base64url');
    const idHash = mac(keys.challenge, challengeId);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    db.statement(SQL.upsertChallenge).run({
      id_hash: idHash,
      email_key: emailKey,
      user_id: user?.userId ?? null,
      host: request.host,
      code_hmac: mac(keys.code, idHash, code),
      next_path: next,
      expires_at: now() + CODE_LIFETIME_MS,
    });
    record('challenge_created', user?.userId ?? null, { level: 'info' });

    if (user !== null) {
      sendInBackground(
        {
          to: user.email,
          subject: 'Din inloggningskod',
          text:
            `Din kod är: ${code}\n\n` +
            'Skriv in den på sidan där du begärde den. Koden gäller i tio minuter och fungerar bara ' +
            'i den webbläsare där du begärde den.\n\n' +
            'Har du inte försökt logga in kan du bortse från det här mejlet.\n',
        },
        user.userId,
      );
    }

    return html(200, codePage(), { 'Set-Cookie': challengeCookie(names, challengeId, CODE_LIFETIME_MS / 1000) });
  }

  function verifyCode(request: AuthRouteRequest): AuthRouteResponse {
    const buckets: Array<readonly [string, number]> = [['global:verify', limits.verifyAttemptsGlobalPerHour]];
    const client = clientKey(request);
    if (client !== null) buckets.push([`client:verify:${client}`, limits.verifyAttemptsPerClientPerHour]);
    if (!consumeAll(buckets)) {
      record('rate_limited', null, { level: 'warn', reason: 'verify' });
      return html(429, rateLimitedPage());
    }

    const form = readFormBody(request);
    if (form === null) {
      log({ level: 'warn', event: 'bad_request' });
      return html(400, badRequestPage());
    }

    const fail = (reason: LoginFailure, userId: string | null, page: string, clear: boolean): AuthRouteResponse => {
      record('login_failed', userId, { level: 'warn', reason });
      return html(401, page, clear ? { 'Set-Cookie': clearChallengeCookie(names) } : {});
    };

    const cookie = readToken(request.headers['cookie'], names.challenge);
    if ('failure' in cookie) return fail(cookie.failure, null, expiredPage(), false);

    const idHash = mac(keys.challenge, cookie.token);
    const row = db.statement(SQL.findChallenge).get({ id_hash: idHash });
    if (row === undefined) return fail('no_challenge', null, expiredPage(), true);

    const userId = typeof row['user_id'] === 'string' ? row['user_id'] : null;
    // Kakan är host-only och kan inte flyttas av en webbläsare, men raden är ändå bunden till värden.
    if (row['host'] !== request.host) return fail('wrong_host', userId, expiredPage(), false);
    if (typeof row['expires_at'] !== 'number' || row['expires_at'] <= now()) {
      db.statement(SQL.deleteChallenge).run({ id_hash: idHash });
      return fail('expired', userId, expiredPage(), true);
    }
    const attempts = typeof row['attempts'] === 'number' ? row['attempts'] : MAX_CODE_ATTEMPTS;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      db.statement(SQL.deleteChallenge).run({ id_hash: idHash });
      return fail('exhausted', userId, expiredPage(), true);
    }

    // Mellanslag tas bort (koden skrivs gärna "123 456"); allt annat än exakt sex ASCII-siffror är fel.
    const presented = (form.get('code') ?? '').replaceAll(' ', '');
    const expected = row['code_hmac'];
    // HMAC:en räknas även för skräp, så att ett felformat svar tar lika lång tid som ett fel svar.
    const candidate = mac(keys.code, idHash, CODE_PATTERN.test(presented) ? presented : 'ogiltig');
    const matches =
      expected instanceof Uint8Array &&
      expected.byteLength === candidate.length &&
      timingSafeEqual(candidate, expected) &&
      CODE_PATTERN.test(presented);

    if (!matches || userId === null) {
      db.statement(SQL.countAttempt).run({ id_hash: idHash });
      if (attempts + 1 >= MAX_CODE_ATTEMPTS) {
        db.statement(SQL.deleteChallenge).run({ id_hash: idHash });
        return fail('exhausted', userId, expiredPage(), true);
      }
      return fail(userId === null ? 'not_invited' : 'wrong_code', userId, codePage('Koden stämmer inte. Försök igen.'), false);
    }

    // Engångs: utmaningen raderas i samma transaktion som sessionen skapas.
    const token = randomBytes(32).toString('base64url');
    const created = now();
    db.transaction(() => {
      db.statement(SQL.deleteChallenge).run({ id_hash: idHash });
      db.statement(SQL.insertSession).run({
        token_hash: mac(keys.session, token),
        user_id: userId,
        host: request.host,
        created_at: created,
        expires_at: created + sessionLifetimeMs,
      });
    });
    record('login_succeeded', userId, { level: 'info' });

    // `next` sparades kontrollerat, men prövas igen: raden kan vara äldre än dagens regler.
    return {
      status: 303,
      headers: {
        Location: safeNext(row['next_path']),
        'Set-Cookie': [sessionCookie(names, token, sessionMaxAge), clearChallengeCookie(names)],
      },
    };
  }

  function logout(request: AuthRouteRequest): AuthRouteResponse {
    const cookie = readToken(request.headers['cookie'], names.session);
    let userId: string | null = null;
    if ('token' in cookie) {
      const tokenHash = mac(keys.session, cookie.token);
      const row = db.statement(SQL.findSession).get({ token_hash: tokenHash });
      // Bara en session från DEN HÄR värden tas bort här.
      if (row !== undefined && row['host'] === request.host) {
        userId = typeof row['user_id'] === 'string' ? row['user_id'] : null;
        db.statement(SQL.deleteSession).run({ token_hash: tokenHash });
      }
    }
    record('logout', userId, { level: 'info' });
    return { status: 303, headers: { Location: LOGIN_PATH, 'Set-Cookie': clearSessionCookie(names) } };
  }

  function onlyPost(): AuthRouteResponse {
    return html(405, methodNotAllowedPage(), { Allow: 'POST' });
  }

  // ── Inbjudningar ────────────────────────────────────────────────────────────

  function cleanAppName(name: unknown): string {
    if (typeof name !== 'string') throw new DataApiError('invalid_request', 'Appens namn saknas.');
    // Kontrolltecken bort (radbrytningar i ett ämne är en klassisk väg till extra mejlhuvuden).
    let cleaned = '';
    for (const char of name) {
      const code = char.codePointAt(0) ?? 0;
      cleaned += code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029 ? ' ' : char;
    }
    cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 100);
    return cleaned.length === 0 ? 'en app' : cleaned;
  }

  function checkAppUrl(url: unknown): string {
    if (typeof url !== 'string' || url.length > 2048) throw new DataApiError('invalid_request', 'Appens adress är ogiltig.');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DataApiError('invalid_request', 'Appens adress är ogiltig.');
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '') {
      throw new DataApiError('invalid_request', 'Appens adress är ogiltig.');
    }
    return parsed.href;
  }

  function highestRank(identity: Identity): number {
    return Math.max(0, ...(Array.isArray(identity?.roles) ? identity.roles : []).filter(isRole).map((r) => ROLE_RANK[r]));
  }

  function assertOpen(): void {
    if (closed) throw new Error('Identitetsleverantören är stängd.');
  }

  return {
    name: 'email-otp',
    loginPath: LOGIN_PATH,

    async authenticate(request) {
      assertOpen();
      cleanup();
      const cookie = readToken(request.headers['cookie'], names.session);
      if (!('token' in cookie)) return null;
      const tokenHash = mac(keys.session, cookie.token);
      const row = db.statement(SQL.findSession).get({ token_hash: tokenHash });
      if (row === undefined) return null;
      // Bunden till värdnamnet: en session från app A godtas aldrig på värd B.
      if (row['host'] !== request.host) return null;
      if (typeof row['expires_at'] !== 'number' || row['expires_at'] <= now()) {
        db.statement(SQL.deleteSession).run({ token_hash: tokenHash });
        return null;
      }
      const user = rowToUser(row);
      if (user === null) return null;
      return { userId: user.userId, email: user.email, roles: [user.role] };
    },

    async handleAuthRoute(request) {
      assertOpen();
      cleanup();
      const isLogin = request.path === LOGIN_PATH;
      const isVerify = request.path === VERIFY_PATH;
      const isLogout = request.path === LOGOUT_PATH;
      if (!isLogin && !isVerify && !isLogout) return null;

      if (request.method === 'GET') return isLogin ? showLogin(request) : onlyPost();
      if (request.method !== 'POST') {
        return html(405, methodNotAllowedPage(), { Allow: isLogin ? 'GET, POST' : 'POST' });
      }

      // FÖRST av allt för varje POST: kommer formuläret från den här värdens egen sida?
      if (!originMatches(request)) {
        log({ level: 'warn', event: 'origin_rejected' });
        return html(403, forbiddenPage());
      }
      if (isLogin) return requestCode(request);
      if (isVerify) return verifyCode(request);
      return logout(request);
    },

    async invite(request) {
      assertOpen();
      if (!isRole(request.role)) throw new DataApiError('invalid_request', 'Okänd roll.');
      const inviterRank = highestRank(request.invitedBy);
      if (inviterRank < ROLE_RANK.builder || ROLE_RANK[request.role] > inviterRank) {
        throw new DataApiError('forbidden', 'Du får inte bjuda in med den rollen.');
      }
      const app = request.app === undefined ? undefined : { name: cleanAppName(request.app.name), url: checkAppUrl(request.app.url) };
      if (normalizeEmail(request.email) === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');

      const inviterKey = `inviter:${mac(keys.client, String(request.invitedBy.userId)).toString('hex')}`;
      if (!consumeAll([[inviterKey, limits.invitationsPerInviterPerHour]])) {
        record('rate_limited', request.invitedBy.userId, { level: 'warn', reason: 'address' });
        throw new DataApiError('rate_limited', 'Du har bjudit in många på kort tid. Vänta en stund och försök igen.');
      }

      const user: UpsertResult = upsertUser(db, request.email, request.role, now());
      record('invited', user.userId, { level: 'info' });

      const subject = app === undefined ? 'Du har fått tillgång' : `Du har fått tillgång till ${app.name}`;
      const text =
        'Hej!\n\n' +
        (app === undefined
          ? 'Du har fått tillgång till appar som delas med dig.\n\n'
          : `Du har fått tillgång till appen "${app.name}". Öppna den här:\n\n${app.url}\n\n`) +
        'Du loggar in med din e-postadress: vi skickar då en kod med sex siffror till den, som du skriver in på sidan. ' +
        'Du behöver inget lösenord.\n';
      try {
        await mailSender.send({ to: user.email, subject, text });
      } catch (error) {
        record('mail_failed', user.userId, { level: 'error', errorName: error instanceof Error ? error.name : typeof error });
        throw new DataApiError('internal', 'Inbjudan är sparad, men mejlet kunde inte skickas. Försök igen om en stund.');
      }
    },

    async addUser(email, role) {
      assertOpen();
      const user = upsertUser(db, email, role, now());
      record('user_added', user.userId, { level: 'info' });
      return { userId: user.userId, role: user.role };
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pendingMail]);
      db.close();
    },
  };
}

