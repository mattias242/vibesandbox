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
 * det försiktiga valet.
 */
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { TenantLimits } from '@vibesandbox/contracts';
import type { GatewayLogger } from '@vibesandbox/gateway';

export interface PlatformConfig {
  /** Byggverktyg, inloggning och förhandsvisningar: `p-<app-id>.<baseDomain>`. */
  readonly baseDomain: string;
  /** Publicerade appar: `<app-id>.<appDomain>`. */
  readonly appDomain: string;
  readonly dataDir: string;
  readonly port: number;
  readonly listenHost: string;
  readonly identity: { readonly provider: 'test'; readonly testSecret: string };
  /** Sätts inte ur miljön. Finns för tester som behöver en liten kvot för att gå fort. */
  readonly limits?: TenantLimits;
  /** Sätts inte ur miljön. Standard är tyst; `main.ts` skickar in en som skriver JSON-rader. */
  readonly logger?: GatewayLogger;
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

  const provider = required('IDENTITY_PROVIDER', 'Ange inloggningssätt. Tills e-postinloggningen finns är "test" det enda.');
  let testSecret = '';
  if (provider !== undefined && provider !== 'test') {
    problems.push('IDENTITY_PROVIDER har ett värde som inte stöds. Tills e-postinloggningen finns är "test" det enda.');
  }
  if (provider === 'test') {
    if (env['NODE_ENV'] === 'production') {
      problems.push(
        'IDENTITY_PROVIDER=test får inte användas när NODE_ENV=production: testinloggningen låter den som kan hemligheten logga in som vem som helst.',
      );
    }
    const secret = required(
      'TEST_IDENTITY_SECRET',
      'Det finns inget standardvärde. Skapa ett eget slumpat värde på minst 32 byte (se .env.example).',
    );
    if (secret !== undefined) {
      if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
        // Medvetet utan värdet och utan dess längd.
        problems.push(`TEST_IDENTITY_SECRET är för kort; det ska vara minst ${MIN_SECRET_BYTES} byte.`);
      } else {
        testSecret = secret;
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return { baseDomain, appDomain, dataDir, port, listenHost, identity: { provider: 'test', testSecret } };
}
