/**
 * En låtsasversion av byggverktygets HTTP-gränssnitt för `npm run dev`, så att gränssnittet går
 * att klicka runt i utan backend. Den följer kontraktet (`/_api/builder/…`) men bygger ingenting:
 * ett jobb är en förinspelad följd av händelser som släpps under några sekunder.
 *
 * Används BARA av Vites utvecklingsserver (`apply: 'serve'`) och följer aldrig med i bygget —
 * `test/build.test.ts` letar efter MOCK_MARKER i det byggda och fäller om den finns.
 *
 * Prova felvägarna genom att skriva:
 *   "fel" i ett önskemål   → första kontrollen hittar fel, som sedan rättas
 *   "stopp" i ett önskemål → bygget misslyckas med en förklaring
 *   "upptagen@…" vid delning → 429 (för många inbjudningar)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  BUILDER_API_PREFIX,
  CSRF_HEADER,
  type AgentEvent,
  type ApiErrorBody,
  type ApiErrorCode,
  type BuilderAppDetail,
  type BuilderJob,
  type BuilderMessage,
} from '@vibesandbox/contracts';

export const MOCK_MARKER = 'vibesandbox-builder-ui-mock';

interface MockApp {
  appId: string;
  name: string;
  updatedAt: string;
  hasDraft: boolean;
  published: boolean;
  draftVersion: number;
  publishedVersion: number;
  messages: BuilderMessage[];
  job?: { jobId: string };
}

interface MockJob {
  jobId: string;
  appId: string;
  startedAt: number;
  /** Händelse och hur många ms efter start den släpps. */
  script: Array<{ atMs: number; event: AgentEvent }>;
  ok: boolean;
  summary: string;
  settled: boolean;
}

const apps = new Map<string, MockApp>();
const jobs = new Map<string, MockJob>();
let counter = 0;

function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`.slice(0, 26);
}

function now(): string {
  return new Date().toISOString();
}

function nameFrom(text: string): string {
  const first = text.trim().split(/[.!?\n]/)[0] ?? '';
  const name = first.replace(/^(en|ett)\s+/i, '');
  const short = name.length > 40 ? `${name.slice(0, 40).trimEnd()}…` : name;
  return short.charAt(0).toUpperCase() + short.slice(1) || 'Min app';
}

function scriptFor(text: string): { script: MockJob['script']; ok: boolean; summary: string } {
  const lower = text.toLowerCase();
  const script: MockJob['script'] = [{ atMs: 300, event: { type: 'status', message: 'Jag skriver koden till din app.' } }];
  for (let i = 1; i <= 8; i += 1) script.push({ atMs: 300 + i * 400, event: { type: 'progress', outputChars: i * 1400 } });
  script.push({ atMs: 3800, event: { type: 'files', paths: ['src/App.tsx', 'src/styles.css'] } });

  if (lower.includes('stopp')) {
    const summary =
      'Appen skulle ha skickat uppgifter till en annan adress på internet, och det är inte tillåtet här. Beskriv gärna appen utan den delen.';
    script.push({ atMs: 5000, event: { type: 'check', ok: false, problems: 1 } });
    script.push({ atMs: 5300, event: { type: 'done', ok: false, message: summary } });
    return { script, ok: false, summary };
  }

  let at = 5200;
  if (lower.includes('fel')) {
    script.push({ atMs: at, event: { type: 'check', ok: false, problems: 2 } });
    script.push({ atMs: at + 300, event: { type: 'status', message: 'Jag rättar två fel som kontrollen hittade.' } });
    for (let i = 1; i <= 4; i += 1) script.push({ atMs: at + 300 + i * 400, event: { type: 'progress', outputChars: i * 900 } });
    script.push({ atMs: at + 2200, event: { type: 'files', paths: ['src/App.tsx'] } });
    at += 3400;
  }
  const summary = 'Klart! Appen finns nu i förhandsvisningen till höger. Prova den och skriv om du vill ändra något.';
  script.push({ atMs: at, event: { type: 'check', ok: true, problems: 0 } });
  script.push({ atMs: at + 300, event: { type: 'done', ok: true, message: summary } });
  return { script, ok: true, summary };
}

function jobStatus(job: MockJob): { status: BuilderJob['status']; released: AgentEvent[] } {
  const elapsed = Date.now() - job.startedAt;
  const released = job.script.filter((item) => item.atMs <= elapsed).map((item) => item.event);
  const finished = released.length === job.script.length;
  if (finished && !job.settled) {
    job.settled = true;
    const app = apps.get(job.appId);
    if (app !== undefined) {
      app.messages.push({ role: 'assistant', text: job.summary, createdAt: now() });
      app.updatedAt = now();
      if (job.ok) {
        app.hasDraft = true;
        app.draftVersion += 1;
      }
    }
  }
  if (finished) return { status: job.ok ? 'done' : 'failed', released };
  return { status: elapsed < 700 ? 'queued' : 'running', released };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: ApiErrorCode, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  send(res, status, body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function origin(req: IncomingMessage): string {
  return `http://${req.headers.host ?? '127.0.0.1:5173'}`;
}

