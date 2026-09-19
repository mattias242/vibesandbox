/**
 * SDK:t för tjänsten `roles`: rätt adress och metod, skyddshuvudet på skrivande anrop, och fel
 * som `SdkError`. Webbläsarens `fetch` byts mot en fejk för varje test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../src/errors.ts';
import * as roles from '../src/tjanster/roles.ts';

interface Anrop {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

let anrop: Anrop[];
let svar: { status: number; body?: unknown }[];

beforeEach(() => {
  anrop = [];
  svar = [];
  vi.stubGlobal('fetch', async (url: string, init: Anrop['init']) => {
    anrop.push({ url, init });
    const nasta = svar.shift() ?? { status: 200, body: {} };
    return {
      status: nasta.status,
      ok: nasta.status >= 200 && nasta.status < 300,
      headers: { get: () => 'application/json' },
      json: async () => nasta.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BERTIL = { userId: 'anv-bertil', displayName: 'bertil', access: 'user', roles: ['admin'] };

describe('roles i SDK:t', () => {
  it('members() hämtar medlemmarna', async () => {
    svar.push({ status: 200, body: [BERTIL] });
    expect(await roles.members()).toEqual([BERTIL]);
    expect(anrop[0]?.url).toBe('/_api/roles/members');
    expect(anrop[0]?.init.method).toBe('GET');
  });

  it('me() hämtar den inloggade', async () => {
    svar.push({ status: 200, body: { userId: 'anv-bertil', access: 'user', roles: [] } });
    expect(await roles.me()).toEqual({ userId: 'anv-bertil', access: 'user', roles: [] });
    expect(anrop[0]?.url).toBe('/_api/roles/me');
  });

  it('definitions() hämtar appens roller', async () => {
    svar.push({ status: 200, body: [{ id: 'admin', name: 'Admin' }] });
    expect(await roles.definitions()).toEqual([{ id: 'admin', name: 'Admin' }]);
    expect(anrop[0]?.url).toBe('/_api/roles/definitions');
  });

  it('setDefinitions() skickar hela listan med PUT och skyddshuvudet', async () => {
    const defs = [{ id: 'handlaggare', name: 'Handläggare' }];
    svar.push({ status: 200, body: defs });
    expect(await roles.setDefinitions(defs)).toEqual(defs);
    expect(anrop[0]?.url).toBe('/_api/roles/definitions');
    expect(anrop[0]?.init.method).toBe('PUT');
    expect(anrop[0]?.init.headers[CSRF_HEADER]).toBe('1');
    expect(JSON.parse(anrop[0]?.init.body ?? '')).toEqual(defs);
  });

  it('assign() skickar rollerna till medlemmens adress, med id:t kodat', async () => {
    svar.push({ status: 200, body: BERTIL });
    expect(await roles.assign('anv-bertil', ['admin'])).toEqual(BERTIL);
    expect(anrop[0]?.url).toBe('/_api/roles/members/anv-bertil');
    expect(anrop[0]?.init.method).toBe('PUT');
    expect(JSON.parse(anrop[0]?.init.body ?? '')).toEqual({ roles: ['admin'] });

    svar.push({ status: 200, body: { ...BERTIL, userId: 'a b@c', roles: [] } });
    await roles.assign('a b@c', []);
    expect(anrop[1]?.url).toBe('/_api/roles/members/a%20b%40c');
  });

  it.each([[''], ['..'], ['.'], [7 as unknown as string]])('assign() med id:t %j går aldrig iväg', async (userId) => {
    const fel = await roles.assign(userId, []).catch((e: unknown) => e);
    expect(fel).toBeInstanceOf(SdkError);
    expect((fel as SdkError).code).toBe('invalid_request');
    expect(anrop).toHaveLength(0);
  });

  it('has() svarar för den inloggade', async () => {
    svar.push({ status: 200, body: { userId: 'anv-bertil', access: 'user', roles: ['admin'] } });
    expect(await roles.has('admin')).toBe(true);
    svar.push({ status: 200, body: { userId: 'anv-bertil', access: 'user', roles: ['admin'] } });
    expect(await roles.has('handlaggare')).toBe(false);
  });

  it('has() räknar inte ägaren som innehavare av alla roller', async () => {
    svar.push({ status: 200, body: { userId: 'anv-anna', access: 'owner', roles: [] } });
    expect(await roles.has('admin')).toBe(false);
  });

  it('plattformens nej blir SdkError med plattformens klarspråk', async () => {
    svar.push({ status: 403, body: { error: { code: 'forbidden', message: 'Bara appens ägare kan ändra roller.' } } });
    const fel = (await roles.setDefinitions([]).catch((e: unknown) => e)) as SdkError;
    expect(fel).toBeInstanceOf(SdkError);
    expect(fel.code).toBe('forbidden');
    expect(fel.message).toBe('Bara appens ägare kan ändra roller.');
  });

  it('ett svar med fel form blir internal, inte ett krasch längre fram i appen', async () => {
    svar.push({ status: 200, body: { inte: 'en lista' } });
    expect(((await roles.members().catch((e: unknown) => e)) as SdkError).code).toBe('internal');
    svar.push({ status: 200, body: { userId: 'x' } });
    expect(((await roles.me().catch((e: unknown) => e)) as SdkError).code).toBe('internal');
  });
});
