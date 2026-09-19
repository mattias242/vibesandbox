/**
 * SDK:t för tal till text: `start`, `status` och `transcribe` (som väntar med backoff och tak).
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';
import { start, status, transcribe } from '../src/tjanster/transcribe.ts';

const JOB = 'a'.repeat(32);

function fejk(svar: readonly { status: number; body?: unknown }[]) {
  const anrop: { url: string; init: Parameters<ServiceFetch>[1] }[] = [];
  let i = 0;
  const fetch: ServiceFetch = async (url, init) => {
    anrop.push({ url, init });
    const s = svar[Math.min(i, svar.length - 1)] ?? { status: 500 };
    i += 1;
    return {
      status: s.status,
      ok: s.status >= 200 && s.status < 300,
      headers: { get: () => 'application/json' },
      json: async () => s.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, anrop };
}

describe('start', () => {
  it('POST /_api/transcribe med fileId och språk, skyddshuvud, ger jobId', async () => {
    const { fetch, anrop } = fejk([{ status: 202, body: { jobId: JOB } }]);
    expect(await start('fil-1', { language: 'sv', fetch })).toEqual({ jobId: JOB });
    expect(anrop[0]?.url).toBe('/_api/transcribe');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ fileId: 'fil-1', language: 'sv' });
  });

  it('utan språk skickas inget språk', async () => {
    const { fetch, anrop } = fejk([{ status: 202, body: { jobId: JOB } }]);
    await start('fil-1', { fetch });
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ fileId: 'fil-1' });
  });

  it.each(['', '../x', 'a b', 'x'.repeat(200), 5 as unknown as string])('ogiltigt fil-id %j kastar utan anrop', async (id) => {
    const { fetch, anrop } = fejk([{ status: 202, body: { jobId: JOB } }]);
    await expect(start(id, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toHaveLength(0);
  });

  it('ogiltigt språk kastar utan anrop', async () => {
    const { fetch, anrop } = fejk([]);
    await expect(start('fil-1', { language: 'de' as 'sv', fetch })).rejects.toBeInstanceOf(SdkError);
    expect(anrop).toHaveLength(0);
  });

  it('plattformens fel går vidare med plattformens klarspråk', async () => {
    const { fetch } = fejk([{ status: 429, body: { error: { code: 'rate_limited', message: 'Appens ljudminuter är slut.' } } }]);
    await expect(start('fil-1', { fetch })).rejects.toMatchObject({ code: 'rate_limited', message: 'Appens ljudminuter är slut.' });
  });

  it('ett svar utan jobId blir internal', async () => {
    const { fetch } = fejk([{ status: 202, body: { nej: 1 } }]);
    await expect(start('fil-1', { fetch })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('status', () => {
  it('GET /_api/transcribe/:jobId', async () => {
    const { fetch, anrop } = fejk([{ status: 200, body: { status: 'running' } }]);
    expect(await status(JOB, { fetch })).toEqual({ status: 'running' });
    expect(anrop[0]?.url).toBe(`/_api/transcribe/${JOB}`);
    expect(anrop[0]?.init.method).toBe('GET');
  });

  it('ogiltigt jobb-id kastar utan anrop', async () => {
    const { fetch, anrop } = fejk([]);
    await expect(status('../../collections', { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toHaveLength(0);
  });
});

describe('transcribe', () => {
  it('startar, väntar med växande pauser och ger text och segment', async () => {
    const segments = [{ start: 0, end: 1, text: 'Hej' }];
    const { fetch } = fejk([
      { status: 202, body: { jobId: JOB } },
      { status: 200, body: { status: 'queued' } },
      { status: 200, body: { status: 'running' } },
      { status: 200, body: { status: 'running' } },
      { status: 200, body: { status: 'done', text: 'Hej', segments } },
    ]);
    const pauser: number[] = [];
    const sleep = async (ms: number) => {
      pauser.push(ms);
    };
    expect(await transcribe('fil-1', { fetch, sleep })).toEqual({ text: 'Hej', segments });
    expect(pauser).toHaveLength(4);
    for (let i = 1; i < pauser.length; i += 1) expect(pauser[i]).toBeGreaterThanOrEqual(pauser[i - 1] ?? 0);
    expect(Math.max(...pauser)).toBeLessThanOrEqual(10_000);
  });

  it('ett misslyckat jobb blir ett SdkError med plattformens besked', async () => {
    const { fetch } = fejk([
      { status: 202, body: { jobId: JOB } },
      { status: 200, body: { status: 'failed', error: 'Det gick inte att göra om ljudet till text just nu.' } },
    ]);
    const fel = (await transcribe('fil-1', { fetch, sleep: async () => {} }).catch((e: unknown) => e)) as SdkError;
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel.message).toBe('Det gick inte att göra om ljudet till text just nu.');
  });

  it('ger upp efter taket och säger det i klarspråk', async () => {
    const { fetch, anrop } = fejk([{ status: 202, body: { jobId: JOB } }, { status: 200, body: { status: 'running' } }]);
    let klocka = 0;
    const sleep = async (ms: number) => {
      klocka += ms;
    };
    const fel = (await transcribe('fil-1', { fetch, sleep, now: () => klocka, maxWaitMs: 60_000 }).catch((e: unknown) => e)) as SdkError;
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel.message).toMatch(/tar lång tid/);
    expect(anrop.length).toBeLessThan(40);
  });
});
