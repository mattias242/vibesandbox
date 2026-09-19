/**
 * Scenariernas värld: en RIKTIG plattform per scenario, på en ledig port, med en egen temporär
 * datakatalog. Inget delas mellan scenarier — varken port, data, appar eller inloggningar — så
 * scenarierna kan köras i vilken ordning som helst, och parallellt.
 *
 * Apparna skapas genom en egen `@vibesandbox/control`-instans mot samma datakatalog, precis som
 * CLI:t gör bredvid en server i drift. All övrig kontakt med plattformen går över rå HTTP.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, setWorldConstructor } from '@cucumber/cucumber';
import { BUILDER_API_PREFIX, CSRF_HEADER, DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import type { AgentEvent, AppId, BuilderJob, ChatMessage, Identity, JsonObject, LlmProvider, TenantLimits } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import type { Control } from '@vibesandbox/control';
import { signTestIdentity, testLoginPath } from '@vibesandbox/gateway';
import { createFakeProvider } from '@vibesandbox/llm';
import type { FakeProvider, FakeReply } from '@vibesandbox/llm';
import { createPlatform } from '@vibesandbox/platform';
import type { Platform } from '@vibesandbox/platform';
import { fejkadByggkedja } from './byggkedja.ts';
import type { FejkadByggkedja } from './byggkedja.ts';
import { skrivFixturapp } from './fixtur.ts';
import type { FixturVal } from './fixtur.ts';
import { anropa, jsonKropp } from './http.ts';
import type { Svar } from './http.ts';

/** Scenariot "Ett ogiltigt värdnamn…" nämner `appar.test`, så det är plattformens domän här. */
export const DOMAN = 'appar.test';

/** Byggverktygets värd och origin. Ingen port i origin: den publika porten är schemats standard. */
export const BYGGVARD = `bygg.${DOMAN}`;
export const BYGG_ORIGIN = `http://${BYGGVARD}`;

/** Finns bara i testerna. Slumpas inte: en fast hemlighet gör ett fallerat scenario återskapbart. */
const TESTHEMLIGHET = 'bdd-hemlighet-som-bara-finns-i-scenarierna-0123456789';

/**
 * Liten kvot för scenarierna om en full app, så att appen blir full på ett tjugotal anrop i
 * stället för tusentals. Det är samma mekanism som i drift, bara med en lägre gräns.
 */
export const LITEN_KVOT: TenantLimits = { ...DEFAULT_TENANT_LIMITS, maxDatabaseBytes: 64 * 1024 };

/** Det dokument stegen sparar när scenariot bara säger "ett dokument". */
export const LITET_DOKUMENT = { data: { anteckning: 'ett vanligt litet dokument' } } as const;

export interface Person {
  readonly namn: string;
  readonly identitet: Identity;
  /** Hela värdet till `Authorization`-huvudet. */
  readonly inloggning: string;
}

export interface SparatDokument {
  readonly app: string;
  readonly kollektion: string;
  readonly id: string;
  readonly data: JsonObject;
}

export interface AnropTillApp {
  /** Appens namn i scenariot. */
  readonly app: string;
  /** Förhandsvisningen (utkastet) i stället för den publicerade appen. */
  readonly forhandsvisning?: boolean;
  /** Vem som anropar. Utelämnas det skickas ingen inloggning alls. */
  readonly person?: string;
  readonly metod?: string;
  readonly sokvag?: string;
  readonly huvuden?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  /** Skrivande anrop får plattformens skyddshuvud om inte detta sätts. */
  readonly utanSkyddshuvud?: boolean;
}

const SKRIVANDE = new Set(['POST', 'PUT', 'DELETE']);

export interface AnropTillByggverktyget {
  /** Vem som anropar. Utelämnas det skickas ingen inloggning alls. */
  readonly person?: string;
  readonly metod?: string;
  readonly sokvag: string;
  readonly json?: unknown;
  /** `Origin`-huvudet. Standard för skrivande anrop: byggverktygets egen. `null` = inget huvud. */
  readonly origin?: string | null;
  readonly utanSkyddshuvud?: boolean;
  /** Logga in med webbläsarens kaka i stället för `Authorization` — som en riktig sida gör. */
  readonly medKaka?: boolean;
}

