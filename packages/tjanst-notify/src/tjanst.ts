/**
 * Tjänsten `notify`: aviseringar via mejl till en apps medlemmar.
 *
 *   POST /_api/notify           { to: userId[] | 'all' | 'owner', subject, text } → { sent }
 *   GET  /_api/notify/settings  → { muted }
 *   PUT  /_api/notify/settings  { muted: boolean } → { muted }
 *
 * Säkerhetsbesluten:
 * - Mottagarna slås ALLTID upp bland appens medlemmar (`dependencies.members`). Ett id som inte
 *   hör till appen hoppas över tyst, med samma svar som ett id som inte finns alls. En e-postadress
 *   kan aldrig anges, och appen får aldrig se någons adress.
 * - Ett utkast (ogranskad kod, bara ägaren når det) mejlar bara ägaren själv, oavsett `to`.
 * - Nätfiskeskydd i innehall.ts; mejlets ram i mejl.ts.
 * - Hastighetsgränser per avsändare (över alla appar) och per app, per timme och dygn. 'all'
 *   räknas per mottagare, och ett utskick som inte ryms skickas inte alls — inte heller delvis.
 * - Loggar: antal, app-prefix och userId. Aldrig adresser, ämnen eller text.
 */
import { API_ERROR_STATUS, DataApiError } from '@vibesandbox/contracts';
import type {
  ApiErrorCode,
  AppId,
  AppMailer,
  AppNotifier,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  TenantKind,
} from '@vibesandbox/contracts';
import { checkContent } from './innehall.ts';
import type { Limits, LimitHit, NotifyStore } from './lagring.ts';
import { composeMail, displayName } from './mejl.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECIPIENT_IDS = 100;
const MAX_USER_ID_LENGTH = 256;
/** Appens namn finns inte bland tjänstens beroenden; det neutrala namnet används tills det gör det. */
const APP_NAME = 'en app';

type Recipients = readonly string[] | 'all' | 'owner';

export class NotifyError extends DataApiError {}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function reply(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function fail(code: ApiErrorCode, message: string): AppServiceResponse {
  return reply(API_ERROR_STATUS[code], { error: { code, message } });
}

const LIMIT_MESSAGES: Readonly<Record<LimitHit, string>> = {
  user_hour: 'Du har skickat för många aviseringar den senaste timmen. Försök igen senare.',
  user_day: 'Du har skickat för många aviseringar det senaste dygnet. Försök igen i morgon.',
  app_hour: 'Appen har skickat för många aviseringar den senaste timmen. Försök igen senare.',
  app_day: 'Appen har skickat för många aviseringar det senaste dygnet. Försök igen i morgon.',
};

function parseJson(body: Uint8Array | undefined): unknown {
  if (body === undefined || body.byteLength === 0) throw new NotifyError('invalid_request', 'Anropet saknar innehåll.');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new NotifyError('invalid_request', 'Anropet är inte giltig JSON.');
  }
}

/** Ett objekt med exakt de angivna nycklarna (egna egenskaper, inga andra). */
function exactObject(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotifyError('invalid_request', 'Anropet ska vara ett JSON-objekt.');
  }
  const keys = Object.keys(value);
  if (keys.length !== required.length || !required.every((key) => Object.hasOwn(value, key))) {
    throw new NotifyError('invalid_request', `Anropet ska innehålla exakt fälten ${required.join(', ')}.`);
  }
  return value as Record<string, unknown>;
}

function parseRecipients(value: unknown): Recipients {
  if (value === 'all' || value === 'owner') return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECIPIENT_IDS) {
    throw new NotifyError(
      'invalid_request',
      `Mottagare anges som 'all', 'owner' eller en lista med 1–${MAX_RECIPIENT_IDS} användar-id.`,
    );
  }
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_USER_ID_LENGTH || id.includes('\0')) {
      throw new NotifyError('invalid_request', 'Ett användar-id bland mottagarna är ogiltigt.');
    }
    if (id.includes('@')) {
      throw new NotifyError('invalid_request', 'Mottagare anges med användar-id (se tjänsten roles), aldrig med e-postadress.');
    }
  }
  return value as string[];
}

interface Message {
  readonly to: Recipients;
  readonly subject: string;
  readonly text: string;
}

interface Delivery {
  readonly appId: AppId;
  readonly kind: TenantKind;
  /** `null` = ingen avsändare (påminnelse via schedule). */
  readonly sender: { readonly userId: string; readonly email: string } | null;
  readonly message: Message;
}

export interface NotifyCore {
  readonly service: AppService;
  readonly notifier: AppNotifier;
}

