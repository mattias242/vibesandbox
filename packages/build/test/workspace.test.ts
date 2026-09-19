/**
 * Arbetskatalogen: mallens låsta filer skrivs FÖRST och appens därefter, och en appfil kan
 * aldrig skriva över en mallfil — inte ens om policyn skulle ha släppt igenom den.
 */
import { lstat, mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareWorkspace, TEMPLATE_FILES } from '../src/workspace.ts';

const templateDirectory = fileURLToPath(new URL('../../app-template/', import.meta.url));

let base: string;
let workDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibesandbox-arbetskatalog-'));
  workDir = path.join(base, 'app');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('prepareWorkspace', () => {
  it('skriver mallens filer och appens filer', async () => {
    await prepareWorkspace({ templateDirectory, workDir, files: { 'src/App.tsx': 'export const App = () => null;\n', 'src/lib/x.ts': 'export {};\n' } });
    for (const file of TEMPLATE_FILES) {
      expect(await readFile(path.join(workDir, file), 'utf8')).toBe(await readFile(path.join(templateDirectory, file), 'utf8'));
    }
    expect(await readFile(path.join(workDir, 'src/lib/x.ts'), 'utf8')).toBe('export {};\n');
  });

  it('mallens filer är vite.config.ts, tsconfig.json, index.html, package.json och src/main.tsx', () => {
    expect([...TEMPLATE_FILES].sort()).toEqual(['index.html', 'package.json', 'src/main.tsx', 'tsconfig.json', 'vite.config.ts']);
  });

  it('länkar mallens beroenden i stället för att kopiera dem', async () => {
    await prepareWorkspace({ templateDirectory, workDir, files: {} });
    for (const name of ['vite', 'react', 'typescript', '@vibesandbox/sdk', '@types/react', '@vitejs/plugin-react']) {
      const entry = path.join(workDir, 'node_modules', name);
      expect((await lstat(entry)).isSymbolicLink(), name).toBe(true);
      expect((await stat(entry)).isDirectory(), name).toBe(true);
    }
    // Mallens EGEN, pinnade Vite vinner över den som ligger längre upp.
    expect(await readlink(path.join(workDir, 'node_modules', 'vite'))).toBe(path.join(templateDirectory, 'node_modules', 'vite'));
  });

  it.each(['src/main.tsx', 'vite.config.ts', 'tsconfig.json', 'src/tsconfig.json', '../utanför.ts', 'src/../../x.ts', 'node_modules/vite/index.js'])(
    'vägrar skriva %s även om policyn skulle ha missat den',
    async (file) => {
      await expect(prepareWorkspace({ templateDirectory, workDir, files: { [file]: 'x' } })).rejects.toThrow();
      await expect(stat(path.join(base, 'utanför.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (TEMPLATE_FILES.includes(file)) {
        expect(await readFile(path.join(workDir, file), 'utf8')).toBe(await readFile(path.join(templateDirectory, file), 'utf8'));
      }
    },
  );
});
