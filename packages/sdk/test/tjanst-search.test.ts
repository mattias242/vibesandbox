/** SDK:t för tjänsten search: anropet, kontroll av svaret, och hjälparen som hämtar dokumenten. */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { configure, createMemoryAdapter, createPlatformAdapter, db, search as searchModule, SdkError } from '../src/index.ts';
import { search, searchDocuments } from '../src/tjanster/search.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';

function fejk(svar: { status: number; body?: unknown }) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    return {
      status: svar.status,
      ok: svar.status >= 200 && svar.status < 300,
      headers: { get: () => 'application/json' },
      json: async () => svar.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, anrop };
}

afterEach(() => configure({ adapter: createPlatformAdapter() }));

describe('search', () => {
  it('finns i SDK:ts export', () => {
    expect(searchModule.search).toBe(search);
    expect(searchModule.searchDocuments).toBe(searchDocuments);
  });

  it('POST /_api/search med kollektion, fråga och val — och ger träffarna', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: { results: [{ id: 'a', score: 0.9 }] } });
    const traffar = await search('arenden', 'stulen cykel', { limit: 5, personal: true, fields: ['rubrik'], fetch });
    expect(traffar).toEqual([{ id: 'a', score: 0.9 }]);
    expect(anrop[0]?.url).toBe('/_api/search');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ collection: 'arenden', query: 'stulen cykel', limit: 5, personal: true, fields: ['rubrik'] });
  });

  it('skickar bara de val som angetts', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: { results: [] } });
    await search('arenden', 'x', { fetch });
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ collection: 'arenden', query: 'x' });
  });

  it.each([['../arenden'], ['Arenden'], [''], [42]])('ogiltigt kollektionsnamn %j kastar innan något skickas', async (namn) => {
    const { fetch, anrop } = fejk({ status: 200, body: { results: [] } });
    await expect(search(namn as string, 'x', { fetch })).rejects.toBeInstanceOf(SdkError);
    expect(anrop).toEqual([]);
  });

  it.each([[''], ['   '], ['x'.repeat(1001)], [42]])('ogiltig fråga %# kastar innan något skickas', async (fraga) => {
    const { fetch, anrop } = fejk({ status: 200, body: { results: [] } });
    await expect(search('arenden', fraga as string, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toEqual([]);
  });

  it('plattformens fel blir SdkError med plattformens klarspråk', async () => {
    const { fetch } = fejk({ status: 429, body: { error: { code: 'rate_limited', message: 'Vänta en minut.' } } });
    await expect(search('arenden', 'x', { fetch })).rejects.toMatchObject({ code: 'rate_limited', message: 'Vänta en minut.' });
  });

  it.each([
    [{}],
    [{ results: 'nej' }],
    [{ results: [{ id: 1, score: 0.5 }] }],
    [{ results: [{ id: 'a', score: 'hög' }] }],
  ])('ett svar av fel form ⇒ internal', async (body) => {
    const { fetch } = fejk({ status: 200, body });
    await expect(search('arenden', 'x', { fetch })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('searchDocuments', () => {
  it('hämtar dokumenten med db, i träffordning, med poängen — och hoppar över det som hunnit raderas', async () => {
    configure({ adapter: createMemoryAdapter() });
    const arenden = db.collection<{ rubrik: string }>('arenden');
    const cykel = await arenden.add({ rubrik: 'Cykeln blev stulen' });
    const kaffe = await arenden.add({ rubrik: 'Kaffemaskinen läcker' });
    const borta = await arenden.add({ rubrik: 'Raderad' });
    await arenden.remove(borta.id);

    const { fetch } = fejk({ status: 200, body: { results: [{ id: cykel.id, score: 0.9 }, { id: borta.id, score: 0.5 }, { id: kaffe.id, score: 0.2 }] } });
    const traffar = await searchDocuments<{ rubrik: string }>('arenden', 'cykel', { fetch });
    expect(traffar.map((t) => [t.doc.data.rubrik, t.score])).toEqual([
      ['Cykeln blev stulen', 0.9],
      ['Kaffemaskinen läcker', 0.2],
    ]);
  });

  it('personal: hämtar ur den personliga kollektionen', async () => {
    configure({ adapter: createMemoryAdapter() });
    const mina = db.collection<{ text: string }>('anteckningar', { personal: true });
    const egen = await mina.add({ text: 'Koden till låset' });
    const { fetch, anrop } = fejk({ status: 200, body: { results: [{ id: egen.id, score: 1 }] } });
    const traffar = await searchDocuments<{ text: string }>('anteckningar', 'låset', { personal: true, fetch });
    expect(traffar[0]?.doc.id).toBe(egen.id);
    expect(JSON.parse(String(anrop[0]?.init.body)).personal).toBe(true);
  });

  it('andra fel än "finns inte" släpps inte tyst', async () => {
    configure({ adapter: createMemoryAdapter() });
    await db.collection('arenden').add({ rubrik: 'x' });
    const { fetch } = fejk({ status: 200, body: { results: [{ id: 'inte-ett-id', score: 1 }] } });
    await expect(searchDocuments('arenden', 'x', { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
