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
 * Åtkomstlistan: den som delas med hamnar i listan; att ta bort "fast@…" ger 500.
 *
 * Kontrollrummet (#/admin) är påslaget: `/me` svarar `isAdmin: true`. Starta med ADMIN_NEKAD=1
 * för att se hur vyn möter ett nej från servern — länken visas fortfarande, för vyn får aldrig
 * lita på `isAdmin`.
 *
 * Adresslistan i kontrollrummet ändrar låtsas-serverns EGET tillstånd, så att en inbjudan och en
 * rolländring går att klicka igenom på riktigt och syns i siffrorna. Felvägarna:
 *   "upptagen@…"          → 429 (för många ändringar)
 *   "krock@…"             → 409 (någon annan hann före)
 *   den egna raden        → 400 (servern nekar; vyn erbjuder det aldrig)
 *
 * Avveckling och export går att klicka igenom på riktigt: exporten ger påhittad appdata, och en
 * avvecklad app försvinner ur ägarens lista men står kvar i AI-registret. Starta med
 * AVVECKLING_SAKNAS=1 för att se hur vyn möter en installation där de inte är inkopplade (503).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  ADMIN_APP_ID_PREFIX_LENGTH,
  BUILDER_API_PREFIX,
  CSRF_HEADER,
  type AdminApp,
  type AdminOverview,
  type AgentEvent,
  type AppServiceName,
  type ApiErrorCode,
  type BuilderAppDetail,
  type BuilderJob,
  type AdminRegisterEntry,
  type AdminReview,
  type AppExport,
  type DecommissionEvidence,
  type BuilderMessage,
  type Classification,
  type ClassificationSource,
  type RedlineCategory,
  type ReviewState,
  type Role,
  type SourceFiles,
} from '@vibesandbox/contracts';

export const MOCK_MARKER = 'vibesandbox-builder-ui-mock';

