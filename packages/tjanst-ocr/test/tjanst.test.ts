/**
 * Tjänsten `ocr` mot en fejkad filläsare och en fejkad Berget (`fetch`). Det riktiga API:t
 * anropas aldrig. Fientliga fall: någon annans fil, fel filtyp, jättebild, leverantörsfel med
 * hemlig text, kvoter.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppFileReader,
  AppId,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  TenantContext,
  TenantKind,
} from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';
import { createOcrService } from '../src/tjanst.ts';
import { jpeg, pdf, png, webpVp8x } from './bilder.ts';

const APP_A = '0123456789abcdefghjkmnpqrs' as AppId;
const APP_B = 'zyxwvtsrqpnmkjhgfedcba9876' as AppId;
const KVITTO = 'ICA Kvantum\nSUMMA 49,90 kr';
const HEMLIGT = 'hemlig-stackspårning-sk-live-0123';

function tenant(appId: AppId = APP_A, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

interface Fil {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly name: string;
}

/** Filer per app — en annan apps fil-id ger `null`, precis som tjänsten `files` lovar. */
function fejkadFillasare(): AppFileReader & { filer: Map<string, Fil>; lasningar: number } {
  const filer = new Map<string, Fil>();
  const lasare = {
    filer,
    lasningar: 0,
    async read(t: TenantContext, fileId: string) {
      lasare.lasningar += 1;
      return filer.get(`${t.appId}/${fileId}`) ?? null;
    },
  };
  return lasare;
}

interface Anrop {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type Svarare = (anrop: Anrop, signal: AbortSignal | undefined) => Promise<Response> | Response;

function chattsvar(text: string, finish = 'stop'): Response {
  return Response.json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: finish }] });
}

let katalog: string;
let loggar: Record<string, unknown>[];
let klocka: Date;
let lasare: ReturnType<typeof fejkadFillasare>;
let anrop: Anrop[];
let svarare: Svarare;
const oppna: AppService[] = [];

function beroenden(env: Record<string, string> = {}, andra: Partial<AppServiceDependencies> = {}): AppServiceDependencies {
  return {
    dataDir: katalog,
    env: { SVC_OCR_MODEL: 'google/gemma-4-31B-it', ...env },
    log: (entry) => loggar.push({ ...entry }),
    now: () => klocka,
    members: { members: async () => [] },
    store: {} as AppServiceDependencies['store'],
    publishedUrl: () => 'https://exempel.test',
    berget: { baseUrl: 'https://berget.test/v1/', apiKey: 'nyckel-123' },
    files: lasare,
    ...andra,
  };
}

const fejkadFetch: typeof fetch = async (input, init) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const post: Anrop = { url: String(input), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
  anrop.push(post);
  return svarare(post, init?.signal ?? undefined);
};

function tjanst(env: Record<string, string> = {}): AppService {
  const { service } = createOcrService(beroenden(env), { fetch: fejkadFetch });
  oppna.push(service);
  return service;
}

function begaran(json: unknown, andra: Partial<AppServiceRequest> = {}): AppServiceRequest {
  return {
    method: 'POST',
    segments: [],
    query: '',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json)),
    tenant: tenant(),
    identity: { userId: 'anv-anna', email: 'anna@exempel.se', roles: ['viewer'] },
    access: 'user' as AppAccessRole,
    ...andra,
  };
}

function kropp(svar: AppServiceResponse): { text?: string; pages?: { number: number; text: string }[]; error?: { code: string; message: string } } {
  return JSON.parse(String(svar.body));
}

function laggFil(fileId: string, body: Uint8Array, contentType = 'image/png', appId: AppId = APP_A): void {
  lasare.filer.set(`${appId}/${fileId}`, { body, contentType, name: `${fileId}.bin` });
}

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'tjanst-ocr-'));
  loggar = [];
  klocka = new Date('2026-09-19T10:00:00Z');
  lasare = fejkadFillasare();
  anrop = [];
  svarare = () => chattsvar(KVITTO);
});

afterEach(async () => {
  for (const s of oppna.splice(0)) await s.close?.();
  await rm(katalog, { recursive: true, force: true });
});

