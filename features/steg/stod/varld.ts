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
import type { AgentEvent, AppId, BuilderJob, ChatMessage, Identity, JsonObject, LlmProvider, Role, TenantLimits } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import type { Control } from '@vibesandbox/control';
import { signTestIdentity, testLoginPath } from '@vibesandbox/gateway';
import { CLASSIFICATION_SYSTEM_PROMPT } from '@vibesandbox/agent';
import { createFakeProvider } from '@vibesandbox/llm';
import type { FakeProvider, FakeReply } from '@vibesandbox/llm';
import type { AppMailer, AppServiceName } from '@vibesandbox/contracts';
import { forbered } from './tjanster.ts';
import type { TjanstForberedelse } from './tjanster.ts';
import { createPlatform, loadAgentKnowledge } from '@vibesandbox/platform';
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
  /**
   * Ett annat app-id än appens eget — för att jämföra med svaret för en app som INTE finns,
   * med exakt samma anrop i övrigt.
   */
  readonly appId?: AppId;
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

/**
 * Är det här klassningens fråga till modellen, och inte agentens? Prövas på systemprompten ur
 * `@vibesandbox/agent`, inte på en avskriven kopia: ändras prompten följer scenarierna med.
 */
function arKlassning(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' && m.content === CLASSIFICATION_SYSTEM_PROMPT);
}

export class Varld extends World {
  kvot: TenantLimits | undefined;
  port = 0;

  /** Svaren från det senaste När-steget. Ett steg som prövar flera varianter lägger alla här. */
  svar: Svar[] = [];
  /**
   * Anropen bakom `svar`, i samma ordning — sätts av de När-steg vars utfall jämförs med "samma
   * svar som för en app som inte finns", så att jämförelsen kan göra exakt samma anrop igen.
   */
  appanrop: AnropTillApp[] = [];
  senastInloggad: string | undefined;
  okantAppId: AppId | undefined;
  /** Sökvägen till "den sidan" i scenariot om egna skyddsregler. */
  sida: string | undefined;

  /**
   * Allt plattformen loggat under scenariot, en rad per loggpost. Utan en loggare skriver
   * plattformen ingenting alls (`silentLogger`), och då går det inte att pröva vad som INTE står
   * i driftloggarna — t.ex. att en e-postadress aldrig hamnar där.
   */
  readonly loggrader: string[] = [];

  readonly appar = new Map<string, AppId>();
  readonly personer = new Map<string, Person>();
  /** Det dokument var och en senast sparade — "Annas dokument". */
  readonly senastSparat = new Map<string, SparatDokument>();
  /** Id:n på dokument som skapats i en app, i ordning — för "raderar ett dokument". */
  readonly dokumentIApp = new Map<string, string[]>();
  /**
   * Användar-id som plattformen gav en person när en app delades med hen. Loggar personen in
   * senare i scenariot är det med just det id:t — annars vore det en annan användare.
   */
  readonly anvandarIdn = new Map<string, string>();
  /** Appar som scenariot publicerat direkt i control (`publicera`), utan byggverktyget. */
  readonly #direktPublicerade = new Set<string>();
  /** Personer som fått de direkt publicerade apparna — se `publicera`. */
  readonly #delasMed = new Set<string>();

  // ── Byggverktyget (bara i scenarierna under features/bygga/) ──────────────────
  /** Sätts av kroken innan plattformen startar. */
  byggverktyg = false;
  /** Plattformstjänster scenariot slagit på med `@tjanst-<namn>` (se stod/tjanster.ts). */
  tjanster: AppServiceName[] = [];
  #tjanstForberedelser: TjanstForberedelse[] = [];
  /** Allt som skickades till språkmodellen, EFTER plattformens maskning — klassningen inräknad. */
  readonly modellanrop: ChatMessage[][] = [];
  /**
   * Klassningen frågar modellen en egen fråga före varje bygge, med en egen systemprompt. Ett
   * scenario som räknar agentens turer ska inte behöva veta om den — men ett scenario som prövar
   * vad som LÄMNAR servern ska se den. Därför skiljs de åt här, i stället för att klassningen
   * göms undan.
   */
  get agentanrop(): readonly ChatMessage[][] {
    return this.modellanrop.filter((anrop) => !arKlassning(anrop));
  }
  /** Det modellen svarar när den ombeds klassa ett önskemål. Byts av `sattKlassning`. */
  #klassningssvar: FakeReply = 'oppen';
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
        const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
        this.modellanrop.push(messages);
        // Klassningen är en EGEN fråga till modellen, inte ett varv i agentens loop. Den får därför
        // sitt eget svar och rör inte scenariots manus — annars hade varje scenario som säger
        // "språkmodellen svarar med en giltig app" fått sitt svar uppätet av klassningen.
        if (arKlassning(messages)) return createFakeProvider([this.#klassningssvar]).complete(request);
        return this.#modell.complete(request);
      },
    };

