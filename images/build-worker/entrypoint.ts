/**
 * Inträdesskript för byggavbilden, drivrutinen `docker`: en engångscontainer per bygge.
 *
 *   docker run --rm --network none --read-only --tmpfs /work … -v <in>:/in:ro -v <ut>:/out <avbild>
 *
 * Läser /in/src, bygger med den låsta mallen i /opt/vibesandbox/packages/app-template (installerad
 * när avbilden byggdes), kopierar dist till /out/dist och skriver resultatet som EN rad JSON på
 * standard ut. Gränserna kommer som miljövariabler från värden — inga hemligheter finns här.
 */
import { DEFAULT_LIMITS, runContainerBuild } from '@vibesandbox/build';

// Filer i /out ska gå att ta bort för värdens användare, som inte är uid 10001.
process.umask(0o000);

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

try {
  const report = await runContainerBuild({
    inDirectory: '/in',
    outDirectory: '/out',
    workRoot: '/work',
    templateDirectory: '/opt/vibesandbox/packages/app-template',
    limits: {
      ...DEFAULT_LIMITS,
      timeoutMs: limit('BUILD_TIMEOUT_MS', DEFAULT_LIMITS.timeoutMs),
      memoryMb: limit('BUILD_MEMORY_MB', DEFAULT_LIMITS.memoryMb),
      maxOutputBytes: limit('BUILD_MAX_OUTPUT_BYTES', DEFAULT_LIMITS.maxOutputBytes),
    },
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  // Inga detaljer ut: felet kan innehålla sökvägar. Värden ger modellen ett allmänt besked.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, diagnostics: [{ source: 'build', rule: 'build-failed', message: 'Bygget misslyckades oväntat.' }] })}\n`);
  process.exitCode = 1;
}
