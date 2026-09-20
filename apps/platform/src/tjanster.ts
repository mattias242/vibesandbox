/**
 * Plattformstjänsterna för appar (`/_api/<namn>`): vilka som finns, och hur de skapas.
 *
 * Varje tjänst är ett eget paket, `@vibesandbox/tjanst-<namn>`, som exporterar `factory` — eller
 * `undefined` så länge tjänsten inte är byggd. Vilka som är påslagna avgör `APP_SERVICES`; en
 * avslagen tjänst skapas aldrig och finns inte för apparna (404).
 *
 * Tjänsterna skapas i `APP_SERVICE_NAMES` ordning, så att en tjänst kan använda det en tidigare
 * delat med sig av: `ocr` och `transcribe` läser filer genom `files`, `schedule` skickar genom `notify`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_SERVICE_NAMES } from '@vibesandbox/contracts';
import type {
  AppFileReader,
  AppMailer,
  AppMemberDirectory,
  AppNotifier,
  AppService,
  AppServiceDependencies,
  AppServiceFactory,
  AppServiceName,
  TenantStore,
} from '@vibesandbox/contracts';
import { factory as files } from '@vibesandbox/tjanst-files';
import { factory as history } from '@vibesandbox/tjanst-history';
import { factory as llm } from '@vibesandbox/tjanst-llm';
import { factory as notify } from '@vibesandbox/tjanst-notify';
import { factory as ocr } from '@vibesandbox/tjanst-ocr';
import { factory as roles } from '@vibesandbox/tjanst-roles';
import { factory as schedule } from '@vibesandbox/tjanst-schedule';
import { factory as search } from '@vibesandbox/tjanst-search';
import { factory as transcribe } from '@vibesandbox/tjanst-transcribe';
import type { PlatformLogger } from './logg.ts';

/** De byggda tjänsterna. Ett paket som ännu inte är klart exporterar `undefined`. */
export const APP_SERVICE_FACTORIES: Readonly<Partial<Record<AppServiceName, AppServiceFactory>>> = Object.fromEntries(
  Object.entries({ files, notify, roles, llm, ocr, history, schedule, transcribe, search }).filter(([, f]) => f !== undefined),
);

export interface AppServiceSetup {
  readonly enabled: readonly AppServiceName[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly factories: Readonly<Partial<Record<AppServiceName, AppServiceFactory>>>;
  readonly dataDir: string;
  readonly log: PlatformLogger;
  readonly members: AppMemberDirectory;
  readonly store: TenantStore;
  readonly publishedUrl: (appId: string) => string;
  readonly berget?: { readonly baseUrl: string; readonly apiKey: string };
  readonly mailer?: AppMailer;
}

/** Skapar de påslagna tjänsterna. Kastar vid start om en påslagen tjänst saknas eller är felbyggd. */
export function createAppServices(setup: AppServiceSetup): AppService[] {
  const enabled = new Set(setup.enabled);
  // Tomt värde = inte satt. docker compose skickar in VARJE variabel, även de som inte är
  // ifyllda (`${SVC_X:-}`), och en tjänst som läser "" som ett ogiltigt värde fäller hela
  // plattformen vid start. Det hände i drift 2026-09-20: SVC_HISTORY_RETENTION_DAYS var tom.
  const env = Object.fromEntries(
    Object.entries(setup.env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const services: AppService[] = [];
  let fileReader: AppFileReader | undefined;
  let notifier: AppNotifier | undefined;

  for (const name of APP_SERVICE_NAMES) {
    if (!enabled.has(name)) continue;
    const factory = setup.factories[name];
    if (factory === undefined) {
      throw new Error(`Tjänsten "${name}" är påslagen i APP_SERVICES men är inte byggd i den här versionen.`);
    }
    const dataDir = join(setup.dataDir, 'services', name);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dependencies: AppServiceDependencies = {
      dataDir,
      env,
      log: (entry) => setup.log({ source: 'service', service: name, ...entry }),
      now: () => new Date(),
      members: setup.members,
      store: setup.store,
      publishedUrl: setup.publishedUrl,
      ...(setup.berget === undefined ? {} : { berget: setup.berget }),
      ...(setup.mailer === undefined ? {} : { mailer: setup.mailer }),
      ...(fileReader === undefined ? {} : { files: fileReader }),
      ...(notifier === undefined ? {} : { notifier }),
    };
    const instance = factory(dependencies);
    if (instance?.service?.name !== name) {
      throw new Error(`Tjänsten "${name}": fabriken gav en tjänst med ett annat namn.`);
    }
    services.push(instance.service);
    if (instance.fileReader !== undefined) fileReader = instance.fileReader;
    if (instance.notifier !== undefined) notifier = instance.notifier;
  }
  return services;
}
