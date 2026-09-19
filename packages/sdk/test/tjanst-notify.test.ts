/**
 * SDK:t för tjänsten `notify`: rätt anrop till `/_api/notify`, felen som `SdkError` i klarspråk,
 * och uppenbart fel indata stoppas innan något skickas.
 */
import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import type { ServiceFetch } from '../src/tjanster/anrop.ts';
import { send, setMuted, settings } from '../src/tjanster/notify.ts';

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

describe('notify.send', () => {
  it('POST till /_api/notify med skyddshuvudet och meddelandet som JSON', async () => {
    const { fetch, anrop } = fejk(200, { sent: 2 });
    expect(await send({ to: 'all', subject: 'Hej', text: 'Välkomna!' }, { fetch })).toEqual({ sent: 2 });
    expect(anrop[0]?.url).toBe('/_api/notify');
    expect(anrop[0]?.init.method).toBe('POST');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ to: 'all', subject: 'Hej', text: 'Välkomna!' });
  });

  it('skickar en lista med användar-id som den är', async () => {
    const { fetch, anrop } = fejk(200, { sent: 1 });
    await send({ to: ['u-1', 'u-2'], subject: 'Hej', text: 'Hej' }, { fetch });
    expect(JSON.parse(String(anrop[0]?.init.body)).to).toEqual(['u-1', 'u-2']);
  });

  it('ger vidare att ett utkast bara mejlade ägaren', async () => {
    const { fetch } = fejk(200, { sent: 1, onlyOwner: true, message: 'Det här är ett utkast …' });
    expect(await send({ to: 'all', subject: 'Hej', text: 'Hej' }, { fetch })).toEqual({
      sent: 1,
      onlyOwner: true,
      message: 'Det här är ett utkast …',
    });
  });

  it('plattformens felmeddelande blir ett SdkError med samma klarspråk', async () => {
    const { fetch } = fejk(429, { error: { code: 'rate_limited', message: 'Du har skickat för många aviseringar den senaste timmen.' } });
    const fel = await send({ to: 'all', subject: 'Hej', text: 'Hej' }, { fetch }).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect((fel as SdkError).code).toBe('rate_limited');
    expect((fel as SdkError).message).toMatch(/för många aviseringar/);
  });

  it.each([
    [{ to: 'everyone', subject: 'Hej', text: 'Hej' }],
    [{ to: [], subject: 'Hej', text: 'Hej' }],
    [{ to: [1], subject: 'Hej', text: 'Hej' }],
    [{ to: 'all', subject: '', text: 'Hej' }],
    [{ to: 'all', subject: 'Hej', text: 3 }],
    [null],
  ])('stoppar uppenbart fel indata %j innan något skickas', async (meddelande) => {
    const { fetch, anrop } = fejk(200, { sent: 0 });
    await expect(send(meddelande as never, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toEqual([]);
  });

  it('ett svar utan antal räknas som ett fel hos plattformen', async () => {
    const { fetch } = fejk(200, { skickat: 'två' });
    await expect(send({ to: 'all', subject: 'Hej', text: 'Hej' }, { fetch })).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('notify.settings och notify.setMuted', () => {
  it('läser den inloggades inställning med GET', async () => {
    const { fetch, anrop } = fejk(200, { muted: false });
    expect(await settings({ fetch })).toEqual({ muted: false });
    expect(anrop[0]?.url).toBe('/_api/notify/settings');
    expect(anrop[0]?.init.method).toBe('GET');
  });

  it('stänger av och på med PUT', async () => {
    const { fetch, anrop } = fejk(200, { muted: true });
    expect(await setMuted(true, { fetch })).toEqual({ muted: true });
    expect(anrop[0]?.init.method).toBe('PUT');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(String(anrop[0]?.init.body))).toEqual({ muted: true });
  });

  it('kräver true eller false', async () => {
    const { fetch, anrop } = fejk(200, { muted: true });
    await expect(setMuted('ja' as never, { fetch })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(anrop).toEqual([]);
  });
});
