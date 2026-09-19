/**
 * Tjänsten `schedule` för appar (`/_api/schedule`): påminnelser som plattformen skickar till appens
 * medlemmar vid en viss tid — även när ingen har appen öppen.
 *
 *   import { schedule } from '@vibesandbox/sdk';
 *
 *   await schedule.remind({ at: '2026-10-02T09:00:00+02:00', repeat: 'weekly', to: 'all',
 *                           subject: 'Städdag', text: 'Samling vid förrådet.' });
 *   const mina = await schedule.list();
 *   await schedule.cancel(mina[0].id);
 *
 * Anropar tjänsten bara genom `callService` i ./anrop.ts. Dokumentation för byggagenten:
 * packages/sdk/tjanster/schedule.md.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

export type Repeat = 'daily' | 'weekly' | 'monthly';

/** Användar-id bland appens medlemmar, eller alla medlemmar, eller bara ägaren. */
export type Recipients = readonly string[] | 'all' | 'owner';

export interface ReminderInput {
  /** ISO-tid MED tidszon ("2026-10-02T09:00:00+02:00") eller ett `Date`. */
  readonly at: string | Date;
  /** Upprepa med samma klockslag i Sverige, även över sommartid. Utelämnas = en gång. */
  readonly repeat?: Repeat;
  readonly to: Recipients;
  /** Högst 200 tecken, en rad. */
  readonly subject: string;
  /** Högst 4000 tecken. */
  readonly text: string;
}

export interface Reminder {
  readonly id: string;
  /** Nästa utskick, ISO-tid i UTC. */
  readonly nextAt: string;
  readonly repeat: Repeat | null;
  readonly to: Recipients;
  readonly subject: string;
  readonly text: string;
  /** Användar-id för den som schemalade påminnelsen. */
  readonly createdBy: string;
}

/** Bara för tester. */
export interface ScheduleOptions {
  readonly fetch?: ServiceFetch;
}

const ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

function fetchOption(options: ScheduleOptions): { fetch?: ServiceFetch } {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}

/** Schemalägger en påminnelse. Ger dess id och när den skickas första gången. */
export async function remind(input: ReminderInput, options: ScheduleOptions = {}): Promise<{ id: string; nextAt: string }> {
  let at: string;
  if (input.at instanceof Date) {
    if (Number.isNaN(input.at.getTime())) throw new SdkError('invalid_request', 'Tiden är inte ett giltigt datum.');
    at = input.at.toISOString();
  } else {
    at = input.at;
  }
  const body = {
    at,
    ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
    to: input.to,
    subject: input.subject,
    text: input.text,
  };
  return (await callService('schedule', 'POST', '', { json: body, ...fetchOption(options) })) as { id: string; nextAt: string };
}

/** Den inloggades egna påminnelser — för appens ägare: alla i appen. */
export async function list(options: ScheduleOptions = {}): Promise<Reminder[]> {
  const svar = (await callService('schedule', 'GET', '', fetchOption(options))) as { reminders: Reminder[] };
  return svar.reminders;
}

/** Tar bort en påminnelse (sin egen; ägaren kan ta bort alla). Någon annans ger `not_found`. */
export async function cancel(id: string, options: ScheduleOptions = {}): Promise<void> {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new SdkError('invalid_request');
  await callService('schedule', 'DELETE', `/${id}`, fetchOption(options));
}
