/**
 * Kommandona bakom `cli.ts` — ett litet verktyg för lokal utveckling tills byggverktyget finns.
 *
 * CLI:t öppnar appregistret DIREKT i datakatalogen, bredvid en eventuell server som redan är
 * igång (SQLite i WAL-läge klarar det). Det går alltså förbi inloggningen, och är därför bara
 * till för den som ändå har skalåtkomst till servern.
 *
 * Logiken ligger här och inte i `cli.ts` så att den går att testa utan att starta en process:
 * argument, miljö och utskrift skickas in.
 */
import { isAbsolute, resolve } from 'node:path';
import { isAppId } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';
import { ControlError, createControl } from '@vibesandbox/control';
import type { Control } from '@vibesandbox/control';
import type { Environment } from './config.ts';

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

/** 0 = gick bra, 1 = kommandot misslyckades, 2 = kommandot användes fel. */
export type ExitCode = 0 | 1 | 2;

const USAGE = [
  'Användning: npm run cli -w @vibesandbox/platform -- <kommando>',
  '',
  '  skapa-app                        skapar en tom app och skriver ut dess app-id',
  '  publicera <appId> <katalog>      läser in en byggd katalog och publicerar den',
  '  satt-utkast <appId> <katalog>    läser in en byggd katalog som appens utkast (förhandsvisning)',
  '  lista                            visar alla appar',
  '',
  'Miljö: DATA_DIR (absolut sökväg till plattformens datakatalog).',
];

class UsageError extends Error {}

function parseAppId(value: string | undefined): AppId {
  if (value === undefined || !isAppId(value)) throw new UsageError('Ange ett giltigt app-id (26 tecken).');
  return value;
}

function parseDirectory(value: string | undefined, env: Environment): string {
  if (value === undefined || value.length === 0) throw new UsageError('Ange katalogen med den byggda appen.');
  // `npm run … -w` kör skriptet med paketets katalog som arbetskatalog; INIT_CWD är där
  // användaren faktiskt stod när kommandot skrevs.
  return resolve(env['INIT_CWD'] ?? process.cwd(), value);
}

async function importAndPoint(
  control: Control,
  args: readonly string[],
  env: Environment,
  point: (appId: AppId, versionId: string) => Promise<void>,
): Promise<void> {
  const appId = parseAppId(args[0]);
  const directory = parseDirectory(args[1], env);
  if (args.length > 2) throw new UsageError('För många argument.');
  await point(appId, await control.importVersion(appId, directory));
}

export async function runCli(argv: readonly string[], env: Environment, output: CliOutput): Promise<ExitCode> {
  const [command, ...args] = argv;

  let control: Control | undefined;
  try {
    const dataDir = env['DATA_DIR'];
    if (dataDir === undefined || !isAbsolute(dataDir)) {
      throw new UsageError('DATA_DIR saknas eller är inte en absolut sökväg.');
    }
    if (command === undefined || !['skapa-app', 'publicera', 'satt-utkast', 'lista'].includes(command)) {
      throw new UsageError(command === undefined ? 'Inget kommando angavs.' : 'Okänt kommando.');
    }
    // Argumenten kontrolleras FÖRE registret öppnas, så att ett skrivfel inte skapar en databas.
    if (command === 'publicera' || command === 'satt-utkast') {
      parseAppId(args[0]);
      parseDirectory(args[1], env);
    }

    control = createControl({ dataDir });
    const opened = control;

    switch (command) {
      case 'skapa-app':
        // Bara id:t på standard ut, så att det går att fånga: APP=$(npm run -s cli … -- skapa-app)
        output.out(await opened.createApp());
        return 0;
      case 'publicera':
        await importAndPoint(opened, args, env, (appId, versionId) => opened.publish(appId, versionId));
        output.out('Publicerad.');
        return 0;
      case 'satt-utkast':
        await importAndPoint(opened, args, env, (appId, versionId) => opened.setDraft(appId, versionId));
        output.out('Utkastet är satt.');
        return 0;
      default: {
        const apps = await opened.listApps();
        if (apps.length === 0) output.out('Inga appar finns ännu. Skapa en med: skapa-app');
        for (const app of apps) {
          const state = [app.published ? 'publicerad' : 'ej publicerad', app.draft ? 'har utkast' : 'inget utkast'];
          output.out(`${app.appId}  ${state.join(', ')}  (skapad ${app.createdAt})`);
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      output.err(error.message);
      output.err('');
      for (const line of USAGE) output.err(line);
      return 2;
    }
    // ControlError-meddelanden är skrivna för att visas. Allt annat är oväntat: visa felets
    // namn men inte dess text, som kan innehålla sökvägar.
    output.err(error instanceof ControlError ? error.message : `Oväntat fel (${error instanceof Error ? error.name : 'okänt'}).`);
    return 1;
  } finally {
    await control?.close();
  }
}
