/**
 * Drivrutinen `spool`: plattformen lämnar byggjobb i en delad katalog och en separat byggarbetare
 * (egen container utan nät och utan hemligheter) bygger dem. Här körs båda sidorna i samma
 * testprocess mot en temporär katalog.
 */
import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuildResult, SourceFiles } from '@vibesandbox/contracts';
import { createBuildRunner, createSpoolBuildRunner, readTemplateKnowledge, runSpoolWorker } from '../src/index.ts';
import { TYPE_ERROR_APP } from './apps.ts';

const templateDirectory = fileURLToPath(new URL('../../app-template/', import.meta.url));
const SLOW = 120_000;

let jobsDirectory: string;
let starterFiles: SourceFiles;
let worker: { stop: () => Promise<void> } | undefined;
const results: BuildResult[] = [];

beforeAll(async () => {
  starterFiles = (await readTemplateKnowledge(templateDirectory)).starterFiles;
});

beforeEach(async () => {
  jobsDirectory = await mkdtemp(path.join(tmpdir(), 'vibesandbox-jobb-'));
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  for (const result of results.splice(0)) await result.dispose();
  await rm(jobsDirectory, { recursive: true, force: true });
});

function startWorker(options: { maxJobAgeMs?: number; beforePublish?: (id: string) => Promise<void> } = {}): { stop: () => Promise<void>; done: Promise<void> } {
  const controller = new AbortController();
  const done = runSpoolWorker({ jobsDirectory, templateDirectory, signal: controller.signal, pollIntervalMs: 20, ...options });
  const handle = {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
  worker = handle;
  return handle;
}

function runner(timeoutMs = 60_000) {
  return createSpoolBuildRunner({ jobsDirectory, timeoutMs, pollIntervalMs: 20 });
}

async function build(files: SourceFiles, timeoutMs?: number, signal?: AbortSignal): Promise<BuildResult> {
  const result = await runner(timeoutMs).build(files, signal === undefined ? {} : { signal });
  results.push(result);
  return result;
}

async function entries(sub: string): Promise<string[]> {
  try {
    return await readdir(path.join(jobsDirectory, sub));
  } catch {
    return [];
  }
}

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const stop = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > stop) throw new Error('Villkoret uppfylldes aldrig.');
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('spool: plattform och byggarbetare', () => {
  it('bygger startappen; resultatet kopieras till en katalog som bara plattformen äger, och jobbet städas', async () => {
    startWorker();
    const started = performance.now();
    const result = await build(starterFiles);
    console.info(`[build/spool] startappen: ${((performance.now() - started) / 1000).toFixed(2)} s`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const directory = result.outputDirectory ?? '';
    expect(directory.startsWith(jobsDirectory)).toBe(false);
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['index.html', 'assets']));
    for (const sub of ['incoming', 'running', 'done', 'tmp']) expect(await entries(sub), sub).toEqual([]);
  }, SLOW);

  it('arbetaren får köras med NODE_ENV=production — den ÄR sandlådan', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => createBuildRunner({ driver: 'local', templateDirectory })).toThrow(/production/);
      startWorker();
      const result = await build(starterFiles);
      expect(result.ok).toBe(true);
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  }, SLOW);

  it('typfel kommer tillbaka som diagnoser med fil och rad', async () => {
    startWorker();
    const result = await build(TYPE_ERROR_APP);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ source: 'typecheck', file: 'src/App.tsx', line: 2 });
  }, SLOW);

  it('policybrott lämnas aldrig till arbetaren', async () => {
    const result = await build({ ...starterFiles, 'src/lib/x.ts': "fetch('https://evil.example');\n" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.source).toBe('policy');
    expect(await entries('incoming')).toEqual([]);
    expect(await entries('tmp')).toEqual([]);
  });

  it('ett jobb som lämnats innan arbetaren startat byggs när den startar', async () => {
    const pending = build(starterFiles);
    await until(async () => (await entries('incoming')).length === 1);
    startWorker();
    expect((await pending).ok).toBe(true);
  }, SLOW);

  it('kö: flera jobb byggs ett i taget och alla blir klara', async () => {
    startWorker();
    const shared = runner();
    const all = await Promise.all([shared.build(starterFiles), shared.build(TYPE_ERROR_APP), shared.build(starterFiles)]);
    results.push(...all);
    expect(all.map((r) => r.ok)).toEqual([true, false, true]);
  }, SLOW);

  it('utan arbetare: tidsgränsen ger en diagnos, och jobbet tas tillbaka', async () => {
    const result = await build(starterFiles, 300);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('timeout');
    expect(await entries('incoming')).toEqual([]);
  });

  it('avbrott medan jobbet väntar: avvisas med AbortError, och jobbet tas tillbaka', async () => {
    const controller = new AbortController();
    const pending = runner().build(starterFiles, { signal: controller.signal });
    await until(async () => (await entries('incoming')).length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await entries('incoming')).toEqual([]);
  });

  it('tidsgräns medan arbetaren bygger: jobbet avbryts, och arbetaren tar nästa', async () => {
    startWorker();
    const first = await build(starterFiles, 150);
    expect(first.diagnostics.map((d) => d.rule)).toContain('timeout');
    const second = await build(starterFiles);
    expect(second.ok).toBe(true);
    await until(async () => (await entries('done')).length === 0 && (await entries('cancel')).length === 0);
  }, SLOW);

  it('plattformen ger upp precis när arbetaren publicerar: inget övergivet resultat blir kvar', async () => {
    // Kapplöpningen: arbetaren kontrollerar avbrott, plattformen ger upp (skriver cancel/ och städar
    // done/, som ännu inte finns) och slutar vänta, arbetaren flyttar sedan sitt resultat på plats.
    // Utan åtgärd blev resultatet liggande tills städningen efter tio minuter. Ingen plattform väntar
    // här — jobbet läggs direkt i katalogen, precis som en plattform som redan har gått vidare.
    const id = `${Date.now()}-${'0123456789abcdef'}`;
    const job = { version: 1, id, deadline: Date.now() + 60_000, files: starterFiles };
    await mkdir(path.join(jobsDirectory, 'tmp'), { recursive: true });
    await mkdir(path.join(jobsDirectory, 'incoming'), { recursive: true });
    await writeFile(path.join(jobsDirectory, 'tmp', `${id}.json`), JSON.stringify(job));
    await rename(path.join(jobsDirectory, 'tmp', `${id}.json`), path.join(jobsDirectory, 'incoming', `${id}.json`));
    let publicerat = false;
    const handle = startWorker({
      beforePublish: async (publishId) => {
        await writeFile(path.join(jobsDirectory, 'cancel', publishId), '');
        publicerat = true;
      },
    });
    await until(async () => publicerat && (await entries('running')).length === 0);
    expect(await entries('done')).toEqual([]);
    await handle.stop();
  }, SLOW);

  it('arbetaren slutar när signalen avbryts', async () => {
    const handle = startWorker();
    await handle.stop();
    await expect(handle.done).resolves.toBeUndefined();
  });
});