    this.#tjanstForberedelser = await forbered(this.tjanster);
    const tjanstMiljo: Record<string, string> = {};
    const tjanstOverrides: { mailer?: AppMailer; berget?: { baseUrl: string; apiKey: string } } = {};
    for (const f of this.#tjanstForberedelser) {
      Object.assign(tjanstMiljo, f.miljo ?? {});
      if (f.mailer !== undefined) tjanstOverrides.mailer = f.mailer;
      if (f.berget !== undefined) tjanstOverrides.berget = f.berget;
    }

    this.#platform = createPlatform(
      {
        baseDomain: DOMAN,
        appDomain: DOMAN,
        dataDir: this.dataDir,
        port: 0,
        listenHost: '127.0.0.1',
        publicScheme: 'http',
        identity: { provider: 'test', testSecret: TESTHEMLIGHET },
        logger: (post) => {
          try {
            this.loggrader.push(JSON.stringify(post));
          } catch {
            this.loggrader.push('[loggpost som inte gick att skriva ut]');
          }
        },
        ...(builder === undefined ? {} : { builder }),
        ...(this.kvot === undefined ? {} : { limits: this.kvot }),
        ...(this.tjanster.length === 0 ? {} : { appServices: { enabled: this.tjanster, env: tjanstMiljo } }),
      },
      {
        ...(this.#byggkedja === undefined
          ? {}
          : { buildRunner: this.#byggkedja, llmProvider: modell, knowledge: await loadAgentKnowledge(undefined, this.tjanster) }),
        ...(Object.keys(tjanstOverrides).length === 0 ? {} : { appServiceOverrides: tjanstOverrides }),
      },
    );
    this.port = (await this.#platform.listen()).port;
  }

  /** Stänger och städar ALLT, även när bara en del hann starta. Kastar aldrig. */
  async stada(): Promise<void> {
    await this.#platform?.close().catch(() => {});
    for (const f of this.#tjanstForberedelser) await f.stada?.().catch(() => {});
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

  /**
   * "Appen X är publicerad" (isoleringsscenarierna): appen skapas och publiceras direkt i control,
   * som CLI:t gör, utan byggverktyget. Scenarierna handlar om isolering av DATA mellan appar och
   * användare — inte om vem som fått appen delad med sig — så appen är publicerad FÖR personerna
   * i scenariot: Anna är dess ägare och övriga inloggade (Bertil) har fått den delad med sig.
   * Åtkomsten ges vid inloggningen (`gePubliceradeAppar`) eller här, om personen redan loggat in.
   * Den som bara dyker upp i ett När-steg (t.ex. en manipulerad inloggning) får ingen åtkomst.
   */
  async publicera(namn: string, val: FixturVal = {}): Promise<void> {
    if (!this.appar.has(namn)) {
      this.appar.set(namn, await this.control.createApp());
      this.#direktPublicerade.add(namn);
      for (const person of this.#delasMed) await this.#geAtkomst(namn, person);
    }
    await this.control.publish(this.appId(namn), await this.importeraFixtur(namn, val));
  }

  /** Ger en inloggad person åtkomst till alla appar som scenariot publicerat direkt — se `publicera`. */
  async gePubliceradeAppar(namn: string): Promise<void> {
    this.#delasMed.add(namn);
    for (const app of this.#direktPublicerade) await this.#geAtkomst(app, namn);
  }

  async #geAtkomst(app: string, namn: string): Promise<void> {
    const { userId, email } = this.person(namn).identitet;
    await this.control.grantAccess(this.appId(app), userId, namn === 'Anna' ? 'owner' : 'user', email);
  }

  async sattUtkast(namn: string): Promise<void> {
    await this.control.setDraft(this.appId(namn), await this.importeraFixtur(namn));
  }

  /** Adressen som den står i webbläsaren, med port: `<app-id>.appar.test:<port>`. */
  adress(namn: string, forhandsvisning = false, appId: AppId = this.appId(namn)): string {
    return `${forhandsvisning ? 'p-' : ''}${appId}.${DOMAN}:${this.port}`;
  }

  // ── Personer ─────────────────────────────────────────────────────────────────

  /** Adressen en person har i scenariot — även innan hen loggat in (t.ex. när någon delar med hen). */
  epost(namn: string): string {
    return this.personer.get(namn)?.identitet.email ?? `${namn.toLowerCase()}@example.org`;
  }

  /** Personens användar-id: det plattformen gav hen vid en delning, annars ett eget för scenariot. */
  anvandarId(namn: string): string {
    return this.anvandarIdn.get(namn) ?? `anv-${namn.toLowerCase()}`;
  }

  loggaIn(namn: string, epost = this.epost(namn), roller: readonly Role[] = ['viewer']): Person {
    const identitet: Identity = { userId: this.anvandarId(namn), email: epost, roles: roller };
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
      host: this.adress(anrop.app, anrop.forhandsvisning === true, anrop.appId),
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

  /** Vad modellen svarar när den ombeds klassa ett önskemål. Ett fel eller `{ hang: true }` går bra. */
  sattKlassning(svar: FakeReply): void {
    this.#klassningssvar = svar;
  }

  loggaInSomByggare(namn: string): Person {
    const identitet: Identity = { userId: this.anvandarId(namn), email: this.epost(namn), roles: ['builder'] };
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
