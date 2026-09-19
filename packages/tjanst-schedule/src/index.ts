/**
 * Plattformstjänsten `schedule` (`/_api/schedule`): schemalagda påminnelser till en apps medlemmar.
 *
 * En app är ren frontend och kör inget när ingen har den öppen. Här lämnar appen en påminnelse
 * som plattformen skickar vid en viss tid — genom tjänsten `notify` (`AppNotifier`), så att
 * mottagarna alltid är appens egna medlemmar och aldrig en godtycklig adress.
 *
 *   POST   /_api/schedule        { at, repeat?, to, subject, text } → 201 { id, nextAt }
 *   GET    /_api/schedule        → { reminders }  (den inloggades egna; ägaren ser alla i appen)
 *   DELETE /_api/schedule/:id    → { cancelled: true }  (skaparen eller ägaren; annars 404)
 *
 * Val som styr beteendet (motiveringarna står vid koden):
 * - Missade tillfällen (efter ett avbrott eller ett klockhopp) skickas EN gång, inte en per tillfälle.
 * - Hellre en missad påminnelse än en dubblett: påminnelsen markeras som skickad innan den skickas.
 * - I förhandsvisningen (utkast) går påminnelser bara till ägaren.
 * - En påminnelse vars skapare inte längre är medlem skickas inte, och tas bort.
 *
 * Inställningar (alla valfria): SVC_SCHEDULE_MAX_PER_APP, SVC_SCHEDULE_MAX_PER_USER,
 * SVC_SCHEDULE_MAX_DAYS_AHEAD, SVC_SCHEDULE_TICK_MS.
 */
import { randomUUID } from 'node:crypto';
import { API_ERROR_STATUS, DataApiError } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppId,
  AppNotifier,
  AppService,
  AppServiceDependencies,
  AppServiceFactory,
  AppServiceRequest,
  AppServiceResponse,
} from '@vibesandbox/contracts';
import { openReminderStore } from './lagring.ts';
import type { Recipients, Reminder, ReminderStore } from './lagring.ts';
import { REPEATS, parseInstant } from './tid.ts';
import type { Repeat } from './tid.ts';

export const SERVICE_NAME = 'schedule';

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_TEXT_LENGTH = 4000;
export const MAX_RECIPIENTS = 100;
const MAX_USER_ID_LENGTH = 200;
const MAX_BODY_BYTES = 32 * 1024;
/** Förfallna påminnelser som plockas ut per transaktion; en väckning tar flera omgångar. */
const CLAIM_BATCH = 100;
const DAY = 24 * 60 * 60 * 1000;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Ämnet hamnar i ett mejlhuvud: inga kontrolltecken alls (radbrytning ⇒ huvudinjektion). */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** I texten är radbrytning och tabb tillåtna, men inga andra kontrolltecken. */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['at', 'repeat', 'to', 'subject', 'text']);

interface Settings {
  readonly maxPerApp: number;
  readonly maxPerUser: number;
  readonly maxDaysAhead: number;
  readonly tickMs: number;
}

