/**
 * Plattformens konfiguration ur miljövariabler.
 *
 * Princip: hellre vägra starta än starta fel. Ett skrivfel i en domän ger en gateway som aldrig
 * matchar ett värdnamn; en relativ datakatalog ger data på olika ställen beroende på varifrån
 * processen startades; en testinloggning i produktion låter vem som helst vara vem som helst.
 * Alla fel samlas och rapporteras på en gång, på svenska, och ingenting ur en hemlighet skrivs
 * någonsin ut.
 *
 * Inga standardvärden för hemligheter, och inga standardvärden för sådant som avgör VAR data
 * hamnar eller VILKA adresser som gäller. Det enda standardvärdet är `LISTEN_HOST`, och det är
 * det försiktiga valet (och `BUILDER_UI_DIR`, som pekar in i repot).
 */
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { APP_SERVICE_NAMES, BUILDER_HOST_LABEL } from '@vibesandbox/contracts';
import type { AppServiceName, TenantLimits } from '@vibesandbox/contracts';
import type { PlatformLogger } from './logg.ts';

/** Byggverktygets webbgränssnitt, byggt med `npm run build -w @vibesandbox/builder-ui`. */
export const DEFAULT_BUILDER_UI_DIR = resolve(import.meta.dirname, '..', '..', 'builder-ui', 'dist');

export type IdentityConfig =
  | { readonly provider: 'test'; readonly testSecret: string }
  | { readonly provider: 'email-otp'; readonly secret: string; readonly mail: MailConfig };

export type MailConfig =
  | { readonly kind: 'mailgun'; readonly apiKey: string; readonly domain: string; readonly from: string }
  /** Mejlen skrivs som filer i katalogen. Bara utanför produktion. */
  | { readonly kind: 'outbox'; readonly directory: string };

export type BuildDriver = 'local' | 'docker' | 'spool';

export interface BuilderConfig {
  readonly llm: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
    readonly reasoningEffort?: 'low' | 'medium' | 'high';
  };
  /** Hur byggkedjan kör opålitlig kod. Tolkas av `@vibesandbox/build`, inte här. */
  readonly build: { readonly driver: BuildDriver; readonly jobsDir?: string };
  readonly uiDirectory: string;
}

export interface PlatformConfig {
  /** Byggverktyg, inloggning och förhandsvisningar: `p-<app-id>.<baseDomain>`. */
  readonly baseDomain: string;
  /** Publicerade appar: `<app-id>.<appDomain>`. */
  readonly appDomain: string;
  readonly dataDir: string;
  readonly port: number;
  readonly listenHost: string;
  /** Schemat webbläsaren ser (TLS avslutas i proxyn framför oss). Avgör adresser och kakor. */
  readonly publicScheme: 'http' | 'https';
  /** Porten webbläsaren ser. Saknas = schemats standardport (och då står den aldrig i en adress). */
  readonly publicPort?: number;
  readonly identity: IdentityConfig;
  /** Finns när byggverktyget är påslaget (`LLM_MODEL` satt). */
  readonly builder?: BuilderConfig;
  /**
   * Plattformstjänster för appar (`APP_SERVICES`, kommaseparerad). Saknas = inga. `env` är hela
   * miljön: varje tjänst läser sina egna `SVC_<NAMN>_…` och vägrar starta om något fattas.
   */
  readonly appServices?: { readonly enabled: readonly AppServiceName[]; readonly env: Environment };
  /**
   * Berget för plattformstjänsterna (`BERGET_API_KEY`, valfri `BERGET_BASE_URL`). Oberoende av
   * byggverktyget; saknas den används byggverktygets språkmodell om den finns.
   */
  readonly berget?: { readonly baseUrl: string; readonly apiKey: string };
  /** Sätts inte ur miljön. Finns för tester som behöver en liten kvot för att gå fort. */
  readonly limits?: TenantLimits;
  /** Sätts inte ur miljön. Standard är tyst; `main.ts` skickar in en som skriver JSON-rader. */
  readonly logger?: PlatformLogger;
}

export interface PlatformAddresses {
  /** Exakt som webbläsaren skriver den i `Origin`: `https://bygg.example.org`, `http://bygg.localtest.me:8787`. */
  readonly builderOrigin: string;
  /** `<schema>://p-<id>.<BASE_DOMAIN>[:port]/` */
  preview(appId: string): string;
  /** `<schema>://<id>.<APP_DOMAIN>[:port]/` */
  published(appId: string): string;
}

