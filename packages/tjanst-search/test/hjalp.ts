/**
 * Testhjälp för tjänsten search. Ingen produktionskod importerar detta.
 *
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — i ett enhetstest är det den enda
 * vägen att bygga ett TenantContext.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppAccessRole, AppId, AppServiceRequest, Identity, TenantContext, TenantKind } from '@vibesandbox/contracts';
import type { Embedder } from '../src/inbaddning.ts';

export const APP_A = '0000000000000000000000000a' as AppId;
export const APP_B = '0000000000000000000000000b' as AppId;

export function tenant(appId: AppId = APP_A, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

export const anna: Identity = { userId: 'anv-anna', email: 'anna@exempel.se', roles: ['viewer'] };
export const bertil: Identity = { userId: 'anv-bertil', email: 'bertil@exempel.se', roles: ['viewer'] };

export async function tempKatalog(): Promise<{ katalog: string; stada: () => Promise<void> }> {
  const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-search-'));
  return { katalog, stada: () => rm(katalog, { recursive: true, force: true }) };
}

const DIMENSIONER = 128;

/** Histogram över teckentrigram: texter med gemensamma ordstammar hamnar nära varandra. */
export function trigramvektor(text: string): Float32Array {
  const vektor = new Float32Array(DIMENSIONER);
  const ren = ` ${text.replace(/^(?:query|passage): /, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  for (let i = 0; i + 3 <= ren.length; i += 1) {
    let hash = 2166136261;
    for (const tecken of ren.slice(i, i + 3)) hash = Math.imul(hash ^ (tecken.codePointAt(0) ?? 0), 16777619);
    const plats = (hash >>> 0) % DIMENSIONER;
    vektor[plats] = (vektor[plats] ?? 0) + 1;
  }
  return vektor;
}

export interface FejkadInbaddare extends Embedder {
  /** Varje anrop: de texter som skickades. */
  readonly anrop: string[][];
  /** Alla texter som någonsin skickats. */
  readonly allt: () => string[];
  fel: Error | undefined;
}

export function fejkadInbaddare(model = 'intfloat/multilingual-e5-large'): FejkadInbaddare {
  const anrop: string[][] = [];
  const fejk: FejkadInbaddare = {
    model,
    anrop,
    allt: () => anrop.flat(),
    fel: undefined,
    async embed(texts) {
      if (fejk.fel !== undefined) throw fejk.fel;
      anrop.push([...texts]);
      return { vectors: texts.map(trigramvektor), tokens: texts.reduce((summa, t) => summa + t.length, 0) };
    },
  };
  return fejk;
}

export function forfragan(
  body: unknown,
  val: {
    readonly tenant?: TenantContext;
    readonly identity?: Identity;
    readonly method?: string;
    readonly segments?: readonly string[];
    readonly query?: string;
    readonly access?: AppAccessRole;
    readonly contentType?: string;
    readonly raw?: Uint8Array;
  } = {},
): AppServiceRequest {
  return {
    method: val.method ?? 'POST',
    segments: val.segments ?? [],
    query: val.query ?? '',
    headers: { 'content-type': val.contentType ?? 'application/json' },
    body: val.raw ?? new TextEncoder().encode(JSON.stringify(body)),
    tenant: val.tenant ?? tenant(),
    identity: val.identity ?? anna,
    access: val.access ?? 'user',
  };
}

export function json(body: string | Uint8Array | undefined): Record<string, unknown> {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return JSON.parse(text) as Record<string, unknown>;
}