describe('spool: plattformen litar inte på arbetaren', () => {
  /** En falsk arbetare: tar första jobbet och lämnar det resultat testet vill. */
  async function fakeWorker(write: (resultDirectory: string) => Promise<void>): Promise<void> {
    await until(async () => (await entries('incoming')).length === 1);
    const [job = ''] = await entries('incoming');
    const id = job.replace(/\.json$/, '');
    const staging = path.join(jobsDirectory, 'tmp', `falsk-${id}`);
    await mkdir(staging, { recursive: true });
    await write(staging);
    await mkdir(path.join(jobsDirectory, 'done'), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rm(path.join(jobsDirectory, 'incoming', job));
    await rename(staging, path.join(jobsDirectory, 'done', id));
  }

  async function okWithDist(directory: string, extra: (dist: string) => Promise<void>): Promise<void> {
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: true, diagnostics: [] }));
    const dist = path.join(directory, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="./assets/a.js"></script>');
    await writeFile(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
    await extra(dist);
  }

  it('en symbolisk länk i resultatet nekas och följs aldrig', async () => {
    const pending = build(starterFiles);
    await fakeWorker((directory) => okWithDist(directory, (dist) => symlink('/etc/hosts', path.join(dist, 'assets', 'b.js'))));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('output-invalid');
  });

  it('ett resultat som inte går att tolka ger ett allmänt fel', async () => {
    const pending = build(starterFiles);
    await fakeWorker((directory) => writeFile(path.join(directory, 'result.json'), '{inte json'));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('build-failed');
  });

  it('det byggda granskas av plattformen själv (checkBuiltBundle)', async () => {
    const pending = build(starterFiles);
    await fakeWorker((directory) => okWithDist(directory, (dist) => writeFile(path.join(dist, 'assets', 'a.js'), 'fetch("https://evil.example")')));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('bundle-external-url');
  });

  it('diagnoser från arbetaren tvättas: bara väntade fält, ingen påhittad källa', async () => {
    const pending = build(starterFiles);
    await fakeWorker((directory) =>
      writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify({ ok: false, diagnostics: [{ source: 'policy', rule: 'x', file: '/etc/passwd', line: -1, message: 'm', extra: 1 }, { source: 'annat', message: 'n' }] }),
      ),
    );
    const result = await pending;
    expect(result.diagnostics).toEqual([{ source: 'policy', rule: 'x', message: 'm' }]);
  });
});

describe('spool: arbetaren städar', () => {
  it('tar bort gamla resultat, gamla tillfälliga filer och jobb med ogiltiga namn eller innehåll', async () => {
    for (const sub of ['done/gammalt', 'tmp/gammalt']) await mkdir(path.join(jobsDirectory, sub), { recursive: true });
    await mkdir(path.join(jobsDirectory, 'incoming'), { recursive: true });
    await writeFile(path.join(jobsDirectory, 'incoming', 'utanför.json'), 'x');
    await writeFile(path.join(jobsDirectory, 'incoming', '0000000000001-0123456789abcdef.json'), '{inte json');
    const old = new Date(Date.now() - 3_600_000);
    for (const sub of ['done/gammalt', 'tmp/gammalt']) await utimes(path.join(jobsDirectory, sub), old, old);

    startWorker({ maxJobAgeMs: 60_000 });
    await until(async () => (await entries('done')).length <= 1 && (await entries('tmp')).length === 0 && (await entries('incoming')).length === 0);
    expect(await entries('done')).not.toContain('gammalt');
  });
});
