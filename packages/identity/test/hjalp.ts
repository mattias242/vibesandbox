/**
 * Testhjälp för @vibesandbox/identity. Ingen produktionskod importerar detta.
 *
 * `Webblasare` efterliknar det en riktig webbläsare gör med host-only-kakor: en kakburk PER VÄRD,
 * `Origin` satt till sidans egen origin vid formulärposter. Varje svar leverantören ger prövas
 * dessutom mot samma regler som gatewayn verkställer (`kontrolleraMotGatewaynsRegler`), så att ett
 * svar som skulle fällas av gatewayn fäller testet i stället.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { AuthRequest, AuthRouteRequest, AuthRouteResponse, Identity } from '@vibesandbox/contracts';
import { createEmailOtpProvider, createOutboxSender } from '../src/index.ts';
import type { EmailOtpProvider, EmailOtpProviderOptions, IdentityLogEntry, OutboxSender } from '../src/index.ts';

export const HEMLIGHET = 'en-testhemlighet-som-ar-minst-32-byte-lang';
export const VARD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa.localtest.me';
export const VARD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.localtest.me';

export interface FejkadKlocka {
  nu(): number;
  flytta(ms: number): void;
}

export function skapaKlocka(start = Date.UTC(2026, 8, 19, 8, 0, 0)): FejkadKlocka {
  let tid = start;
  return { nu: () => tid, flytta: (ms) => (tid += ms) };
}

export interface Uppsattning {
  readonly katalog: string;
  readonly klocka: FejkadKlocka;
  readonly utkorg: OutboxSender;
  readonly logg: IdentityLogEntry[];
  readonly leverantor: EmailOtpProvider;
  stada(): Promise<void>;
}

const oppna: Uppsattning[] = [];

export async function skapaUppsattning(overrides: Partial<EmailOtpProviderOptions> = {}): Promise<Uppsattning> {
  const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-identity-'));
  const klocka = skapaKlocka();
  const utkorg = createOutboxSender();
  const logg: IdentityLogEntry[] = [];
  const leverantor = createEmailOtpProvider({
    dataDirectory: katalog,
    secret: HEMLIGHET,
    publicScheme: 'https',
    mailSender: utkorg,
    clock: klocka.nu,
    logger: (post) => logg.push(post),
    ...overrides,
  });
  const uppsattning: Uppsattning = {
    katalog,
    klocka,
    utkorg,
    logg,
    leverantor,
    async stada() {
      await leverantor.close();
      await rm(katalog, { recursive: true, force: true });
    },
  };
  oppna.push(uppsattning);
  return uppsattning;
}

/** Anropas i afterEach. */
export async function stadaAllt(): Promise<void> {
  while (oppna.length > 0) await oppna.pop()?.stada();
}

// ── Gatewayns regler (packages/gateway/src/inloggningsrutt.ts), återgivna ────────

const TILLATNA_STATUSAR = new Set([200, 303, 400, 401, 404, 405, 429]);
const TILLATNA_HUVUDEN = new Set(['allow', 'content-type', 'location', 'set-cookie']);
const TILLATNA_TYPER = new Set(['text/plain; charset=utf-8', 'text/html; charset=utf-8', 'application/json; charset=utf-8']);

/**
 * Säkerhetsleverantören ska inte bara passera gatewayn — den ska inte ens FÖRSÖKA något gatewayn
 * skulle stoppa. Här prövas därför strängare än gatewayn: okända huvuden är fel, inte bara ignorerade.
 * 403 finns inte i gatewayns lista — se luckan i slutrapporten; här godtas den.
 */
export function kontrolleraMotGatewaynsRegler(svar: AuthRouteResponse): void {
  expect(TILLATNA_STATUSAR.has(svar.status) || svar.status === 403, `status ${svar.status}`).toBe(true);
  for (const namn of Object.keys(svar.headers)) {
    expect(TILLATNA_HUVUDEN.has(namn.toLowerCase()), `huvud ${namn}`).toBe(true);
  }
  const location = svar.headers['Location'];
  expect(svar.status === 303, 'Location bara vid 303').toBe(location !== undefined);
  if (typeof location === 'string') {
    expect(location).toMatch(/^\/(?![/\\])[\x21-\x7e]*$/);
    expect(location).not.toContain('\\');
  }
  const kakor = svar.headers['Set-Cookie'];
  for (const kaka of kakor === undefined ? [] : typeof kakor === 'string' ? [kakor] : kakor) {
    const attribut = kaka.split(';').slice(1).map((a) => a.trim().split('=')[0]?.toLowerCase());
    expect(attribut, 'aldrig Domain').not.toContain('domain');
    expect(attribut, 'alltid HttpOnly').toContain('httponly');
  }
  const typ = svar.headers['Content-Type'];
  if (typ !== undefined) expect(TILLATNA_TYPER.has(String(typ))).toBe(true);
  if (svar.body !== undefined && svar.body.length > 0) expect(typ).toBe('text/html; charset=utf-8');
}

