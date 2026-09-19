/**
 * Tjänsten `history` mot en riktig lagring (data-API med historiken påslagen). Gatewayn är inte
 * med här: förfrågan byggs som gatewayn skulle ha byggt den, med tenant, identitet och åtkomst.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppId,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  Identity,
  TenantContext,
  TenantStore,
} from '@vibesandbox/contracts';
import { createTenantStore } from '@vibesandbox/data-api';
import { factory } from '@vibesandbox/tjanst-history';

const APP = '0123456789abcdefghjkmnpqrs' as AppId;
const ANNAN_APP = 'zzzzzzzzzzzzzzzzzzzzzzzzzz' as AppId;

const anna: Identity = { userId: 'anv-anna', email: 'anna.andersson@exempel.se', roles: ['viewer'] };
const bertil: Identity = { userId: 'anv-bertil', email: 'bertil.berg@exempel.se', roles: ['viewer'] };
const cecilia: Identity = { userId: 'anv-cecilia', email: 'cecilia@exempel.se', roles: ['viewer'] };

interface Loggrad {
  readonly level: string;
  readonly event: string;
  readonly [nyckel: string]: unknown;
}

function beroenden(dataDir: string, store: TenantStore, loggar: Loggrad[]): AppServiceDependencies {
  return {
    dataDir,
    env: {},
    log: (rad) => loggar.push(rad),
    now: () => new Date(),
    members: {
      members: async (appId) =>
        appId === APP
          ? [
              { userId: 'anv-anna', role: 'owner', email: 'anna.andersson@exempel.se' },
              { userId: 'anv-bertil', role: 'user', email: 'bertil.berg@exempel.se' },
            ]
          : [],
    },
    store,
    publishedUrl: (appId) => `https://${appId}.appar.test/`,
  };
}

describe('tjänsten history', () => {
  let dataDir: string;
  let store: TenantStore;
  let tjanst: AppService;
  let loggar: Loggrad[];
  const app: TenantContext = unsafeCreateTenantContext(APP, 'published');

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibesandbox-tjanst-history-'));
    store = createTenantStore({ dataDir, history: { retentionDays: 365 } });
    loggar = [];
    if (factory === undefined) throw new Error('Fabriken saknas.');
    tjanst = factory(beroenden(dataDir, store, loggar)).service;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function anropa(
    identity: Identity,
    method: string,
    sokvag: string,
    extra: { body?: unknown; rå?: string; tenant?: TenantContext; access?: AppAccessRole; contentType?: string } = {},
  ): Promise<AppServiceResponse> {
    const [vag = '', query = ''] = sokvag.split('?');
    const text = extra.rå ?? (extra.body === undefined ? undefined : JSON.stringify(extra.body));
    const request: AppServiceRequest = {
      method,
      segments: vag.split('/').filter((del) => del.length > 0),
      query,
      headers: text === undefined ? {} : { 'content-type': extra.contentType ?? 'application/json' },
      tenant: extra.tenant ?? app,
      identity,
      access: extra.access ?? 'user',
      ...(text === undefined ? {} : { body: new TextEncoder().encode(text) }),
    };
    return tjanst.handle(request);
  }

  function kropp(svar: AppServiceResponse): Record<string, unknown> {
    expect(svar.headers['Content-Type']).toMatch(/^application\/json/);
    return JSON.parse(String(svar.body)) as Record<string, unknown>;
  }

  function felkod(svar: AppServiceResponse): unknown {
    return (kropp(svar) as { error?: { code?: unknown; message?: unknown } }).error?.code;
  }

  describe('start', () => {
    it('heter history och har en liten kroppsgräns', () => {
      expect(tjanst.name).toBe('history');
      expect(tjanst.maxBodyBytes).toBeLessThanOrEqual(4096);
    });

    it('vägrar starta mot en lagring där historiken är avstängd', async () => {
      const utan = createTenantStore({ dataDir: join(dataDir, 'utan') });
      try {
        expect(() => factory?.(beroenden(dataDir, utan, []))).toThrow(/historik/i);
      } finally {
        await utan.close();
      }
    });
  });

  describe('läsa', () => {
    it('dokumentets historik, nyast först, med visningsnamn och aldrig e-post', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { status: 'ny' });
      await store.replaceDocument(app, bertil, 'arenden', dok.id, { status: 'klar' });

      const svar = await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}`);
      expect(svar.status).toBe(200);
      expect(svar.headers['Cache-Control']).toBe('no-store');
      const { entries, nextCursor } = kropp(svar) as { entries: Record<string, unknown>[]; nextCursor?: string };
      expect(entries.map(({ event, userId, displayName, data }) => ({ event, userId, displayName, data }))).toEqual([
        { event: 'replace', userId: 'anv-bertil', displayName: 'bertil.berg', data: { status: 'klar' } },
        { event: 'create', userId: 'anv-anna', displayName: 'anna.andersson', data: { status: 'ny' } },
      ]);
      expect(entries[0]?.['at']).toMatch(/Z$/);
      expect(nextCursor).toBeUndefined();
      expect(String(svar.body)).not.toContain('@');
    });

    it('den som inte längre är medlem visas neutralt, utan id-gissning eller e-post', async () => {
      await store.createDocument(app, cecilia, 'arenden', 'app', { a: 1 });
      const svar = await anropa(anna, 'GET', '/collections/arenden');
      const [rad] = (kropp(svar) as { entries: Record<string, unknown>[] }).entries;
      expect(rad?.['displayName']).toBe('Tidigare användare');
      expect(String(svar.body)).not.toContain('cecilia@');
    });

    it('sidindelning med limit och cursor', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { n: 0 });
      for (let n = 1; n <= 3; n++) await store.replaceDocument(app, anna, 'arenden', dok.id, { n });
      const forsta = kropp(await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}?limit=2`)) as {
        entries: { data: { n: number } }[];
        nextCursor: string;
      };
      expect(forsta.entries.map((rad) => rad.data.n)).toEqual([3, 2]);
      const andra = kropp(
        await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}?limit=2&cursor=${encodeURIComponent(forsta.nextCursor)}`),
      ) as { entries: { data: { n: number } }[]; nextCursor?: string };
      expect(andra.entries.map((rad) => rad.data.n)).toEqual([1, 0]);
      expect(andra.nextCursor).toBeUndefined();
    });

    it('kollektionens historik med since, och dokument-id i varje rad', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { n: 0 });
      vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
      await store.replaceDocument(app, bertil, 'arenden', dok.id, { n: 1 });

      const svar = await anropa(anna, 'GET', '/collections/arenden?since=2026-09-01T10:00:00.000Z');
      const { entries } = kropp(svar) as { entries: Record<string, unknown>[] };
      expect(entries).toEqual([
        { documentId: dok.id, event: 'replace', at: '2026-09-02T10:00:00.000Z', userId: 'anv-bertil', displayName: 'bertil.berg', data: { n: 1 } },
      ]);
    });
  });

  describe('återställa', () => {
    it('skriver en ny version och svarar med dokumentet', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { status: 'ny' });
      vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
      await store.replaceDocument(app, bertil, 'arenden', dok.id, { status: 'fel' });

      const svar = await anropa(bertil, 'POST', `/collections/arenden/docs/${dok.id}/restore`, { body: { at: dok.createdAt } });
      expect(svar.status).toBe(200);
      expect(kropp(svar)).toMatchObject({ id: dok.id, data: { status: 'ny' } });
      expect((await store.getDocument(app, anna, 'arenden', dok.id)).data).toEqual({ status: 'ny' });
      // Loggen säger att något återställdes — men aldrig vad eller av vem med e-post.
      expect(loggar.some((rad) => rad.event === 'history_restore')).toBe(true);
      expect(JSON.stringify(loggar)).not.toContain('status');
      expect(JSON.stringify(loggar)).not.toContain('@');
    });

    it('en tid som inte finns ger 404', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      const svar = await anropa(anna, 'POST', `/collections/arenden/docs/${dok.id}/restore`, { body: { at: '2001-01-01T00:00:00.000Z' } });
      expect(svar.status).toBe(404);
      expect(felkod(svar)).toBe('not_found');
    });

    it('fel kropp avvisas: inte JSON, fel typ, okända fält, fel innehållstyp', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      const vag = `/collections/arenden/docs/${dok.id}/restore`;
      const fall = [
        { rå: '{inte json' },
        { body: [] },
        { body: { at: 12 } },
        { body: { at: dok.createdAt, userId: 'anv-bertil' } },
        { body: { at: dok.createdAt }, contentType: 'text/plain' },
        {},
      ];
      for (const extra of fall) {
        const svar = await anropa(anna, 'POST', vag, extra);
        expect(svar.status, JSON.stringify(extra)).toBe(400);
        expect(felkod(svar)).toBe('invalid_request');
      }
    });
  });

  describe('fientliga anrop', () => {
    it('någon annans personliga dokument: historik och återställning "finns inte"', async () => {
      const dok = await store.createDocument(app, anna, 'privat', 'user', { anteckning: 'hemlig' });
      const las = await anropa(bertil, 'GET', `/collections/privat/docs/${dok.id}`);
      const aterstall = await anropa(bertil, 'POST', `/collections/privat/docs/${dok.id}/restore`, { body: { at: dok.createdAt } });
      for (const svar of [las, aterstall]) {
        expect(svar.status).toBe(404);
        expect(String(svar.body)).not.toContain('hemlig');
      }
      expect((kropp(await anropa(bertil, 'GET', '/collections/privat')) as { entries: unknown[] }).entries).toEqual([]);
    });

    it('en annan app ser inte appens historik', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      const annan = unsafeCreateTenantContext(ANNAN_APP, 'published');
      expect((await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}`, { tenant: annan })).status).toBe(404);
      expect((await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}`, { tenant: unsafeCreateTenantContext(APP, 'draft') })).status).toBe(404);
    });

    it('dokument-id med ../, NUL och fel skiftläge avvisas utan att röja något', async () => {
      for (const id of ['..', '%2e%2e', '..%2f..%2fetc', `${'0'.repeat(25)}%00`, 'A'.repeat(26), 'x'.repeat(5000)]) {
        const svar = await anropa(anna, 'GET', `/collections/arenden/docs/${id}`);
        expect([400, 404], id).toContain(svar.status);
      }
      const svar = await anropa(anna, 'GET', '/collections/../docs/x');
      expect([400, 404]).toContain(svar.status);
    });

    it('dubbla, okända och ogiltiga frågeparametrar avvisas', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      for (const fraga of ['limit=1&limit=2', 'appId=zzz', 'limit=0', 'limit=abc', 'limit=99999999999', 'since=igår', 'cursor=x', 'since=2026-01-01T00:00:00.000Z']) {
        const svar = await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}?${fraga}`);
        expect(svar.status, fraga).toBe(400);
      }
      for (const fraga of ['since=a&since=b', 'userId=anv-bertil']) {
        expect((await anropa(anna, 'GET', `/collections/arenden?${fraga}`)).status, fraga).toBe(400);
      }
    });

    it('okända vägar ger 404 och fel metod 405', async () => {
      const dok = await store.createDocument(app, anna, 'arenden', 'app', { a: 1 });
      expect((await anropa(anna, 'GET', '')).status).toBe(404);
      expect((await anropa(anna, 'GET', '/collections')).status).toBe(404);
      expect((await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}/extra/del`)).status).toBe(404);
      expect((await anropa(anna, 'DELETE', `/collections/arenden/docs/${dok.id}`)).status).toBe(405);
      expect((await anropa(anna, 'GET', `/collections/arenden/docs/${dok.id}/restore`)).status).toBe(405);
      expect((await anropa(anna, 'POST', '/collections/arenden', { body: {} })).status).toBe(405);
    });
  });
});
