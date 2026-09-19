/**
 * Startskript för BYGGARBETAREN (drivrutinen `spool`): en långlivad process i en egen container.
 *
 *   node images/build-worker/spool-worker.ts
 *
 * Containern ska köras med network_mode: none, read_only: true, cap_drop: [ALL],
 * no-new-privileges, en tmpfs på /tmp, egna gränser för minne och processer, INGA hemligheter —
 * och bara jobbkatalogen delad med plattformen (se packages/build/README.md).
 *
 *   VIBESANDBOX_JOBS_DIR   jobbkatalogen (standard /jobs)
 *   BUILD_TIMEOUT_MS, BUILD_MEMORY_MB, BUILD_MAX_OUTPUT_BYTES   gränser (valfria)
 */
import { DEFAULT_LIMITS, runSpoolWorker } from '@vibesandbox/build';

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

const jobsDirectory = process.env['VIBESANDBOX_JOBS_DIR'] ?? '/jobs';
process.stdout.write(`Byggarbetaren väntar på jobb i ${jobsDirectory}.\n`);
await runSpoolWorker({
  jobsDirectory,
  templateDirectory: '/opt/vibesandbox/packages/app-template',
  signal: controller.signal,
  limits: {
    timeoutMs: limit('BUILD_TIMEOUT_MS', DEFAULT_LIMITS.timeoutMs),
    memoryMb: limit('BUILD_MEMORY_MB', DEFAULT_LIMITS.memoryMb),
    maxOutputBytes: limit('BUILD_MAX_OUTPUT_BYTES', DEFAULT_LIMITS.maxOutputBytes),
  },
});
process.stdout.write('Byggarbetaren har stannat.\n');
