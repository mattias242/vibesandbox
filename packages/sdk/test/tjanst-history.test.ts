/**
 * SDK:t för tjänsten `history`: rätt adress, rätt metod, validering före nätverket, och fel som
 * SdkError i klarspråk.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import { history } from '../src/index.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';

const ID = '01j8x0000000000000000000ab';

function fejk(status: number, body: unknown) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, anrop };
}

const RAD = { event: 'replace', at: '2026-09-02T10:00:00.000Z', userId: 'anv-bertil', displayName: 'bertil.berg', data: { status: 'klar' } };

describe('history.forDocument', () => {
  it('GET till dokumentets historik, nyast först som plattformen gav den', async () => {
    const { fetch, anrop } = fejk(200, { entries: [RAD], nextCursor: 'abc' });
    const sida = await history.forDocument('arenden', ID, { fetch });
    expect(sida).toEqual({ entries: [RAD], nextCursor: 'abc' });
    expect(anrop[0]?.url).toBe(`/_api/history/collections/arenden/docs/${ID}`);
    expect(anrop[0]?.init.method).toBe('GET');
  });

  it('limit och cursor följer med, kodade', async () => {
    const { fetch, anrop } = fejk(200, { entries: [] });
    await history.forDocument('arenden', ID, { limit: 10, cursor: 'a b&c', fetch });
    expect(anrop[0]?.url).toBe(`/_api/history/collections/arenden/docs/${ID}?limit=10&cursor=a+b%26c`);
  });

  it('ogiltigt namn eller id avvisas innan något skickas', async () => {
    const { fetch, anrop } = fejk(200, { entries: [] });
    for (const [namn, id] of [['../x', ID], ['arenden', '../../etc'], ['arenden', `${ID}/restore`], ['Arenden', ID]] as const) {
      await expect(history.forDocument(namn, id, { fetch })).rejects.toBeInstanceOf(SdkError);
    }
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(history.forDocument('arenden', ID, { limit, fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(anrop).toHaveLength(0);
  });

  it('plattformens fel blir SdkError med plattformens klarspråk', async () => {
    const { fetch } = fejk(404, { error: { code: 'not_found', message: 'Dokumentet finns inte.' } });
    const fel = (await history.forDocument('arenden', ID, { fetch }).catch((e: unknown) => e)) as SdkError;
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel.code).toBe('not_found');
    expect(fel.message).toBe('Dokumentet finns inte.');
  });

  it('ett svar i fel form blir internal', async () => {
    const { fetch } = fejk(200, { entries: 'nej' });
    await expect(history.forDocument('arenden', ID, { fetch })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('history.forCollection', () => {
  it('GET till kollektionens historik med since', async () => {
    const { fetch, anrop } = fejk(200, { entries: [{ ...RAD, documentId: ID }] });
    const sida = await history.forCollection('arenden', { since: '2026-09-01T00:00:00.000Z', fetch });
    expect(sida.entries[0]?.documentId).toBe(ID);
    expect(anrop[0]?.url).toBe('/_api/history/collections/arenden?since=2026-09-01T00%3A00%3A00.000Z');
  });

  it('utan val: ingen frågesträng', async () => {
    const { fetch, anrop } = fejk(200, { entries: [] });
    await history.forCollection('arenden', { fetch });
    expect(anrop[0]?.url).toBe('/_api/history/collections/arenden');
  });
});

describe('history.restore', () => {
  it('POST med { at } och skyddshuvudet, och ger tillbaka dokumentet', async () => {
    const dokument = { id: ID, data: { status: 'ny' }, createdAt: 'a', updatedAt: 'b' };
    const { fetch, anrop } = fejk(200, dokument);
    expect(await history.restore('arenden', ID, '2026-09-01T10:00:00.000Z', { fetch })).toEqual(dokument);
    expect(anrop[0]?.url).toBe(`/_api/history/collections/arenden/docs/${ID}/restore`);
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(anrop[0]?.init.body).toBe('{"at":"2026-09-01T10:00:00.000Z"}');
  });

  it('en tid som inte är en sträng avvisas innan något skickas', async () => {
    const { fetch, anrop } = fejk(200, {});
    await expect(history.restore('arenden', ID, 42 as unknown as string, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(history.restore('arenden', ID, '', { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toHaveLength(0);
  });
});
