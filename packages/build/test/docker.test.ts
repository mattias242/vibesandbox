/**
 * Drivrutinen `docker` på riktigt. Körs bara när VIBESANDBOX_DOCKER_TESTS=1 (kräver Docker):
 *
 *   VIBESANDBOX_DOCKER_TESTS=1 npx vitest run packages/build/test/docker.test.ts
 *
 * Avbilden byggs i beforeAll. Isoleringen prövas med en EGEN testmall vars vite.config.ts kör
 * fientlig kod vid bygget — den riktiga mallen kör ingen appkod, så där finns inget att pröva.
 * Vilken attack som körs styrs av en kommentar i appens App.tsx.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildResult, SourceFiles } from '@vibesandbox/contracts';
import { createBuildRunner, readTemplateKnowledge } from '../src/index.ts';
import { dockerRunArguments } from '../src/docker.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { TODO_APP } from './apps.ts';

const run = promisify(execFile);
const enabled = process.env['VIBESANDBOX_DOCKER_TESTS'] === '1';
const templateDirectory = fileURLToPath(new URL('../../app-template/', import.meta.url));
const repoRoot = path.resolve(templateDirectory, '../..');
const IMAGE = 'vibesandbox/build-worker:test';
const HOSTILE_IMAGE = 'vibesandbox/build-worker:test-fientlig';
const SLOW = 600_000;

/** Körs av Vite vid bygget i testavbilden. Rapporterar genom att kasta ett fel som blir en diagnos. */
const HOSTILE_CONFIG = `
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import { defineConfig } from 'vite';

const app = fs.readFileSync('src/App.tsx', 'utf8');
const attack = /ATTACK: (\\w+)/.exec(app)?.[1] ?? 'ingen';

async function natet() {
  const resultat = [];
  try { await dns.lookup('example.com'); resultat.push('DNS-NÅDD'); } catch (e) { resultat.push('DNS-STÄNGD:' + e.code); }
  await new Promise((done) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
    socket.on('connect', () => { resultat.push('TCP-NÅDD'); socket.destroy(); done(); });
    socket.on('error', (e) => { resultat.push('TCP-STÄNGD:' + e.code); done(); });
    socket.on('timeout', () => { resultat.push('TCP-STÄNGD:TIMEOUT'); socket.destroy(); done(); });
  });
  try { await fetch('http://1.1.1.1/'); resultat.push('FETCH-NÅDD'); } catch { resultat.push('FETCH-STÄNGD'); }
  return resultat.join(' ');
}

function skriva() {
  const resultat = [];
  for (const fil of ['/opt/vibesandbox/packages/app-template/index.html', '/opt/vibesandbox/x', '/etc/x', '/x', '/in/src/x', '/usr/local/bin/x', '/home/x']) {
    try { fs.writeFileSync(fil, 'x'); resultat.push('SKREV:' + fil); } catch (e) { resultat.push('NEKAD:' + fil + ':' + e.code); }
  }
  try { fs.writeFileSync('/work/ok', 'x'); resultat.push('WORK-OK'); } catch (e) { resultat.push('WORK-NEKAD:' + e.code); }
  return resultat.join(' ');
}

if (attack === 'nat') throw new Error('RAPPORT ' + (await natet()));
if (attack === 'skriv') throw new Error('RAPPORT ' + skriva());
if (attack === 'miljo') throw new Error('RAPPORT ' + Object.keys(process.env).sort().join(','));
if (attack === 'minne') {
  const hog = [];
  for (;;) hog.push(Buffer.alloc(64 * 1024 * 1024, 1));
}
if (attack === 'tid') { for (;;) {} }

export default defineConfig({ root: import.meta.dirname, publicDir: false, envDir: false, css: { postcss: { plugins: [] } } });
`;

function attack(name: string): SourceFiles {
  return { 'src/App.tsx': `// ATTACK: ${name}\nexport function App() {\n  return <p>hej</p>;\n}\n`, 'src/styles.css': '' };
}

function report(result: BuildResult): string {
  return result.diagnostics.map((d) => d.message).join('\n');
}

