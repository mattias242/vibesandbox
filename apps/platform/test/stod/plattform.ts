/**
 * En riktig plattform för ett test: egen temporär datakatalog, ledig port, fejkad språkmodell och
 * byggkedja. Allt annat — gateway, inloggning, byggverktyg, control, lagring — är det riktiga.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildRunner, LlmProvider } from '@vibesandbox/contracts';
import { CLASSIFICATION_SYSTEM_PROMPT } from '@vibesandbox/agent';
import { createFakeProvider } from '@vibesandbox/llm';
import type { FakeProvider, FakeReply } from '@vibesandbox/llm';
import type { BuilderConfig, IdentityConfig, PlatformConfig } from '../../src/config.ts';
import { createPlatformBuildRunner } from '../../src/byggkedja.ts';
import { loadAgentKnowledge } from '../../src/kunskap.ts';
import type { PlatformLogEntry } from '../../src/logg.ts';
import { createPlatform } from '../../src/server.ts';
import type { Platform } from '../../src/server.ts';
import { fejkadByggkedja } from './byggkedja.ts';
import type { FejkadByggkedja } from './byggkedja.ts';

export const DOMAN = 'example.org';
export const BYGG = `bygg.${DOMAN}`;
export const BYGG_ORIGIN = `http://${BYGG}`;
export const TESTHEMLIGHET = 'testinloggningens-hemlighet-bara-i-testerna-0123456789';
const IDENTITETSHEMLIGHET = 'identitetens-hemlighet-bara-i-plattformstesterna-0123456789';

export interface Testplattform {
  readonly platform: Platform;
  readonly port: number;
  readonly dataDir: string;
  readonly utkorg: string;
  readonly modell: FakeProvider;
  readonly byggkedja: FejkadByggkedja;
  readonly logg: PlatformLogEntry[];
  stang(): Promise<void>;
}

export interface Val {
  readonly identitet?: 'email-otp' | 'test';
  readonly modellsvar?: readonly FakeReply[];
  /** Vad modellen svarar på klassningsfrågan. Standard: den mildaste klassen, så att den inte stör. */
  readonly klassning?: FakeReply;
  /** Utan byggverktyg: ingen `LLM_MODEL`. */
  readonly utanByggverktyg?: boolean;
  /** Utan byggkedja trots påslaget byggverktyg (för startfelet). */
  readonly utanByggkedja?: boolean;
  /** Den RIKTIGA byggkedjan (`local`: tsc och Vite som barnprocesser) i stället för den fejkade. */
  readonly riktigByggkedja?: boolean;
}

export async function startaPlattform(val: Val = {}): Promise<Testplattform> {
  const arbetskatalog = await mkdtemp(join(tmpdir(), 'vibesandbox-plattformstest-'));
  const dataDir = join(arbetskatalog, 'data');
  const utkorg = join(arbetskatalog, 'utkorg');
  const ui = join(arbetskatalog, 'ui');
  await mkdir(ui);
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Byggverktyget</title><h1>byggverktygets-webbgranssnitt</h1>');

  const identity: IdentityConfig =
    (val.identitet ?? 'email-otp') === 'email-otp'
      ? { provider: 'email-otp', secret: IDENTITETSHEMLIGHET, mail: { kind: 'outbox', directory: utkorg } }
      : { provider: 'test', testSecret: TESTHEMLIGHET };
  const builder: BuilderConfig = {
    llm: { baseUrl: 'https://llm.example.org/v1', model: 'fejk/modell', apiKey: 'llm-nyckel-bara-i-testerna' },
    build: { driver: 'local' },
    uiDirectory: ui,
  };
  const logg: PlatformLogEntry[] = [];
  const config: PlatformConfig = {
    baseDomain: DOMAN,
    appDomain: DOMAN,
    dataDir,
    port: 0,
    listenHost: '127.0.0.1',
    publicScheme: 'http',
    identity,
    ...(val.utanByggverktyg === true ? {} : { builder }),
    logger: (entry) => logg.push(entry),
  };

  const modell = createFakeProvider(val.modellsvar ?? []);
  const byggkedja = fejkadByggkedja();
  // Klassningen frågar modellen en EGEN fråga före varje bygge, med egen systemprompt. Den får
  // därför ett eget svar och rör inte `modellsvar` — annars hade varje test som spelar in ett
  // agentsvar fått det uppätet av klassningen. `val.klassning` styr bara den frågan.
  const klassning = (): FakeReply => val.klassning ?? 'oppen';
  const llmProvider: LlmProvider = {
    name: 'fejk',
    complete: (request) =>
      request.messages.some((m) => m.role === 'system' && m.content === CLASSIFICATION_SYSTEM_PROMPT)
        ? createFakeProvider([klassning()]).complete(request)
        : modell.complete(request),
  };
  const riktig: BuildRunner | undefined =
    val.riktigByggkedja === true ? await createPlatformBuildRunner({ ...config, ...(config.builder === undefined ? {} : { builder }) }) : undefined;
  const knowledge = await loadAgentKnowledge();
  let platform: Platform;
  let port: number;
  try {
    platform = createPlatform(config, {
      ...(val.utanByggkedja === true ? {} : { buildRunner: riktig ?? byggkedja }),
      llmProvider,
      knowledge,
    });
  } catch (error) {
    await rm(arbetskatalog, { recursive: true, force: true });
    throw error;
  }
  try {
    ({ port } = await platform.listen());
  } catch (error) {
    await platform.close();
    await rm(arbetskatalog, { recursive: true, force: true });
    throw error;
  }

  return {
    platform,
    port,
    dataDir,
    utkorg,
    modell,
    byggkedja,
    logg,
    async stang() {
      await platform.close();
      await rm(arbetskatalog, { recursive: true, force: true });
    },
  };
}

