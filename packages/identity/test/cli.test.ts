/**
 * CLI:t som lägger in den första byggaren på servern:
 *
 *   npm run anvandare -w @vibesandbox/identity -- lagg-till anna@example.org builder
 *
 *   Givet en tom server
 *   När driften lägger till en byggare med CLI:t
 *   Så kan den byggaren logga in med engångskod
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityDataDirectory, runIdentityCli } from '../src/index.ts';
import { VARD_A, Webblasare, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';

describe('CLI: anvandare', () => {
  let dataDir: string;
  let ut: string[];
  let fel: string[];
  const output = {
    out: (rad: string) => ut.push(rad),
    err: (rad: string) => fel.push(rad),
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-identity-cli-'));
    ut = [];
    fel = [];
  });
  afterEach(async () => {
    await stadaAllt();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lägger till en byggare som sedan kan logga in', async () => {
    const kod = await runIdentityCli(['lagg-till', 'Anna@Example.org', 'builder'], { DATA_DIR: dataDir }, output);
    expect(kod).toBe(0);
    expect(ut.join('\n')).toMatch(/builder/);
    expect(fel).toEqual([]);

    const u = await skapaUppsattning({ dataDirectory: identityDataDirectory(dataDir) });
    const w = new Webblasare(u.leverantor);
    await loggaIn(w, u.utkorg, VARD_A, 'anna@example.org');
    expect((await w.vem(VARD_A))?.roles).toEqual(['builder']);
  });

  it('ger användningstext och kod 2 vid fel användning', async () => {
    for (const argv of [[], ['okant'], ['lagg-till'], ['lagg-till', 'anna@example.org'], ['lagg-till', 'anna@example.org', 'kung']]) {
      fel = [];
      expect(await runIdentityCli(argv, { DATA_DIR: dataDir }, output)).toBe(2);
      expect(fel.join('\n')).toMatch(/lagg-till/);
    }
  });

  it('nekar en ogiltig adress', async () => {
    expect(await runIdentityCli(['lagg-till', 'inte-en-adress', 'viewer'], { DATA_DIR: dataDir }, output)).toBe(2);
    expect(fel.join('\n')).toMatch(/adress/i);
  });

  it('kräver en absolut DATA_DIR', async () => {
    expect(await runIdentityCli(['lagg-till', 'a@example.org', 'viewer'], {}, output)).toBe(2);
    expect(await runIdentityCli(['lagg-till', 'a@example.org', 'viewer'], { DATA_DIR: 'relativ' }, output)).toBe(2);
    expect(fel.join('\n')).toMatch(/DATA_DIR/);
  });
});
