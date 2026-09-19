/**
 * Scenariernas värld: en RIKTIG plattform per scenario, på en ledig port, med en egen temporär
 * datakatalog. Inget delas mellan scenarier — varken port, data, appar eller inloggningar — så
 * scenarierna kan köras i vilken ordning som helst, och parallellt.
 *
 * Apparna skapas genom en egen `@vibesandbox/control`-instans mot samma datakatalog, precis som
 * CLI:t gör bredvid en server i drift. All övrig kontakt med plattformen går över rå HTTP.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, setWorldConstructor } from '@cucumber/cucumber';
import { CSRF_HEADER, DEFAULT_TENANT_LIMITS } from '@vibesandbox/contracts';
import type { AppId, Identity, JsonObject, TenantLimits } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import type { Control } from '@vibesandbox/control';
import { signTestIdentity } from '@vibesandbox/gateway';
import { createPlatform } from '@vibesandbox/platform';
import type { Platform } from '@vibesandbox/platform';
import { skrivFixturapp } from './fixtur.ts';
import type { FixturVal } from './fixtur.ts';
import { anropa, jsonKropp } from './http.ts';
import type { Svar } from './http.ts';

/** Scenariot "Ett ogiltigt värdnamn…" nämner `appar.test`, så det är plattformens domän här. */
export const DOMAN = 'appar.test';

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
    this.#platform = createPlatform({
      baseDomain: DOMAN,
      appDomain: DOMAN,
      dataDir: this.dataDir,
      port: 0,
      listenHost: '127.0.0.1',
      publicScheme: 'http',
      identity: { provider: 'test', testSecret: TESTHEMLIGHET },
      ...(this.kvot === undefined ? {} : { limits: this.kvot }),
    });
    this.port = (await this.#platform.listen()).port;
  }

  /** Stänger och städar ALLT, även när bara en del hann starta. Kastar aldrig. */
  async stada(): Promise<void> {
    await this.#platform?.close().catch(() => {});
    await this.#control?.close().catch(() => {});
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
