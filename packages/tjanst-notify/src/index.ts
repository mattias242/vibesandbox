/**
 * Plattformstjänsten `notify` (`/_api/notify`): aviseringar via mejl till en apps medlemmar —
 * aldrig till godtyckliga adresser. Slås på med APP_SERVICES=notify och kräver plattformens
 * mejltjänst. Delar med sig av en `AppNotifier` som tjänsten `schedule` skickar påminnelser genom.
 *
 * Inställningar (miljövariabler, alla valfria):
 *   SVC_NOTIFY_PER_USER_HOUR  mejl per avsändare och timme (standard 20)
 *   SVC_NOTIFY_PER_USER_DAY   mejl per avsändare och dygn (standard 100)
 *   SVC_NOTIFY_PER_APP_HOUR   mejl per app och timme (standard 200)
 *   SVC_NOTIFY_PER_APP_DAY    mejl per app och dygn (standard 1000)
 */
import type { AppServiceFactory } from '@vibesandbox/contracts';
import { openNotifyStore } from './lagring.ts';
import type { Limits } from './lagring.ts';
import { createNotifyCore } from './tjanst.ts';

const DEFAULT_LIMITS: Limits = { perUserHour: 20, perUserDay: 100, perAppHour: 200, perAppDay: 1000 };
const MAX_LIMIT = 1_000_000;

function readLimit(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`${name} ska vara ett heltal mellan 1 och ${MAX_LIMIT}.`);
  }
  return value;
}

export const factory: AppServiceFactory = (dependencies) => {
  const mailer = dependencies.mailer;
  if (mailer === undefined) {
    throw new Error(
      'notify kräver mejl — sätt MAILGUN_API_KEY och MAILGUN_DOMAIN (inloggning med e-postkod), ' +
        'eller ta bort notify ur APP_SERVICES.',
    );
  }
  const { env } = dependencies;
  const limits: Limits = {
    perUserHour: readLimit(env, 'SVC_NOTIFY_PER_USER_HOUR', DEFAULT_LIMITS.perUserHour),
    perUserDay: readLimit(env, 'SVC_NOTIFY_PER_USER_DAY', DEFAULT_LIMITS.perUserDay),
    perAppHour: readLimit(env, 'SVC_NOTIFY_PER_APP_HOUR', DEFAULT_LIMITS.perAppHour),
    perAppDay: readLimit(env, 'SVC_NOTIFY_PER_APP_DAY', DEFAULT_LIMITS.perAppDay),
  };
  const store = openNotifyStore(dependencies.dataDir);
  const { service, notifier } = createNotifyCore(dependencies, mailer, store, limits);
  return { service, notifier };
};
