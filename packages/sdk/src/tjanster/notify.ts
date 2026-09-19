/**
 * Tjänsten `notify` för appar (`/_api/notify`): aviseringar via mejl till appens medlemmar.
 * Mottagare anges med användar-id (från tjänsten `roles`) eller `'all'`/`'owner'` — aldrig med
 * e-postadress, och appen får aldrig se någons adress. Plattformen prövar texten (inga
 * webbadresser utom appens egen) och gränserna; fel kommer som `SdkError` i klarspråk.
 * Dokumentation för byggagenten: packages/sdk/tjanster/notify.md.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

export interface NotifyMessage {
  /** Användar-id bland appens medlemmar, `'all'` (alla medlemmar) eller `'owner'` (appens ägare). */
  readonly to: readonly string[] | 'all' | 'owner';
  /** Ämnesraden, högst 150 tecken. */
  readonly subject: string;
  /** Ren text, högst 5000 tecken. Inga webbadresser utom appens egen. */
  readonly text: string;
}

export interface NotifyResult {
  /** Så många mejl som gick iväg. Okända, avstängda och de utan adress räknas inte. */
  readonly sent: number;
  /** Sant i förhandsvisningen (utkastet): då gick mejlet bara till ägaren. */
  readonly onlyOwner?: boolean;
  /** Förklaring att visa när `onlyOwner` är sant. */
  readonly message?: string;
}

export interface NotifySettings {
  /** Har den inloggade stängt av aviseringar från den här appen? */
  readonly muted: boolean;
}

/** Bara för tester. */
export interface NotifyOptions {
  readonly fetch?: ServiceFetch;
}

function assertMessage(message: NotifyMessage): void {
  const valid =
    typeof message === 'object' &&
    message !== null &&
    (message.to === 'all' ||
      message.to === 'owner' ||
      (Array.isArray(message.to) && message.to.length > 0 && message.to.every((id) => typeof id === 'string' && id.length > 0))) &&
    typeof message.subject === 'string' &&
    message.subject.trim().length > 0 &&
    typeof message.text === 'string' &&
    message.text.trim().length > 0;
  if (!valid) {
    throw new SdkError('invalid_request', "Aviseringen behöver mottagare ('all', 'owner' eller användar-id), ett ämne och en text.");
  }
}

function fetchOption(options: NotifyOptions): { fetch?: ServiceFetch } {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}

/** Skickar en avisering via mejl. */
export async function send(message: NotifyMessage, options: NotifyOptions = {}): Promise<NotifyResult> {
  assertMessage(message);
  const body = (await callService('notify', 'POST', '', {
    json: { to: message.to, subject: message.subject, text: message.text },
    ...fetchOption(options),
  })) as Partial<NotifyResult> | null;
  if (typeof body?.sent !== 'number') throw new SdkError('internal');
  return {
    sent: body.sent,
    ...(body.onlyOwner === true ? { onlyOwner: true } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

function toSettings(body: unknown): NotifySettings {
  const muted = (body as Partial<NotifySettings> | null)?.muted;
  if (typeof muted !== 'boolean') throw new SdkError('internal');
  return { muted };
}

/** Den inloggades inställning för aviseringar från den här appen. */
export async function settings(options: NotifyOptions = {}): Promise<NotifySettings> {
  return toSettings(await callService('notify', 'GET', '/settings', fetchOption(options)));
}

/** Stänger av (`true`) eller slår på (`false`) aviseringar från den här appen för den inloggade. */
export async function setMuted(muted: boolean, options: NotifyOptions = {}): Promise<NotifySettings> {
  if (typeof muted !== 'boolean') throw new SdkError('invalid_request', 'Ange true eller false.');
  return toSettings(await callService('notify', 'PUT', '/settings', { json: { muted }, ...fetchOption(options) }));
}
