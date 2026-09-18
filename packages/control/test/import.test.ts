import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppId } from '@vibesandbox/contracts';
import { ControlError, createControl } from '../src/index.ts';
import type { Control } from '../src/index.ts';
import { MINSTA_APP, allaFiler, skapaTempKatalog, skrivTrad, tenant } from './hjalp.ts';
import type { TempKatalog } from './hjalp.ts';

describe('Import av en byggd version: hellre avvisa än gissa', () => {
  let data: TempKatalog;
  let bygge: TempKatalog;
  let utanfor: TempKatalog;
  let control: Control;
  let appId: AppId;

  beforeEach(async () => {
    data = await skapaTempKatalog();
    bygge = await skapaTempKatalog('vibesandbox-bygge-');
    utanfor = await skapaTempKatalog('vibesandbox-utanfor-');
    await skrivTrad(bygge.katalog, MINSTA_APP);
    await skrivTrad(utanfor.katalog, { 'hemligt.txt': 'HEMLIGT-UTANFOR-BYGGET' });
    control = createControl({ dataDir: data.katalog });
    appId = await control.createApp();
  });

  afterEach(async () => {
    await control.close();
    await utanfor.stada();
    await bygge.stada();
    await data.stada();
  });

  async function forvantaAvvisad(katalog = bygge.katalog): Promise<ControlError> {
    const fel: unknown = await control.importVersion(appId, katalog).then(
      () => new Error('importen godtogs'),
      (orsak: unknown) => orsak,
    );
    expect(fel).toBeInstanceOf(ControlError);
    expect((fel as ControlError).code).toBe('import_rejected');
    return fel as ControlError;
  }

  it('godtar ett vanligt bygge', async () => {
    const version = await control.importVersion(appId, bygge.katalog);
    await control.publish(appId, version);

    expect(await control.files.read(tenant(appId), '/assets/app.js')).not.toBeNull();
  });

  it('avvisar en symlänk till en fil utanför bygget', async () => {
    await symlink(join(utanfor.katalog, 'hemligt.txt'), join(bygge.katalog, 'lank.txt'));
    await forvantaAvvisad();
  });

  it('avvisar en symlänkad katalog', async () => {
    await symlink(utanfor.katalog, join(bygge.katalog, 'mapp'));
    await forvantaAvvisad();
  });

  it('avvisar även en symlänk som pekar INOM bygget — inga undantag att resonera om', async () => {
    await symlink(join(bygge.katalog, 'index.html'), join(bygge.katalog, 'kopia.html'));
    await forvantaAvvisad();
  });

  it('avvisar en bygg-katalog som själv är en symlänk', async () => {
    const lank = join(utanfor.katalog, 'bygge-lank');
    await symlink(bygge.katalog, lank);
    await forvantaAvvisad(lank);
  });

  it('avvisar en hård länk — den kan peka på en fil utanför bygget utan att det syns', async () => {
    await link(join(utanfor.katalog, 'hemligt.txt'), join(bygge.katalog, 'hard.txt'));
    await forvantaAvvisad();
  });

  it('avvisar punktfiler och punktkataloger', async () => {
    await writeFile(join(bygge.katalog, '.env'), 'NYCKEL=1');
    await forvantaAvvisad();
  });

  it('avvisar en punktkatalog även när filerna i den ser oskyldiga ut', async () => {
    await mkdir(join(bygge.katalog, '.git'));
    await writeFile(join(bygge.katalog, '.git', 'config.txt'), 'x');
    await forvantaAvvisad();
  });

  it('avvisar okända filändelser i stället för att gissa en innehållstyp', async () => {
    for (const namn of ['skript.php', 'program.exe', 'arkiv.zip', 'utan-andelse', 'sida.html.bak', 'sida.HTML']) {
      const katalog = await skapaTempKatalog('vibesandbox-andelse-');
      try {
        await skrivTrad(katalog.katalog, { ...MINSTA_APP, [namn]: 'x' });
        const fel = await forvantaAvvisad(katalog.katalog);
        // Byggaren ska få veta VILKEN fil det gäller.
        expect(fel.message).toContain(namn);
      } finally {
        await katalog.stada();
      }
    }
  });

  it('avvisar filnamn med tecken som aldrig kan nås via gatewayn', async () => {
    await writeFile(join(bygge.katalog, 'rad\nbrytning.txt'), 'x');
    await forvantaAvvisad();
  });

  it('avvisar ett bygge utan startsida', async () => {
    const katalog = await skapaTempKatalog('vibesandbox-tomt-');
    try {
      await skrivTrad(katalog.katalog, { 'assets/app.js': 'x' });
      await forvantaAvvisad(katalog.katalog);
    } finally {
      await katalog.stada();
    }
  });

  it('avvisar en katalog som inte finns, och en fil i stället för en katalog', async () => {
    await forvantaAvvisad(join(bygge.katalog, 'finns-inte'));
    await forvantaAvvisad(join(bygge.katalog, 'index.html'));
  });

  it('avvisar en för stor fil, för många filer och ett för stort bygge', async () => {
    await control.close();
    control = createControl({
      dataDir: data.katalog,
      importLimits: { maxFileBytes: 1000, maxFiles: 4, maxTotalBytes: 1500, maxDepth: 3 },
    });

    const stor = await skapaTempKatalog('vibesandbox-stor-');
    const manga = await skapaTempKatalog('vibesandbox-manga-');
    const totalt = await skapaTempKatalog('vibesandbox-totalt-');
    const djup = await skapaTempKatalog('vibesandbox-djup-');
    try {
      await skrivTrad(stor.katalog, { ...MINSTA_APP, 'stor.txt': 'x'.repeat(1001) });
      await forvantaAvvisad(stor.katalog);

      await skrivTrad(manga.katalog, { ...MINSTA_APP, 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
      await forvantaAvvisad(manga.katalog);

      await skrivTrad(totalt.katalog, { ...MINSTA_APP, 'a.txt': 'x'.repeat(900), 'b.txt': 'y'.repeat(900) });
      await forvantaAvvisad(totalt.katalog);

      // Tre katalognivåer är tillåtet, den fjärde är en för mycket.
      await skrivTrad(djup.katalog, { ...MINSTA_APP, 'a/b/c/d/e.txt': 'x' });
      await forvantaAvvisad(djup.katalog);
    } finally {
      await stor.stada();
      await manga.stada();
      await totalt.stada();
      await djup.stada();
    }
  });

  it('en avvisad import lämnar varken version, filer eller ändrad app efter sig', async () => {
    await control.publish(appId, await control.importVersion(appId, bygge.katalog));
    const fore = await allaFiler(join(data.katalog, 'versions'));

    const daligt = await skapaTempKatalog('vibesandbox-daligt-');
    try {
      await skrivTrad(daligt.katalog, { ...MINSTA_APP, 'ny.txt': 'NYTT-INNEHALL', 'skript.php': 'x' });
      await forvantaAvvisad(daligt.katalog);
    } finally {
      await daligt.stada();
    }

    expect(await allaFiler(join(data.katalog, 'versions'))).toEqual(fore);
    expect(await control.registry.find(appId)).toEqual({ appId, published: true, draft: false });
    expect(await control.files.read(tenant(appId), '/ny.txt')).toBeNull();
  });

  it('innehållet utanför bygget hamnar aldrig i lagret, hur importen än slutar', async () => {
    await symlink(join(utanfor.katalog, 'hemligt.txt'), join(bygge.katalog, 'lank.txt'));
    await forvantaAvvisad();

    const lagrat = await allaFiler(data.katalog);
    expect(lagrat.filter((fil) => fil.startsWith('versions/'))).toEqual([]);
  });
});
