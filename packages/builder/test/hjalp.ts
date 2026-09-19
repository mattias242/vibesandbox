/**
 * Testhjälp för @vibesandbox/builder: fejkar för agenten, control och inbjudningar, en temporär
 * data- och UI-katalog, och ett litet anropsverktyg mot `BuilderHandler`. Ingen produktionskod
 * importerar detta.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILDER_API_PREFIX, DataApiError, isAppId } from '@vibesandbox/contracts';
import type {
  Agent,
  AgentEvent,
  AgentTurnInput,
  AgentTurnResult,
  AppAccessRole,
  AppId,
  BuildResult,
  Identity,
  InvitationService,
  InvitedUser,
  PlatformResponse,
  SourceFiles,
} from '@vibesandbox/contracts';
import { createBuilder } from '../src/index.ts';
import type { Builder, BuilderControl, BuilderLogEntry, BuilderOptions } from '../src/index.ts';

// ── Personer ─────────────────────────────────────────────────────────────────────

export const ANNA: Identity = { userId: 'u-anna', email: 'anna@example.org', roles: ['builder'] };
export const BERTIL: Identity = { userId: 'u-bertil', email: 'bertil@example.org', roles: ['builder'] };
export const ADAM: Identity = { userId: 'u-adam', email: 'adam.admin@example.org', roles: ['admin'] };
export const VERA: Identity = { userId: 'u-vera', email: 'vera@example.org', roles: ['viewer'] };

export const STARTFILER: SourceFiles = { 'src/App.tsx': 'export function App() { return null; }' };

// ── Kataloger ────────────────────────────────────────────────────────────────────

export async function tempKatalog(prefix = 'vibesandbox-builder-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function skrivTrad(rot: string, filer: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativ, innehall] of Object.entries(filer)) {
    const mal = join(rot, ...relativ.split('/'));
    await mkdir(dirname(mal), { recursive: true });
    await writeFile(mal, innehall);
  }
}

export const UI_FILER: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>Bygg</title><script type="module" src="/assets/app.js"></script>',
  'assets/app.js': 'console.log("byggverktyget");',
  'assets/app.css': 'body { margin: 0; }',
};

// ── Fejkad control ───────────────────────────────────────────────────────────────

const ALFABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function slumpatAppId(): AppId {
  let id = '';
  for (let i = 0; i < 26; i++) id += ALFABET.charAt(Math.floor(Math.random() * 32));
  if (!isAppId(id)) throw new Error('fel i testhjälpen');
  return id;
}

/** Samma form som control-paketets `ControlError`: ett namn och en fast kod. */
export class FejkControlFel extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ControlError';
    this.code = code;
  }
}

export interface FejkAtkomst {
  readonly userId: string;
  role: AppAccessRole;
  email: string | null;
}

export interface FejkControl extends BuilderControl {
  readonly anrop: string[];
  /** Appar som control känner till. */
  readonly appar: Set<string>;
  /** Åtkomstlistan per app, i den ordning raderna lades till. Beter sig som control enligt jsdoc:en. */
  readonly atkomst: Map<string, FejkAtkomst[]>;
  /** Hur många gånger grantAccess anropats. (Åtkomstanropen hålls utanför `anrop`, som gäller bygg- och publiceringsflödet.) */
  tilldelningar: number;
  readonly importerade: { appId: string; directory: string; versionId: string }[];
  readonly utkast: Map<string, string>;
  readonly publicerade: Map<string, string>;
  /** Sätts för att nästa import ska misslyckas. */
  importFel: Error | null;
}

export function fejkControl(): FejkControl {
  let versioner = 0;
  const control: FejkControl = {
    anrop: [],
    importerade: [],
    utkast: new Map(),
    publicerade: new Map(),
    appar: new Set(),
    atkomst: new Map(),
    tilldelningar: 0,
    importFel: null,
    async createApp() {
      control.anrop.push('createApp');
      const appId = slumpatAppId();
      control.appar.add(appId);
      return appId;
    },
    async importVersion(appId, directory) {
      control.anrop.push('importVersion');
      if (control.importFel !== null) throw control.importFel;
      versioner += 1;
      const versionId = `version-${versioner}`;
      control.importerade.push({ appId, directory, versionId });
      return versionId;
    },
    async setDraft(appId, versionId) {
      control.anrop.push('setDraft');
      control.utkast.set(appId, versionId);
    },
    async publish(appId, versionId) {
      control.anrop.push('publish');
      control.publicerade.set(appId, versionId);
    },
    async grantAccess(appId, userId, role, email) {
      control.tilldelningar += 1;
      if (!control.appar.has(appId)) throw new FejkControlFel('app_not_found');
      const rader = control.atkomst.get(appId) ?? [];
      const befintlig = rader.find((rad) => rad.userId === userId);
      const annanAgare = rader.find((rad) => rad.role === 'owner' && rad.userId !== userId);
      if (role === 'owner' && annanAgare !== undefined) throw new FejkControlFel('access_rejected');
      if (befintlig === undefined) {
        rader.push({ userId, role, email });
      } else {
        // En ägare nedgraderas aldrig; en adress fylls i om den saknades.
        if (role === 'owner') befintlig.role = 'owner';
        if (befintlig.email === null) befintlig.email = email;
      }
      control.atkomst.set(appId, rader);
    },
    async revokeAccess(appId, userId) {
      if (!control.appar.has(appId)) throw new FejkControlFel('app_not_found');
      const rader = control.atkomst.get(appId) ?? [];
      const rad = rader.find((kandidat) => kandidat.userId === userId);
      if (rad === undefined) return;
      if (rad.role === 'owner') throw new FejkControlFel('access_rejected');
      control.atkomst.set(
        appId,
        rader.filter((kandidat) => kandidat !== rad),
      );
    },
    async listAccess(appId) {
      if (!control.appar.has(appId)) throw new FejkControlFel('app_not_found');
      const rader = control.atkomst.get(appId) ?? [];
      const ordnade = [...rader.filter((rad) => rad.role === 'owner'), ...rader.filter((rad) => rad.role !== 'owner')];
      return ordnade.map((rad) => ({ ...rad, addedAt: '2026-09-19T08:00:00.000Z' }));
    },
  };
  return control;
}

