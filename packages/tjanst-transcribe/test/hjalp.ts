/**
 * Hjälp för testerna: en fejkad Berget på en lokal port (tar emot riktig multipart), en fejkad
 * filtjänst, och förfrågningar som gatewayn skulle ha byggt dem.
 *
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — här är det uttryckligen tillåtet,
 * eftersom testerna spelar gatewayns roll.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppFileReader,
  AppId,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  TenantContext,
  TenantKind,
} from '@vibesandbox/contracts';

export const APP_A = '0123456789abcdefghjkmnpqrs' as AppId;
export const APP_B = 'zyxwvtsrqpnmkjhgfedcba9876' as AppId;

export function tenant(appId: AppId = APP_A, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

// ── Ljud ────────────────────────────────────────────────────────────────────────

/** En giltig WAV (8 kHz, 8 bitar, mono = 8000 byte per sekund) på `sekunder` sekunder. */
export function wav(sekunder: number): Uint8Array {
  const data = Math.round(sekunder * 8000);
  const buffer = Buffer.alloc(44 + data, 0x80);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(8000, 24); // samplingsfrekvens
  buffer.writeUInt32LE(8000, 28); // byte per sekund
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(data, 40);
  return new Uint8Array(buffer);
}

/** Början på en mp3 (ID3-huvud) följd av `bytes` byte. */
export function mp3(bytes: number): Uint8Array {
  const buffer = Buffer.alloc(Math.max(bytes, 10), 0);
  buffer.write('ID3', 0, 'ascii');
  return new Uint8Array(buffer);
}

export function webm(bytes: number): Uint8Array {
  const buffer = Buffer.alloc(Math.max(bytes, 8), 0);
  buffer.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return new Uint8Array(buffer);
}

export function mp4(bytes: number): Uint8Array {
  const buffer = Buffer.alloc(Math.max(bytes, 12), 0);
  buffer.write('ftypM4A ', 4, 'ascii');
  return new Uint8Array(buffer);
}

// ── Fejkad filtjänst ────────────────────────────────────────────────────────────

export interface FejkadeFiler extends AppFileReader {
  lagg(t: TenantContext, fileId: string, fil: { body: Uint8Array; contentType: string; name?: string }): void;
  ta(t: TenantContext, fileId: string): void;
  readonly lasningar: number;
}

export function fejkadeFiler(): FejkadeFiler {
  const filer = new Map<string, { body: Uint8Array; contentType: string; name: string }>();
  const nyckel = (t: TenantContext, id: string) => `${t.appId}:${t.kind}:${id}`;
  let lasningar = 0;
  return {
    async read(t, fileId) {
      lasningar += 1;
      return filer.get(nyckel(t, fileId)) ?? null;
    },
    lagg(t, fileId, fil) {
      filer.set(nyckel(t, fileId), { name: 'inspelning.wav', ...fil });
    },
    ta(t, fileId) {
      filer.delete(nyckel(t, fileId));
    },
    get lasningar() {
      return lasningar;
    },
  };
}

// ── Fejkad Berget ───────────────────────────────────────────────────────────────

export interface MottagetAnrop {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly falt: Readonly<Record<string, string>>;
  readonly fil: { readonly name: string; readonly type: string; readonly bytes: number } | undefined;
}

export type BergetSvar =
  | { readonly typ: 'ok'; readonly text?: string; readonly duration?: number; readonly segments?: unknown }
  | { readonly typ: 'fel'; readonly status: number; readonly kropp: string }
  | { readonly typ: 'skrap'; readonly kropp: string }
  /** Svarar aldrig förrän `slapp()` anropas (eller anslutningen stängs). */
  | { readonly typ: 'hang' };

export interface FejkadBerget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly anrop: MottagetAnrop[];
  svar: BergetSvar;
  /** Löser alla hängande anrop med ett lyckat svar. */
  slapp(): void;
  /** Väntar tills minst `antal` anrop har kommit in. */
  vantaPaAnrop(antal: number): Promise<void>;
  stang(): Promise<void>;
}

async function lasKropp(request: IncomingMessage): Promise<Buffer> {
  const delar: Buffer[] = [];
  for await (const del of request) delar.push(del as Buffer);
  return Buffer.concat(delar);
}

export const BERGET_TEXT = 'Välkomna till mötet. Första punkten är budgeten.';
export const BERGET_SEGMENT = [
  { id: 0, start: 0, end: 2.5, text: ' Välkomna till mötet.' },
  { id: 1, start: 2.5, end: 5, text: ' Första punkten är budgeten.' },
];

