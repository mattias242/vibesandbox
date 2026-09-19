/**
 * Gemensam uppstart för `main.ts` (drift) och `dev.ts` (lokal utveckling): starta, logga EN rad
 * om att plattformen lyssnar, och stäng ordnat på SIGTERM/SIGINT.
 *
 * Loggen är JSON-rader på standard ut, märkta med `source`. Varje del loggar bara sin egen snävt
 * typade post (gatewayns, byggverktygets, identitetens), vars typer utesluter e-postadresser,
 * huvuden, kroppar, sökvägar, önskemål och koder. Startraden innehåller aldrig en hemlighet och
 * aldrig datakatalogens innehåll.
 */
import type { PlatformConfig } from './config.ts';
import type { PlatformLogEntry } from './logg.ts';
import { createPlatform } from './server.ts';
import type { ListenInfo, Platform, PlatformDependencies } from './server.ts';

function writeLogLine(entry: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

export interface RunningPlatform {
  readonly platform: Platform;
  readonly listening: ListenInfo;
}

export async function startPlatform(config: PlatformConfig, deps: PlatformDependencies = {}): Promise<RunningPlatform> {
  const platform = createPlatform(
    {
      ...config,
      logger: config.logger ?? ((entry: PlatformLogEntry) => writeLogLine({ ...entry })),
    },
    deps,
  );

  let listening: ListenInfo;
  try {
    listening = await platform.listen();
  } catch (error) {
    await platform.close();
    throw error;
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      // Andra signalen: någon vill verkligen ut. Vänta inte på pågående förfrågningar.
      process.exit(1);
    }
    stopping = true;
    writeLogLine({ level: 'info', event: 'stopping', signal });
    platform.close().then(
      () => {
        writeLogLine({ level: 'info', event: 'stopped' });
        process.exitCode = 0;
      },
      (error: unknown) => {
        writeLogLine({ level: 'error', event: 'stop_failed', errorName: error instanceof Error ? error.name : 'okänt' });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  writeLogLine({
    level: 'info',
    event: 'listening',
    host: listening.host,
    port: listening.port,
    baseDomain: config.baseDomain,
    appDomain: config.appDomain,
    publicScheme: config.publicScheme,
    identityProvider: config.identity.provider,
    builder: config.builder === undefined ? 'av' : 'på',
    ...(config.builder === undefined ? {} : { llmModel: config.builder.llm.model, buildDriver: config.builder.build.driver }),
  });

  return { platform, listening };
}

/** Skriver ett startfel begripligt och avslutar. Konfigurationsfel har redan en färdig text. */
export function exitWithStartupError(error: unknown): never {
  const name = error instanceof Error ? error.name : 'okänt fel';
  const message = error instanceof Error ? error.message : '';
  console.error(name === 'ConfigError' ? message : `Plattformen kunde inte starta (${name}): ${message}`);
  process.exit(1);
}