function readInteger(
  env: AppServiceDependencies['env'],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} ska vara ett heltal mellan ${min} och ${max} (nu "${raw}").`);
  }
  return value;
}

function readSettings(env: AppServiceDependencies['env']): Settings {
  return {
    maxPerApp: readInteger(env, 'SVC_SCHEDULE_MAX_PER_APP', 500, 1, 100_000),
    maxPerUser: readInteger(env, 'SVC_SCHEDULE_MAX_PER_USER', 50, 1, 100_000),
    maxDaysAhead: readInteger(env, 'SVC_SCHEDULE_MAX_DAYS_AHEAD', 366, 1, 3660),
    tickMs: readInteger(env, 'SVC_SCHEDULE_TICK_MS', 30_000, 10, 24 * 60 * 60 * 1000),
  };
}

// ── Svar ────────────────────────────────────────────────────────────────────────

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

function ok(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function fail(code: ApiErrorCode, message: string): AppServiceResponse {
  return ok(API_ERROR_STATUS[code], { error: { code, message } });
}

const NOT_FOUND = (): AppServiceResponse => fail('not_found', 'Påminnelsen finns inte, eller så har den redan tagits bort.');
const INVALID = (message: string): AppServiceResponse => fail('invalid_request', message);

/** Den form appen ser. Inget internt (app-id, utkast/publicerat, första tillfället). */
function view(r: Reminder): Record<string, unknown> {
  return {
    id: r.id,
    nextAt: new Date(r.nextAt).toISOString(),
    repeat: r.repeat,
    to: r.to,
    subject: r.subject,
    text: r.text,
    createdBy: r.createdBy,
  };
}

// ── Indata ──────────────────────────────────────────────────────────────────────

type Parsed =
  | { readonly ok: true; readonly at: number; readonly repeat: Repeat | null; readonly to: Recipients; readonly subject: string; readonly text: string }
  | { readonly ok: false; readonly message: string };

function parseBody(body: Uint8Array | undefined): unknown {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecipients(value: unknown): Recipients | null {
  if (value === 'all' || value === 'owner') return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECIPIENTS) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_USER_ID_LENGTH || CONTROL.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseReminder(raw: unknown, now: number, settings: Settings): Parsed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Påminnelsen ska skickas som ett JSON-objekt.' };
  }
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknown !== undefined) return { ok: false, message: 'Påminnelsen innehåller ett fält som inte finns.' };

  const at = parseInstant(fields['at']);
  if (at === null) {
    return { ok: false, message: 'Tiden ska anges som ISO-tid med tidszon, t.ex. "2026-10-02T09:00:00+02:00".' };
  }
  if (at <= now) return { ok: false, message: 'Tiden har redan passerat.' };
  if (at > now + settings.maxDaysAhead * DAY) {
    return { ok: false, message: `Tiden får ligga högst ${settings.maxDaysAhead} dagar fram.` };
  }

  const repeatValue = fields['repeat'];
  let repeat: Repeat | null = null;
  if (repeatValue !== undefined && repeatValue !== null) {
    if (typeof repeatValue !== 'string' || !(REPEATS as readonly string[]).includes(repeatValue)) {
      return { ok: false, message: 'Upprepningen ska vara "daily", "weekly" eller "monthly".' };
    }
    repeat = repeatValue as Repeat;
  }

  const to = parseRecipients(fields['to']);
  if (to === null) {
    return { ok: false, message: `Mottagare ska vara "all", "owner" eller en lista med högst ${MAX_RECIPIENTS} användar-id.` };
  }

  const subject = fields['subject'];
  if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > MAX_SUBJECT_LENGTH || CONTROL.test(subject)) {
    return { ok: false, message: `Ämnet ska vara en rad text på högst ${MAX_SUBJECT_LENGTH} tecken.` };
  }
  const text = fields['text'];
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH || TEXT_CONTROL.test(text)) {
    return { ok: false, message: `Texten får vara högst ${MAX_TEXT_LENGTH} tecken.` };
  }
  return { ok: true, at, repeat, to, subject, text };
}

// ── Tjänsten ────────────────────────────────────────────────────────────────────

/** Tjänsten och dess väckning. `tick` finns för testerna; i drift sköter timern den. */
export interface ScheduleInstance {
  readonly service: AppService;
  /** Skickar alla förfallna påminnelser. Samtidiga anrop delar på samma körning. */
  tick(): Promise<void>;
}

/** App-id förkortas i loggarna (docs/tjanster.md). */
const shortId = (appId: AppId): string => appId.slice(0, 8);

export function createSchedule(dependencies: AppServiceDependencies): ScheduleInstance {
  const { notifier } = dependencies;
  if (notifier === undefined) {
    throw new Error('schedule kräver tjänsten notify — slå på båda (APP_SERVICES=notify,schedule).');
  }
  const settings = readSettings(dependencies.env);
  const store: ReminderStore = openReminderStore(dependencies.dataDir);
  const { log } = dependencies;
  const now = (): number => dependencies.now().getTime();

  let closed = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function send(reminder: Reminder, sender: AppNotifier): Promise<void> {
    const app = shortId(reminder.appId);
    // Den som tagits bort ur appen ska inte kunna fortsätta skicka till medlemmarna genom en
    // kvarglömd påminnelse. Ägaren ser den inte heller längre som sin — den tas bort helt.
    const members = await dependencies.members.members(reminder.appId);
    if (!members.some((m) => m.userId === reminder.createdBy)) {
      store.remove(reminder.appId, reminder.kind, reminder.id);
      log({ level: 'info', event: 'reminder_dropped', app, reason: 'creator_not_member' });
      return;
    }
    // Förhandsvisningen kör ogranskad kod: den når bara ägaren, oavsett vad som lagrats.
    const to: Recipients = reminder.kind === 'draft' ? 'owner' : reminder.to;
    const { sent } = await sender.notify(reminder.appId, { to, subject: reminder.subject, text: reminder.text });
    log({ level: 'info', event: 'reminder_sent', app, kind: reminder.kind, recipients: sent, repeating: reminder.repeat !== null });
  }

  async function runDue(): Promise<void> {
    for (;;) {
      if (closed) return;
      // Påminnelserna markeras som skickade (engång: borttagen, upprepad: nästa tid EFTER nu) i
      // samma transaktion som de plockas ut, INNAN de skickas. Kraschar processen mitt i ett
      // utskick blir det en missad påminnelse — aldrig en dubblett. Notify har ingen nyckel för
      // att känna igen ett upprepat utskick, och "påminnelse" två gånger till alla medlemmar är
      // värre än en som uteblir; ägaren ser ändå nästa tillfälle i listan.
      // Nästa tid räknas från NU: efter ett avbrott eller ett klockhopp framåt skickas en upprepad
      // påminnelse en gång, inte en gång per missat tillfälle — tio "städdag i dag" i rad säger
      // inget mer än ett, och bara det senaste är aktuellt.
      const claimed = store.claimDue(now(), CLAIM_BATCH);
      for (const reminder of claimed) {
        try {
          await send(reminder, notifier as AppNotifier);
        } catch (error) {
          // Inget nytt försök (se ovan), och ett nekat utskick stoppar inte de andra. Notify nekar
          // med DataApiError (`invalid_request`, t.ex. en främmande webbadress i texten, eller
          // `rate_limited`). Felets namn och kod loggas — aldrig meddelandet, som kan citera texten.
          log({
            level: 'warn',
            event: 'reminder_failed',
            app: shortId(reminder.appId),
            error: error instanceof Error ? error.name : 'unknown',
            ...(error instanceof DataApiError ? { code: error.code } : {}),
          });
        }
      }
      if (claimed.length < CLAIM_BATCH) return;
    }
  }

  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    running ??= runDue()
      .catch((error: unknown) => {
        log({ level: 'error', event: 'tick_failed', error: error instanceof Error ? error.name : 'unknown' });
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  function schedule(): void {
    if (closed) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, settings.tickMs);
    // Timern ska aldrig ensam hålla processen vid liv.
    timer.unref();
  }
  schedule();

  function create(request: AppServiceRequest): AppServiceResponse {
    const parsed = parseReminder(parseBody(request.body), now(), settings);
    if (!parsed.ok) return INVALID(parsed.message);
    const { tenant, identity } = request;
    const reminder: Reminder = {
      id: randomUUID(),
      appId: tenant.appId,
      kind: tenant.kind,
      createdBy: identity.userId,
      to: tenant.kind === 'draft' ? 'owner' : parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      repeat: parsed.repeat,
      firstAt: parsed.at,
      nextAt: parsed.at,
    };
    const result = store.insert(reminder, { perApp: settings.maxPerApp, perUser: settings.maxPerUser });
    // 429 och inte `quota_exceeded`: gatewayn släpper inte igenom 507 från en tjänst.
    if (result === 'app_full') {
      return fail('rate_limited', `Appen har redan ${settings.maxPerApp} aktiva påminnelser. Ta bort någon och försök igen.`);
    }
    if (result === 'user_full') {
      return fail('rate_limited', `Du har redan ${settings.maxPerUser} aktiva påminnelser. Ta bort någon och försök igen.`);
    }
    log({ level: 'info', event: 'reminder_created', app: shortId(tenant.appId), kind: tenant.kind, repeating: parsed.repeat !== null });
    return ok(201, { id: reminder.id, nextAt: new Date(reminder.nextAt).toISOString() });
  }

  function list(request: AppServiceRequest): AppServiceResponse {
    const { tenant, identity, access } = request;
    const reminders = store.list(tenant.appId, tenant.kind, access === 'owner' ? undefined : identity.userId);
    return ok(200, { reminders: reminders.map(view) });
  }

  function cancel(request: AppServiceRequest, id: string): AppServiceResponse {
    const { tenant, identity, access } = request;
    if (!ID_PATTERN.test(id)) return NOT_FOUND();
    const reminder = store.get(tenant.appId, tenant.kind, id);
    // Någon annans påminnelse "finns inte" — att den finns röjs inte.
    if (reminder === undefined || (access !== 'owner' && reminder.createdBy !== identity.userId)) return NOT_FOUND();
    store.remove(tenant.appId, tenant.kind, id);
    log({ level: 'info', event: 'reminder_cancelled', app: shortId(tenant.appId), kind: tenant.kind });
    return ok(200, { cancelled: true });
  }

  const service: AppService = {
    name: SERVICE_NAME,
    maxBodyBytes: MAX_BODY_BYTES,
    async handle(request) {
      if (closed) return fail('internal', 'Tjänsten stängs. Försök igen om en stund.');
      const { method, segments } = request;
      if (segments.length === 0) {
        if (method === 'POST') return create(request);
        if (method === 'GET') return list(request);
        return fail('method_not_allowed', 'Det här går inte att göra på det sättet.');
      }
      if (segments.length === 1 && segments[0] !== undefined) {
        if (method === 'DELETE') return cancel(request, segments[0]);
        if (method === 'GET' || method === 'POST') return NOT_FOUND();
        return fail('method_not_allowed', 'Det här går inte att göra på det sättet.');
      }
      return NOT_FOUND();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      // Pågående utskick får gå klart; databasen stängs först därefter.
      await running;
      store.close();
    },
  };

  return { service, tick };
}

export const factory: AppServiceFactory = (dependencies) => ({ service: createSchedule(dependencies).service });