// ── En webbläsare ───────────────────────────────────────────────────────────────

export interface Svar extends AuthRouteResponse {
  readonly kakor: readonly string[];
}

export class Webblasare {
  /** värd → kaknamn → värde */
  readonly burkar = new Map<string, Map<string, string>>();
  readonly schema: 'http' | 'https';
  readonly leverantor: EmailOtpProvider;

  constructor(leverantor: EmailOtpProvider, schema: 'http' | 'https' = 'https') {
    this.leverantor = leverantor;
    this.schema = schema;
  }

  burk(vard: string): Map<string, string> {
    let burk = this.burkar.get(vard);
    if (burk === undefined) {
      burk = new Map();
      this.burkar.set(vard, burk);
    }
    return burk;
  }

  kakhuvud(vard: string): string | undefined {
    const par = [...this.burk(vard)].map(([namn, varde]) => `${namn}=${varde}`);
    return par.length === 0 ? undefined : par.join('; ');
  }

  async get(vard: string, sokvag: string, query: Record<string, string> = {}): Promise<Svar | null> {
    return this.skicka(vard, { method: 'GET', path: sokvag, query, headers: { cookie: this.kakhuvud(vard) } });
  }

  async post(
    vard: string,
    sokvag: string,
    falt: Record<string, string>,
    extra: { origin?: string | null; headers?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<Svar | null> {
    const origin = extra.origin === undefined ? `${this.schema}://${vard}` : (extra.origin ?? undefined);
    const headers: Record<string, string | undefined> = {
      cookie: this.kakhuvud(vard),
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      ...extra.headers,
    };
    const body = 'body' in extra ? extra.body : new TextEncoder().encode(new URLSearchParams(falt).toString());
    return this.skicka(vard, { method: 'POST', path: sokvag, query: {}, headers, body });
  }

  async skicka(vard: string, forfragan: Omit<AuthRouteRequest, 'host'> & { body?: unknown }): Promise<Svar | null> {
    const request = { host: vard, ...forfragan } as AuthRouteRequest;
    const svar = await this.leverantor.handleAuthRoute(request);
    if (svar === null) return null;
    kontrolleraMotGatewaynsRegler(svar);
    const satta = svar.headers['Set-Cookie'];
    const kakor = satta === undefined ? [] : typeof satta === 'string' ? [satta] : [...satta];
    for (const kaka of kakor) this.taEmotKaka(vard, kaka);
    return { ...svar, kakor };
  }

  taEmotKaka(vard: string, kaka: string): void {
    const [par = '', ...attribut] = kaka.split(';').map((d) => d.trim());
    const likhet = par.indexOf('=');
    const namn = par.slice(0, likhet);
    const varde = par.slice(likhet + 1);
    const maxAge = attribut.find((a) => a.toLowerCase().startsWith('max-age='));
    if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) this.burk(vard).delete(namn);
    else this.burk(vard).set(namn, varde);
  }

  async vem(vard: string): Promise<Identity | null> {
    const request: AuthRequest = { host: vard, headers: { cookie: this.kakhuvud(vard) } };
    return this.leverantor.authenticate(request);
  }
}

/** Den sexsiffriga koden ur det SENASTE mejlet till adressen. */
export function kodUrUtkorgen(utkorg: OutboxSender, adress: string): string {
  const mejl = [...utkorg.messages].reverse().find((m) => m.to === adress);
  if (mejl === undefined) throw new Error('Inget mejl till adressen.');
  const traff = /\b(\d{6})\b/.exec(mejl.text);
  if (traff?.[1] === undefined) throw new Error('Ingen kod i mejlet.');
  return traff[1];
}

/** En kod som garanterat INTE är den rätta. */
export function felKod(ratt: string): string {
  return ratt === '000000' ? '111111' : '000000';
}

/** Begär en kod och loggar in med den. Returnerar svaret från verify. */
export async function loggaIn(
  webblasare: Webblasare,
  utkorg: OutboxSender,
  vard: string,
  adress: string,
  next = '/',
): Promise<Svar | null> {
  await webblasare.post(vard, '/_auth/login', { email: adress, next });
  return webblasare.post(vard, '/_auth/verify', { code: kodUrUtkorgen(utkorg, adress) });
}
