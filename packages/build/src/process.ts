/**
 * Barnprocesser för bygget: alltid `spawn` med argumentlista (aldrig ett skal), alltid en
 * uttryckligen given miljö (aldrig `process.env` — plattformens hemligheter ska inte kunna nås
 * från bygget), tidsgräns och avbrott som dödar hela processgruppen, och tak på fångad utdata.
 */
import { spawn } from 'node:child_process';
import { abortError } from './queue.ts';

export interface ProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** HELA miljön barnet får. Ärver ingenting. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Tak per ström (standard ut och standard fel). Standard 1 MB. */
  readonly maxOutputBytes?: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  const { signal } = options;
  if (signal?.aborted === true) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // Egen processgrupp, så att tidsgränsen även når barnbarn (tsc startar en inbyggd binär).
      detached: true,
      windowsHide: true,
    });

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = limit - sizes[stream];
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks[stream].push(part);
      sizes[stream] += part.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    let timedOut = false;
    let aborted = false;
    let released: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gruppen finns redan inte.
      }
      // En process som lämnat gruppen (setsid) kan hålla rören öppna; släpp dem så att vi inte hänger.
      released ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Även om huvudprocessen avslutats kan barnbarn leva kvar i gruppen.
      killGroup();
      clearTimeout(released);
      if (aborted && signal !== undefined) {
        reject(abortError(signal));
        return;
      }
      resolve({
        exitCode,
        exitSignal,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut,
      });
    });
  });
}
