/**
 * CLI:t som lägger in den första byggaren på servern:
 *
 *   npm run anvandare -w @vibesandbox/identity -- lagg-till anna@example.org builder
 *
 *   Givet en tom server
 *   När driften lägger till en byggare med CLI:t
 *   Så kan den byggaren logga in med engångskod
 *
 *   Givet en användare vars roll är för hög
 *   När driften kör `satt-roll` med en lägre roll
 *   Så SÄNKS rollen — det `lagg-till` vägrar göra
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityDataDirectory, listUsers, openIdentityDatabase, runIdentityCli } from '../src/index.ts';
import { VARD_A, Webblasare, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';

describe('CLI: anvandare', () => {
  let dataDir: string;
  let ut: string[];
  let fel: string[];
  const output = {
    out: (rad: string) => ut.push(rad),
    err: (rad: string) => fel.push(rad),
  };

  /** Rollerna i databasen CLI:t skrev till, i listordning. */
  const roller = (): string[] => {
    const db = openIdentityDatabase(identityDataDirectory(dataDir));
    try {
      return listUsers(db).map((user) => user.role);
    } finally {
      db.close();
    }
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

  it('sänker en roll med satt-roll — det lagg-till vägrar', async () => {
    expect(await runIdentityCli(['lagg-till', 'anna@example.org', 'admin'], { DATA_DIR: dataDir }, output)).toBe(0);
    expect(await runIdentityCli(['lagg-till', 'anna@example.org', 'viewer'], { DATA_DIR: dataDir }, output)).toBe(0);
    expect(roller()).toEqual(['admin']);

    expect(await runIdentityCli(['satt-roll', 'Anna@Example.org', 'viewer'], { DATA_DIR: dataDir }, output)).toBe(0);

    expect(roller()).toEqual(['viewer']);
    expect(ut.join('\n')).toMatch(/viewer/);
    expect(fel).toEqual([]);
  });

  it('skriver aldrig ut adressen', async () => {
    await runIdentityCli(['lagg-till', 'anna@example.org', 'admin'], { DATA_DIR: dataDir }, output);
    await runIdentityCli(['satt-roll', 'anna@example.org', 'builder'], { DATA_DIR: dataDir }, output);
    await runIdentityCli(['satt-roll', 'bo@example.org', 'builder'], { DATA_DIR: dataDir }, output);

    expect([...ut, ...fel].join('\n')).not.toMatch(/anna|bo@|example\.org/i);
  });

  it('ger kod 1 när adressen inte finns', async () => {
    expect(await runIdentityCli(['satt-roll', 'bo@example.org', 'viewer'], { DATA_DIR: dataDir }, output)).toBe(1);
    expect(fel.join('\n')).toMatch(/finns ingen/i);
  });

  it('ger användningstext och kod 2 vid fel användning av satt-roll', async () => {
    for (const argv of [['satt-roll'], ['satt-roll', 'anna@example.org'], ['satt-roll', 'anna@example.org', 'kung'], ['satt-roll', 'inte-en-adress', 'viewer']]) {
      fel = [];
      expect(await runIdentityCli(argv, { DATA_DIR: dataDir }, output)).toBe(2);
      expect(fel.join('\n')).toMatch(/satt-roll/);
    }
  });

  it('kräver en absolut DATA_DIR', async () => {
    expect(await runIdentityCli(['lagg-till', 'a@example.org', 'viewer'], {}, output)).toBe(2);
    expect(await runIdentityCli(['lagg-till', 'a@example.org', 'viewer'], { DATA_DIR: 'relativ' }, output)).toBe(2);
    expect(fel.join('\n')).toMatch(/DATA_DIR/);
  });
});
