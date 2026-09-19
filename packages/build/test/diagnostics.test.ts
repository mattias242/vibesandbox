/**
 * Tolkning av tsc:s och Vites utdata till diagnoser. Exemplen är verklig utdata (TypeScript 7,
 * Vite 8/rolldown) med värdens sökvägar utbytta mot testets.
 */
import { describe, expect, it } from 'vitest';
import { capDiagnostics, parseTscOutput, parseViteOutput, scrubPaths } from '../src/diagnostics.ts';

const WORK = '/tmp/vibesandbox-bygge-abc123/app';
const ROOTS = { work: [WORK], other: ['/Users/någon/repo'] };

describe('tsc-utdata', () => {
  it('ger fil, rad och meddelande', () => {
    const diagnostics = parseTscOutput(
      "src/App.tsx(2,9): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/lib/x.ts(10,1): error TS1005: '>' expected.\n",
      ROOTS,
    );
    expect(diagnostics).toEqual([
      { source: 'typecheck', file: 'src/App.tsx', line: 2, message: "Type 'string' is not assignable to type 'number'. (TS2322)" },
      { source: 'typecheck', file: 'src/lib/x.ts', line: 10, message: "'>' expected. (TS1005)" },
    ]);
  });

  it('tar med fortsättningsrader i samma meddelande', () => {
    const [diagnostic] = parseTscOutput(
      "src/App.tsx(3,5): error TS2345: Argument of type '{ a: number; }' is not assignable to parameter of type 'Bok'.\n  Property 'titel' is missing in type '{ a: number; }' but required in type 'Bok'.\n",
      ROOTS,
    );
    expect(diagnostic?.message).toContain("Property 'titel' is missing");
  });

  it('byter ut värdens absoluta sökvägar', () => {
    const [diagnostic] = parseTscOutput(
      `/Users/någon/repo/node_modules/@types/react/index.d.ts(1,1): error TS2300: Duplicate identifier; see ${WORK}/src/App.tsx.\n`,
      ROOTS,
    );
    expect(JSON.stringify(diagnostic)).not.toContain('/Users/någon');
    expect(JSON.stringify(diagnostic)).not.toContain(WORK);
    expect(diagnostic?.message).toContain('src/App.tsx');
  });

  it('ger en allmän diagnos om utdatan inte gick att tolka', () => {
    const diagnostics = parseTscOutput('error TS5058: The specified path does not exist.\n', ROOTS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.source).toBe('typecheck');
    expect(diagnostics[0]?.message).toContain('TS5058');
  });
});

describe('Vite-utdata', () => {
  it('syntaxfel ur rolldown: fil, rad och meddelande utan färgkoder och stackspår', () => {
    const output = [
      'vite v8.2.2 building client environment for production...',
      'transforming...',
      '✗ Build failed in 694ms',
      'error during build:',
      'Build failed with 1 error:',
      '',
      '\u001b[31m[builtin:vite-transform] \u001b[0mExpected `>` but found `}`',
      '   \u001b[38;5;246m╭\u001b[0m─[ src/App.tsx:4:1 ]',
      '   │',
      ' 4 │ }',
      '   │ ┬  ',
      '   │ ╰── `>` expected',
      '───╯',
      '',
      `    at aggregateBindingErrorsIntoJsError (file://${ROOTS.other[0]}/node_modules/rolldown/dist/shared/error.mjs:48:18)`,
      '    at async CAC.<anonymous> (file:///x/cli.js:776:3) {',
      '  errors: [Getter/Setter]',
      '}',
    ].join('\n');
    const [diagnostic, ...rest] = parseViteOutput(output, ROOTS);
    expect(rest).toEqual([]);
    expect(diagnostic).toMatchObject({ source: 'build', file: 'src/App.tsx', line: 4 });
    expect(diagnostic?.message).toContain('Expected `>` but found `}`');
    expect(diagnostic?.message).not.toMatch(/\u001b|\bat aggregate|node_modules/);
  });

  it('import som inte går att lösa upp: absolut sökväg bortbytt', () => {
    const output = `error during build:\nBuild failed with 1 error:\n\nError: [vite]: Rolldown failed to resolve import "lodash" from "${WORK}/src/App.tsx".\nThis is most likely unintended because it can break your application at runtime.\n    at viteLog (file:///x/node.js:1:1)\n`;
    const [diagnostic] = parseViteOutput(output, ROOTS);
    expect(diagnostic).toMatchObject({ source: 'build', file: 'src/App.tsx' });
    expect(diagnostic?.message).toContain('"lodash"');
    expect(diagnostic?.message).not.toContain(WORK);
  });

  it('okänd utdata ger ändå en diagnos, med värdens sökvägar bortbytta', () => {
    const [diagnostic] = parseViteOutput(`något oväntat i ${WORK}/vite.config.ts`, ROOTS);
    expect(diagnostic?.source).toBe('build');
    expect(diagnostic?.message).not.toContain(WORK);
  });
});

describe('tak och städning', () => {
  it('högst 20 diagnoser, och varje meddelande trimmat', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ source: 'typecheck' as const, message: `${'x'.repeat(2000)} ${i}` }));
    const capped = capDiagnostics(many);
    expect(capped.length).toBeLessThanOrEqual(21);
    expect(capped.every((d) => d.message.length <= 600)).toBe(true);
    expect(capped[capped.length - 1]?.message).toMatch(/30 fler/);
  });

  it('scrubPaths byter även ut file://-adresser och tar längsta roten först', () => {
    expect(scrubPaths(`file://${WORK}/src/a.ts och ${WORK}/src/b.ts och /Users/någon/repo/x`, ROOTS)).toBe('src/a.ts och src/b.ts och …/x');
  });
});
