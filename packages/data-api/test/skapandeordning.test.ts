import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantStore } from '@vibesandbox/contracts';
import { anna, bertil, nyButik, nyttAppId, skapaTempDataDir, tenant } from './hjalp.ts';

/**
 * Kontraktet lovar att listning ger dokumenten i skapandeordning, äldst först. Ett id med
 * tidsprefix räcker inte för det: inom samma millisekund avgör slumpdelen ordningen, och en
 * serverklocka som justeras bakåt (NTP) ger nya dokument som sorteras FÖRE gamla.
 */
describe('Listning ger skapandeordning', () => {
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
    vi.useRealTimers();
    try {
      await store?.close();
    } finally {
      await städa?.();
    }
  });

  async function allaIOrdning(som = anna, kollektion = 'poster', scope: 'app' | 'user' = 'app'): Promise<number[]> {
    const nummer: number[] = [];
    let cursor: string | undefined;
    do {
      const sida = await store.listDocuments(app, som, kollektion, scope, {
        limit: 37,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const dok of sida.documents) nummer.push(dok.data['nr'] as number);
      cursor = sida.nextCursor;
    } while (cursor !== undefined);
    return nummer;
  }

  it('många dokument skapade inom samma millisekund listas i den ordning de skapades', async () => {
    // Klockan står stilla: alla id får samma tidsprefix, så bara slumpdelen skiljer dem åt.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));

    const antal = 300;
    for (let nr = 0; nr < antal; nr++) await store.createDocument(app, anna, 'poster', 'app', { nr });

    expect(await allaIOrdning()).toEqual(Array.from({ length: antal }, (_v, nr) => nr));
  });

  it('en klocka som ställs bakåt ändrar inte ordningen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    await store.createDocument(app, anna, 'poster', 'app', { nr: 0 });

    vi.setSystemTime(new Date('2026-09-18T11:00:00.000Z'));
    await store.createDocument(app, anna, 'poster', 'app', { nr: 1 });
    await store.createDocument(app, anna, 'poster', 'app', { nr: 2 });

    expect(await allaIOrdning()).toEqual([0, 1, 2]);
  });

  it('ordningen håller även efter omstart med klockan bakåtställd', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    await store.createDocument(app, anna, 'poster', 'app', { nr: 0 });
    await store.close();

    vi.setSystemTime(new Date('2026-09-18T09:00:00.000Z'));
    store = nyButik(dataDir);
    await store.createDocument(app, anna, 'poster', 'app', { nr: 1 });

    expect(await allaIOrdning()).toEqual([0, 1]);
  });

  it('personliga kollektioner: var och en får sina egna i skapandeordning, även inom samma millisekund', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    for (let nr = 0; nr < 60; nr++) {
      await store.createDocument(app, anna, 'mina', 'user', { nr });
      await store.createDocument(app, bertil, 'mina', 'user', { nr: 1000 + nr });
    }

    expect(await allaIOrdning(anna, 'mina', 'user')).toEqual(Array.from({ length: 60 }, (_v, nr) => nr));
    expect(await allaIOrdning(bertil, 'mina', 'user')).toEqual(Array.from({ length: 60 }, (_v, nr) => 1000 + nr));
  });

  it('id:n förblir giltiga och unika när de räknas upp inom samma millisekund', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    const id = new Set<string>();
    for (let nr = 0; nr < 200; nr++) {
      const dok = await store.createDocument(app, anna, 'poster', 'app', { nr });
      expect(dok.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
      id.add(dok.id);
    }
    expect(id.size).toBe(200);
  });
});