/** Adresserna så som webbläsaren ser dem, härledda ur konfigurationen och ingenting annat. */
export function platformAddresses(config: Pick<PlatformConfig, 'publicScheme' | 'publicPort' | 'baseDomain' | 'appDomain'>): PlatformAddresses {
  const port = config.publicPort === undefined ? '' : `:${config.publicPort}`;
  const origin = (host: string): string => `${config.publicScheme}://${host}${port}`;
  return {
    builderOrigin: origin(`${BUILDER_HOST_LABEL}.${config.baseDomain}`),
    preview: (appId) => `${origin(`p-${appId}.${config.baseDomain}`)}/`,
    published: (appId) => `${origin(`${appId}.${config.appDomain}`)}/`,
  };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      ['Plattformen startar inte: konfigurationen är ofullständig eller ogiltig.', ...problems.map((p) => `  - ${p}`)].join(
        '\n',
      ),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** Samma krav som testinloggningen själv ställer (gateway/testidentitet.ts). Räknas i byte. */
const MIN_SECRET_BYTES = 32;

/**
 * Gemener, ingen port, ingen avslutande punkt, inga jokertecken — samma regel som gatewayn
 * tillämpar på sina domäner. Kontrollen görs redan här, så att felet nämner miljövariabeln.
 */
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Bara ASCII-siffror: `Number('0x50')`, `Number('1e3')` och `Number(' 80')` är alla "giltiga" tal. */
const PORT_PATTERN = /^(?:0|[1-9][0-9]{0,4})$/;

/** Som `DOMAIN_PATTERN`, men med minst en punkt: en avsändardomän är aldrig ett ensamt namn. */
const MAIL_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function loadConfig(env: Environment): PlatformConfig {
  const problems: string[] = [];

  /** Värdet, eller `undefined` efter att ha noterat att det saknas. Tomt räknas som saknat. */
  function required(name: string, purpose: string): string | undefined {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      problems.push(`${name} saknas. ${purpose}`);
      return undefined;
    }
    return value;
  }

  function domain(name: string, purpose: string): string {
    const value = required(name, purpose);
    if (value !== undefined && !DOMAIN_PATTERN.test(value)) {
      problems.push(`${name} ska vara ett värdnamn i gemener, utan protokoll, port och avslutande punkt (t.ex. example.org).`);
    }
    return value ?? '';
  }

  const baseDomain = domain('BASE_DOMAIN', 'Ange domänen för byggverktyg och förhandsvisningar, t.ex. example.org.');
  const appDomain = domain('APP_DOMAIN', 'Ange domänen som publicerade appar nås under, t.ex. example.org.');

  const dataDir = required('DATA_DIR', 'Ange en absolut sökväg till katalogen där plattformens data ska ligga.') ?? '';
  if (dataDir.length > 0 && (!isAbsolute(dataDir) || dataDir.includes(String.fromCharCode(0)))) {
    problems.push('DATA_DIR ska vara en absolut sökväg (börja med /), så att data hamnar på samma ställe varifrån plattformen än startas.');
  }

  const portText = required('PORT', 'Ange porten plattformen ska lyssna på, t.ex. 8787.');
  let port = 0;
  if (portText !== undefined) {
    port = PORT_PATTERN.test(portText) ? Number(portText) : Number.NaN;
    if (!Number.isInteger(port) || port > 65535) {
      problems.push('PORT ska vara ett heltal mellan 0 och 65535, skrivet med siffror.');
    }
  }

  const listenHost = env['LISTEN_HOST'] === undefined || env['LISTEN_HOST'] === '' ? DEFAULT_LISTEN_HOST : env['LISTEN_HOST'];
  if (isIP(listenHost) === 0) {
    // Ett värdnamn här skulle slås upp i DNS vid start; då avgör någon annan var vi lyssnar.
    problems.push('LISTEN_HOST ska vara en IP-adress, t.ex. 127.0.0.1 (standard) eller 0.0.0.0.');
  }

  const production = env['NODE_ENV'] === 'production';

  const scheme = required('PUBLIC_SCHEME', 'Ange schemat webbläsaren ser: https i drift, http lokalt.');
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    problems.push('PUBLIC_SCHEME ska vara http eller https (gemener, utan "://").');
  }
  const publicScheme = scheme === 'http' ? 'http' : 'https';

  let publicPort: number | undefined;
  const publicPortText = env['PUBLIC_PORT'];
  if (publicPortText !== undefined && publicPortText !== '') {
    const value = PORT_PATTERN.test(publicPortText) ? Number(publicPortText) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      problems.push('PUBLIC_PORT ska vara ett heltal mellan 1 och 65535, eller tom för schemats standardport.');
    } else if (value !== (publicScheme === 'https' ? 443 : 80)) {
      // Webbläsare utelämnar standardporten i `Origin`; står den i våra adresser matchar inget.
      publicPort = value;
    }
  }

  const identity = loadIdentity(env, production, problems, required);
  const builder = loadBuilder(env, production, problems);
  const appServices = loadAppServices(env, problems);
  const berget = loadBerget(env, production, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    baseDomain,
    appDomain,
    dataDir,
    port,
    listenHost,
    publicScheme,
    ...(publicPort === undefined ? {} : { publicPort }),
    identity: identity as IdentityConfig,
    ...(builder === undefined ? {} : { builder }),
    ...(appServices.length === 0 ? {} : { appServices: { enabled: appServices, env } }),
    ...(berget === undefined ? {} : { berget }),
  };
}