/** Ett jobb som följts till sitt slut: status och ALLA händelser i den ordning de kom. */
export interface FoljtJobb {
  readonly jobId: string;
  readonly status: BuilderJob['status'];
  readonly events: readonly AgentEvent[];
}

export class Varld extends World {
  kvot: TenantLimits | undefined;
  port = 0;

  /** Svaren från det senaste När-steget. Ett steg som prövar flera varianter lägger alla här. */
  svar: Svar[] = [];
  senastInloggad: string | undefined;
  okantAppId: AppId | undefined;
  /** Sökvägen till "den sidan" i scenariot om egna skyddsregler. */
  sida: string | undefined;

  readonly appar = new Map<string, AppId>();
  readonly personer = new Map<string, Person>();
  /** Det dokument var och en senast sparade — "Annas dokument". */
  readonly senastSparat = new Map<string, SparatDokument>();
  /** Id:n på dokument som skapats i en app, i ordning — för "raderar ett dokument". */
  readonly dokumentIApp = new Map<string, string[]>();

  // ── Byggverktyget (bara i scenarierna under features/bygga/) ──────────────────
  /** Sätts av kroken innan plattformen startar. */
  byggverktyg = false;
  /** Allt som skickades till språkmodellen, EFTER plattformens maskning. */
  readonly modellanrop: ChatMessage[][] = [];
  /** Varje persons app i byggverktyget ("Annas app"). */
  readonly byggappar = new Map<string, string>();
  /** Det senaste jobbet, följt till sitt slut. */
  jobb: FoljtJobb | undefined;
  /** Den senast öppnade förhandsvisningen. */
  forhandsvisning: Svar | undefined;
  /** Kom svaren i `svar` från byggverktygets värd? Avgör vilka skyddsregler som gäller för dem. */
  svarFranByggverktyget = false;
  #modell: FakeProvider = createFakeProvider([]);
  #byggkedja: FejkadByggkedja | undefined;
  /** Byggverktygets inloggningskaka per person (testinloggningens `vs-test-session`). */
  readonly #byggkakor = new Map<string, string>();

  #arbetskatalog: string | undefined;
  #platform: Platform | undefined;
  #control: Control | undefined;
  #byggen = 0;