describe('fabriken', () => {
  it('kräver tjänsten files, med ett begripligt besked', () => {
    const { files: _utan, ...utanFiler } = beroenden();
    expect(() => factory?.(utanFiler)).toThrow(/ocr kräver tjänsten files — slå på båda/);
  });

  it('kräver Berget', () => {
    const { berget: _utan, ...utanBerget } = beroenden();
    expect(() => factory?.(utanBerget)).toThrow(/Berget/);
  });

  it('kräver en modell i SVC_OCR_MODEL', () => {
    expect(() => factory?.(beroenden({ SVC_OCR_MODEL: '' }))).toThrow(/SVC_OCR_MODEL/);
  });

  it('avvisar ogiltiga tal i inställningarna', () => {
    for (const varde of ['abc', '0', '-1', '1.5', '1e3', ' 2']) {
      expect(() => factory?.(beroenden({ SVC_OCR_PAGES_PER_APP_DAY: varde }))).toThrow(/SVC_OCR_PAGES_PER_APP_DAY/);
    }
  });

  it('ger en tjänst som heter ocr med liten kroppsgräns', () => {
    const instans = factory?.(beroenden());
    expect(instans?.service.name).toBe('ocr');
    expect(instans?.service.maxBodyBytes).toBeLessThanOrEqual(4096);
    oppna.push(instans!.service);
  });
});

describe('läsa text i en bild', () => {
  it('skickar bilden till Bergets bildmodell och ger texten tillbaka', async () => {
    laggFil('kvitto', png(800, 600));
    const svar = await tjanst().handle(begaran({ fileId: 'kvitto' }));
    expect(svar.status).toBe(200);
    expect(svar.headers['Content-Type']).toMatch(/^application\/json/);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(kropp(svar)).toEqual({ text: KVITTO, pages: [{ number: 1, text: KVITTO }] });

    expect(anrop).toHaveLength(1);
    const [forsta] = anrop;
    expect(forsta?.url).toBe('https://berget.test/v1/chat/completions');
    expect(forsta?.headers['authorization']).toBe('Bearer nyckel-123');
    expect(forsta?.body['model']).toBe('google/gemma-4-31B-it');
    expect(forsta?.body['stream']).toBe(false);
    expect(forsta?.body['temperature']).toBe(0);
    const bild = JSON.stringify(forsta?.body['messages']);
    expect(bild).toContain(`data:image/png;base64,${Buffer.from(png(800, 600)).toString('base64')}`);
    expect(bild).toContain('svenska');
  });

  it('typen tas ur filens byte, inte ur den angivna typen', async () => {
    laggFil('foto', jpeg(400, 300), 'image/png');
    expect((await tjanst().handle(begaran({ fileId: 'foto' }))).status).toBe(200);
    expect(JSON.stringify(anrop[0]?.body['messages'])).toContain('data:image/jpeg;base64,');
  });

  it('språket kan vara engelska', async () => {
    laggFil('kvitto', png(10, 10));
    await tjanst().handle(begaran({ fileId: 'kvitto', language: 'en' }));
    expect(JSON.stringify(anrop[0]?.body['messages'])).toContain('engelska');
  });

  it('modellens tankar skalas bort', async () => {
    laggFil('kvitto', png(10, 10));
    svarare = () => chattsvar('<think>hmm</think>Kaffe 20 kr');
    expect(kropp(await tjanst().handle(begaran({ fileId: 'kvitto' }))).text).toBe('Kaffe 20 kr');
  });

  it('både ägare och användare får läsa', async () => {
    laggFil('kvitto', png(10, 10));
    expect((await tjanst().handle(begaran({ fileId: 'kvitto' }, { access: 'owner' }))).status).toBe(200);
  });
});

describe('cache', () => {
  it('samma fil och språk läses bara en gång', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    const forsta = kropp(await s.handle(begaran({ fileId: 'kvitto' })));
    const andra = kropp(await s.handle(begaran({ fileId: 'kvitto' })));
    expect(andra).toEqual(forsta);
    expect(anrop).toHaveLength(1);
  });

  it('överlever en omstart', async () => {
    laggFil('kvitto', png(10, 10));
    await tjanst().handle(begaran({ fileId: 'kvitto' }));
    await oppna.pop()?.close?.();
    expect((await tjanst().handle(begaran({ fileId: 'kvitto' }))).status).toBe(200);
    expect(anrop).toHaveLength(1);
  });

  it('annat språk är en ny läsning', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    await s.handle(begaran({ fileId: 'kvitto', language: 'en' }));
    expect(anrop).toHaveLength(2);
  });

  it('utkast och publicerad app delar inte cache', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    await s.handle(begaran({ fileId: 'kvitto' }, { tenant: tenant(APP_A, 'draft') }));
    expect(anrop).toHaveLength(2);
  });

  it('en ändrad fil med samma id läses på nytt', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    laggFil('kvitto', png(10, 10, 7));
    await s.handle(begaran({ fileId: 'kvitto' }));
    expect(anrop).toHaveLength(2);
  });

  it('en borttagen fil finns inte, även om texten ligger i cachen', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    lasare.filer.clear();
    const svar = await s.handle(begaran({ fileId: 'kvitto' }));
    expect(svar.status).toBe(404);
    expect(kropp(svar).error?.code).toBe('not_found');
  });

  it('en annan app får aldrig en annan apps cachade text', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    const svar = await s.handle(begaran({ fileId: 'kvitto' }, { tenant: tenant(APP_B) }));
    expect(svar.status).toBe(404);
  });
});

