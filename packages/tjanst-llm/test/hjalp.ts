/**
 * Gemensamt för tjänstens tester: beroenden med egen temporär katalog, fångade loggrader, en
 * klocka testet styr och förfrågningar som gatewayn skulle ha lämnat dem.
 *
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — här är det uttryckligen tillåtet,
 * eftersom testerna spelar gatewayns roll.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppAccessRole, AppId, AppServiceDependencies, AppServiceRequest, AppServiceResponse, TenantKind } from '@vibesandbox/contracts';

export const APP_A = '01hzzzzzzzzzzzzzzzzzzzzzza';
export const APP_B = '01hzzzzzzzzzzzzzzzzzzzzzzb';

export type Loggrad = Parameters<AppServiceDependencies['log']>[0];

export interface Testmiljo {
  readonly dataDir: string;
  readonly loggar: Loggrad[];
  /** Klockan som tjänsten ser. Ändra `tid.nu` för att flytta den. */
  readonly tid: { nu: Date };
  beroenden(env?: Readonly<Record<string, string | undefined>>, berget?: AppServiceDependencies['berget'] | null): AppServiceDependencies;
  stada(): Promise<void>;
}

export async function skapaTestmiljo(): Promise<Testmiljo> {
  const dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-tjanst-llm-'));
  const loggar: Loggrad[] = [];
  const tid = { nu: new Date('2026-09-19T10:15:00Z') };
  return {
    dataDir,
    loggar,
    tid,
    beroenden(env = { SVC_LLM_MODEL: 'fejk/modell' }, berget = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-nyckel-0123456789abcdef' }) {
      return {
        dataDir,
        env,
        log: (rad) => loggar.push(rad),
        now: () => tid.nu,
        members: { members: async () => [] },
        store: {} as AppServiceDependencies['store'],
        publishedUrl: (appId) => `https://${appId}.appar.test`,
        ...(berget === null ? {} : { berget }),
      };
    },
    async stada() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Anrop {
  readonly metod?: string;
  readonly segment?: readonly string[];
  readonly query?: string;
  readonly json?: unknown;
  /** Rå kropp i stället för `json`. */
  readonly kropp?: string;
  readonly contentType?: string | null;
  readonly app?: string;
  readonly kind?: TenantKind;
  readonly userId?: string;
  readonly access?: AppAccessRole;
}

export function forfragan(anrop: Anrop = {}): AppServiceRequest {
  const text = anrop.kropp ?? (anrop.json === undefined ? undefined : JSON.stringify(anrop.json));
  const contentType = anrop.contentType === undefined ? 'application/json' : anrop.contentType;
  return {
    method: anrop.metod ?? 'POST',
    segments: anrop.segment ?? ['complete'],
    query: anrop.query ?? '',
    headers: contentType === null ? {} : { 'content-type': contentType },
    ...(text === undefined ? {} : { body: new TextEncoder().encode(text) }),
    tenant: unsafeCreateTenantContext((anrop.app ?? APP_A) as AppId, anrop.kind ?? 'published'),
    identity: { userId: anrop.userId ?? 'anv-anna', email: 'anna@example.org', roles: ['viewer'] },
    access: anrop.access ?? 'user',
  };
}

export function kropp(svar: AppServiceResponse): Record<string, unknown> {
  const text = typeof svar.body === 'string' ? svar.body : new TextDecoder().decode(svar.body ?? new Uint8Array());
  return JSON.parse(text) as Record<string, unknown>;
}

export function felkod(svar: AppServiceResponse): unknown {
  return (kropp(svar)['error'] as { code?: unknown } | undefined)?.code;
}

export function felmeddelande(svar: AppServiceResponse): string {
  return String((kropp(svar)['error'] as { message?: unknown } | undefined)?.message);
}

/** Allt tjänsten svarade, som text — för kontroller av typen "nämns X någonstans?". */
export function allText(svar: AppServiceResponse): string {
  return JSON.stringify(svar.headers) + (typeof svar.body === 'string' ? svar.body : new TextDecoder().decode(svar.body ?? new Uint8Array()));
}
