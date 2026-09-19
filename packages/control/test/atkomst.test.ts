/**
 * Åtkomst per app: en ägare (den som byggde appen) och noll eller flera användare (fått appen
 * delad med sig). Se features/delning/appatkomst.feature. Plattformens roller spelar ingen roll
 * här — registret känner bara till appens egen åtkomstlista.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAccessRole, AppId } from '@vibesandbox/contracts';
import { ControlError, createControl } from '../src/index.ts';
import type { Control } from '../src/index.ts';
import { skapaTempKatalog } from './hjalp.ts';
import type { TempKatalog } from './hjalp.ts';

const OKAND_APP = '0123456789abcdefghjkmnpqrs' as AppId;

async function forvantaFel(arbete: Promise<unknown>, kod: string): Promise<void> {
  const fel = await arbete.then(
    () => null,
    (error: unknown) => error,
  );
  expect(fel).toBeInstanceOf(ControlError);
  expect((fel as ControlError).code).toBe(kod);
}

describe('Åtkomst till en app', () => {
  let data: TempKatalog;
  let control: Control;

  beforeEach(async () => {
    data = await skapaTempKatalog();
    control = createControl({ dataDir: data.katalog });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await control.close();
    await data.stada();
  });

  it('en ny app har ingen åtkomstlista — ingen kommer åt den', async () => {
    const appId = await control.createApp();
    expect(await control.listAccess(appId)).toEqual([]);
    expect(await control.registry.accessFor(appId, 'anna')).toBeNull();
  });

  it('ägaren och den som fått appen delad med sig får var sin roll; alla andra null', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', 'anna@example.test');
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');

    expect(await control.registry.accessFor(appId, 'anna')).toBe('owner');
    expect(await control.registry.accessFor(appId, 'bertil')).toBe('user');
    expect(await control.registry.accessFor(appId, 'cecilia')).toBeNull();
  });

  it('åtkomstlistan visar ägaren först och sedan användarna i den ordning de lades till', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');
    await control.grantAccess(appId, 'cecilia', 'user', 'cecilia@example.test');
    await control.grantAccess(appId, 'anna', 'owner', null);

    const lista = await control.listAccess(appId);
    expect(lista.map(({ userId, role, email }) => ({ userId, role, email }))).toEqual([
      { userId: 'anna', role: 'owner', email: null },
      { userId: 'bertil', role: 'user', email: 'bertil@example.test' },
      { userId: 'cecilia', role: 'user', email: 'cecilia@example.test' },
    ]);
    for (const rad of lista) expect(Number.isNaN(Date.parse(rad.addedAt))).toBe(false);
  });

  it('att dela samma app två gånger med samma person är ofarligt', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', 'anna@example.test');
    await control.grantAccess(appId, 'anna', 'owner', 'anna@example.test');
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');

    expect((await control.listAccess(appId)).map((rad) => rad.userId)).toEqual(['anna', 'bertil']);
  });

  it('en app kan inte få en andra ägare', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);

    await forvantaFel(control.grantAccess(appId, 'erik', 'owner', null), 'access_rejected');
    expect(await control.registry.accessFor(appId, 'erik')).toBeNull();

    // Inte heller genom att en befintlig användare uppgraderas.
    await control.grantAccess(appId, 'bertil', 'user', null);
    await forvantaFel(control.grantAccess(appId, 'bertil', 'owner', null), 'access_rejected');
    expect(await control.registry.accessFor(appId, 'bertil')).toBe('user');
    expect(await control.registry.accessFor(appId, 'anna')).toBe('owner');
  });

  it('ägaren nedgraderas aldrig till användare', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    await control.grantAccess(appId, 'anna', 'user', 'anna@example.test');

    expect(await control.registry.accessFor(appId, 'anna')).toBe('owner');
  });

  it('en ägare som lagts in utan adress får adressen när den blir känd', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    await control.grantAccess(appId, 'anna', 'owner', 'anna@example.test');
    // Ett senare anrop utan adress suddar inte ut den.
    await control.grantAccess(appId, 'anna', 'owner', null);

    expect((await control.listAccess(appId))[0]?.email).toBe('anna@example.test');
  });

  it('ägarens åtkomst går inte att ta bort', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);

    await forvantaFel(control.revokeAccess(appId, 'anna'), 'access_rejected');
    expect(await control.registry.accessFor(appId, 'anna')).toBe('owner');
  });

  it('en borttagen åtkomst upphör direkt; att ta bort den igen är ofarligt', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');

    await control.revokeAccess(appId, 'bertil');
    expect(await control.registry.accessFor(appId, 'bertil')).toBeNull();

    await control.revokeAccess(appId, 'bertil');
    await control.revokeAccess(appId, 'någon-som-aldrig-funnits');
    expect((await control.listAccess(appId)).map((rad) => rad.userId)).toEqual(['anna']);
  });

  it('en app läcker inte en annan apps åtkomst', async () => {
    const annasApp = await control.createApp();
    const eriksApp = await control.createApp();
    await control.grantAccess(annasApp, 'anna', 'owner', null);
    await control.grantAccess(annasApp, 'bertil', 'user', null);
    await control.grantAccess(eriksApp, 'erik', 'owner', null);

    expect(await control.registry.accessFor(eriksApp, 'anna')).toBeNull();
    expect(await control.registry.accessFor(eriksApp, 'bertil')).toBeNull();
    expect(await control.registry.accessFor(annasApp, 'erik')).toBeNull();
    expect((await control.listAccess(eriksApp)).map((rad) => rad.userId)).toEqual(['erik']);

    // Att ta bort Bertil ur Eriks app rör inte hans åtkomst till Annas.
    await control.revokeAccess(eriksApp, 'bertil');
    expect(await control.registry.accessFor(annasApp, 'bertil')).toBe('user');
  });

  it('åtkomsten överlever inte att appen tas bort', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    await control.grantAccess(appId, 'bertil', 'user', 'bertil@example.test');

    await control.deleteApp(appId);
    expect(await control.registry.accessFor(appId, 'anna')).toBeNull();
    expect(await control.registry.accessFor(appId, 'bertil')).toBeNull();

    // Kontrollera i själva databasen att raderna är borta, inte bara osynliga.
    await control.close();
    const db = new DatabaseSync(join(data.katalog, 'control', 'control.sqlite'));
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_access').get()?.['n']).toBe(0);
    } finally {
      db.close();
    }
  });

  it('okänd app ger app_not_found vid ändring och listning, men null vid uppslag', async () => {
    await forvantaFel(control.grantAccess(OKAND_APP, 'anna', 'owner', null), 'app_not_found');
    await forvantaFel(control.revokeAccess(OKAND_APP, 'anna'), 'app_not_found');
    await forvantaFel(control.listAccess(OKAND_APP), 'app_not_found');
    expect(await control.registry.accessFor(OKAND_APP, 'anna')).toBeNull();
  });

  it('ett värde som inte är ett app-id ger app_not_found eller null — aldrig en träff', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    const fientliga: unknown[] = [
      '',
      '../control',
      "' OR 1=1 --",
      '%',
      appId.toUpperCase(),
      `${appId.slice(0, 25)}${String.fromCharCode(0)}`,
      'x'.repeat(10_000),
      null,
      undefined,
      42,
      { toString: () => appId },
    ];
    for (const varde of fientliga) {
      expect(await control.registry.accessFor(varde as AppId, 'anna')).toBeNull();
      await forvantaFel(control.grantAccess(varde as AppId, 'bertil', 'user', null), 'app_not_found');
      await forvantaFel(control.revokeAccess(varde as AppId, 'anna'), 'app_not_found');
      await forvantaFel(control.listAccess(varde as AppId), 'app_not_found');
    }
    expect((await control.listAccess(appId)).map((rad) => rad.userId)).toEqual(['anna']);
  });

  it('ett ogiltigt användar-id avvisas vid ändring och ger null vid uppslag', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);
    const fientliga: unknown[] = ['', 'x'.repeat(257), `anna${String.fromCharCode(0)}`, null, undefined, 42, {
      toString: () => 'anna',
    }];
    for (const varde of fientliga) {
      expect(await control.registry.accessFor(appId, varde as string)).toBeNull();
      await forvantaFel(control.grantAccess(appId, varde as string, 'user', null), 'access_rejected');
      await forvantaFel(control.revokeAccess(appId, varde as string), 'access_rejected');
    }
    // Det längsta tillåtna id:t går bra.
    await control.grantAccess(appId, 'x'.repeat(256), 'user', null);
    expect(await control.registry.accessFor(appId, 'x'.repeat(256))).toBe('user');
    expect(await control.registry.accessFor(appId, 'x'.repeat(255))).toBeNull();
  });

  it('användar-id jämförs ordagrant — inget skiftläge, inga blanktecken', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', null);

    expect(await control.registry.accessFor(appId, 'Anna')).toBeNull();
    expect(await control.registry.accessFor(appId, ' anna')).toBeNull();
    expect(await control.registry.accessFor(appId, 'ann%')).toBeNull();
  });

  it('en okänd roll eller en ogiltig adress avvisas', async () => {
    const appId = await control.createApp();
    for (const roll of ['admin', 'viewer', 'OWNER', '', null, undefined, 1]) {
      await forvantaFel(control.grantAccess(appId, 'bertil', roll as AppAccessRole, null), 'access_rejected');
    }
    for (const adress of ['', 'x'.repeat(321), 42, {}, `a${String.fromCharCode(0)}@example.test`]) {
      await forvantaFel(control.grantAccess(appId, 'bertil', 'user', adress as string), 'access_rejected');
    }
    expect(await control.listAccess(appId)).toEqual([]);
  });

  it('e-postadressen skrivs aldrig till loggen', async () => {
    const utskrifter: unknown[] = [];
    for (const metod of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, metod).mockImplementation((...args: unknown[]) => {
        utskrifter.push(args);
      });
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', 'hemlig.anna@example.test');
    await control.grantAccess(appId, 'bertil', 'user', 'hemlig.bertil@example.test');
    await forvantaFel(control.grantAccess(appId, 'erik', 'owner', 'hemlig.erik@example.test'), 'access_rejected');
    await forvantaFel(control.revokeAccess(appId, 'anna'), 'access_rejected');
    await control.listAccess(appId);

    const allt = JSON.stringify([utskrifter, stdout.mock.calls, stderr.mock.calls]);
    expect(allt).not.toContain('hemlig');
  });

  it('felmeddelanden röjer varken adress eller användar-id', async () => {
    const appId = await control.createApp();
    await control.grantAccess(appId, 'anna', 'owner', 'hemlig.anna@example.test');
    const fel = await control.grantAccess(appId, 'erik-id', 'owner', 'hemlig.erik@example.test').catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(ControlError);
    expect((fel as ControlError).message).not.toMatch(/hemlig|erik-id|anna/);
  });

  it('ett stängt register tar inte emot anrop', async () => {
    const appId = await control.createApp();
    await control.close();
    await forvantaFel(control.grantAccess(appId, 'anna', 'owner', null), 'closed');
    await forvantaFel(control.revokeAccess(appId, 'anna'), 'closed');
    await forvantaFel(control.listAccess(appId), 'closed');
    await forvantaFel(control.registry.accessFor(appId, 'anna'), 'closed');
  });
});

describe('Åtkomsttabellen i databasen', () => {
  let data: TempKatalog;

  beforeEach(async () => {
    data = await skapaTempKatalog();
  });

  afterEach(async () => {
    await data.stada();
  });

  function oppnaRa(): DatabaseSync {
    const db = new DatabaseSync(join(data.katalog, 'control', 'control.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }

  it('databasen själv vägrar en andra ägare, en okänd roll och en rad för en app som inte finns', async () => {
    const control = createControl({ dataDir: data.katalog });
    const appId = await control.createApp();
    await control.close();

    const db = oppnaRa();
    try {
      const infoga = db.prepare('INSERT INTO app_access (app_id, user_id, role, email, added_at) VALUES (?, ?, ?, ?, ?)');
      const nu = new Date().toISOString();
      infoga.run(appId, 'anna', 'owner', null, nu);
      expect(() => infoga.run(appId, 'erik', 'owner', null, nu)).toThrow();
      expect(() => infoga.run(appId, 'bertil', 'admin', null, nu)).toThrow();
      expect(() => infoga.run(OKAND_APP, 'bertil', 'user', null, nu)).toThrow();
      expect(() => infoga.run(appId, 'anna', 'user', null, nu)).toThrow();
    } finally {
      db.close();
    }
  });

  it('en befintlig databas från före åtkomsttabellen uppgraderas och behåller sina appar', async () => {
    let control = createControl({ dataDir: data.katalog });
    const appId = await control.createApp();
    await control.close();

    // Återskapa läget före migreringen: schemaversion 1 utan åtkomsttabell.
    const db = oppnaRa();
    try {
      db.exec('DROP TABLE app_access');
      db.exec('PRAGMA user_version = 1');
    } finally {
      db.close();
    }

    control = createControl({ dataDir: data.katalog });
    try {
      expect(await control.registry.find(appId)).toEqual({ appId, published: false, draft: false });
      expect(await control.listAccess(appId)).toEqual([]);
      await control.grantAccess(appId, 'anna', 'owner', null);
      expect(await control.registry.accessFor(appId, 'anna')).toBe('owner');
    } finally {
      await control.close();
    }
  });
});