describe('fientliga fall', () => {
  it('fil från en annan app: finns inte, och inget skickas till Berget', async () => {
    laggFil('kvitto', png(10, 10), 'image/png', APP_B);
    const svar = await tjanst().handle(begaran({ fileId: 'kvitto' }));
    expect(svar.status).toBe(404);
    expect(kropp(svar).error?.code).toBe('not_found');
    expect(anrop).toHaveLength(0);
  });

  it('otillåten filtyp avvisas, även när den utger sig för att vara en bild', async () => {
    const s = tjanst();
    for (const [namn, body] of [
      ['text', new TextEncoder().encode('hej hej')],
      ['svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>hej</text></svg>')],
      ['gif', new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000')],
    ] as const) {
      laggFil(namn, body, 'image/png');
      const svar = await s.handle(begaran({ fileId: namn }));
      expect(svar.status).toBe(400);
      expect(kropp(svar).error?.code).toBe('invalid_request');
      expect(kropp(svar).error?.message).toMatch(/PNG, JPEG, WebP/);
    }
    expect(anrop).toHaveLength(0);
  });

  it('jättestor bild (upplösning) avvisas utan att skickas', async () => {
    laggFil('stor', webpVp8x(16000, 16000));
    const svar = await tjanst().handle(begaran({ fileId: 'stor' }));
    expect(svar.status).toBe(413);
    expect(kropp(svar).error?.code).toBe('too_large');
    expect(anrop).toHaveLength(0);
  });

  it('för stor fil (byte) avvisas utan att skickas', async () => {
    const stor = new Uint8Array(2048);
    stor.set(png(10, 10));
    laggFil('tung', stor);
    const svar = await tjanst({ SVC_OCR_MAX_FILE_BYTES: '1024' }).handle(begaran({ fileId: 'tung' }));
    expect(svar.status).toBe(413);
    expect(anrop).toHaveLength(0);
  });

  it('leverantörsfel med hemlig text blir 503 i klarspråk, utan det hemliga, och loggas utan det', async () => {
    laggFil('kvitto', png(10, 10));
    svarare = () => Response.json({ error: { message: HEMLIGT } }, { status: 500 });
    const svar = await tjanst().handle(begaran({ fileId: 'kvitto' }));
    expect(svar.status).toBe(503);
    expect(kropp(svar).error?.message).toMatch(/inte tillgänglig/);
    expect(String(svar.body)).not.toContain(HEMLIGT);
    expect(JSON.stringify(loggar)).not.toContain(HEMLIGT);
    expect(JSON.stringify(loggar)).not.toContain('nyckel-123');
  });

  it('nätverksfel, felaktigt svar och avkapat svar blir 503', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    for (const fel of [
      () => {
        throw new TypeError(`fetch failed ${HEMLIGT}`);
      },
      () => Response.json({ inget: 'här' }),
      () => new Response('inte json', { status: 200 }),
      () => chattsvar('halv text', 'length'),
    ] satisfies Svarare[]) {
      svarare = fel;
      const svar = await s.handle(begaran({ fileId: 'kvitto' }));
      expect(svar.status).toBe(503);
      expect(String(svar.body)).not.toContain(HEMLIGT);
    }
  });

  it('tidsgräns: ett svar som aldrig kommer blir 503', async () => {
    laggFil('kvitto', png(10, 10));
    svarare = (_anrop, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const svar = await tjanst({ SVC_OCR_TIMEOUT_MS: '30' }).handle(begaran({ fileId: 'kvitto' }));
    expect(svar.status).toBe(503);
  });

  it('ett misslyckat anrop sparas inte i cachen och kostar ingen kvot', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst({ SVC_OCR_PAGES_PER_APP_DAY: '1' });
    svarare = () => new Response('', { status: 502 });
    expect((await s.handle(begaran({ fileId: 'kvitto' }))).status).toBe(503);
    svarare = () => chattsvar(KVITTO);
    expect((await s.handle(begaran({ fileId: 'kvitto' }))).status).toBe(200);
    expect(anrop).toHaveLength(2);
  });

  it('ogiltiga förfrågningar', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    const fall: [AppServiceRequest, number][] = [
      [begaran({ fileId: 'kvitto' }, { method: 'GET' }), 405],
      [begaran({ fileId: 'kvitto' }, { segments: ['read'] }), 404],
      [begaran('inte json'), 400],
      [begaran([]), 400],
      [begaran({}), 400],
      [begaran({ fileId: 42 }), 400],
      [begaran({ fileId: '' }), 400],
      [begaran({ fileId: '../kvitto' }), 400],
      [begaran({ fileId: 'kvitto\u0000' }), 400],
      [begaran({ fileId: 'k'.repeat(201) }), 400],
      [begaran({ fileId: 'kvitto', language: 'de' }), 400],
      [begaran({ fileId: 'kvitto', language: 'SV' }), 400],
      [begaran({ fileId: 'kvitto', appId: APP_B }), 400],
      [begaran({ fileId: 'kvitto' }, { headers: { 'content-type': 'text/plain' } }), 400],
      [begaran({ fileId: 'kvitto' }, { body: new Uint8Array([0xff, 0xfe]) }), 400],
    ];
    for (const [req, status] of fall) {
      const svar = await s.handle(req);
      expect(svar.status, JSON.stringify(req.body && new TextDecoder().decode(req.body))).toBe(status);
      expect(kropp(svar).error?.message.length).toBeGreaterThan(0);
    }
    expect(anrop).toHaveLength(0);
  });
});