export interface Mejl {
  readonly till: string;
  readonly amne: string;
  readonly text: string;
}

/** Mejlen i utkorgen, äldst först (filnamnen börjar med tid och löpnummer). */
export async function lasUtkorg(katalog: string): Promise<Mejl[]> {
  let namn: string[];
  try {
    namn = (await readdir(katalog)).sort();
  } catch {
    return [];
  }
  const mejl: Mejl[] = [];
  for (const fil of namn) {
    const innehall = await readFile(join(katalog, fil), 'utf8');
    const [huvud = '', ...kropp] = innehall.split('\n\n');
    const till = /^Till: (.*)$/m.exec(huvud)?.[1] ?? '';
    const amne = /^Ämne: (.*)$/m.exec(huvud)?.[1] ?? '';
    mejl.push({ till, amne, text: kropp.join('\n\n') });
  }
  return mejl;
}

/** Väntar på ett mejl till adressen (mejl skickas i bakgrunden, efter svaret). */
export async function vantaPaMejl(katalog: string, till: string, antalFore = 0): Promise<Mejl> {
  for (let forsok = 0; forsok < 100; forsok += 1) {
    const mejl = (await lasUtkorg(katalog)).filter((m) => m.till === till);
    const nytt = mejl[antalFore];
    if (nytt !== undefined) return nytt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Inget mejl kom till ${till}.`);
}

export function kodUr(mejl: Mejl): string {
  const kod = /Din kod är: ([0-9]{6})/.exec(mejl.text)?.[1];
  if (kod === undefined) throw new Error('Mejlet innehöll ingen kod.');
  return kod;
}

/**
 * Loggar in webbläsaren på en värd som en människa gör: formuläret med adressen, koden ur mejlet,
 * formuläret med koden. Ger svaret på det sista steget (303 med sessionskaka vid lyckad inloggning).
 */
export async function loggaInMedKod(
  webblasare: import('./webblasare.ts').Webblasare,
  plattform: Testplattform,
  host: string,
  epost: string,
  next = '/',
): Promise<import('./webblasare.ts').Svar> {
  const origin = `http://${host}`;
  const fore = (await lasUtkorg(plattform.utkorg)).filter((m) => m.till === epost).length;
  const begaran = await webblasare.skickaFormular(host, '/_auth/login', { email: epost, next }, origin);
  if (begaran.status !== 200) throw new Error(`Begäran om kod gav ${begaran.status}.`);
  const kod = kodUr(await vantaPaMejl(plattform.utkorg, epost, fore));
  return webblasare.skickaFormular(host, '/_auth/verify', { code: kod }, origin);
}

/**
 * Publicerar appen HELA vägen genom plattformen: ägaren begär granskning, och en administratör
 * läser kön och godkänner.
 *
 * Sedan granskningsskivan är det den enda vägen ut. Granskaren skapas här och är aldrig ägaren —
 * en granskare får inte avgöra sin egen app. Adressen är egen just för att den inte ska krocka
 * med någon av testets egna personer.
 */
export async function publiceraViaGranskning(
  plattform: Testplattform,
  appId: string,
  agare: import('./webblasare.ts').Webblasare,
): Promise<void> {
  const { Webblasare } = await import('./webblasare.ts');
  const begaran = await agare.api(BYGG, 'POST', `/_api/builder/apps/${appId}/publish`, { origin: BYGG_ORIGIN });
  if (begaran.status !== 202) throw new Error(`kunde inte begära granskning: ${begaran.status} ${begaran.body}`);

  const epost = 'granskaren@example.org';
  await plattform.platform.addUser(epost, 'admin');
  const granskare = new Webblasare(plattform.port);
  const inloggad = await loggaInMedKod(granskare, plattform, BYGG, epost);
  if (inloggad.status !== 303) throw new Error(`granskaren kunde inte logga in: ${inloggad.status}`);

  const kon = await granskare.api(BYGG, 'GET', '/_api/builder/admin/granskning', { origin: BYGG_ORIGIN });
  if (kon.status !== 200) throw new Error(`granskningskön gick inte att läsa: ${kon.status} ${kon.body}`);
  const { reviews } = JSON.parse(kon.body) as { reviews: { reviewId: string; appIdPrefix: string }[] };
  const arende = reviews.find((r) => appId.startsWith(r.appIdPrefix));
  if (arende === undefined) throw new Error('appen syns inte i granskningskön.');

  const beslut = await granskare.api(BYGG, 'POST', `/_api/builder/admin/granskning/${arende.reviewId}`, {
    json: { decision: 'godkand' },
    origin: BYGG_ORIGIN,
  });
  if (beslut.status !== 200) throw new Error(`granskningen gick inte att godkänna: ${beslut.status} ${beslut.body}`);
}
