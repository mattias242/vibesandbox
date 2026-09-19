/** Startpunkt för `npm run anvandare`. Se kommando.ts. */
import { runIdentityCli } from './kommando.ts';

process.exitCode = await runIdentityCli(process.argv.slice(2), process.env, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
