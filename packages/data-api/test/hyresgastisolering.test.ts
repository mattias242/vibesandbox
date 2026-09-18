import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantStore } from '@vibesandbox/contracts';
import {
  allaFiler,
  anna,
  förväntaFel,
  nyButik,
  nyttAppId,
  skapaTempDataDir,
  tenant,
} from './hjalp.ts';

describe('Hyresgästisolering: varje app har sin egen isolerade datamiljö', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
  });

  afterEach(async () => {
    // Kastar beforeEach innan `store` hunnit skapas får det inte hindra städningen — annars
    // blir den temporära katalogen kvar på disk efter varje rött test.
    try {
      await store?.close();
    } finally {
      await städa?.();
    }
  });

  it('en app ser bara sina egna dokument i listan', async () => {
    const bokningar = tenant(nyttAppId());
    const enkät = tenant(nyttAppId());

    await store.createDocument(bokningar, anna, 'poster', 'app', { rum: 'Stora salen' });

    const sida = await store.listDocuments(enkät, anna, 'poster', 'app');

    expect(sida.documents).toEqual([]);
  });

  it('ett dokument-id från en annan app ger not_found', async () => {
    const bokningar = tenant(nyttAppId());
    const enkät = tenant(nyttAppId());

    const skapat = await store.createDocument(bokningar, anna, 'poster', 'app', {
      rum: 'Stora salen',
    });

    await förväntaFel(store.getDocument(enkät, anna, 'poster', skapat.id), 'not_found');
  });

  it('utkast och publicerad version för samma app delar aldrig data (publicerat läcker inte till utkast)', async () => {
    const appId = nyttAppId();
    const publicerad = tenant(appId, 'published');
    const utkast = tenant(appId, 'draft');

    await store.createDocument(publicerad, anna, 'poster', 'app', { rum: 'Stora salen' });

    const sidaUtkast = await store.listDocuments(utkast, anna, 'poster', 'app');

    expect(sidaUtkast.documents).toEqual([]);
  });

  it('utkast och publicerad version för samma app delar aldrig data (utkast läcker inte till publicerat)', async () => {
    const appId = nyttAppId();
    const publicerad = tenant(appId, 'published');
    const utkast = tenant(appId, 'draft');

    await store.createDocument(publicerad, anna, 'poster', 'app', { rum: 'Stora salen' });
    await store.createDocument(utkast, anna, 'poster', 'app', { rum: 'Kontoret' });

    const sidaPublicerad = await store.listDocuments(publicerad, anna, 'poster', 'app');

    expect(sidaPublicerad.documents).toHaveLength(1);
    expect(sidaPublicerad.documents[0]?.data).toEqual({ rum: 'Stora salen' });
  });

  it('olika hyresgäster lagras i separata filer på disk', async () => {
    const första = tenant(nyttAppId());
    await store.createDocument(första, anna, 'poster', 'app', { v: 1 });
    const filerEfterFörsta = await allaFiler(dataDir);
    expect(filerEfterFörsta.length).toBeGreaterThan(0);

    const andra = tenant(nyttAppId());
    await store.createDocument(andra, anna, 'poster', 'app', { v: 2 });
    const filerEfterAndra = await allaFiler(dataDir);

    // Den första hyresgästens filer finns kvar oförändrade...
    for (const fil of filerEfterFörsta) {
      expect(filerEfterAndra).toContain(fil);
    }
    // ...och minst en ny fil har tillkommit för den andra hyresgästen.
    expect(filerEfterAndra.length).toBeGreaterThan(filerEfterFörsta.length);
  });

  it('publicerad och utkast för samma app-id får separata filer på disk', async () => {
    const appId = nyttAppId();
    const publicerad = tenant(appId, 'published');
    const utkast = tenant(appId, 'draft');

    await store.createDocument(publicerad, anna, 'poster', 'app', { v: 1 });
    const filerEfterPublicerad = await allaFiler(dataDir);

    await store.createDocument(utkast, anna, 'poster', 'app', { v: 2 });
    const filerEfterUtkast = await allaFiler(dataDir);

    expect(filerEfterUtkast.length).toBeGreaterThan(filerEfterPublicerad.length);
  });

  it('en läsning av en tom hyresgäst ger en tom lista utan fel', async () => {
    const tom = tenant(nyttAppId());

    const sida = await store.listDocuments(tom, anna, 'poster', 'app');

    expect(sida.documents).toEqual([]);
  });
});