export async function fejkadBerget(): Promise<FejkadBerget> {
  const anrop: MottagetAnrop[] = [];
  const hangande = new Set<() => void>();
  const vantare = new Set<() => void>();
  const tillstand: { svar: BergetSvar } = { svar: { typ: 'ok' } };

  const okSvar = (s: { text?: string; duration?: number; segments?: unknown }) =>
    JSON.stringify({
      text: s.text ?? BERGET_TEXT,
      language: 'sv',
      duration: s.duration ?? 5,
      segments: s.segments ?? BERGET_SEGMENT,
    });

  const server: Server = createServer((request, response) => {
    void (async () => {
      const kropp = await lasKropp(request);
      // Kroppen tolkas med samma standardbibliotek som tjänsten bygger den med.
      const form = await new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': request.headers['content-type'] ?? '' },
        body: kropp,
      })
        .formData()
        .catch(() => undefined);
      const falt: Record<string, string> = {};
      let fil: MottagetAnrop['fil'];
      for (const [namn, varde] of form?.entries() ?? []) {
        if (typeof varde === 'string') falt[namn] = varde;
        else fil = { name: varde.name, type: varde.type, bytes: varde.size };
      }
      anrop.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        falt,
        fil,
      });
      for (const v of vantare) v();

      const svar = tillstand.svar;
      if (svar.typ === 'hang') {
        await new Promise<void>((resolve) => {
          hangande.add(resolve);
          response.on('close', () => resolve());
        });
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, { 'content-type': 'application/json' }).end(okSvar({}));
        return;
      }
      if (svar.typ === 'fel') {
        response.writeHead(svar.status, { 'content-type': 'text/plain' }).end(svar.kropp);
        return;
      }
      if (svar.typ === 'skrap') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(svar.kropp);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(okSvar(svar));
    })().catch(() => {
      // Anslutningen stängdes mitt i (tjänsten avbröt, eller testet stänger fejken).
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adress = server.address();
  if (adress === null || typeof adress === 'string') throw new Error('Ingen port.');

  return {
    baseUrl: `http://127.0.0.1:${adress.port}/v1`,
    apiKey: 'test-nyckel-som-aldrig-lamnar-testet',
    anrop,
    get svar() {
      return tillstand.svar;
    },
    set svar(s: BergetSvar) {
      tillstand.svar = s;
    },
    slapp() {
      for (const h of hangande) h();
      hangande.clear();
    },
    async vantaPaAnrop(antal) {
      while (anrop.length < antal) {
        await new Promise<void>((resolve) => {
          vantare.add(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
    async stang() {
      for (const h of hangande) h();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── Beroenden och förfrågningar ─────────────────────────────────────────────────

export interface Loggrad {
  readonly level: string;
  readonly event: string;
  readonly [nyckel: string]: string | number | boolean;
}

export interface Miljo {
  readonly dataDir: string;
  readonly logg: Loggrad[];
  readonly filer: FejkadeFiler;
  readonly berget: FejkadBerget;
  nu: Date;
  beroenden(env?: Record<string, string>): AppServiceDependencies;
  stada(): Promise<void>;
}

export async function miljo(): Promise<Miljo> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tjanst-transcribe-'));
  const berget = await fejkadBerget();
  const filer = fejkadeFiler();
  const logg: Loggrad[] = [];
  const m: Miljo = {
    dataDir,
    logg,
    filer,
    berget,
    nu: new Date('2026-09-19T10:00:00.000Z'),
    beroenden(env = {}) {
      return {
        dataDir,
        env,
        log: (entry) => logg.push(entry as Loggrad),
        now: () => m.nu,
        members: { members: async () => [] },
        store: {} as AppServiceDependencies['store'],
        berget: { baseUrl: berget.baseUrl, apiKey: berget.apiKey },
        files: filer,
        publishedUrl: () => 'https://example.org/',
      };
    },
    async stada() {
      await berget.stang();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return m;
}

export function forfragan(del: {
  readonly method?: string;
  readonly segments?: readonly string[];
  readonly json?: unknown;
  readonly body?: Uint8Array;
  readonly tenant?: TenantContext;
  readonly userId?: string;
  readonly access?: AppAccessRole;
  readonly query?: string;
}): AppServiceRequest {
  const body = del.body ?? (del.json === undefined ? undefined : new TextEncoder().encode(JSON.stringify(del.json)));
  return {
    method: del.method ?? 'GET',
    segments: del.segments ?? [],
    query: del.query ?? '',
    headers: { 'content-type': 'application/json' },
    tenant: del.tenant ?? tenant(),
    identity: { userId: del.userId ?? 'anv-bertil', email: 'bertil@example.org', roles: ['viewer'] },
    access: del.access ?? 'user',
    ...(body === undefined ? {} : { body }),
  };
}

export function json(svar: AppServiceResponse): Record<string, unknown> {
  const text = typeof svar.body === 'string' ? svar.body : new TextDecoder().decode(svar.body);
  return JSON.parse(text) as Record<string, unknown>;
}

export function felkod(svar: AppServiceResponse): string | undefined {
  return (json(svar)['error'] as { code?: string } | undefined)?.code;
}

export async function vantaTills(villkor: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const slut = Date.now() + ms;
  while (!(await villkor())) {
    if (Date.now() > slut) throw new Error('Villkoret blev aldrig sant.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
