import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentPage, StoredDocument } from '@vibesandbox/contracts';
import { configure, createMemoryAdapter, createPlatformAdapter, db, LIST_MAX_DOCUMENTS, whoami } from '../src/index.ts';
import type { StorageAdapter } from '../src/index.ts';
import { ANNA, BERTIL, expectSdkError } from './adapter-contract.ts';
import { createFakeServer, jsonResponse } from './fake-server.ts';

interface Bokning {
  rum: string;
  datum: string;
  vem?: string;
}

afterEach(() => {
  // Standardadaptern är plattformen; återställ så att tester inte läcker in i varandra.
  configure({ adapter: createPlatformAdapter() });
});

describe('db.collection', () => {
  it('lägger till, listar, hämtar, ersätter och tar bort — med appens egen typ på data', async () => {
    configure({ adapter: createMemoryAdapter({ user: ANNA }) });
    const bokningar = db.collection<Bokning>('bokningar');

    const skapad = await bokningar.add({ rum: 'Stora salen', datum: '2026-10-01', vem: 'Anna' });
    expect(skapad.data.rum).toBe('Stora salen');

    expect(await bokningar.list()).toEqual([skapad]);
    expect(await bokningar.get(skapad.id)).toEqual(skapad);

    const ersatt = await bokningar.update(skapad.id, { rum: 'Lilla salen', datum: '2026-10-02' });
    expect(ersatt.data).toEqual({ rum: 'Lilla salen', datum: '2026-10-02' });
    expect(ersatt.data.vem).toBeUndefined();

    await bokningar.remove(skapad.id);
    expect(await bokningar.list()).toEqual([]);
  });

  it('är gemensam om inget annat sägs, och personlig med { personal: true }', async () => {
    const adapter = createMemoryAdapter({ user: ANNA });
    configure({ adapter });
    await db.collection('anslag').add({ rubrik: 'Fika' });
    await db.collection('svar', { personal: true }).add({ svar: 'Ja' });

    configure({ adapter: adapter.asUser(BERTIL) });
    expect(await db.collection('anslag').list()).toHaveLength(1);
    expect(await db.collection('svar', { personal: true }).list()).toEqual([]);
    await expectSdkError(db.collection('svar').list(), 'scope_mismatch');
  });

  it('använder den adapter som gäller vid anropet, inte den som gällde när kollektionen skapades', async () => {
    // Genererad kod skapar ofta kollektioner överst i modulen, före configure().
    const bokningar = db.collection<Bokning>('bokningar');
    configure({ adapter: createMemoryAdapter() });
    await bokningar.add({ rum: 'Stora salen', datum: '2026-10-01' });
    expect(await bokningar.list()).toHaveLength(1);
  });

  it('whoami går via samma adapter', async () => {
    configure({ adapter: createMemoryAdapter({ user: BERTIL }) });
    expect(await whoami()).toEqual(BERTIL);
  });
});

describe('validering innan något skickas', () => {
  function spyAdapter(): { adapter: StorageAdapter; calls: string[] } {
    const calls: string[] = [];
    const inner = createMemoryAdapter();
    const adapter = new Proxy(inner as StorageAdapter, {
      get(target, property, receiver) {
        calls.push(String(property));
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { adapter, calls };
  }

  it.each([
    '',
    'Bokningar',
    '1bokningar',
    'bok ningar',
    'bokningår',
    '../hemligt',
    'a/b',
    'a\u0000b',
    'a'.repeat(65),
    '%2e%2e',
  ])('kollektionsnamnet %j avvisas direkt, med ett meddelande som säger vad som gäller', (name) => {
    const { adapter, calls } = spyAdapter();
    configure({ adapter });
    let caught: unknown;
    try {
      db.collection(name);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'SdkError', code: 'invalid_request' });
    expect((caught as Error).message).toMatch(/a–z/);
    expect(calls).toEqual([]);
  });

  it.each(['../../whoami', '', 'ABC', '0123456789abcdefghjkmnpqr', 'x'.repeat(5000), '0123456789abcdefghjkmnpqr\u0000'])(
    'dokument-id %j avvisas utan att adaptern anropas',
    async (id) => {
      const { adapter, calls } = spyAdapter();
      configure({ adapter });
      const bokningar = db.collection('bokningar');
      await expectSdkError(bokningar.get(id), 'invalid_request');
      await expectSdkError(bokningar.update(id, { rum: 'x' }), 'invalid_request');
      await expectSdkError(bokningar.remove(id), 'invalid_request');
      expect(calls).toEqual([]);
    },
  );

  it.each([null, undefined, 'text', 42, ['a'], new Date(0)])('data %j som inte är ett vanligt objekt avvisas', async (data) => {
    const { adapter, calls } = spyAdapter();
    configure({ adapter });
    await expectSdkError(db.collection('bokningar').add(data as never), 'invalid_request');
    expect(calls).toEqual([]);
  });

  it('data som inte går att spara som JSON avvisas', async () => {
    configure({ adapter: createMemoryAdapter() });
    const cirkel: Record<string, unknown> = {};
    cirkel['jag'] = cirkel;
    await expectSdkError(db.collection<Record<string, unknown>>('bokningar').add(cirkel), 'invalid_request');
    await expectSdkError(db.collection<{ antal: bigint }>('bokningar').add({ antal: 10n }), 'invalid_request');
  });
});

describe('list() följer markörer själv', () => {
  it('hämtar alla sidor från plattformen, 100 åt gången', async () => {
    const server = createFakeServer();
    configure({ adapter: createPlatformAdapter({ fetch: server.fetchAs(ANNA) }) });
    const poster = db.collection<{ nummer: number }>('poster');
    for (let nummer = 1; nummer <= 250; nummer += 1) await poster.add({ nummer });
    server.requests.length = 0;

    const alla = await poster.list();

    expect(alla).toHaveLength(250);
    expect(new Set(alla.map((doc) => doc.id)).size).toBe(250);
    expect(server.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
    expect(server.requests[0]?.url).toBe('/_api/collections/poster/docs?scope=app&limit=100');
    expect(server.requests[1]?.url).toMatch(/&limit=100&cursor=.+$/);
  });

  function endlessFetch() {
    let sida = 0;
    const urls: string[] = [];
    return {
      urls,
      fetch: async (url: string) => {
        urls.push(url);
        sida += 1;
        const documents: StoredDocument[] = Array.from({ length: 100 }, (_, index) => ({
          id: `sida${sida}-${index}`,
          data: {},
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z',
        }));
        const page: DocumentPage = { documents, nextCursor: `efter-${sida}` };
        return jsonResponse(200, page);
      },
    };
  }

  it('stannar vid taket även om plattformen aldrig slutar dela ut markörer', async () => {
    const { fetch, urls } = endlessFetch();
    configure({ adapter: createPlatformAdapter({ fetch }) });
    const alla = await db.collection('poster').list();
    expect(alla).toHaveLength(LIST_MAX_DOCUMENTS);
    expect(urls).toHaveLength(LIST_MAX_DOCUMENTS / 100);
  });

  it('stannar även om varje sida är tom men har en markör', async () => {
    let anrop = 0;
    configure({
      adapter: createPlatformAdapter({
        fetch: async () => {
          anrop += 1;
          return jsonResponse(200, { documents: [], nextCursor: 'samma' });
        },
      }),
    });
    expect(await db.collection('poster').list()).toEqual([]);
    expect(anrop).toBeLessThanOrEqual(LIST_MAX_DOCUMENTS / 100);
  });
});