describe('PDF', () => {
  it('avvisas med klarspråk när motorn är en bildmodell', async () => {
    laggFil('dok', pdf(2), 'application/pdf');
    const svar = await tjanst().handle(begaran({ fileId: 'dok' }));
    expect(svar.status).toBe(400);
    expect(kropp(svar).error?.message).toMatch(/PDF/);
    expect(anrop).toHaveLength(0);
  });

  it('läses med Bergets dokument-API när det är valt', async () => {
    laggFil('dok', pdf(2), 'application/pdf');
    svarare = () => Response.json({ content: '# Faktura\n\nAtt betala: 100 kr', usage: { pages: 2 } });
    const svar = await tjanst({ SVC_OCR_MODEL: 'berget-ocr' }).handle(begaran({ fileId: 'dok' }));
    expect(svar.status).toBe(200);
    expect(kropp(svar)).toEqual({ text: '# Faktura\n\nAtt betala: 100 kr' });
    expect(anrop[0]?.url).toBe('https://berget.test/v1/ocr');
    const dokument = anrop[0]?.body['document'] as { url: string };
    expect(dokument.url.startsWith('data:application/pdf;base64,')).toBe(true);
    expect(anrop[0]?.body['async']).toBe(false);
  });

  it('dokument-API:t tar också bilder', async () => {
    laggFil('kvitto', png(10, 10));
    svarare = () => Response.json({ content: KVITTO, usage: { pages: 1 } });
    const svar = await tjanst({ SVC_OCR_MODEL: 'berget-ocr' }).handle(begaran({ fileId: 'kvitto' }));
    expect(kropp(svar)).toEqual({ text: KVITTO, pages: [{ number: 1, text: KVITTO }] });
    expect((anrop[0]?.body['document'] as { url: string }).url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('dokument-API:ts asynkrona svar och felaktiga svar blir 503', async () => {
    laggFil('dok', pdf(1), 'application/pdf');
    const s = tjanst({ SVC_OCR_MODEL: 'berget-ocr' });
    for (const fel of [
      () => Response.json({ taskId: 'x', status: 'pending' }, { status: 202 }),
      () => Response.json({ content: 42 }),
      () => Response.json({ error: { message: HEMLIGT } }, { status: 400 }),
    ] satisfies Svarare[]) {
      svarare = fel;
      const svar = await s.handle(begaran({ fileId: 'dok' }));
      expect(svar.status).toBe(503);
      expect(String(svar.body)).not.toContain(HEMLIGT);
    }
  });

  it('för många sidor avvisas innan något skickas', async () => {
    laggFil('dok', pdf(6), 'application/pdf');
    const svar = await tjanst({ SVC_OCR_MODEL: 'berget-ocr', SVC_OCR_MAX_PDF_PAGES: '5' }).handle(begaran({ fileId: 'dok' }));
    expect(svar.status).toBe(413);
    expect(anrop).toHaveLength(0);
  });

  it('sidorna räknas mot kvoten — de faktiska om leverantören säger fler', async () => {
    const s = tjanst({ SVC_OCR_MODEL: 'berget-ocr', SVC_OCR_PAGES_PER_APP_DAY: '4' });
    laggFil('dok', pdf(1), 'application/pdf');
    svarare = () => Response.json({ content: 'text', usage: { pages: 3 } });
    expect((await s.handle(begaran({ fileId: 'dok' }))).status).toBe(200);
    laggFil('dok2', pdf(2), 'application/pdf');
    const svar = await s.handle(begaran({ fileId: 'dok2' }));
    expect(svar.status).toBe(429);
    expect(anrop).toHaveLength(1);
  });
});

describe('kvoter', () => {
  it('sidor per app och dygn — sedan klarspråk, och öppet igen nästa dygn', async () => {
    const s = tjanst({ SVC_OCR_PAGES_PER_APP_DAY: '2' });
    for (const id of ['a', 'b', 'c']) laggFil(id, png(10, 10, id.charCodeAt(0)));
    expect((await s.handle(begaran({ fileId: 'a' }))).status).toBe(200);
    expect((await s.handle(begaran({ fileId: 'b' }, { identity: { userId: 'anv-bertil', email: 'b@exempel.se', roles: ['viewer'] } }))).status).toBe(200);
    const nekad = await s.handle(begaran({ fileId: 'c' }));
    expect(nekad.status).toBe(429);
    expect(kropp(nekad).error?.code).toBe('rate_limited');
    expect(kropp(nekad).error?.message).toMatch(/gräns/);
    expect(anrop).toHaveLength(2);

    // Redan lästa filer kostar inget och går att läsa ändå.
    expect((await s.handle(begaran({ fileId: 'a' }))).status).toBe(200);

    // En annan app påverkas inte.
    laggFil('c', png(10, 10, 99), 'image/png', APP_B);
    expect((await s.handle(begaran({ fileId: 'c' }, { tenant: tenant(APP_B) }))).status).toBe(200);

    // Utkastet delar kvot med den publicerade appen — annars vore gränsen lätt att dubbla.
    expect((await s.handle(begaran({ fileId: 'c' }, { tenant: tenant(APP_A, 'draft') }))).status).toBe(429);

    klocka = new Date(klocka.getTime() + 24 * 3600 * 1000 + 1000);
    expect((await s.handle(begaran({ fileId: 'c' }))).status).toBe(200);
  });

  it('sidor per användare och timme', async () => {
    const s = tjanst({ SVC_OCR_PAGES_PER_USER_HOUR: '1' });
    for (const id of ['a', 'b']) laggFil(id, png(10, 10, id.charCodeAt(0)));
    expect((await s.handle(begaran({ fileId: 'a' }))).status).toBe(200);
    expect((await s.handle(begaran({ fileId: 'b' }))).status).toBe(429);
    const bertil = { userId: 'anv-bertil', email: 'b@exempel.se', roles: ['viewer' as const] };
    expect((await s.handle(begaran({ fileId: 'b' }, { identity: bertil }))).status).toBe(200);
    klocka = new Date(klocka.getTime() + 3600 * 1000 + 1000);
    laggFil('c', png(10, 10, 3));
    expect((await s.handle(begaran({ fileId: 'c' }))).status).toBe(200);
  });

  it('samtidiga anrop kan inte tillsammans gå över gränsen', async () => {
    const s = tjanst({ SVC_OCR_PAGES_PER_APP_DAY: '1' });
    for (const id of ['a', 'b', 'c']) laggFil(id, png(10, 10, id.charCodeAt(0)));
    const svar = await Promise.all(['a', 'b', 'c'].map((id) => s.handle(begaran({ fileId: id }))));
    expect(svar.filter((x) => x.status === 200)).toHaveLength(1);
    expect(anrop).toHaveLength(1);
  });
});

describe('loggar', () => {
  it('innehåller aldrig igenkänd text, filinnehåll, e-post eller hela app-id:t', async () => {
    laggFil('kvitto', png(10, 10));
    const s = tjanst();
    await s.handle(begaran({ fileId: 'kvitto' }));
    await s.handle(begaran({ fileId: 'kvitto' }));
    expect(loggar.length).toBeGreaterThan(0);
    const allt = JSON.stringify(loggar);
    expect(allt).not.toContain('ICA');
    expect(allt).not.toContain('anna@exempel.se');
    expect(allt).not.toContain(APP_A);
    expect(allt).toContain(APP_A.slice(0, 8));
    expect(allt).not.toContain(Buffer.from(png(10, 10)).toString('base64').slice(0, 20));
  });
});