// ── Fejkad agent ─────────────────────────────────────────────────────────────────

export interface FejkBygge extends BuildResult {
  disposed: number;
}

export function fejkBygge(outputDirectory = '/tmp/bygge-som-inte-finns'): FejkBygge {
  const bygge: FejkBygge = {
    ok: true,
    outputDirectory,
    diagnostics: [],
    durationMs: 5,
    disposed: 0,
    async dispose() {
      bygge.disposed += 1;
    },
  };
  return bygge;
}

export type Tur = (input: AgentTurnInput) => Promise<AgentTurnResult>;

export function lyckadTur(files: SourceFiles, summary = 'Klart! Appen är byggd.', bygge = fejkBygge()): Tur {
  return async (input) => {
    input.onEvent?.({ type: 'status', message: 'Skriver koden' });
    input.onEvent?.({ type: 'files', paths: Object.keys(files) });
    input.onEvent?.({ type: 'check', ok: true, problems: 0 });
    input.onEvent?.({ type: 'done', ok: true, message: summary });
    return {
      ok: true,
      files,
      build: bygge,
      summary,
      rounds: 1,
      model: 'testmodell-1',
      usage: { inputTokens: 1200, outputTokens: 800 },
    };
  };
}

export function misslyckadTur(summary = 'Det gick inte att bygga appen: koden skickar data till en extern adress.'): Tur {
  return async (input) => {
    input.onEvent?.({ type: 'check', ok: false, problems: 1 });
    input.onEvent?.({ type: 'done', ok: false, message: summary });
    return {
      ok: false,
      files: input.currentFiles,
      summary,
      rounds: 3,
      model: 'testmodell-1',
      usage: { inputTokens: 3000, outputTokens: 2000 },
    };
  };
}

export interface Uppskjuten<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function uppskjuten<T>(): Uppskjuten<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface FejkAgent extends Agent {
  readonly inputs: AgentTurnInput[];
  /** Turer som körs i tur och ordning; när listan är tom används `standard`. */
  readonly turer: Tur[];
  standard: Tur;
  /** Hur många turer som körs just nu (ska aldrig bli mer än 1). */
  samtidiga: number;
  hogstaSamtidiga: number;
}

export function fejkAgent(): FejkAgent {
  const agent: FejkAgent = {
    inputs: [],
    turer: [],
    standard: lyckadTur({ 'src/App.tsx': 'export function App() { return <h1>Todo</h1>; }' }),
    samtidiga: 0,
    hogstaSamtidiga: 0,
    async runTurn(input) {
      agent.inputs.push(input);
      agent.samtidiga += 1;
      agent.hogstaSamtidiga = Math.max(agent.hogstaSamtidiga, agent.samtidiga);
      try {
        const tur = agent.turer.shift() ?? agent.standard;
        return await tur(input);
      } finally {
        agent.samtidiga -= 1;
      }
    },
  };
  return agent;
}

// ── Fejkade inbjudningar ─────────────────────────────────────────────────────────

export interface FejkInbjudningar extends InvitationService {
  readonly inbjudna: Parameters<InvitationService['invite']>[0][];
  readonly kanda: Set<string>;
  /** Adress → användar-id. Personerna ovan finns från början; nya adresser får ett slumpat id som identitetspaketets. */
  readonly anvandare: Map<string, string>;
}

export function fejkInbjudningar(): FejkInbjudningar {
  const tjanst: FejkInbjudningar = {
    inbjudna: [],
    kanda: new Set(),
    anvandare: new Map([ANNA, BERTIL, ADAM, VERA].map((person) => [person.email, person.userId])),
    async invite(request): Promise<InvitedUser> {
      const adress = request.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(adress)) {
        throw new DataApiError('invalid_request', 'Ogiltig adress.');
      }
      tjanst.inbjudna.push(request);
      tjanst.kanda.add(adress);
      let userId = tjanst.anvandare.get(adress);
      if (userId === undefined) {
        userId = randomBytes(16).toString('base64url');
        tjanst.anvandare.set(adress, userId);
      }
      return { userId, email: adress };
    },
  };
  return tjanst;
}

