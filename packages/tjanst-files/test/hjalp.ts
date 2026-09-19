/**
 * Testhjälp: en `files`-instans i en egen temporär katalog, och förfrågningar som gatewayn
 * skulle ha lämnat dem (hyresgäst, identitet och åtkomst redan avgjorda).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppId,
  AppMemberDirectory,
  AppServiceDependencies,
  AppServiceInstance,
  AppServiceRequest,
  AppServiceResponse,
  TenantContext,
  TenantKind,
  TenantStore,
} from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';

export const APP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' as AppId;
export const APP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb' as AppId;

export function tenant(appId: AppId = APP_A, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

export type Loggrad = { level: string; event: string } & Record<string, string | number | boolean>;

export interface Testtjanst {
  readonly instans: AppServiceInstance;
  readonly dataDir: string;
  readonly logg: Loggrad[];
  anropa(anrop: Partial<Omit<AppServiceRequest, 'identity'>> & { user?: string; access?: AppAccessRole }): Promise<Svar>;
  ladda(anrop: { bytes: Uint8Array; typ?: string; namn?: string; personal?: boolean; user?: string; tenant?: TenantContext; query?: string }): Promise<Svar>;
  stang(): Promise<void>;
}

export interface Svar extends AppServiceResponse {
  json(): Record<string, unknown>;
  bytes(): Uint8Array;
}

function svar(r: AppServiceResponse): Svar {
  return {
    ...r,
    json: () => JSON.parse(typeof r.body === 'string' ? r.body : Buffer.from(r.body ?? new Uint8Array()).toString('utf8')) as Record<string, unknown>,
    bytes: () => (typeof r.body === 'string' ? Uint8Array.from(Buffer.from(r.body)) : (r.body ?? new Uint8Array())),
  };
}

export async function skapaTjanst(env: Record<string, string> = {}, dataDir?: string): Promise<Testtjanst> {
  const katalog = dataDir ?? (await mkdtemp(join(tmpdir(), 'vibesandbox-files-')));
  const logg: Loggrad[] = [];
  const beroenden: AppServiceDependencies = {
    dataDir: katalog,
    env,
    log: (rad) => logg.push(rad as Loggrad),
    now: () => new Date('2026-09-19T08:00:00.000Z'),
    members: {} as AppMemberDirectory,
    store: {} as TenantStore,
    publishedUrl: (appId) => `https://${appId}.example.org`,
  };
  const instans = factory(beroenden);
  const anropa: Testtjanst['anropa'] = async (a) =>
    svar(
      await instans.service.handle({
        method: a.method ?? 'GET',
        segments: a.segments ?? [],
        query: a.query ?? '',
        headers: a.headers ?? {},
        tenant: a.tenant ?? tenant(),
        identity: { userId: a.user ?? 'anv-anna', email: 'dold@example.org', roles: ['viewer'] },
        access: a.access ?? (a.user === undefined || a.user === 'anv-anna' ? 'owner' : 'user'),
        ...(a.body === undefined ? {} : { body: a.body }),
      }),
    );
  return {
    instans,
    dataDir: katalog,
    logg,
    anropa,
    ladda: (a) =>
      anropa({
        method: 'POST',
        query: a.query ?? `name=${encodeURIComponent(a.namn ?? 'fil')}${a.personal === true ? '&personal=true' : ''}`,
        headers: a.typ === undefined ? {} : { 'content-type': a.typ },
        body: a.bytes,
        ...(a.user === undefined ? {} : { user: a.user }),
        ...(a.tenant === undefined ? {} : { tenant: a.tenant }),
      }),
    async stang() {
      await instans.service.close?.();
      if (dataDir === undefined) await rm(katalog, { recursive: true, force: true });
    },
  };
}