describe.skipIf(!enabled)('docker: engångscontainer per bygge', () => {
  let starterFiles: SourceFiles;
  let contextDirectory: string;
  const results: BuildResult[] = [];

  beforeAll(async () => {
    starterFiles = (await readTemplateKnowledge(templateDirectory)).starterFiles;
    const started = performance.now();
    await run('docker', ['build', '-q', '-f', 'images/build-worker/Dockerfile', '-t', IMAGE, '.'], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
    contextDirectory = await mkdtemp(path.join(tmpdir(), 'vibesandbox-fientlig-avbild-'));
    await writeFile(path.join(contextDirectory, 'vite.config.ts'), HOSTILE_CONFIG);
    await writeFile(
      path.join(contextDirectory, 'Dockerfile'),
      `FROM ${IMAGE}\nCOPY vite.config.ts /opt/vibesandbox/packages/app-template/vite.config.ts\n`,
    );
    await run('docker', ['build', '-q', '-t', HOSTILE_IMAGE, '.'], { cwd: contextDirectory });
    console.info(`[build/docker] avbilderna byggda på ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }, SLOW);

  afterAll(async () => {
    for (const result of results) await result.dispose();
    if (contextDirectory !== undefined) await rm(contextDirectory, { recursive: true, force: true });
  });

  function runner(image = IMAGE, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
    return createBuildRunner({ driver: 'docker', templateDirectory, image, limits });
  }

  it('startappen och en todo-app bygger grönt, och värden får en egen katalog med resultatet', async () => {
    for (const [name, files] of [['startapp', starterFiles], ['todo', TODO_APP]] as const) {
      const started = performance.now();
      const result = await runner().build(files);
      results.push(result);
      console.info(`[build/docker] ${name}: ${((performance.now() - started) / 1000).toFixed(2)} s`);
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      expect(await readdir(result.outputDirectory ?? '')).toEqual(expect.arrayContaining(['index.html', 'assets']));
    }
  }, SLOW);

  it('typfel ger en diagnos med fil och rad, utan containerns sökvägar', async () => {
    const result = await runner().build({ 'src/App.tsx': "export const App = () => { const a: number = 'x'; return null; };\n", 'src/styles.css': '' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ source: 'typecheck', file: 'src/App.tsx', line: 1 });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/\/work|\/opt\/vibesandbox/);
  }, SLOW);

  it('nätet går inte att nå under bygget: varken DNS, TCP eller fetch', async () => {
    const result = await runner(HOSTILE_IMAGE).build(attack('nat'));
    expect(result.ok).toBe(false);
    const text = report(result);
    expect(text).toContain('RAPPORT');
    expect(text).not.toMatch(/NÅDD/);
    expect(text).toMatch(/DNS-STÄNGD/);
    expect(text).toMatch(/TCP-STÄNGD/);
    expect(text).toMatch(/FETCH-STÄNGD/);
  }, SLOW);

  it('skrivning utanför /work nekas — mallen, systemet och /in är skrivskyddade', async () => {
    const result = await runner(HOSTILE_IMAGE).build(attack('skriv'));
    const text = report(result);
    expect(text).toContain('WORK-OK');
    expect(text).not.toContain('SKREV:');
    // Containerns sökvägar byts ut mot … i diagnoserna; mallens index.html står först i listan.
    expect(text).toMatch(/NEKAD:\S*index\.html:EROFS/);
    expect(text).toMatch(/NEKAD:\/in\/src\/x/);
  }, SLOW);

  it('containern får inga av värdens miljövariabler', async () => {
    process.env['VIBESANDBOX_HEMLIGHET'] = 'läcker';
    try {
      const text = report(await runner(HOSTILE_IMAGE).build(attack('miljo')));
      expect(text).toContain('RAPPORT');
      expect(text).not.toContain('VIBESANDBOX_HEMLIGHET');
    } finally {
      delete process.env['VIBESANDBOX_HEMLIGHET'];
    }
  }, SLOW);

  it('minnesgränsen håller', async () => {
    const result = await runner(HOSTILE_IMAGE, { memoryMb: 512 }).build(attack('minne'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('memory-limit');
  }, SLOW);

  it('tidsgränsen håller: containern dödas och finns inte kvar', async () => {
    const started = performance.now();
    const result = await runner(HOSTILE_IMAGE, { timeoutMs: 4000 }).build(attack('tid'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.rule)).toContain('timeout');
    expect(performance.now() - started).toBeLessThan(40_000);
    const { stdout } = await run('docker', ['ps', '-a', '--filter', `ancestor=${HOSTILE_IMAGE}`, '--format', '{{.Names}}']);
    expect(stdout.trim()).toBe('');
  }, SLOW);

  it('policybrott startar ingen container', async () => {
    const result = await runner('finns-inte/avbild:ingen').build({ ...starterFiles, 'src/lib/x.ts': "fetch('https://evil.example');\n" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.source).toBe('policy');
  });

  it('mallens låsta filer i avbilden är de i repot', async () => {
    const { stdout } = await run('docker', ['run', '--rm', '--network', 'none', IMAGE, 'cat', '/opt/vibesandbox/packages/app-template/vite.config.ts']);
    expect(stdout).toBe(await readFile(path.join(templateDirectory, 'vite.config.ts'), 'utf8'));
  }, SLOW);
});

describe('docker: kommandoraden', () => {
  it('har alla härdningsflaggor, och inga hemligheter i miljön', () => {
    process.env['VIBESANDBOX_HEMLIGHET'] = 'läcker';
    try {
      const args = dockerRunArguments({ name: 'n', image: 'i', runtime: 'runsc', limits: DEFAULT_LIMITS, inDirectory: '/a', outDirectory: '/b' });
      const line = args.join(' ');
      for (const flag of ['--rm', '--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 10001:10001', '--runtime runsc', '/a:/in:ro', '/b:/out:rw']) {
        expect(line).toContain(flag);
      }
      expect(line).toContain('--memory 1536m --memory-swap 1536m');
      expect(line).toContain('--cpus 1.5');
      expect(line).toMatch(/--pids-limit \d+/);
      expect(line).toMatch(/--tmpfs \/work:rw,size=\d+m,mode=1777/);
      expect(line).not.toContain('läcker');
      expect(args.filter((arg) => /^[A-Z_]+=/.test(arg)).every((arg) => arg.startsWith('BUILD_'))).toBe(true);
      expect(args.at(-1)).toBe('i');
    } finally {
      delete process.env['VIBESANDBOX_HEMLIGHET'];
    }
  });

  it('utan runsc väljs ingen runtime', () => {
    expect(dockerRunArguments({ name: 'n', image: 'i', runtime: 'runc', limits: DEFAULT_LIMITS, inDirectory: '/a', outDirectory: '/b' })).not.toContain('--runtime');
  });
});