type Required = (name: string, purpose: string) => string | undefined;

/** Kontrolltecken i ett värde som hamnar i ett HTTP- eller mejlhuvud kan bli ett extra huvud. */
function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Kontrollerar en hemlighet på minst `MIN_SECRET_BYTES` byte. Varken värdet eller dess längd nämns. */
function secret(name: string, purpose: string, problems: string[], required: Required): string | undefined {
  const value = required(name, purpose);
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
    problems.push(`${name} är för kort; det ska vara minst ${MIN_SECRET_BYTES} byte.`);
    return undefined;
  }
  return value;
}

function isSet(env: Environment, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.length > 0;
}

function loadIdentity(env: Environment, production: boolean, problems: string[], required: Required): IdentityConfig | undefined {
  const provider = required('IDENTITY_PROVIDER', 'Ange inloggningssätt: "email-otp" (engångskod via mejl) eller "test".');
  if (provider === undefined) return undefined;

  if (provider === 'test') {
    if (production) {
      problems.push(
        'IDENTITY_PROVIDER=test får inte användas när NODE_ENV=production: testinloggningen låter den som kan hemligheten logga in som vem som helst.',
      );
    }
    const testSecret = secret(
      'TEST_IDENTITY_SECRET',
      'Det finns inget standardvärde. Skapa ett eget slumpat värde på minst 32 byte (se .env.example).',
      problems,
      required,
    );
    return testSecret === undefined ? undefined : { provider: 'test', testSecret };
  }

  if (provider !== 'email-otp') {
    problems.push('IDENTITY_PROVIDER har ett värde som inte stöds. Välj "email-otp" eller "test".');
    return undefined;
  }

  const identitySecret = secret(
    'IDENTITY_SECRET',
    'Nyckeln för sessioner och engångskoder. Det finns inget standardvärde; skapa ett slumpat värde på minst 32 byte (se .env.example).',
    problems,
    required,
  );

  const mailgunNames = ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN', 'MAIL_FROM'] as const;
  const usesMailgun = mailgunNames.some((name) => isSet(env, name));
  const usesOutbox = isSet(env, 'MAIL_OUTBOX_DIR');
  let mail: MailConfig | undefined;

  if (usesMailgun && usesOutbox) {
    problems.push('Både Mailgun (MAILGUN_*) och MAIL_OUTBOX_DIR är satta. Välj ett sätt att skicka mejl.');
  } else if (usesMailgun) {
    const apiKey = required('MAILGUN_API_KEY', 'Mailguns API-nyckel behövs när MAILGUN_DOMAIN eller MAIL_FROM är satt.');
    const domain = required('MAILGUN_DOMAIN', 'Ange den verifierade avsändardomänen hos Mailgun, t.ex. mg.example.org.');
    const from = required('MAIL_FROM', 'Ange avsändaren, t.ex. "Vibesandbox <noreply@example.org>".');
    if (apiKey !== undefined && (apiKey.length < 8 || hasControlCharacters(apiKey))) {
      problems.push('MAILGUN_API_KEY ser inte ut som en API-nyckel.');
    }
    if (domain !== undefined && !MAIL_DOMAIN_PATTERN.test(domain)) {
      problems.push('MAILGUN_DOMAIN ska vara ett värdnamn i gemener, utan protokoll (t.ex. mg.example.org).');
    }
    if (from !== undefined && (hasControlCharacters(from) || from.length > 320)) {
      problems.push('MAIL_FROM får inte innehålla radbrytningar eller andra styrtecken.');
    }
    if (apiKey !== undefined && domain !== undefined && from !== undefined) mail = { kind: 'mailgun', apiKey, domain, from };
  } else if (usesOutbox) {
    const directory = env['MAIL_OUTBOX_DIR'] ?? '';
    if (production) {
      problems.push(
        'MAIL_OUTBOX_DIR får inte användas när NODE_ENV=production: inloggningskoderna skulle hamna på disk i stället för hos mottagaren. Använd Mailgun.',
      );
    } else if (!isAbsolute(directory) || directory.includes(String.fromCharCode(0))) {
      problems.push('MAIL_OUTBOX_DIR ska vara en absolut sökväg.');
    } else {
      mail = { kind: 'outbox', directory };
    }
  } else {
    problems.push(
      'Inget sätt att skicka mejl är inställt. Ange MAILGUN_API_KEY, MAILGUN_DOMAIN och MAIL_FROM (Mailgun EU), ' +
        'eller — bara utanför produktion — MAIL_OUTBOX_DIR, så skrivs mejlen som filer.',
    );
  }

  if (identitySecret === undefined || mail === undefined) return undefined;
  return { provider: 'email-otp', secret: identitySecret, mail };
}

const REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high'];
const BUILD_DRIVERS: readonly string[] = ['local', 'docker', 'spool'];

/** Namnen ur `APP_SERVICES`, i plattformens fasta ordning (`APP_SERVICE_NAMES`) och utan dubbletter. */
function loadAppServices(env: Environment, problems: string[]): AppServiceName[] {
  const text = env['APP_SERVICES'] ?? '';
  const wanted = new Set(
    text
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  const known = new Set<string>(APP_SERVICE_NAMES);
  for (const name of wanted) {
    if (!known.has(name)) {
      const shown = name.length > 40 || hasControlCharacters(name) ? 'ett ogiltigt namn' : `"${name}"`;
      problems.push(`APP_SERVICES innehåller ${shown}. Kända tjänster: ${APP_SERVICE_NAMES.join(', ')}.`);
    }
  }
  return APP_SERVICE_NAMES.filter((name) => wanted.has(name));
}

const DEFAULT_BERGET_BASE_URL = 'https://api.berget.ai/v1';

function loadBerget(env: Environment, production: boolean, problems: string[]): { baseUrl: string; apiKey: string } | undefined {
  const apiKey = env['BERGET_API_KEY'];
  if (apiKey === undefined || apiKey === '') return undefined;
  const before = problems.length;
  // Medvetet utan värdet i meddelandet: det är en nyckel.
  if (apiKey.length < 8 || hasControlCharacters(apiKey)) problems.push('BERGET_API_KEY ser inte ut som en API-nyckel.');
  const baseUrl = env['BERGET_BASE_URL'] === undefined || env['BERGET_BASE_URL'] === '' ? DEFAULT_BERGET_BASE_URL : env['BERGET_BASE_URL'];
  let parsed: URL | undefined;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !/^https?:\/\//.test(baseUrl)
  ) {
    problems.push('BERGET_BASE_URL ska vara en http- eller https-adress utan inloggningsuppgifter och utan frågesträng.');
  } else if (production && parsed.protocol !== 'https:') {
    problems.push('BERGET_BASE_URL ska vara en https-adress när NODE_ENV=production.');
  }
  return problems.length === before ? { baseUrl, apiKey } : undefined;
}

