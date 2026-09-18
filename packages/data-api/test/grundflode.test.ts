import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCUMENT_ID_PATTERN, type TenantContext, type TenantStore } from '@vibesandbox/contracts';
import { anna, förväntaFel, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

describe('Grundflöde: skapa, hämta, lista, ersätta, radera', () => {
  let dataDir: string;
  let städa: () => Promise<void>;
  let store: TenantStore;
  let app: TenantContext;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
    store = nyButik(dataDir);
    app = tenant(nyttAppId());
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

  it('ett skapat dokument har ett giltigt id och rätt data', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });

    expect(skapat.id).toMatch(DOCUMENT_ID_PATTERN);
    expect(skapat.data).toEqual({ text: 'hej' });
  });

  it('createdAt och updatedAt är giltiga ISO-tidsstämplar och lika vid skapande', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });

    expect(new Date(skapat.createdAt).toISOString()).toBe(skapat.createdAt);
    expect(new Date(skapat.updatedAt).toISOString()).toBe(skapat.updatedAt);
    expect(skapat.createdAt).toBe(skapat.updatedAt);
  });

  it('ett skapat dokument går att hämta igen oförändrat', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });

    const hämtat = await store.getDocument(app, anna, 'anteckningar', skapat.id);

    expect(hämtat).toEqual(skapat);
  });

  it('ett nytt dokument dyker upp i listan för sin kollektion', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });

    const sida = await store.listDocuments(app, anna, 'anteckningar', 'app');

    expect(sida.documents.map((dok) => dok.id)).toContain(skapat.id);
  });

  it('replace uppdaterar data och updatedAt men rör inte id eller createdAt', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });
    // Liten paus så att klockan hinner gå vidare mellan skapande och ersättning.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ersatt = await store.replaceDocument(app, anna, 'anteckningar', skapat.id, {
      text: 'hejdå',
    });

    expect(ersatt.id).toBe(skapat.id);
    expect(ersatt.createdAt).toBe(skapat.createdAt);
    expect(ersatt.updatedAt).not.toBe(skapat.updatedAt);
    expect(ersatt.data).toEqual({ text: 'hejdå' });
  });

  it('ett raderat dokument kan inte längre hämtas', async () => {
    const skapat = await store.createDocument(app, anna, 'anteckningar', 'app', { text: 'hej' });

    await store.deleteDocument(app, anna, 'anteckningar', skapat.id);

    await förväntaFel(store.getDocument(app, anna, 'anteckningar', skapat.id), 'not_found');
  });

  it('en läsning av en tom, aldrig använd kollektion ger en tom lista utan fel', async () => {
    const sida = await store.listDocuments(app, anna, 'aldrig-anvand', 'app');

    expect(sida.documents).toEqual([]);
    expect(sida.nextCursor).toBeUndefined();
  });
});
