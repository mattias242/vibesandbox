import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredDocument } from '@vibesandbox/contracts';
import { anna, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

describe('Beständighet: data överlever close() och en ny store mot samma dataDir', () => {
  let dataDir: string;
  let städa: () => Promise<void>;

  beforeEach(async () => {
    ({ dataDir, städa } = await skapaTempDataDir());
  });

  afterEach(async () => {
    await städa();
  });

  it('ett dokument skrivet innan close() går att läsa från en ny store mot samma dataDir', async () => {
    const app = tenant(nyttAppId());

    const förstaStore = nyButik(dataDir);
    let skapat: StoredDocument;
    try {
      skapat = await förstaStore.createDocument(app, anna, 'poster', 'app', {
        text: 'överlever',
      });
    } finally {
      // Stängningen är en del av scenariot, men ska ske även om skapandet fallerar.
      await förstaStore.close();
    }

    const andraStore = nyButik(dataDir);
    try {
      const hämtat = await andraStore.getDocument(app, anna, 'poster', skapat.id);
      expect(hämtat.data).toEqual({ text: 'överlever' });
      expect(hämtat.id).toBe(skapat.id);
      expect(hämtat.createdAt).toBe(skapat.createdAt);
    } finally {
      await andraStore.close();
    }
  });
});
