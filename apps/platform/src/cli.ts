/**
 * Startpunkt för CLI:t. All logik ligger i kommandon.ts.
 *
 *   npm run cli -w @vibesandbox/platform -- skapa-app
 */
import { runCli } from './kommandon.ts';

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