interface MockApp {
  appId: string;
  name: string;
  /** Sant när ÄGAREN valt namnet. Ett valt namn följer med till kontrollrummet; en avskrift gör det inte. */
  namnValt: boolean;
  updatedAt: string;
  hasDraft: boolean;
  published: boolean;
  draftVersion: number;
  publishedVersion: number;
  messages: BuilderMessage[];
  job?: { jobId: string };
  /** Senaste granskningsärendet. Ägaren publicerar inte själv — hon begär, och någon läser. */
  review?: { reviewId: string; state: ReviewState; requestedAt: string; decidedAt: string | null; reason: string | null };
  classification: Classification;
  classificationSource: ClassificationSource;
  /** Adress → medlems-id för dem appen delats med. Ägaren läggs till i svaret. */
  members: Map<string, string>;
  /**
   * När appen avvecklades, eller `null` så länge den lever. En avvecklad app finns inte längre för
   * sin ägare — men raden i AI-registret står kvar, precis som i den riktiga plattformen.
   */
  decommissionedAt: string | null;
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

/**
 * Påslagna tjänster i utvecklingsläget, så att guiden "Vilka tjänster finns som appen kan använda?"
 * visar något. Bytt lista ⇒ andra rubriker i guiden. Påminnelser kräver mejl, och att läsa text i
 * bilder kräver filer — samma regel som i plattformen.
 */
const MOCK_SERVICES: AppServiceName[] = ['files', 'notify', 'llm', 'ocr', 'schedule', 'history'];

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

/**
 * Kontrollrummet ska vara värt att titta på direkt: flera appar, olika ägare, några publicerade
 * och en utan ägare kvar. De här raderna är påhittade och finns bara i utvecklingsläget — de
 * appar man själv bygger under körningen läggs till ovanpå dem.
 *
 * Bara början av app-id:t, aldrig hela: raderna följer samma regel som den riktiga rutten.
 */
const ADMIN_DEMO_APPS: readonly AdminApp[] = [
  {
    appId: 'a01f3c7d0000000000000000dm',
    appIdPrefix: 'a01f3c7d',
    appUrl: 'https://a01f3c7d0000000000000000dm.example.test/',
    name: 'Bokning av mötesrum',
    ownerEmail: 'anna@example.se',
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    hasDraft: true,
    published: true,
    members: 7,
    tokens: { input: 184_200, output: 61_400 },
  },
  {
    appId: 'b92ka4m10000000000000000dm',
    appIdPrefix: 'b92ka4m1',
    appUrl: 'https://b92ka4m10000000000000000dm.example.test/',
    name: 'Anmälan till städdagen',
    ownerEmail: 'karin@example.se',
    updatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    hasDraft: false,
    published: true,
    members: 23,
    tokens: { input: 92_800, output: 31_100 },
  },
  {
    appId: 'c55prt090000000000000000dm',
    appIdPrefix: 'c55prt09',
    appUrl: 'https://c55prt090000000000000000dm.example.test/',
    name: 'Checklista för nyanställda',
    ownerEmail: 'johan@example.se',
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    hasDraft: true,
    published: false,
    members: 2,
    tokens: { input: 40_150, output: 12_900 },
  },
  {
    appId: 'd7zq2x880000000000000000dm',
    appIdPrefix: 'd7zq2x88',
    appUrl: 'https://d7zq2x880000000000000000dm.example.test/',
    name: 'Enkät om fikat',
    ownerEmail: null,
    updatedAt: new Date(Date.now() - 41 * 24 * 60 * 60 * 1000).toISOString(),
    hasDraft: false,
    published: false,
    members: 1,
    tokens: { input: 5_300, output: 1_100 },
  },
];

interface MockUser {
  userId: string;
  email: string;
  role: Role;
  createdAt: string;
  self: boolean;
}

/**
 * Adresserna som får logga in. Första raden är den inloggade själv (`self`), så att vyn har en rad
 * som INTE får någon knapp — det är den regeln som är värd att se med egna ögon.
 *
 * Kontraktets `AdminUser` är genomgående `readonly` — svaret ska inte gå att ändra där det tagits
 * emot. Låtsas-serverns eget tillstånd är däremot just det som ska ändras, därav den egna typen.
 */
const adminUsers: MockUser[] = [
  { userId: 'u-anna', email: 'anna@example.se', role: 'admin', createdAt: '2026-05-04T09:12:00Z', self: true },
  { userId: 'u-karin', email: 'karin@example.se', role: 'builder', createdAt: '2026-06-18T13:40:00Z', self: false },
  { userId: 'u-johan', email: 'johan@example.se', role: 'builder', createdAt: '2026-07-02T08:05:00Z', self: false },
  { userId: 'u-sara', email: 'sara@example.se', role: 'viewer', createdAt: '2026-08-29T15:20:00Z', self: false },
  { userId: 'u-per', email: 'per@example.se', role: 'viewer', createdAt: '2026-09-11T11:00:00Z', self: false },
];

/**
 * Stoppade önskemål. Biometri två gånger med flit: det är ÅTERKOMSTEN panelen finns för att visa,
 * och den som klickar runt ska se skillnaden mot en gräns som träffats en enda gång.
 *
 * Ingen rad bär önskemålets text — den finns inte i kontraktet och ska inte finnas här heller.
 */
const adminStops: { appIdPrefix: string; category: RedlineCategory; at: string }[] = [
  { appIdPrefix: 'a01f3c7d', category: 'biometri', at: '2026-09-20T14:05:00Z' },
  { appIdPrefix: 'c93be220', category: 'biometri', at: '2026-09-19T09:40:00Z' },
  { appIdPrefix: 'c93be220', category: 'automatiskt-beslut-om-enskild', at: '2026-09-12T16:20:00Z' },
];

/** Rollerna i styrka, så att en inbjudan kan höja men aldrig sänka — precis som kontraktet säger. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, builder: 2, admin: 3 };

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'builder' || value === 'viewer';
}

function countAdminUsers(): { admin: number; builder: number; viewer: number } {
  const counts = { admin: 0, builder: 0, viewer: 0 };
  for (const user of adminUsers) counts[user.role] += 1;
  return counts;
}

/** Låtsas-appar man byggt under körningen, som rader i kontrollrummet. */
function adminRows(): AdminApp[] {
  const own = [...apps.values()].map((app) => {
    const hasDraft = app.hasDraft && app.decommissionedAt === null;
    const published = app.published && app.decommissionedAt === null;
    return {
      appId: app.appId,
      appIdPrefix: app.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      // Den publicerade adressen när den finns, annars förhandsvisningen. Ingenting att öppna för
      // en app som aldrig byggts.
      appUrl: published ? `https://${app.appId}.example.test/` : hasDraft ? `https://p-${app.appId}.example.test/` : null,
      // Ägarens egen lista visar avskriften; kontrollrummet gör det inte. Samma regel som servern.
      name: app.namnValt ? app.name : 'Namnlös app',
      ownerEmail: 'anna@example.se',
      updatedAt: app.updatedAt,
      hasDraft,
      published,
      members: 1 + app.members.size,
      tokens: { input: app.draftVersion * 18_400, output: app.draftVersion * 6_200 },
    };
  });
  return [...own, ...ADMIN_DEMO_APPS].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * AI-registret och granskningskön för utvecklingsläget. Demoraderna ovanför har ingen nivå — de är
 * `AdminApp`, inte hela appar — så registret blandar dem (som oklassade, alltså strängast) med de
 * appar man själv bygger under körningen.
 */
function adminRegister(): AdminRegisterEntry[] {
  const egna: AdminRegisterEntry[] = [...apps.values()].map((app) => ({
    appIdPrefix: app.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: app.name,
    ownerEmail: 'anna@example.se',
    classification: app.classification,
    source: app.classificationSource,
    classifiedAt: app.classificationSource === 'fail-closed' ? null : app.updatedAt,
    // En avvecklad app är inte publicerad, hur den än såg ut när den levde: adressen slutade
    // svara i samma stund. Raden står kvar — det är hela poängen med registret.
    published: app.published && app.decommissionedAt === null,
    decommissionedAt: app.decommissionedAt,
  }));
  // Sista demoraden är avvecklad från start, så att en avvecklad rad går att se i registret utan
  // att man först måste bygga en app och sedan avveckla den.
  const demo: AdminRegisterEntry[] = ADMIN_DEMO_APPS.map((rad, i) => ({
    appIdPrefix: rad.appIdPrefix,
    name: rad.name,
    ownerEmail: rad.ownerEmail,
    classification: (['intern', 'personuppgift', 'oppen', 'kanslig'] as const)[i % 4] ?? 'kanslig',
    source: (['modell', 'signalord', 'modell', 'fail-closed'] as const)[i % 4] ?? 'fail-closed',
    classifiedAt: i % 4 === 3 ? null : rad.updatedAt,
    published: i === ADMIN_DEMO_APPS.length - 1 ? false : rad.published,
    decommissionedAt: i === ADMIN_DEMO_APPS.length - 1 ? '2026-09-14T10:12:00Z' : null,
  }));
  return [...egna, ...demo];
}

/** Ett ärende som kön visar det — aldrig med koden. Den hämtas ett ärende i taget. */
function reviewRow(app: MockApp): AdminReview {
  const review = app.review;
  return {
    reviewId: review?.reviewId ?? '',
    appIdPrefix: app.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
    name: app.name,
    ownerEmail: 'anna@example.se',
    classification: app.classification,
    classificationSource: app.classificationSource,
    state: review?.state ?? 'vantar',
    requestedAt: review?.requestedAt ?? now(),
    decidedAt: review?.decidedAt ?? null,
    reason: review?.reason ?? null,
  };
}

function adminReviews(): AdminReview[] {
  return [...apps.values()]
    .filter((app) => app.review?.state === 'vantar')
    .sort((a, b) => (a.review?.requestedAt ?? '').localeCompare(b.review?.requestedAt ?? ''))
    .map(reviewRow);
}

/** Koden granskaren läser. Attrappen bygger ingenting, så den hittar på något som ser ut som en app. */
function mockFiles(app: MockApp): SourceFiles {
  return {
    'src/App.tsx': `export function App() {\n  return <h1>${app.name}</h1>;\n}\n`,
    'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { App } from './App.tsx';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
  };
}

function adminOverview(): AdminOverview {
  const rows = adminRows();
  const tokens = rows.reduce(
    (sum, row) => ({ input: sum.input + row.tokens.input, output: sum.output + row.tokens.output }),
    { input: 0, output: 0 },
  );
  return {
    apps: rows.length,
    published: rows.filter((row) => row.published).length,
    drafts: rows.filter((row) => row.hasDraft && !row.published).length,
    users: countAdminUsers(),
    tokens: { ...tokens, jobs: jobs.size + 37 },
    failedJobs: 2,
  };
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

/**
 * `conflict` finns bara i byggverktyget, inte i kontraktet (se `BuilderErrorCode` i
 * packages/builder/src/svar.ts). Attrappen ska svara som den riktiga rutten gör, alltså också
 * med den koden — därför den vidgade typen här.
 */
function fail(res: ServerResponse, status: number, code: ApiErrorCode | 'conflict', message: string): void {
  const body = { error: { code, message } } satisfies { error: { code: string; message: string } };
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

/**
 * Svaret från en installation där appdata inte är inkopplad: samma 503 som den riktiga rutten ger.
 * Gäller BÅDA rutterna — vägen ut och vägen bort hänger ihop, och en installation som saknar den
 * ena saknar den andra.
 */
function unavailable(res: ServerResponse): void {
  fail(res, 503, 'unavailable', 'Export och avveckling är inte inkopplade i den här installationen.');
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
  const { draftVersion: _d, publishedVersion: _p, job, members: _m, decommissionedAt: _a, ...summary } = app;
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

  if (method !== 'GET' && req.headers[CSRF_HEADER] !== '1') {
    fail(res, 403, 'forbidden', 'Åtkomst nekad.');
    return;
  }

  if (method === 'GET' && path === '/me') {
    return send(res, 200, { displayName: 'Anna', canBuild: true, isAdmin: true, services: MOCK_SERVICES, version: 'lokal-dev' });
  }

  // Kontrollrummet. Låtsas-servern släpper in alla — den riktiga rutten kräver rollen `admin`.
  // Vill du se hur nekad åtkomst ser ut: starta om med ADMIN_NEKAD=1 i miljön.
  if (path.startsWith('/admin/')) {
    if (process.env['ADMIN_NEKAD'] === '1') return fail(res, 403, 'forbidden', 'Åtkomst nekad.');
    if (method === 'GET') {
      if (path === '/admin/oversikt') return send(res, 200, adminOverview());
      if (path === '/admin/appar') return send(res, 200, { apps: adminRows() });
      if (path === '/admin/anvandare') return send(res, 200, { users: adminUsers });
      // Tomt läge är den goda nyheten och värt att se: starta om med ADMIN_INGA_STOPP=1.
      if (path === '/admin/stopp') {
        return send(res, 200, { stops: process.env['ADMIN_INGA_STOPP'] === '1' ? [] : adminStops });
      }
      if (path === '/admin/register') return send(res, 200, { entries: adminRegister() });
      if (path === '/admin/granskning') return send(res, 200, { reviews: adminReviews() });
      // Ett enskilt ärende MED koden. Enda stället i kontrollrummet där en apps innehåll visas —
      // granskningen ÄR att någon läser koden.
      const arende = path.startsWith('/admin/granskning/') ? path.slice('/admin/granskning/'.length) : null;
      if (arende !== null && arende.length > 0) {
        const trad = [...apps.values()].find((a) => a.review?.reviewId === arende && a.review.state === 'vantar');
        if (trad === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
        return send(res, 200, { review: reviewRow(trad), files: mockFiles(trad) });
      }
      return fail(res, 404, 'not_found', 'Det finns inte.');
    }
    // Beslutet. Godkänt publicerar appen; ett nej kräver ett skäl, som går ordagrant till ägaren.
    if (method === 'POST' && path.startsWith('/admin/granskning/')) {
      const reviewId = path.slice('/admin/granskning/'.length);
      const trad = [...apps.values()].find((a) => a.review?.reviewId === reviewId && a.review.state === 'vantar');
      if (trad === undefined || trad.review === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
      const body = await readJson(req);
      const decision = body['decision'];
      if (decision !== 'godkand' && decision !== 'avvisad') {
        return fail(res, 400, 'invalid_request', 'Ange om appen godkänns eller avvisas.');
      }
      const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
      if (decision === 'avvisad' && reason === '') {
        return fail(res, 400, 'invalid_request', 'Skriv varför appen inte kan publiceras. Ägaren får skälet ordagrant.');
      }
      trad.review = { ...trad.review, state: decision, decidedAt: now(), reason: decision === 'avvisad' ? reason : null };
      if (decision === 'godkand') {
        trad.published = true;
        trad.publishedVersion = trad.draftVersion;
      }
      trad.messages.push({
        role: 'assistant',
        text: decision === 'godkand' ? 'Granskad och godkänd — appen är publicerad och går att dela.' : `Granskningen säger nej, och så här står det: ${reason}`,
        createdAt: now(),
      });
      trad.updatedAt = now();
      return send(res, 200, { review: reviewRow(trad) });
    }
    if (method === 'POST' && path === '/admin/anvandare') {
      const body = await readJson(req);
      const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
      const role = body['role'];
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) || !isRole(role)) {
        return fail(res, 400, 'invalid_request', 'Ogiltig adress eller roll.');
      }
      if (email.startsWith('upptagen@')) return fail(res, 429, 'rate_limited', 'För många ändringar.');
      if (email.startsWith('krock@')) return fail(res, 409, 'scope_mismatch', 'Någon annan hann före.');
      const existing = adminUsers.find((user) => user.email === email);
      if (existing !== undefined) {
        // Den här vägen HÖJER bara — att sänka går bara på personens egen sökväg.
        if (ROLE_RANK[role] > ROLE_RANK[existing.role]) existing.role = role;
        return send(res, 201, { user: existing });
      }
      const user: MockUser = { userId: newId('u'), email, role, createdAt: now(), self: false };
      adminUsers.push(user);
      return send(res, 201, { user });
    }
    const userMatch = /^\/admin\/anvandare\/([\w-]+)$/.exec(path);
    if (method === 'POST' && userMatch !== null) {
      const user = adminUsers.find((row) => row.userId === userMatch[1]);
      if (user === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
      // Den egna raden: en administratör som sänker sig själv låser ut sig, så servern nekar.
      if (user.self) return fail(res, 400, 'invalid_request', 'Du kan inte ändra din egen roll.');
      const body = await readJson(req);
      const role = body['role'];
      if (!isRole(role)) return fail(res, 400, 'invalid_request', 'Ogiltig roll.');
      if (user.email.startsWith('krock@')) return fail(res, 409, 'scope_mismatch', 'Någon annan hann före.');
      user.role = role;
      return send(res, 200, { user });
    }
    return fail(res, 405, 'method_not_allowed', 'Det går inte.');
  }

  if (path === '/apps') {
    if (method === 'GET') {
      const list = [...apps.values()]
        // En avvecklad app finns inte för sin ägare. Det är inte att dölja något: det finns
        // ingenting kvar att öppna.
        .filter((app) => app.decommissionedAt === null)
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
        namnValt: typeof body['name'] === 'string' && body['name'].trim() !== '',
        updatedAt: now(),
        hasDraft: false,
        published: false,
        draftVersion: 0,
        publishedVersion: 0,
        messages: [],
        // Oklassad tills ett önskemål beskrivits: läses som den strängaste nivån, precis som i
        // den riktiga plattformen.
        classification: 'kanslig',
        classificationSource: 'fail-closed',
        members: new Map(),
        decommissionedAt: null,
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

  const memberMatch = /^\/apps\/([\w-]+)\/members(?:\/([\w-]+))?$/.exec(path);
  if (memberMatch !== null) {
    const owned = apps.get(memberMatch[1] ?? '');
    if (owned === undefined) return fail(res, 404, 'not_found', 'Det finns inte.');
    const memberId = memberMatch[2];
    if (memberId === undefined && method === 'GET') {
      const members = [
        { memberId: 'agare-anna', email: 'anna@example.se', role: 'owner' },
        ...[...owned.members].map(([email, id]) => ({ memberId: id, email, role: 'user' })),
      ];
      return send(res, 200, { members });
    }
    if (memberId !== undefined && method === 'DELETE') {
      if (memberId === 'agare-anna') return fail(res, 400, 'invalid_request', 'Ogiltig begäran.');
      for (const [email, id] of owned.members) {
        if (id !== memberId) continue;
        if (email.startsWith('fast@')) return fail(res, 500, 'internal', 'Något gick fel hos oss. Försök igen om en stund.');
        owned.members.delete(email);
      }
      return send(res, 200, { removed: true });
    }
  }

  const appMatch = /^\/apps\/([\w-]+)(?:\/(messages|namn|publish|open|share|feedback|export|avveckla))?$/.exec(path);
  const app = appMatch === null ? undefined : apps.get(appMatch[1] ?? '');
  // En avvecklad app svarar som en app som aldrig funnits — samma 404, ingen särskild text som
  // röjer att den har funnits. Den upplysningen hör hemma i registret, inte här.
  if (appMatch === null || app === undefined || app.decommissionedAt !== null) {
    return fail(res, 404, 'not_found', 'Det finns inte.');
  }
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
    if (app.messages.length === 0 && !app.namnValt) app.name = nameFrom(text);
    app.messages.push({ role: 'user', text, createdAt: now() });
    app.updatedAt = now();
    const jobId = newId('j');
    jobs.set(jobId, { jobId, appId: app.appId, startedAt: Date.now(), settled: false, ...scriptFor(text) });
    app.job = { jobId };
    return send(res, 202, { jobId });
  }

  // Ägaren döper sin app. `namnValt` är hela poängen: ett valt namn skrivs aldrig över av
  // plattformens avskrift av det första önskemålet, och det följer med till kontrollrummet.
  if (action === 'namn' && method === 'POST') {
    const body = await readJson(req);
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '') return fail(res, 400, 'invalid_request', 'Skriv vad appen ska heta.');
    if ([...name].length > 80) return fail(res, 400, 'invalid_request', 'Namnet får vara högst 80 tecken.');
    app.name = name;
    app.namnValt = true;
    app.updatedAt = now();
    return send(res, 200, { name });
  }

  if (action === 'publish' && method === 'POST') {
    if (!app.hasDraft) return fail(res, 409, 'conflict', 'Det finns inget färdigt utkast att publicera.');
    if (app.review?.state === 'vantar') {
      return fail(res, 409, 'conflict', 'Appen väntar redan på granskning. Du får besked så snart någon har tittat på den.');
    }
    // Ägaren publicerar inte — hon begär. Det är en granskare som släpper ut appen.
    app.review = { reviewId: newId('g'), state: 'vantar', requestedAt: now(), decidedAt: null, reason: null };
    app.updatedAt = now();
    return send(res, 202, { review: { state: 'vantar', requestedAt: app.review.requestedAt } });
  }

  // Exporten: allt appen bär, som JSON. Attrappen lagrar ingen appdata, så den hittar på ett par
  // rader och en fil — men formen är kontraktets, så nedladdningen går att prova på riktigt.
  if (action === 'export' && method === 'GET') {
    if (process.env['AVVECKLING_SAKNAS'] === '1') return unavailable(res);
    const body: AppExport = {
      format: 1,
      exportedAt: now(),
      app: {
        name: app.name,
        classification: app.classification,
        classificationSource: app.classificationSource,
        published: app.published,
      },
      collections: {
        uppgifter: {
          documents: [
            { id: 'r1', rubrik: 'Köpa kaffe till fikat', klar: false, skapad: '2026-09-18T08:14:00Z' },
            { id: 'r2', rubrik: 'Boka mötesrum', klar: true, skapad: '2026-09-18T09:02:00Z' },
            { id: 'r3', rubrik: 'Skicka protokollet', klar: false, skapad: '2026-09-19T15:41:00Z' },
          ],
          truncated: false,
        },
      },
      files: [{ id: 'f1', name: 'dagordning.pdf', size: 184_320 }],
      conversation: [...app.messages],
    };
    return send(res, 200, body);
  }

  // Avvecklingen. Bekräftelsen är appens namn ORDAGRANT: fel namn, tomt namn eller `true` ger 400,
  // precis som den riktiga rutten. Starta om med AVVECKLING_SAKNAS=1 för att se hur vyn möter en
  // installation där export och avveckling inte är inkopplade (503).
  if (action === 'avveckla' && method === 'POST') {
    if (process.env['AVVECKLING_SAKNAS'] === '1') return unavailable(res);
    const body = await readJson(req);
    if (body['confirm'] !== app.name) {
      return fail(res, 400, 'invalid_request', `Skriv appens namn för att bekräfta att den ska avvecklas: ${app.name}`);
    }
    const at = now();
    app.decommissionedAt = at;
    app.published = false;
    app.hasDraft = false;
    // Ett ärende som låg i kö försvinner med appen: det finns ingen kod kvar att läsa.
    delete app.review;
    app.updatedAt = at;
    // Gallringsbeviset. Siffrorna räknas FÖRE raderingen — efteråt finns inget att räkna.
    const evidence: DecommissionEvidence = {
      appIdPrefix: app.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
      decommissionedAt: at,
      documentsDeleted: 3,
      filesDeleted: 1,
    };
    return send(res, 200, { evidence });
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
    if (!app.members.has(email)) app.members.set(email, newId('m'));
    return send(res, 200, { shared: true });
  }

  // Återkoppling på byggverktyget. Låtsas-API:t skickar inget mejl — det räcker att svara som
  // den riktiga rutten, så att tummarna och rutan går att klicka igenom lokalt.
  // Skriv "upptagen" i texten för att pröva hur gränsen ser ut.
  if (action === 'feedback' && method === 'POST') {
    const body = await readJson(req);
    const helpful = body['helpful'];
    if (typeof helpful !== 'boolean') return fail(res, 400, 'invalid_request', 'Säg om det hjälpte eller inte.');
    if (helpful) return send(res, 200, { received: true });
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (text === '') return fail(res, 400, 'invalid_request', 'Skriv vad som inte hjälpte.');
    if (text.toLowerCase().includes('upptagen')) {
      return fail(res, 429, 'rate_limited', 'Du har skickat återkoppling flera gånger på kort tid. Vänta en stund och försök igen.');
    }
    return send(res, 200, { received: true });
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