function loadBuilder(env: Environment, production: boolean, problems: string[]): BuilderConfig | undefined {
  // Byggverktyget är påslaget exakt när en modell är vald. Allt annat som då saknas är ett fel —
  // inte ett tyst avstängt byggverktyg.
  const model = env['LLM_MODEL'];
  if (model === undefined || model.length === 0) return undefined;
  const before = problems.length;
  const purpose = 'Byggverktyget är påslaget eftersom LLM_MODEL är satt.';

  if (hasControlCharacters(model) || model.length > 200) problems.push('LLM_MODEL innehåller otillåtna tecken.');

  const baseUrlText = env['LLM_BASE_URL'];
  let baseUrl: string | undefined;
  if (baseUrlText === undefined || baseUrlText.length === 0) {
    problems.push(`LLM_BASE_URL saknas. ${purpose} Ange språkmodellens adress, t.ex. https://api.berget.ai/v1.`);
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(baseUrlText);
    } catch {
      parsed = undefined;
    }
    // Medvetet utan värdet: en adress kan bära inloggningsuppgifter.
    if (
      parsed === undefined ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !/^https?:\/\//.test(baseUrlText)
    ) {
      problems.push('LLM_BASE_URL ska vara en http- eller https-adress utan inloggningsuppgifter och utan frågesträng.');
    } else if (production && parsed.protocol !== 'https:') {
      problems.push('LLM_BASE_URL ska vara en https-adress när NODE_ENV=production: användarnas önskemål ska inte gå okrypterat.');
    } else {
      baseUrl = baseUrlText;
    }
  }

  const llmKey = env['LLM_API_KEY'];
  const bergetKey = env['BERGET_API_KEY'];
  const keys = [llmKey, bergetKey].filter((key): key is string => key !== undefined && key.length > 0);
  let apiKey: string | undefined;
  if (keys.length === 0) {
    problems.push(`LLM_API_KEY (eller BERGET_API_KEY) saknas. ${purpose} Ange nyckeln till språkmodellen.`);
  } else if (keys.length === 2 && keys[0] !== keys[1]) {
    problems.push('Både LLM_API_KEY och BERGET_API_KEY är satta, med olika värden. Sätt bara den ena.');
  } else if (keys[0] !== undefined && (keys[0].length < 8 || hasControlCharacters(keys[0]))) {
    problems.push('LLM_API_KEY (eller BERGET_API_KEY) ser inte ut som en API-nyckel.');
  } else {
    apiKey = keys[0];
  }

  const effort = env['LLM_REASONING_EFFORT'];
  if (effort !== undefined && effort !== '' && !REASONING_EFFORTS.includes(effort)) {
    problems.push('LLM_REASONING_EFFORT ska vara low, medium eller high (eller tom för leverantörens standard).');
  }

  const driver = env['BUILD_DRIVER'];
  let build: BuilderConfig['build'] | undefined;
  if (driver === undefined || driver.length === 0) {
    problems.push(`BUILD_DRIVER saknas. ${purpose} Ange hur appar byggs: docker, spool eller (bara lokalt) local.`);
  } else if (!BUILD_DRIVERS.includes(driver)) {
    problems.push('BUILD_DRIVER ska vara local, docker eller spool.');
  } else if (driver === 'local' && production) {
    problems.push('BUILD_DRIVER=local får inte användas när NODE_ENV=production: då körs opålitlig kod direkt på servern, utan sandlåda.');
  } else if (driver === 'spool') {
    const jobsDir = env['BUILD_JOBS_DIR'];
    if (jobsDir === undefined || !isAbsolute(jobsDir) || jobsDir.includes(String.fromCharCode(0))) {
      problems.push('BUILD_JOBS_DIR ska vara en absolut sökväg när BUILD_DRIVER=spool.');
    } else {
      build = { driver: 'spool', jobsDir };
    }
  } else {
    build = { driver: driver as BuildDriver };
  }

  const uiText = env['BUILDER_UI_DIR'];
  let uiDirectory = DEFAULT_BUILDER_UI_DIR;
  if (uiText !== undefined && uiText.length > 0) {
    if (!isAbsolute(uiText) || uiText.includes(String.fromCharCode(0))) {
      problems.push('BUILDER_UI_DIR ska vara en absolut sökväg (eller tom för apps/builder-ui/dist).');
    } else {
      uiDirectory = uiText;
    }
  }

  if (problems.length > before || baseUrl === undefined || apiKey === undefined || build === undefined) return undefined;
  return {
    llm: {
      baseUrl,
      model,
      apiKey,
      ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort as 'low' | 'medium' | 'high' }),
    },
    build,
    uiDirectory,
  };
}