function previewHtml(app: MockApp, version: number, kind: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${escape(app.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f6f8fb;color:#1b2533}
h1{font-size:1.4rem}li{background:#fff;border:1px solid #d5dce6;border-radius:6px;padding:10px 12px;margin:6px 0;list-style:none}
ul{padding:0}small{color:#4a5668}</style></head><body data-mock="${MOCK_MARKER}">
<h1>${escape(app.name)}</h1><small>${escape(kind)} · version ${version} (låtsas-app från utvecklingsläget)</small>
<ul><li>☐ Köpa kaffe till fikat</li><li>☑ Boka mötesrum</li><li>☐ Skicka protokollet</li></ul></body></html>`;
}

function detail(app: MockApp, req: IncomingMessage): BuilderAppDetail {
  const { draftVersion: _d, publishedVersion: _p, job, ...summary } = app;
  const current = job === undefined ? undefined : jobs.get(job.jobId);
  return {
    ...summary,
    messages: [...app.messages],
    ...(app.published ? { publishedUrl: `${origin(req)}/_mock/published/${app.appId}` } : {}),
    ...(current === undefined ? {} : { job: { jobId: current.jobId, status: jobStatus(current).status } }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mock');
  const method = req.method ?? 'GET';
  const path = url.pathname.slice(BUILDER_API_PREFIX.length);

  if (method === 'POST' && req.headers[CSRF_HEADER] !== '1') {
    fail(res, 403, 'forbidden', 'Åtkomst nekad.');
    return;
  }

  if (method === 'GET' && path === '/me') return send(res, 200, { displayName: 'Anna', canBuild: true });

  if (path === '/apps') {
    if (method === 'GET') {
      const list = [...apps.values()]
        .map(({ appId, name, updatedAt, hasDraft, published }) => ({ appId, name, updatedAt, hasDraft, published }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return send(res, 200, { apps: list });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const appId = newId('a');
      apps.set(appId, {
        appId,
        name: typeof body['name'] === 'string' && body['name'].trim() !== '' ? body['name'].trim().slice(0, 80) : 'Ny app',
        updatedAt: now(),
        hasDraft: false,
        published: false,
        draftVersion: 0,
        publishedVersion: 0,
        messages: [],
      });
      return send(res, 201, { appId });
    }
  }

  const jobMatch = /^\/jobs\/([\w-]+)$/.exec(path);
  if (jobMatch !== null && method === 'GET') {
    const job = jobs.get(jobMatch[1] ?? '');
    if (job === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
    const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0);
    const { status, released } = jobStatus(job);
    const body: BuilderJob = { jobId: job.jobId, appId: job.appId, status, events: released.slice(after), next: released.length };
    return send(res, 200, body);
  }

  const appMatch = /^\/apps\/([\w-]+)(?:\/(messages|publish|open|share))?$/.exec(path);
  const app = appMatch === null ? undefined : apps.get(appMatch[1] ?? '');
  if (appMatch === null || app === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
  const action = appMatch[2];

  if (action === undefined && method === 'GET') return send(res, 200, detail(app, req));

  if (action === 'messages' && method === 'POST') {
    const current = app.job === undefined ? undefined : jobs.get(app.job.jobId);
    if (current !== undefined && !['done', 'failed'].includes(jobStatus(current).status)) {
      return fail(res, 409, 'scope_mismatch', 'Appen byggs redan.');
    }
    const body = await readJson(req);
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (text === '') return fail(res, 400, 'invalid_request', 'Skriv vad du vill att appen ska göra.');
    if (app.messages.length === 0 && app.name === 'Ny app') app.name = nameFrom(text);
    app.messages.push({ role: 'user', text, createdAt: now() });
    app.updatedAt = now();
    const jobId = newId('j');
    jobs.set(jobId, { jobId, appId: app.appId, startedAt: Date.now(), settled: false, ...scriptFor(text) });
    app.job = { jobId };
    return send(res, 202, { jobId });
  }

  if (action === 'publish' && method === 'POST') {
    if (!app.hasDraft) return fail(res, 409, 'scope_mismatch', 'Det finns inget färdigt utkast att publicera.');
    app.published = true;
    app.publishedVersion = app.draftVersion;
    app.updatedAt = now();
    return send(res, 200, { publishedUrl: `${origin(req)}/_mock/published/${app.appId}` });
  }

  if (action === 'open' && method === 'GET') {
    const target = url.searchParams.get('target');
    if (target === 'preview' && app.hasDraft) return send(res, 200, { url: `${origin(req)}/_mock/preview/${app.appId}` });
    if (target === 'published' && app.published) return send(res, 200, { url: `${origin(req)}/_mock/published/${app.appId}` });
    return fail(res, 404, 'not_found', 'Det finns inte.');
  }

  if (action === 'share' && method === 'POST') {
    if (!app.published) return fail(res, 409, 'scope_mismatch', 'Appen är inte publicerad.');
    const body = await readJson(req);
    const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return fail(res, 400, 'invalid_request', 'Ogiltig adress.');
    if (email.startsWith('upptagen@')) return fail(res, 429, 'rate_limited', 'För många försök.');
    return send(res, 200, { shared: true });
  }

  fail(res, 405, 'method_not_allowed', 'Det går inte.');
}

export function builderApiMock(): Plugin {
  return {
    name: 'vibesandbox-builder-api-mock',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const mockPage = /^\/_mock\/(preview|published)\/([\w-]+)$/.exec(path);
        if (mockPage !== null) {
          const app = apps.get(mockPage[2] ?? '');
          if (app === undefined) {
            res.statusCode = 404;
            res.end('Finns inte');
            return;
          }
          const preview = mockPage[1] === 'preview';
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(previewHtml(app, preview ? app.draftVersion : app.publishedVersion, preview ? 'Förhandsvisning' : 'Publicerad'));
          return;
        }
        if (path !== BUILDER_API_PREFIX && !path.startsWith(`${BUILDER_API_PREFIX}/`)) {
          next();
          return;
        }
        handle(req, res).catch((error: unknown) => {
          console.error('[mock]', error);
          fail(res, 500, 'internal', 'Något gick fel i låtsas-servern.');
        });
      });
    },
  };
}
