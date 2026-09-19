import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/process.ts';

const node = process.execPath;

describe('runProcess: barnprocess med argumentlista, minimal miljö, tidsgräns och avbrott', () => {
  it('fångar utdata och slutkod', async () => {
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.stdout.write("ut"); process.stderr.write("fel"); process.exit(3)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'ut', stderr: 'fel', timedOut: false });
  });

  it('ärver INTE föräldrans miljö — bara det som skickas med', async () => {
    process.env['VIBESANDBOX_HEMLIGHET'] = 'läcker';
    try {
      const result = await runProcess({
        command: node,
        args: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
        cwd: process.cwd(),
        env: { NAMN: 'x' },
        timeoutMs: 10_000,
      });
      const keys = JSON.parse(result.stdout) as string[];
      expect(keys).not.toContain('VIBESANDBOX_HEMLIGHET');
      expect(keys).toContain('NAMN');
    } finally {
      delete process.env['VIBESANDBOX_HEMLIGHET'];
    }
  });

  it('argument tolkas aldrig av ett skal', async () => {
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.stdout.write(process.argv[1])', '$(echo injicerat); `id`'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
    });
    expect(result.stdout).toBe('$(echo injicerat); `id`');
  });

  it('dödar processen — och dess barn — vid tidsgränsen', async () => {
    const started = performance.now();
    const result = await runProcess({
      command: node,
      args: ['-e', 'require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('dödar processen vid avbrott och avvisar med signalens skäl', async () => {
    const controller = new AbortController();
    const run = runProcess({
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('kapar utdata vid taket i stället för att fylla minnet', async () => {
    const result = await runProcess({
      command: node,
      args: ['-e', 'process.stdout.write("x".repeat(5_000_000))'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });
});
