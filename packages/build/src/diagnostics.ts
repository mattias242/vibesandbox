/**
 * tsc:s och Vites utdata → diagnoser som matas tillbaka till modellen. Korta, med fil och rad
 * när det går, och utan värdens absoluta sökvägar (de röjer serverns katalogstruktur och hjälper
 * inte modellen).
 */
import type { Diagnostic } from '@vibesandbox/contracts';

export interface PathRoots {
  /** Arbetskatalogen: `<rot>/src/App.tsx` blir `src/App.tsx`. */
  readonly work: readonly string[];
  /** Övriga kataloger på värden (mallen, repot, temp): `<rot>/x` blir `…/x`. */
  readonly other: readonly string[];
}

export const MAX_DIAGNOSTICS = 20;
const MAX_MESSAGE_CHARS = 500;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubPaths(text: string, roots: PathRoots): string {
  const all = [
    ...roots.work.map((root) => ({ root, replacement: '' })),
    ...roots.other.map((root) => ({ root, replacement: '…/' })),
  ]
    .filter(({ root }) => root.length > 1)
    .sort((a, b) => b.root.length - a.root.length);
  let result = text;
  for (const { root, replacement } of all) {
    const trimmed = root.replace(/\/+$/, '');
    result = result.replace(new RegExp(`(?:file://)?${escapeRegExp(trimmed)}(?:/|(?![\\w.-]))`, 'g'), replacement);
  }
  return result;
}

function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '');
}

function trimMessage(message: string): string {
  const compact = message.trim().replace(/\n{3,}/g, '\n\n');
  return compact.length > MAX_MESSAGE_CHARS ? `${compact.slice(0, MAX_MESSAGE_CHARS)} …` : compact;
}

function located(file: string | undefined): string | undefined {
  return file !== undefined && /^src\/[A-Za-z0-9_/.-]+$/.test(file) ? file : undefined;
}

/** `src/App.tsx(2,9): error TS2322: …` med indenterade fortsättningsrader. */
export function parseTscOutput(output: string, roots: PathRoots): Diagnostic[] {
  const text = scrubPaths(clean(output), roots);
  const diagnostics: Diagnostic[] = [];
  let current: { file?: string; line?: number; message: string } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const file = located(current.file);
    diagnostics.push({
      source: 'typecheck',
      ...(file === undefined ? {} : { file }),
      ...(file === undefined || current.line === undefined ? {} : { line: current.line }),
      message: trimMessage(file === undefined && current.file !== undefined ? `${current.file}: ${current.message}` : current.message),
    });
    current = undefined;
  };

  for (const line of text.split('\n')) {
    const located = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    const general = /^error (TS\d+): (.*)$/.exec(line);
    if (located !== null) {
      flush();
      current = { file: located[1] ?? '', line: Number(located[2]), message: `${located[5] ?? ''} (${located[4] ?? ''})` };
    } else if (general !== null) {
      flush();
      current = { message: `${general[2] ?? ''} (${general[1] ?? ''})` };
    } else if (current !== undefined && /^\s+\S/.test(line)) {
      current.message = `${current.message}\n${line.trim()}`;
    }
  }
  flush();

  if (diagnostics.length === 0 && text.trim() !== '') {
    diagnostics.push({ source: 'typecheck', message: trimMessage(text.trim().split('\n').slice(0, 10).join('\n')) });
  }
  return diagnostics;
}

/** Vites/rolldowns fel: blocket efter "error during build:", utan stackspår. */
export function parseViteOutput(output: string, roots: PathRoots): Diagnostic[] {
  const text = scrubPaths(clean(output), roots);
  const marker = text.indexOf('error during build:');
  let block = marker >= 0 ? text.slice(marker + 'error during build:'.length) : text;
  const stack = block.search(/^\s+at\s/m);
  if (stack >= 0) block = block.slice(0, stack);
  block = block
    .split('\n')
    .filter((line) => !/^Build failed with \d+ errors?:?$/.test(line.trim()))
    .join('\n')
    .replace(/^Error: /m, '')
    .trim();
  if (block === '') block = 'Bygget misslyckades utan att tala om varför.';

  const where = /(src\/[A-Za-z0-9_/.-]+\.(?:tsx|ts|css))(?::(\d+))?/.exec(block);
  const file = located(where?.[1]);
  const line = where?.[2] === undefined ? undefined : Number(where[2]);
  return [
    {
      source: 'build',
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      message: trimMessage(block),
    },
  ];
}

/** Högst MAX_DIAGNOSTICS, plus en rad om hur många som utelämnades. */
export function capDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const kept = diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) => ({ ...diagnostic, message: trimMessage(diagnostic.message) }));
  const omitted = diagnostics.length - kept.length;
  if (omitted > 0) {
    kept.push({ source: kept[kept.length - 1]?.source ?? 'build', message: `… och ${omitted} fler fel. Rätta de första så visas resten.` });
  }
  return kept;
}
