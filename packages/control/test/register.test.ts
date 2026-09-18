import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAppId } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';
import { ControlError, createControl } from '../src/index.ts';
import type { Control } from '../src/index.ts';
import { MINSTA_APP, skapaTempKatalog, skrivTrad } from './hjalp.ts';
import type { TempKatalog } from './hjalp.ts';

describe('Appregistret', () => {
  let data: TempKatalog;
  let bygge: TempKatalog;
  let control: Control;

  beforeEach(async () => {
    data = await skapaTempKatalog();
    bygge = await skapaTempKatalog('vibesandbox-bygge-');
    await skrivTrad(bygge.katalog, MINSTA_APP);
    control = createControl({ dataDir: data.katalog });
  });

  afterEach(async () => {
    await control.close();
    await bygge.stada();
    await data.stada();
  });

  it('en ny app finns i registret, utan publicerad version och utan utkast', async () => {
    const appId = await control.createApp();

    expect(isAppId(appId)).toBe(true);
    expect(await control.registry.find(appId)).toEqual({ appId, published: false, draft: false });
  });

  it('ett okänt app-id ger null', async () => {
    await control.createApp();
    expect(await control.registry.find('0123456789abcdefghjkmnpqrs' as AppId)).toBeNull();
  });

  it('ett värde som inte är ett app-id ger null — aldrig ett fel, aldrig en träff', async () => {
    await control.createApp();
    const fientliga: unknown[] = [
      '',
      '../control',
      "' OR 1=1 --",
      '%',
      'A'.repeat(26),
      `0123456789abcdefghjkmnpqr${String.fromCharCode(0)}`,
      'x'.repeat(10_000),
      null,
      undefined,
      42,
      { toString: () => '0123456789abcdefghjkmnpqrs' },
    ];
    for (const varde of fientliga) {
      expect(await control.registry.find(varde as AppId)).toBeNull();
    }
  });

  it('publicering och utkast är två skilda uppgifter om appen', async () => {
    const appId = await control.createApp();
    const v1 = await control.importVersion(appId, bygge.katalog);

    await control.setDraft(appId, v1);
    expect(await control.registry.find(appId)).toEqual({ appId, published: false, draft: true });

    await control.publish(appId, v1);
    expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: true });

    await control.clearDraft(appId);
    expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: false });

    await control.unpublish(appId);
    expect(await control.registry.find(appId)).toEqual({ appId, published: false, draft: false });
  });

  it('en raderad app finns inte längre', async () => {
    const appId = await control.createApp();
    await control.publish(appId, await control.importVersion(appId, bygge.katalog));

    await control.deleteApp(appId);

    expect(await control.registry.find(appId)).toBeNull();
    expect(await control.listApps()).toEqual([]);
  });

  it('listar apparna i den ordning de skapades', async () => {
    const a = await control.createApp();
    const b = await control.createApp();
    await control.publish(b, await control.importVersion(b, bygge.katalog));

    const lista = await control.listApps();

    expect(lista.map((app) => app.appId)).toEqual([a, b]);
    expect(lista.map((app) => app.published)).toEqual([false, true]);
    expect(lista[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('en version kan inte publiceras eller sättas som utkast i en ANNAN app', async () => {
    const egen = await control.createApp();
    const annan = await control.createApp();
    const version = await control.importVersion(egen, bygge.katalog);

    await expect(control.publish(annan, version)).rejects.toMatchObject({ code: 'version_not_found' });
    await expect(control.setDraft(annan, version)).rejects.toMatchObject({ code: 'version_not_found' });
    expect(await control.registry.find(annan)).toEqual({ appId: annan, published: false, draft: false });
  });

  it('ändringar av en app som inte finns ger ett tydligt fel', async () => {
    const okand = '0123456789abcdefghjkmnpqrs' as AppId;
    for (const forsok of [
      () => control.importVersion(okand, bygge.katalog),
      () => control.publish(okand, 'x'),
      () => control.setDraft(okand, 'x'),
      () => control.clearDraft(okand),
      () => control.unpublish(okand),
      () => control.deleteApp(okand),
    ]) {
      await expect(forsok()).rejects.toBeInstanceOf(ControlError);
      await expect(forsok()).rejects.toMatchObject({ code: 'app_not_found' });
    }
  });

  it('registret överlever en omstart', async () => {
    const appId = await control.createApp();
    await control.publish(appId, await control.importVersion(appId, bygge.katalog));
    await control.close();

    control = createControl({ dataDir: data.katalog });

    expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: false });
  });

  it('databasen ligger under control/ och bär en schemaversion att bygga vidare på', async () => {
    await control.createApp();
    await control.close();

    const fil = join(data.katalog, 'control', 'control.sqlite');
    expect(existsSync(fil)).toBe(true);
    const db = new DatabaseSync(fil, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    } finally {
      db.close();
    }
  });

  it('vägrar öppna en databas med ett nyare schema än koden känner till', async () => {
    await control.close();
    const fil = join(data.katalog, 'control', 'control.sqlite');
    const db = new DatabaseSync(fil);
    db.exec('PRAGMA user_version = 999');
    db.close();

    expect(() => createControl({ dataDir: data.katalog })).toThrow(/schema/i);
    // afterEach stänger `control` en gång till; det ska vara ofarligt.
  });

  it('efter close() nekas alla anrop, och close() går att anropa flera gånger', async () => {
    const appId = await control.createApp();
    await control.close();
    await control.close();

    await expect(control.registry.find(appId)).rejects.toMatchObject({ code: 'closed' });
    await expect(control.createApp()).rejects.toMatchObject({ code: 'closed' });
  });

  it('två öppna instanser mot samma katalog ser varandras ändringar (CLI bredvid servern)', async () => {
    const annan = createControl({ dataDir: data.katalog });
    try {
      const appId = await annan.createApp();
      await annan.publish(appId, await annan.importVersion(appId, bygge.katalog));

      expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: false });
    } finally {
      await annan.close();
    }
  });
});