  get dataDir(): string {
    if (this.#arbetskatalog === undefined) throw new Error('Världen är inte startad.');
    return join(this.#arbetskatalog, 'data');
  }

  async starta(): Promise<void> {
    this.#arbetskatalog = await mkdtemp(join(tmpdir(), 'vibesandbox-bdd-'));
    this.#control = createControl({ dataDir: this.dataDir });

    let builder;
    if (this.byggverktyg) {
      const ui = join(this.#arbetskatalog, 'ui');
      await mkdir(ui);
      await writeFile(join(ui, 'index.html'), '<!doctype html><title>Byggverktyget</title>');
      builder = {
        llm: { baseUrl: 'https://llm.example.org/v1', model: 'fejk/inspelad', apiKey: 'bdd-nyckel-som-aldrig-anvands' },
        build: { driver: 'local' as const },
        uiDirectory: ui,
      };
      this.#byggkedja = fejkadByggkedja();
    }
    // Språkmodellen byts av scenariots Givet-steg; plattformen lägger sin maskning framför den här.
    const modell: LlmProvider = {
      name: 'fejk',
      complete: (request) => {
        this.modellanrop.push(request.messages.map((m) => ({ role: m.role, content: m.content })));
        return this.#modell.complete(request);
      },
    };

    this.#platform = createPlatform(
      {
        baseDomain: DOMAN,
        appDomain: DOMAN,
        dataDir: this.dataDir,
        port: 0,
        listenHost: '127.0.0.1',
        publicScheme: 'http',
        identity: { provider: 'test', testSecret: TESTHEMLIGHET },
        ...(builder === undefined ? {} : { builder }),
        ...(this.kvot === undefined ? {} : { limits: this.kvot }),
      },
      this.#byggkedja === undefined ? {} : { buildRunner: this.#byggkedja, llmProvider: modell },
    );
    this.port = (await this.#platform.listen()).port;
  }

  /** Stänger och städar ALLT, även när bara en del hann starta. Kastar aldrig. */
  async stada(): Promise<void> {
    await this.#platform?.close().catch(() => {});
    await this.#control?.close().catch(() => {});
    for (const katalog of this.#byggkedja?.kvar ?? []) await rm(katalog, { recursive: true, force: true }).catch(() => {});
    if (this.#arbetskatalog !== undefined) {
      await rm(this.#arbetskatalog, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── Appar ────────────────────────────────────────────────────────────────────

  get control(): Control {
    if (this.#control === undefined) throw new Error('Världen är inte startad.');
    return this.#control;
  }

  appId(namn: string): AppId {
    const appId = this.appar.get(namn);
    if (appId === undefined) throw new Error(`Scenariot har inte skapat någon app som heter "${namn}".`);
    return appId;
  }

  /** "appen" i bestämd form förutsätter att scenariot bara har en. */
  endaAppen(): string {
    const namn = [...this.appar.keys()];
    if (namn.length !== 1 || namn[0] === undefined) throw new Error('Steget förutsätter exakt en app i scenariot.');
    return namn[0];
  }

  /** Den enda app som scenariot har fyllt med dokument. */
  endaAppenMedDokument(): string {
    const namn = [...this.dokumentIApp.keys()];
    if (namn.length !== 1 || namn[0] === undefined) throw new Error('Steget förutsätter dokument i exakt en app.');
    return namn[0];
  }

  async importeraFixtur(namn: string, val: FixturVal = {}): Promise<string> {
    if (this.#arbetskatalog === undefined) throw new Error('Världen är inte startad.');
    this.#byggen += 1;
    const katalog = join(this.#arbetskatalog, `bygge-${this.#byggen}`);
    await skrivFixturapp(katalog, val);
    return this.control.importVersion(this.appId(namn), katalog);
  }

  async publicera(namn: string, val: FixturVal = {}): Promise<void> {
    if (!this.appar.has(namn)) this.appar.set(namn, await this.control.createApp());
    await this.control.publish(this.appId(namn), await this.importeraFixtur(namn, val));
  }

  async sattUtkast(namn: string): Promise<void> {
    await this.control.setDraft(this.appId(namn), await this.importeraFixtur(namn));
  }

  /** Adressen som den står i webbläsaren, med port: `<app-id>.appar.test:<port>`. */
  adress(namn: string, forhandsvisning = false): string {
    return `${forhandsvisning ? 'p-' : ''}${this.appId(namn)}.${DOMAN}:${this.port}`;
  }

  // ── Personer ─────────────────────────────────────────────────────────────────

  loggaIn(namn: string, epost = `${namn.toLowerCase()}@example.org`): Person {
    const identitet: Identity = { userId: `anv-${namn.toLowerCase()}`, email: epost, roles: ['viewer'] };
    const person: Person = { namn, identitet, inloggning: signTestIdentity(identitet, TESTHEMLIGHET) };
    this.personer.set(namn, person);
    this.senastInloggad = namn;
    return person;
  }

  person(namn: string): Person {
    const person = this.personer.get(namn);
    if (person === undefined) throw new Error(`${namn} är inte inloggad i det här scenariot.`);
    return person;
  }

  // ── Anrop ────────────────────────────────────────────────────────────────────

  anropaApp(anrop: AnropTillApp): Promise<Svar> {
    const metod = anrop.metod ?? 'GET';
    const huvuden: Record<string, string> = {};
    if (anrop.person !== undefined) huvuden['Authorization'] = this.person(anrop.person).inloggning;
    if (SKRIVANDE.has(metod) && anrop.utanSkyddshuvud !== true) huvuden[CSRF_HEADER] = '1';
    return anropa({
      port: this.port,
      metod,
      sokvag: anrop.sokvag ?? '/',
      host: this.adress(anrop.app, anrop.forhandsvisning === true),
      huvuden: { ...huvuden, ...anrop.huvuden },
      ...(anrop.json === undefined ? {} : { json: anrop.json }),
    });
  }

  /** Sparar ett dokument och KRÄVER att det gick — för Givet-steg, där ett fel är ett testfel. */
  async sparaDokument(personnamn: string, app: string, kollektion: string, personlig: boolean, data: JsonObject): Promise<SparatDokument> {
    const svar = await this.anropaApp({
      app,
      person: personnamn,
      metod: 'POST',
      sokvag: dokumentlista(kollektion, personlig ? 'user' : undefined),
      json: { data },
    });
    if (svar.status !== 201) throw new Error(`Förberedelsen misslyckades: status ${svar.status}, ${svar.kropp.slice(0, 200)}`);
    const id = (jsonKropp(svar) as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error('Förberedelsen misslyckades: svaret saknar dokument-id.');
    const sparat: SparatDokument = { app, kollektion, id, data };
    this.senastSparat.set(personnamn, sparat);
    this.dokumentIApp.set(app, [...(this.dokumentIApp.get(app) ?? []), id]);
    return sparat;
  }

  // ── Byggverktyget ────────────────────────────────────────────────────────────

  /** Språkmodellen svarar härefter med de här svaren, i tur och ordning. */
  sattModellsvar(svar: readonly FakeReply[]): void {
    this.#modell = createFakeProvider(svar);
  }

  loggaInSomByggare(namn: string): Person {
    const identitet: Identity = { userId: `anv-${namn.toLowerCase()}`, email: `${namn.toLowerCase()}@example.org`, roles: ['builder'] };
    const person: Person = { namn, identitet, inloggning: signTestIdentity(identitet, TESTHEMLIGHET) };
    this.personer.set(namn, person);
    this.senastInloggad = namn;
    return person;
  }

  /** `Host` för en adress som byggverktyget gett ut (utan port) — med plattformens verkliga port. */
  vardFor(url: string): string {
    return `${new URL(url).hostname}:${this.port}`;
  }

  async #byggkaka(namn: string): Promise<string> {
    const sparad = this.#byggkakor.get(namn);
    if (sparad !== undefined) return sparad;
    const kaka = await this.loggaInWebblasare(namn, `http://${BYGGVARD}/`);
    this.#byggkakor.set(namn, kaka);
    return kaka;
  }

  /**
   * Loggar in en webbläsare på adressens värd med testinloggningens länk och ger kakan
   * (`namn=värde`) som webbläsaren sedan skickar dit.
   */
  async loggaInWebblasare(namn: string, url: string): Promise<string> {
    const svar = await anropa({ port: this.port, host: this.vardFor(url), sokvag: testLoginPath(this.person(namn).identitet, TESTHEMLIGHET) });
    const kaka = (svar.huvuden['set-cookie'] ?? [])[0]?.split(';')[0];
    if (svar.status !== 303 || kaka === undefined) throw new Error(`Testinloggningen misslyckades: ${svar.status}`);
    return kaka;
  }

  async anropaByggverktyget(anrop: AnropTillByggverktyget): Promise<Svar> {
    const metod = anrop.metod ?? 'GET';
    const huvuden: Record<string, string> = {};
    if (anrop.person !== undefined) {
      if (anrop.medKaka === true) huvuden['Cookie'] = await this.#byggkaka(anrop.person);
      else huvuden['Authorization'] = this.person(anrop.person).inloggning;
    }
    if (SKRIVANDE.has(metod)) {
      if (anrop.utanSkyddshuvud !== true) huvuden[CSRF_HEADER] = '1';
      const origin = anrop.origin === undefined ? BYGG_ORIGIN : anrop.origin;
      if (origin !== null) huvuden['Origin'] = origin;
    } else if (anrop.origin !== undefined && anrop.origin !== null) {
      huvuden['Origin'] = anrop.origin;
    }
    return anropa({
      port: this.port,
      metod,
      sokvag: anrop.sokvag,
      host: `${BYGGVARD}:${this.port}`,
      huvuden,
      ...(anrop.json === undefined ? {} : { json: anrop.json }),
    });
  }

  /** Byggverktygets API: kräver att anropet lyckas med den angivna statusen — för Givet-steg och förberedelser. */
  async byggApi<T>(person: string, metod: string, sokvag: string, status: number, json?: unknown): Promise<T> {
    const svar = await this.anropaByggverktyget({ person, metod, sokvag: `${BUILDER_API_PREFIX}${sokvag}`, ...(json === undefined ? {} : { json }) });
    if (svar.status !== status) throw new Error(`${metod} ${sokvag} gav ${svar.status}, väntade ${status}: ${svar.kropp.slice(0, 200)}`);
    return jsonKropp(svar) as T;
  }

  /** Personens app i byggverktyget — skapas första gången den behövs. */
  async byggapp(person: string): Promise<string> {
    const finns = this.byggappar.get(person);
    if (finns !== undefined) return finns;
    const { appId } = await this.byggApi<{ appId: string }>(person, 'POST', '/apps', 201, {});
    this.byggappar.set(person, appId);
    return appId;
  }

  /** Personen ber om något i sin app; jobbet följs, händelse för händelse, tills det är slut. */
  async bestall(person: string, text: string): Promise<FoljtJobb> {
    const appId = await this.byggapp(person);
    const { jobId } = await this.byggApi<{ jobId: string }>(person, 'POST', `/apps/${appId}/messages`, 202, { text });
    const events: AgentEvent[] = [];
    let after = 0;
    for (let forsok = 0; forsok < 1000; forsok += 1) {
      const jobb = await this.byggApi<BuilderJob>(person, 'GET', `/jobs/${jobId}?after=${after}`, 200);
      events.push(...jobb.events);
      after = jobb.next;
      if (jobb.status === 'done' || jobb.status === 'failed') {
        this.jobb = { jobId, status: jobb.status, events };
        return this.jobb;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Jobbet blev aldrig klart.');
  }

  /**
   * Öppnar förhandsvisningen eller den publicerade appen som byggverktyget gör: adressen från
   * "öppna" loggar in webbläsaren på målvärden, och sedan hämtas startsidan med den kakan.
   */
  async oppnaFranByggverktyget(person: string, target: 'preview' | 'published'): Promise<Svar> {
    const appId = await this.byggapp(person);
    const { url } = await this.byggApi<{ url: string }>(person, 'GET', `/apps/${appId}/open?target=${target}`, 200);
    const inloggning = await anropa({ port: this.port, host: this.vardFor(url), sokvag: `${new URL(url).pathname}${new URL(url).search}` });
    const kaka = (inloggning.huvuden['set-cookie'] ?? [])[0]?.split(';')[0];
    if (inloggning.status !== 303 || kaka === undefined) throw new Error(`Adressen från "öppna" loggade inte in: ${inloggning.status}`);
    return anropa({ port: this.port, host: this.vardFor(url), sokvag: '/', huvuden: { Cookie: kaka } });
  }

  /** Byggkataloger som plattformen tagit emot men inte städat bort. */
  ostadadeByggen(): number {
    return this.#byggkedja?.kvar.size ?? 0;
  }

  /** Det enda svaret från det senaste När-steget. */
  endaSvaret(): Svar {
    const [svar, ...fler] = this.svar;
    if (svar === undefined || fler.length > 0) throw new Error(`Steget förutsätter exakt ett svar, men det finns ${this.svar.length}.`);
    return svar;
  }
}

/** `/_api/collections/<namn>/docs`, med `?scope=` bara när scenariot uttryckligen anger synlighet. */
export function dokumentlista(kollektion: string, scope?: 'app' | 'user', fraga = ''): string {
  const delar = [scope === undefined ? '' : `scope=${scope}`, fraga].filter((del) => del.length > 0);
  return `/_api/collections/${kollektion}/docs${delar.length > 0 ? `?${delar.join('&')}` : ''}`;
}

export function dokument(kollektion: string, id: string): string {
  return `/_api/collections/${kollektion}/docs/${id}`;
}

setWorldConstructor(Varld);