export function createNotifyCore(
  dependencies: AppServiceDependencies,
  mailer: AppMailer,
  store: NotifyStore,
  limits: Limits,
): NotifyCore {
  const { log } = dependencies;

  /** Skickar enligt alla regler. Kastar `NotifyError` vid ogiltigt innehåll eller nådd gräns. */
  async function deliver(delivery: Delivery): Promise<{ sent: number; onlyOwner: boolean }> {
    const { appId, kind, sender } = delivery;
    const appUrl = dependencies.publishedUrl(appId);
    const content = checkContent(delivery.message, appUrl);
    if (!content.ok) throw new NotifyError('invalid_request', content.message);

    const members = await dependencies.members.members(appId);
    const onlyOwner = kind === 'draft';
    const to = onlyOwner ? 'owner' : delivery.message.to;
    const wanted = to === 'all' ? null : to === 'owner' ? null : new Set(to);

    const recipients: string[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      if (member.email === null || seen.has(member.userId)) continue;
      if (to === 'owner' && member.role !== 'owner') continue;
      if (wanted !== null && !wanted.has(member.userId)) continue;
      seen.add(member.userId);
      if (store.isMuted(appId, kind, member.userId)) continue;
      recipients.push(member.email);
    }

    if (recipients.length > 0) {
      const hit = store.reserve(appId, sender?.userId ?? null, recipients.length, dependencies.now().getTime(), limits);
      if (hit !== null) {
        log({ level: 'warn', event: 'notify_rate_limited', app: appId.slice(0, 8), kind, limit: hit, ...(sender === null ? {} : { userId: sender.userId }) });
        throw new NotifyError('rate_limited', LIMIT_MESSAGES[hit]);
      }
    }

    const mail = composeMail({
      sender: sender === null ? null : displayName(sender.email, appUrl),
      appName: APP_NAME,
      appUrl,
      subject: content.subject,
      text: content.text,
      draft: onlyOwner,
    });

    let sent = 0;
    for (const address of recipients) {
      try {
        await mailer.send({ to: address, subject: mail.subject, text: mail.text });
        sent += 1;
      } catch {
        // Felet kan innehålla adressen — det loggas inte, bara att något inte gick fram.
      }
    }
    const failed = recipients.length - sent;
    log({
      level: failed > 0 ? 'warn' : 'info',
      event: 'notify_sent',
      app: appId.slice(0, 8),
      kind,
      recipients: recipients.length,
      sent,
      failed,
      ...(sender === null ? { source: 'notifier' } : { userId: sender.userId }),
    });
    return { sent, onlyOwner };
  }

  async function handleSend(request: AppServiceRequest): Promise<AppServiceResponse> {
    const body = exactObject(parseJson(request.body), ['to', 'subject', 'text']);
    const message: Message = {
      to: parseRecipients(body['to']),
      subject: body['subject'] as string,
      text: body['text'] as string,
    };
    const { sent, onlyOwner } = await deliver({
      appId: request.tenant.appId,
      kind: request.tenant.kind,
      sender: { userId: request.identity.userId, email: request.identity.email },
      message,
    });
    if (!onlyOwner) return reply(200, { sent });
    return reply(200, {
      sent,
      onlyOwner: true,
      message: 'Det här är ett utkast, så mejlet gick bara till dig som äger appen. När appen är publicerad går det till mottagarna.',
    });
  }

  async function handleSettings(request: AppServiceRequest): Promise<AppServiceResponse> {
    const { appId, kind } = request.tenant;
    const { userId } = request.identity;
    if (request.method === 'PUT') {
      const body = exactObject(parseJson(request.body), ['muted']);
      if (typeof body['muted'] !== 'boolean') throw new NotifyError('invalid_request', 'Fältet muted ska vara true eller false.');
      store.setMuted(appId, kind, userId, body['muted']);
    }
    return reply(200, { muted: store.isMuted(appId, kind, userId) });
  }

  const service: AppService = {
    name: 'notify',
    maxBodyBytes: MAX_BODY_BYTES,
    async handle(request) {
      const { method, segments } = request;
      try {
        if (segments.length === 0) {
          if (method !== 'POST') return fail('method_not_allowed', 'Aviseringar skickas med POST.');
          return await handleSend(request);
        }
        if (segments.length === 1 && segments[0] === 'settings') {
          if (method !== 'GET' && method !== 'PUT') return fail('method_not_allowed', 'Inställningen läses med GET och ändras med PUT.');
          return await handleSettings(request);
        }
        return fail('not_found', 'Det finns inget här.');
      } catch (error) {
        if (error instanceof NotifyError) return fail(error.code, error.message);
        throw error;
      }
    },
    async close() {
      store.close();
    },
  };

  const notifier: AppNotifier = {
    async notify(appId, message) {
      // Utan en förfrågan finns ingen hyresgäst: kontraktet ger bara app-id:t, så det är den
      // publicerade appens medlemmar och inställningar som gäller.
      const { sent } = await deliver({
        appId,
        kind: 'published',
        sender: null,
        message: { to: parseRecipients(message.to), subject: message.subject, text: message.text },
      });
      return { sent };
    },
  };

  return { service, notifier };
}
