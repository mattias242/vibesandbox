import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_ID_PATTERN, isAppId } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import { runCli } from '../src/kommandon.ts';

describe('CLI för lokal utveckling', () => {
  let dataDir: string;
  let bygge: string;
  let ut: string[];
  let fel: string[];

  const kor = (...argv: string[]): Promise<number> =>
    runCli(argv, { DATA_DIR: dataDir }, { out: (rad) => ut.push(rad), err: (rad) => fel.push(rad) });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-cli-'));
    bygge = await mkdtemp(join(tmpdir(), 'vibesandbox-bygge-'));
    await writeFile(join(bygge, 'index.html'), '<!doctype html><title>App</title>');
    ut = [];
    fel = [];
  });

  afterEach(async () => {
    await rm(bygge, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('skapa-app skriver ut ENBART det nya app-id:t, så att det går att fånga i ett skript', async () => {
    expect(await kor('skapa-app')).toBe(0);

    expect(ut).toHaveLength(1);
    expect(ut[0]).toMatch(APP_ID_PATTERN);
    expect(fel).toEqual([]);
  });

  it('publicera och satt-utkast gör appen nåbar, och lista visar läget', async () => {
    await kor('skapa-app');
    const appId = ut[0] ?? '';

    expect(await kor('publicera', appId, bygge)).toBe(0);
    expect(await kor('satt-utkast', appId, bygge)).toBe(0);

    const control = createControl({ dataDir });
    try {
      if (!isAppId(appId)) throw new Error('inget app-id');
      expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: true });
    } finally {
      await control.close();
    }

    ut = [];
    expect(await kor('lista')).toBe(0);
    expect(ut.join('\n')).toContain(appId);
    expect(ut.join('\n')).toMatch(/publicerad/);
    expect(ut.join('\n')).toMatch(/utkast/);
  });

  it('lista i en tom datakatalog säger att inga appar finns', async () => {
    expect(await kor('lista')).toBe(0);
    expect(ut.join('\n')).toMatch(/inga appar/i);
  });

  it('ett avvisat bygge ger felkod och ett begripligt meddelande — och appen är orörd', async () => {
    await kor('skapa-app');
    const appId = ut[0] ?? '';
    await writeFile(join(bygge, 'skript.php'), 'x');

    expect(await kor('publicera', appId, bygge)).toBe(1);

    expect(fel.join('\n')).toContain('skript.php');
    const control = createControl({ dataDir });
    try {
      if (!isAppId(appId)) throw new Error('inget app-id');
      expect(await control.registry.find(appId)).toEqual({ appId, published: false, draft: false });
    } finally {
      await control.close();
    }
  });

  it.each([
    [['publicera']],
    [['publicera', 'inte-ett-app-id', '/tmp']],
    [['publicera', '0123456789abcdefghjkmnpqrs']],
    [['satt-utkast', '0123456789abcdefghjkmnpqrs']],
    [['okant-kommando']],
    [[]],
  ])('felaktig användning %j ger felkod 2 och hjälptexten', async (argv) => {
    expect(await kor(...argv)).toBe(2);
    expect(fel.join('\n')).toMatch(/skapa-app/);
    expect(fel.join('\n')).toMatch(/publicera <appId> <katalog>/);
  });

  it('en app som inte finns ger felkod 1', async () => {
    expect(await kor('publicera', '0123456789abcdefghjkmnpqrs', bygge)).toBe(1);
    expect(fel.join('\n')).toMatch(/finns inte/);
  });

  it('vägrar köra utan en absolut DATA_DIR', async () => {
    const utan = await runCli(['lista'], {}, { out: (rad) => ut.push(rad), err: (rad) => fel.push(rad) });
    const relativ = await runCli(['lista'], { DATA_DIR: 'data' }, { out: (rad) => ut.push(rad), err: (rad) => fel.push(rad) });

    expect(utan).toBe(2);
    expect(relativ).toBe(2);
    expect(fel.join('\n')).toContain('DATA_DIR');
  });

  it('en relativ bygg-katalog tolkas från katalogen där npm-kommandot skrevs, inte från paketets katalog', async () => {
    await kor('skapa-app');
    const appId = ut[0] ?? '';

    // `npm run cli -w …` byter arbetskatalog till paketet och lägger den ursprungliga i INIT_CWD.
    const kod = await runCli(
      ['publicera', appId, '.'],
      { DATA_DIR: dataDir, INIT_CWD: bygge },
      { out: (rad) => ut.push(rad), err: (rad) => fel.push(rad) },
    );

    expect(kod).toBe(0);
  });
});
