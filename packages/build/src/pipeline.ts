/**
 * Själva bygget i en arbetskatalog: typkontroll → Vite → tak på utdatan → kontroll av det byggda.
 * Samma kod körs av `local` (i plattformsprocessen, bara i utveckling), inne i containern
 * (`docker`) och av byggarbetaren (`spool`). Policykontrollen av källfilerna görs av anroparen
 * FÖRE detta, så att inget startas för kod som bryter mot reglerna.
 *
 * Varför det här inte kör appens kod: mallens vite.config.ts är låst och läser bara `src/`.
 * Appens kod transformeras (TypeScript → JavaScript) och buntas, men KÖRS inte vid bygget. Det
 * som körs är mallens konfiguration och de pinnade verktygen. Sandlådan (container/arbetare)
 * finns för det fall att det antagandet brister — t.ex. en sårbarhet i en transformation.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Diagnostic, SourceFiles } from '@vibesandbox/contracts';
import { checkBuiltBundle } from '@vibesandbox/policy';
import { capDiagnostics, parseTscOutput, parseViteOutput } from './diagnostics.ts';
import type { PathRoots } from './diagnostics.ts';
import type { BuildLimits } from './limits.ts';
import { measureTree } from './output.ts';
import { runProcess } from './process.ts';
import { prepareWorkspace } from './workspace.ts';

export interface WorkspaceBuildOptions {
  readonly templateDirectory: string;
  readonly files: SourceFiles;
  /** Tom katalog som anroparen äger och städar. Arbetskatalogen blir `<baseDir>/app`. */
  readonly baseDir: string;
  readonly limits: BuildLimits;
  readonly signal?: AbortSignal;
}

export interface WorkspaceBuildResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Den byggda katalogen (inuti `baseDir`) när bygget lyckades. */
  readonly distDirectory?: string;
}

export function timeoutDiagnostic(timeoutMs: number): Diagnostic {
  return {
    source: 'build',
    rule: 'timeout',
    message: `Bygget tog längre tid än ${Math.round(timeoutMs / 1000)} sekunder och avbröts. Förenkla appen eller dela upp stora filer.`,
  };
}

export function outputTooLargeDiagnostic(bytes: number, maxBytes: number): Diagnostic {
  return {
    source: 'build',
    rule: 'output-too-large',
    message: `Den byggda appen blev ${Math.ceil(bytes / 1024)} kB; högst ${Math.floor(maxBytes / 1024)} kB är tillåtet. Lägg inte stora datamängder i koden — spara dem med db.collection(...).`,
  };
}

/** Miljön för tsc och Vite: bara det verktygen behöver. Inga av plattformens variabler. */
export function buildEnvironment(workDir: string, tmpDir: string): Record<string, string> {
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: workDir,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

async function withRealpaths(paths: readonly string[]): Promise<string[]> {
  const all = new Set<string>();
  for (const candidate of paths) {
    all.add(candidate);
    try {
      all.add(await realpath(candidate));
    } catch {
      // Finns inte (längre) — den oupplösta formen räcker.
    }
  }
  return [...all];
}

async function pathRoots(workDir: string, baseDir: string, templateDirectory: string): Promise<PathRoots> {
  const template = path.resolve(templateDirectory);
  const ancestors: string[] = [];
  for (let dir = template; path.dirname(dir) !== dir; dir = path.dirname(dir)) ancestors.push(dir);
  return {
    work: await withRealpaths([workDir]),
    other: await withRealpaths([baseDir, ...ancestors.slice(0, 3), tmpdir(), homedir()]),
  };
}

export async function buildInWorkspace(options: WorkspaceBuildOptions): Promise<WorkspaceBuildResult> {
  const { limits, signal } = options;
  const deadline = performance.now() + limits.timeoutMs;
  const remaining = (): number => Math.max(1, deadline - performance.now());

  const workDir = path.join(options.baseDir, 'app');
  const tmpDir = path.join(options.baseDir, 'tmp');
  await mkdir(tmpDir);
  await prepareWorkspace({ templateDirectory: options.templateDirectory, workDir, files: options.files });
  const roots = await pathRoots(workDir, options.baseDir, options.templateDirectory);
  const env = buildEnvironment(workDir, tmpDir);
  const modules = path.join(workDir, 'node_modules');

  const tsc = await runProcess({
    command: process.execPath,
    args: [path.join(modules, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'],
    cwd: workDir,
    env,
    timeoutMs: remaining(),
    ...(signal === undefined ? {} : { signal }),
  });
  if (tsc.timedOut) return { diagnostics: [timeoutDiagnostic(limits.timeoutMs)] };
  if (tsc.exitCode !== 0) return { diagnostics: capDiagnostics(parseTscOutput(`${tsc.stdout}\n${tsc.stderr}`, roots)) };

  const vite = await runProcess({
    command: process.execPath,
    args: [`--max-old-space-size=${Math.max(128, Math.floor(limits.memoryMb * 0.75))}`, path.join(modules, 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.ts'],
    cwd: workDir,
    env,
    timeoutMs: remaining(),
    ...(signal === undefined ? {} : { signal }),
  });
  if (vite.timedOut) return { diagnostics: [timeoutDiagnostic(limits.timeoutMs)] };
  if (vite.exitCode !== 0) return { diagnostics: capDiagnostics(parseViteOutput(`${vite.stdout}\n${vite.stderr}`, roots)) };

  const distDirectory = path.join(workDir, 'dist');
  const size = await measureTree(distDirectory);
  if (size.rejected.length > 0) {
    return { diagnostics: [{ source: 'build', rule: 'output-invalid', message: 'Bygget gav något annat än vanliga filer. Det är inte tillåtet.' }] };
  }
  if (size.bytes > limits.maxOutputBytes) return { diagnostics: [outputTooLargeDiagnostic(size.bytes, limits.maxOutputBytes)] };

  const bundle = await checkBuiltBundle(distDirectory);
  if (bundle.length > 0) return { diagnostics: capDiagnostics(bundle) };
  return { diagnostics: [], distDirectory };
}
