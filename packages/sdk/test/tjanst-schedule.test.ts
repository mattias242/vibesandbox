/**
 * SDK:ts påminnelser (`schedule`): rätt anrop till /_api/schedule, och fel som SdkError.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';
import { cancel, list, remind } from '../src/tjanster/schedule.ts';

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

describe('remind', () => {
  it('POST med tid, mottagare, ämne och text — och ger id och nästa tid', async () => {
    const { fetch, anrop } = fejk({ status: 201, body: { id: 'abc', nextAt: '2026-10-02T07:00:00.000Z' } });
    const svar = await remind({ at: '2026-10-02T09:00:00+02:00', repeat: 'weekly', to: 'all', subject: 'Städdag', text: 'Kl 9.' }, { fetch });
    expect(svar).toEqual({ id: 'abc', nextAt: '2026-10-02T07:00:00.000Z' });
    expect(anrop[0]?.url).toBe('/_api/schedule');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({
      at: '2026-10-02T09:00:00+02:00',
      repeat: 'weekly',
      to: 'all',
      subject: 'Städdag',
      text: 'Kl 9.',
    });
  });

  it('tar ett Date och skickar det som ISO-tid i UTC', async () => {
    const { fetch, anrop } = fejk({ status: 201, body: { id: 'abc', nextAt: '2026-10-02T07:00:00.000Z' } });
    await remind({ at: new Date('2026-10-02T07:00:00Z'), to: ['anv-1'], subject: 'Hej', text: '' }, { fetch });
    const kropp = JSON.parse(String(anrop[0]?.init.body)) as Record<string, unknown>;
    expect(kropp['at']).toBe('2026-10-02T07:00:00.000Z');
    expect('repeat' in kropp).toBe(false);
  });

  it('nekar ett ogiltigt Date innan något skickas', async () => {
    const { fetch, anrop } = fejk({ status: 201, body: {} });
    const fel = await remind({ at: new Date('nej'), to: 'owner', subject: 'x', text: '' }, { fetch }).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect((fel as SdkError).code).toBe('invalid_request');
    expect(anrop).toHaveLength(0);
  });

  it('plattformens felsvar blir SdkError med klarspråk', async () => {
    const { fetch } = fejk({ status: 400, body: { error: { code: 'invalid_request', message: 'Tiden har redan passerat.' } } });
    const fel = (await remind({ at: '2020-01-01T00:00:00Z', to: 'all', subject: 'x', text: '' }, { fetch }).catch((e: unknown) => e)) as SdkError;
    expect(fel.code).toBe('invalid_request');
    expect(fel.message).toBe('Tiden har redan passerat.');
  });
});

describe('list', () => {
  it('GET ger påminnelserna', async () => {
    const paminnelse = { id: 'a', nextAt: '2026-10-02T07:00:00.000Z', repeat: null, to: 'all', subject: 'S', text: 'T', createdBy: 'u' };
    const { fetch, anrop } = fejk({ status: 200, body: { reminders: [paminnelse] } });
    expect(await list({ fetch })).toEqual([paminnelse]);
    expect(anrop[0]?.url).toBe('/_api/schedule');
    expect(anrop[0]?.init.method).toBe('GET');
  });
});

describe('cancel', () => {
  it('DELETE på påminnelsens id', async () => {
    const { fetch, anrop } = fejk({ status: 200, body: { cancelled: true } });
    await cancel('0f8fad5b-d9cb-469f-a165-70867728950e', { fetch });
    expect(anrop[0]?.url).toBe('/_api/schedule/0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(anrop[0]?.init.method).toBe('DELETE');
  });

  it.each(['', '../builder', 'a/b', 'a?b', 'x'.repeat(100)])('nekar id %j utan att anropa', async (id) => {
    const { fetch, anrop } = fejk({ status: 200, body: {} });
    const fel = (await cancel(id, { fetch }).catch((e: unknown) => e)) as SdkError;
    expect(fel.code).toBe('invalid_request');
    expect(anrop).toHaveLength(0);
  });
});