// ── Miljö ────────────────────────────────────────────────────────────────────────

export const URLS = {
  preview: (appId: string) => `https://p-${appId}.example.org/`,
  published: (appId: string) => `https://${appId}.example.org/`,
};

export function openUrl(identity: Identity, target: string): string {
  return `https://login.example.org/test?user=${identity.userId}&next=${encodeURIComponent(target)}`;
}

export interface Miljo {
  readonly dataDir: string;
  readonly uiDir: string;
  readonly control: FejkControl;
  readonly agent: FejkAgent;
  readonly inbjudningar: FejkInbjudningar;
  readonly logg: BuilderLogEntry[];
  /** Klockan som byggverktyget ser; flytta den med `tid.ms += …`. */
  readonly tid: { ms: number };
  builder: Builder;
  /** Startar en ny instans mot samma katalog (efter `builder.close()`). */
  starta(extra?: Partial<BuilderOptions>): Builder;
  stada(): Promise<void>;
}

export async function skapaMiljo(extra: Partial<BuilderOptions> = {}): Promise<Miljo> {
  const dataDir = await tempKatalog();
  const uiDir = await tempKatalog('vibesandbox-builder-ui-');
  await skrivTrad(uiDir, UI_FILER);
  const control = fejkControl();
  const agent = fejkAgent();
  const inbjudningar = fejkInbjudningar();
  const logg: BuilderLogEntry[] = [];
  const tid = { ms: Date.parse('2026-09-19T08:00:00.000Z') };

  const starta = (mer: Partial<BuilderOptions> = {}): Builder =>
    createBuilder({
      dataDir,
      control,
      agent,
      starterFiles: STARTFILER,
      invitations: inbjudningar,
      ui: { directory: uiDir },
      urls: URLS,
      openUrl,
      logger: (entry) => logg.push(entry),
      clock: () => new Date(tid.ms),
      ...extra,
      ...mer,
    });

  const miljo: Miljo = {
    dataDir,
    uiDir,
    control,
    agent,
    inbjudningar,
    logg,
    tid,
    builder: starta(),
    starta,
    async stada() {
      await miljo.builder.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(uiDir, { recursive: true, force: true });
    },
  };
  return miljo;
}

// ── Anrop ────────────────────────────────────────────────────────────────────────

export interface Svar {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly json: any;
}

export async function anropa(
  builder: Builder,
  identity: Identity,
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: Uint8Array; query?: Record<string, string> } = {},
): Promise<Svar> {
  let body: Uint8Array | undefined = options.rawBody;
  if (options.body !== undefined) body = new TextEncoder().encode(JSON.stringify(options.body));
  const response: PlatformResponse = await builder.handle({
    method,
    path,
    query: options.query ?? {},
    headers: {},
    ...(body === undefined ? {} : { body }),
    identity,
  });
  const text =
    response.body === undefined
      ? ''
      : typeof response.body === 'string'
        ? response.body
        : new TextDecoder().decode(response.body);
  let json: unknown = undefined;
  if ((response.headers['Content-Type'] ?? '').startsWith('application/json')) json = JSON.parse(text);
  return { status: response.status, headers: response.headers, text, json };
}

export const api = (rest: string): string => `${BUILDER_API_PREFIX}${rest}`;

export async function nyApp(builder: Builder, identity: Identity = ANNA, name?: string): Promise<string> {
  const svar = await anropa(builder, identity, 'POST', api('/apps'), { body: name === undefined ? {} : { name } });
  if (svar.status !== 201) throw new Error(`kunde inte skapa app: ${svar.status} ${svar.text}`);
  return svar.json.appId as string;
}

export async function skicka(builder: Builder, appId: string, text: string, identity: Identity = ANNA): Promise<string> {
  const svar = await anropa(builder, identity, 'POST', api(`/apps/${appId}/messages`), { body: { text } });
  if (svar.status !== 202) throw new Error(`kunde inte skicka: ${svar.status} ${svar.text}`);
  return svar.json.jobId as string;
}

/** Väntar tills jobbet är klart eller misslyckat, och ger dess slutliga tillstånd. */
export async function vantaPaJobb(builder: Builder, jobId: string, identity: Identity = ANNA): Promise<Svar> {
  for (let varv = 0; varv < 2000; varv++) {
    const svar = await anropa(builder, identity, 'GET', api(`/jobs/${jobId}`));
    if (svar.status !== 200) throw new Error(`jobbet gick inte att läsa: ${svar.status}`);
    if (svar.json.status === 'done' || svar.json.status === 'failed') return svar;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('jobbet blev aldrig klart');
}

/** Ger händelseslingan några varv, så att kön hinner plocka upp nästa jobb. */
export async function snurra(varv = 20): Promise<void> {
  for (let i = 0; i < varv; i++) await new Promise((resolve) => setImmediate(resolve));
}

export type { AgentEvent };
