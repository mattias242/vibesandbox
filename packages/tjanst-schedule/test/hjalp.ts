/**
 * Testhjälp för tjänsten `schedule`: en styrbar klocka, en fejkad notifier och medlemslista, och
 * förfrågningar som gatewayn skulle ha lämnat. `unsafeCreateTenantContext` är annars förbehållet
 * gatewayn — i enhetstester är det den enda vägen att bygga ett TenantContext.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppId,
  AppMemberDirectory,
  AppNotifier,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  TenantKind,
  TenantStore,
} from '@vibesandbox/contracts';

export const APP_A = '0000000000000000000000000a' as AppId;
export const APP_B = '0000000000000000000000000b' as AppId;

export interface Utskick {
  readonly appId: AppId;
  readonly to: readonly string[] | 'all' | 'owner';
  readonly subject: string;
  readonly text: string;
}

export interface Klocka {
  nu: number;
  readonly now: () => Date;
  satt(iso: string): void;
  fram(ms: number): void;
}

export function klocka(iso: string): Klocka {
  const k: Klocka = {
    nu: Date.parse(iso),
    now: () => new Date(k.nu),
    satt: (t) => {
      k.nu = Date.parse(t);
    },
    fram: (ms) => {
      k.nu += ms;
    },
  };
  return k;
}

export interface FejkNotifier extends AppNotifier {
  readonly skickat: Utskick[];
  /** Sätts för att låta nästa utskick vänta, kasta osv. */
  beteende: (utskick: Utskick) => Promise<void>;
}

export function fejkNotifier(): FejkNotifier {
  const n: FejkNotifier = {
    skickat: [],
    beteende: async () => {},
    notify: async (appId, message) => {
      const utskick = { appId, to: message.to, subject: message.subject, text: message.text };
      await n.beteende(utskick);
      n.skickat.push(utskick);
      return { sent: 1 };
    },
  };
  return n;
}

export interface FejkMedlemmar extends AppMemberDirectory {
  readonly lista: Map<AppId, { userId: string; role: AppAccessRole; email: string | null }[]>;
  taBort(appId: AppId, userId: string): void;
}

export function fejkMedlemmar(): FejkMedlemmar {
  const lista = new Map<AppId, { userId: string; role: AppAccessRole; email: string | null }[]>([
    [
      APP_A,
      [
        { userId: 'anna', role: 'owner', email: 'anna@example.org' },
        { userId: 'bertil', role: 'user', email: 'bertil@example.org' },
        { userId: 'cecilia', role: 'user', email: 'cecilia@example.org' },
      ],
    ],
    [APP_B, [{ userId: 'bertil', role: 'owner', email: 'bertil@example.org' }]],
  ]);
  return {
    lista,
    members: async (appId) => lista.get(appId) ?? [],
    taBort: (appId, userId) => {
      lista.set(
        appId,
        (lista.get(appId) ?? []).filter((m) => m.userId !== userId),
      );
    },
  };
}

export interface Logg {
  readonly rader: Record<string, unknown>[];
  readonly log: AppServiceDependencies['log'];
}

export function logg(): Logg {
  const rader: Record<string, unknown>[] = [];
  return { rader, log: (entry) => rader.push({ ...entry }) };
}

export async function tempKatalog(): Promise<{ katalog: string; stada: () => Promise<void> }> {
  const katalog = await mkdtemp(join(tmpdir(), 'tjanst-schedule-'));
  return { katalog, stada: () => rm(katalog, { recursive: true, force: true }) };
}

export function beroenden(delar: {
  dataDir: string;
  klocka: Klocka;
  notifier?: AppNotifier;
  medlemmar?: AppMemberDirectory;
  logg?: Logg;
  env?: Record<string, string>;
}): AppServiceDependencies {
  return {
    dataDir: delar.dataDir,
    // Stor tick som standard: testerna driver utskicken själva med `tick()`.
    env: { SVC_SCHEDULE_TICK_MS: '3600000', ...delar.env },
    log: delar.logg?.log ?? (() => {}),
    now: delar.klocka.now,
    members: delar.medlemmar ?? fejkMedlemmar(),
    store: {} as TenantStore,
    publishedUrl: (appId) => `https://${appId}.appar.test/`,
    ...(delar.notifier === undefined ? {} : { notifier: delar.notifier }),
  };
}

export interface Anropare {
  readonly userId: string;
  readonly access: AppAccessRole;
  readonly appId?: AppId;
  readonly kind?: TenantKind;
}

export const ANNA: Anropare = { userId: 'anna', access: 'owner' };
export const BERTIL: Anropare = { userId: 'bertil', access: 'user' };
export const CECILIA: Anropare = { userId: 'cecilia', access: 'user' };

export function forfragan(
  vem: Anropare,
  method: string,
  segments: readonly string[] = [],
  body?: unknown,
): AppServiceRequest {
  const bytes =
    body === undefined ? undefined : body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    method,
    segments,
    query: '',
    headers: { 'content-type': 'application/json' },
    tenant: unsafeCreateTenantContext(vem.appId ?? APP_A, vem.kind ?? 'published'),
    identity: { userId: vem.userId, email: `${vem.userId}@example.org`, roles: ['viewer'] },
    access: vem.access,
    ...(bytes === undefined ? {} : { body: bytes }),
  };
}

export function json(svar: AppServiceResponse): Record<string, unknown> {
  if (typeof svar.body !== 'string') throw new Error('Svaret saknar JSON-kropp.');
  return JSON.parse(svar.body) as Record<string, unknown>;
}

export function felkod(svar: AppServiceResponse): string {
  return (json(svar)['error'] as { code: string }).code;
}
