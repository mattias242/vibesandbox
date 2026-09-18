/** Gemensamt stöd för agentens tester: fejkad byggkedja och svar i protokollets format. */

import type { BuildResult, BuildRunner, Diagnostic, SourceFiles } from '@vibesandbox/contracts';

export interface FakeBuild {
  readonly ok: boolean;
  readonly diagnostics?: readonly Diagnostic[];
  /** Hänger tills signalen avbryts. */
  readonly hang?: boolean;
}

export interface FakeRunner extends BuildRunner {
  readonly builds: SourceFiles[];
  readonly results: Array<BuildResult & { disposed: boolean }>;
}

export function fakeRunner(script: readonly FakeBuild[]): FakeRunner {
  const queue = [...script];
  const builds: SourceFiles[] = [];
  const results: Array<BuildResult & { disposed: boolean }> = [];
  return {
    builds,
    results,
    async build(files, options) {
      builds.push({ ...files });
      const next = queue.shift();
      if (next === undefined) throw new Error('inga fler byggen i manuset');
      if (next.hang === true) {
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
      const result: BuildResult & { disposed: boolean } = {
        ok: next.ok,
        diagnostics: next.diagnostics ?? [],
        durationMs: 5,
        disposed: false,
        async dispose() {
          result.disposed = true;
        },
        ...(next.ok ? { outputDirectory: '/tmp/bygge-123' } : {}),
      };
      results.push(result);
      return result;
    },
  };
}

export function reply(summary: string, files: Readonly<Record<string, string>>): string {
  const blocks = Object.entries(files).map(([path, content]) => `<vs-file path="${path}">\n${content}\n</vs-file>`);
  return `${summary}\n\n${blocks.join('\n')}\n<vs-done/>\n`;
}

export const STARTER: SourceFiles = {
  'src/App.tsx': 'export function App() {\n  return <main><h1>Ny app</h1></main>;\n}',
  'src/styles.css': 'main { padding: 1rem; }',
};

export const KNOWLEDGE = {
  sdkReference: '# @vibesandbox/sdk\n\nSDK-REFERENS-MARKÖR: db.collection<T>(name)',
  exampleFiles: {
    'src/App.tsx': "// EXEMPELAPP-MARKÖR\nexport function App() {\n  return <main>Bokningar</main>;\n}",
    'src/styles.css': 'main { max-width: 40rem; }',
  },
  starterFiles: STARTER,
};
