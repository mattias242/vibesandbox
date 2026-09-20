/**
 * Tjänsten `extract` mot en fejkad filläsare och en fejkad pdf-läsare. Inget nät, ingen
 * leverantör: allt arbete sker här. Fientliga fall: någon annans fil, fel filtyp, zip-bomb,
 * sökvägar i arkivet, XXE, 0 byte, jättetext, samtidiga anrop mot kvoten — och att varken
 * texten eller filnamnet hamnar i loggen.
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
import { createExtractService } from '../src/tjanst.ts';
import type { PdfReader } from '../src/tjanst.ts';
import { DOCX_STYCKEN, PDF, byggZip, docx, pptx, xlsx, zipBomb, zipMedSokvagar } from './exempel.ts';

const APP_A = '0123456789abcdefghjkmnpqrs' as AppId;
const APP_B = 'zyxwvtsrqpnmkjhgfedcba9876' as AppId;
const DOCX_TEXT = DOCX_STYCKEN.join('\n');

function tenant(appId: AppId = APP_A, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

interface Fil {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly name: string;
}

/** Filer per app — en annan apps fil-id ger `null`, precis som tjänsten `files` lovar. */
function fejkadFillasare(): AppFileReader & { filer: Map<string, Fil> } {
  const filer = new Map<string, Fil>();
  return {
    filer,
    async read(t: TenantContext, fileId: string) {
      return filer.get(`${t.appId}/${t.kind}/${fileId}`) ?? null;
    },
  };
}

let katalog: string;
let loggar: Record<string, unknown>[];
let klocka: Date;
let lasare: ReturnType<typeof fejkadFillasare>;
let pdfAnrop: number;
let pdfSvar: PdfReader;
const oppna: AppService[] = [];

function beroenden(env: Record<string, string> = {}, andra: Partial<AppServiceDependencies> = {}): AppServiceDependencies {
  return {
    dataDir: katalog,
    env,
    log: (entry) => loggar.push({ ...entry }),
    now: () => klocka,
    members: { members: async () => [] },
    store: {} as AppServiceDependencies['store'],
    publishedUrl: () => 'https://exempel.test',
    files: lasare,
    ...andra,
  };
}

const pdfLasare: PdfReader = (bytes, granser) => {
  pdfAnrop += 1;
  return pdfSvar(bytes, granser);
};

function tjanst(env: Record<string, string> = {}): AppService {
  const { service } = createExtractService(beroenden(env), { pdf: pdfLasare });
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

interface Kropp {
  text?: string;
  kind?: string;
  truncated?: boolean;
  pages?: number;
  hasText?: boolean;
  message?: string;
  error?: { code: string; message: string };
}

function kropp(svar: AppServiceResponse): Kropp {
  return JSON.parse(String(svar.body)) as Kropp;
}

function laggFil(fileId: string, body: Uint8Array, appId: AppId = APP_A, kind: TenantKind = 'published'): void {
  lasare.filer.set(`${appId}/${kind}/${fileId}`, { body, contentType: 'application/octet-stream', name: `${fileId}.docx` });
}

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'tjanst-extract-'));
  loggar = [];
  klocka = new Date('2026-09-20T10:00:00Z');
  lasare = fejkadFillasare();
  pdfAnrop = 0;
  pdfSvar = () => ({ text: 'Beslut i ärendet', pages: 3, truncated: false });
});

afterEach(async () => {
  for (const service of oppna.splice(0)) await service.close?.();
  await rm(katalog, { recursive: true, force: true });
});

/** Beroenden utan tjänsten `files` — precis som plattformen ger dem när `files` är avslagen. */
function utanFillasare(): AppServiceDependencies {
  const deps: Record<string, unknown> = { ...beroenden() };
  delete deps['files'];
  return deps as unknown as AppServiceDependencies;
}

describe('fabriken', () => {
  it('vägrar starta utan tjänsten files och säger vad som ska göras', () => {
    expect(() => createExtractService(utanFillasare(), { pdf: pdfLasare })).toThrow(/files/);
    expect(() => createExtractService(utanFillasare(), { pdf: pdfLasare })).toThrow(/slå på båda/);
  });

  it('vägrar starta på en oläslig inställning', () => {
    expect(() => tjanst({ SVC_EXTRACT_MAX_CHARS: 'jättemånga' })).toThrow(/SVC_EXTRACT_MAX_CHARS/);
  });

  it('en tom inställning är samma sak som ingen inställning', () => {
    expect(() => tjanst({ SVC_EXTRACT_MAX_CHARS: '' })).not.toThrow();
  });
});

describe('POST /_api/extract', () => {
  it('ger texten ur ett Word-dokument', async () => {
    laggFil('fil1', docx());
    const svar = await tjanst().handle(begaran({ fileId: 'fil1' }));
    expect(svar.status).toBe(200);
    expect(kropp(svar)).toEqual({ text: DOCX_TEXT, kind: 'docx', truncated: false, hasText: true });
  });

  it('ger texten ur ett kalkylblad', async () => {
    laggFil('fil2', xlsx());
    const svar = await tjanst().handle(begaran({ fileId: 'fil2' }));
    expect(kropp(svar).kind).toBe('xlsx');
    expect(kropp(svar).text).toBe('Ärende\tHandläggare\tBelopp\n2026-114\tAnna\t4200');
  });

  it('ger texten ur en presentation, bild för bild', async () => {
    laggFil('fil3', pptx());
    const svar = await tjanst().handle(begaran({ fileId: 'fil3' }));
    expect(kropp(svar).kind).toBe('pptx');
    expect(kropp(svar).pages).toBe(2);
    expect(kropp(svar).text).toContain('Budget 2027');
  });

  it('ger texten ur en PDF genom pdf-läsaren', async () => {
    laggFil('fil4', PDF);
    const svar = await tjanst().handle(begaran({ fileId: 'fil4' }));
    expect(kropp(svar)).toEqual({ text: 'Beslut i ärendet', kind: 'pdf', truncated: false, pages: 3, hasText: true });
    expect(pdfAnrop).toBe(1);
  });

  it('en inskannad PDF ger tom text, ett tydligt fält och en mening att visa', async () => {
    pdfSvar = () => null;
    laggFil('fil5', PDF);
    const svar = await tjanst().handle(begaran({ fileId: 'fil5' }));
    expect(svar.status).toBe(200);
    expect(kropp(svar).text).toBe('');
    expect(kropp(svar).hasText).toBe(false);
    expect(kropp(svar).message).toMatch(/bild/i);
  });

  it('en trasig PDF blir ett begripligt fel utan interna detaljer', async () => {
    pdfSvar = () => {
      throw new Error('offset 0x41 i xref-tabellen är trasig');
    };
    laggFil('fil6', PDF);
    const svar = await tjanst().handle(begaran({ fileId: 'fil6' }));
    expect(svar.status).toBe(400);
    expect(kropp(svar).error?.code).toBe('invalid_request');
    expect(svar.body).not.toContain('xref');
  });

  it('en fil från en annan app finns inte', async () => {
    laggFil('frammande', docx(), APP_B);
    const svar = await tjanst().handle(begaran({ fileId: 'frammande' }));
    expect(svar.status).toBe(404);
    expect(kropp(svar).error?.code).toBe('not_found');
  });

  it('utkastet och den publicerade appen delar inte text', async () => {
    const service = tjanst();
    laggFil('fil', docx(['Publicerat']));
    laggFil('fil', docx(['Utkast']), APP_A, 'draft');
    expect(kropp(await service.handle(begaran({ fileId: 'fil' }))).text).toBe('Publicerat');
    expect(kropp(await service.handle(begaran({ fileId: 'fil' }, { tenant: tenant(APP_A, 'draft') }))).text).toBe('Utkast');
  });

  it('en filtyp som inte stöds avvisas i klarspråk', async () => {
    laggFil('text', new TextEncoder().encode('Bara en anteckning'));
    const svar = await tjanst().handle(begaran({ fileId: 'text' }));
    expect(svar.status).toBe(400);
    expect(kropp(svar).error?.message).toMatch(/Word|Excel|PowerPoint|PDF/);
  });

  it('en zip som inte är ett Office-dokument avvisas', async () => {
    laggFil('zip', byggZip([{ namn: 'index.html', innehall: '<p>hej</p>' }]));
    expect((await tjanst().handle(begaran({ fileId: 'zip' }))).status).toBe(400);
  });

  it('en tom fil avvisas', async () => {
    laggFil('tom', new Uint8Array(0));
    expect((await tjanst().handle(begaran({ fileId: 'tom' }))).status).toBe(400);
  });

  it('en zip-bomb stoppas innan den packas upp', async () => {
    laggFil('bomb', zipBomb());
    const svar = await tjanst().handle(begaran({ fileId: 'bomb' }));
    expect(svar.status).toBe(413);
    expect(kropp(svar).error?.code).toBe('too_large');
  });

  it('ett arkiv med sökvägar utanför sig självt avvisas', async () => {
    laggFil('ut', zipMedSokvagar());
    expect((await tjanst().handle(begaran({ fileId: 'ut' }))).status).toBe(400);
  });

  it('en extern entitet i XML läses aldrig', async () => {
    const xxe = byggZip([
      { namn: '[Content_Types].xml', innehall: '<Types/>' },
      {
        namn: 'word/document.xml',
        innehall:
          '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY ut SYSTEM "file:///etc/passwd">]><w:document xmlns:w="w"><w:body><w:p><w:t>&ut;</w:t></w:p></w:body></w:document>',
      },
    ]);
    laggFil('xxe', xxe);
    const svar = await tjanst().handle(begaran({ fileId: 'xxe' }));
    expect(svar.status).toBe(400);
    expect(String(svar.body)).not.toContain('root:');
    expect(String(svar.body)).not.toContain('passwd');
  });

  it('en för stor fil avvisas utan att läsas', async () => {
    laggFil('stor', docx());
    const svar = await tjanst({ SVC_EXTRACT_MAX_FILE_BYTES: '100' }).handle(begaran({ fileId: 'stor' }));
    expect(svar.status).toBe(413);
  });

  it('en jättestor text kapas och svaret säger det', async () => {
    laggFil('lang', docx(Array.from({ length: 200 }, (_, i) => `Stycke ${i} ${'x'.repeat(200)}`)));
    const svar = await tjanst({ SVC_EXTRACT_MAX_CHARS: '500' }).handle(begaran({ fileId: 'lang' }));
    expect(svar.status).toBe(200);
    expect(kropp(svar).truncated).toBe(true);
    expect(kropp(svar).text).toHaveLength(500);
  });

  it('samma fil läses en gång och sedan ur cachen', async () => {
    laggFil('pdf', PDF);
    const service = tjanst();
    const ett = await service.handle(begaran({ fileId: 'pdf' }));
    const två = await service.handle(begaran({ fileId: 'pdf' }));
    expect(kropp(två)).toEqual(kropp(ett));
    expect(pdfAnrop).toBe(1);
    expect(loggar.at(-1)).toMatchObject({ event: 'extract_read', cached: true });
  });

  it('en fil som bytt innehåll under samma id läses om', async () => {
    const service = tjanst();
    laggFil('fil', docx(['Först']));
    expect(kropp(await service.handle(begaran({ fileId: 'fil' }))).text).toBe('Först');
    laggFil('fil', docx(['Sedan']));
    expect(kropp(await service.handle(begaran({ fileId: 'fil' }))).text).toBe('Sedan');
  });

  it('en borttagen fil finns inte, även om texten ligger i cachen', async () => {
    laggFil('fil', docx());
    const service = tjanst();
    expect((await service.handle(begaran({ fileId: 'fil' }))).status).toBe(200);
    lasare.filer.clear();
    expect((await service.handle(begaran({ fileId: 'fil' }))).status).toBe(404);
  });

  it('en app ser aldrig en annan apps cachade text', async () => {
    const service = tjanst();
    laggFil('samma', docx(['Appen A']));
    laggFil('samma', docx(['Appen B']), APP_B);
    expect(kropp(await service.handle(begaran({ fileId: 'samma' }))).text).toBe('Appen A');
    expect(kropp(await service.handle(begaran({ fileId: 'samma' }, { tenant: tenant(APP_B) }))).text).toBe('Appen B');
  });

  it('appens dygnsgräns ger 429 i klarspråk', async () => {
    const service = tjanst({ SVC_EXTRACT_CALLS_PER_APP_DAY: '2' });
    for (let i = 1; i <= 2; i += 1) {
      laggFil(`fil${i}`, docx([`Nummer ${i}`]));
      expect((await service.handle(begaran({ fileId: `fil${i}` }))).status).toBe(200);
    }
    laggFil('fil3', docx(['Nummer 3']));
    const svar = await service.handle(begaran({ fileId: 'fil3' }));
    expect(svar.status).toBe(429);
    expect(kropp(svar).error?.code).toBe('rate_limited');
    expect(kropp(svar).error?.message).toMatch(/gräns/);
  });

  it('användarens timgräns ger 429', async () => {
    const service = tjanst({ SVC_EXTRACT_CALLS_PER_USER_HOUR: '1' });
    laggFil('a', docx(['A']));
    laggFil('b', docx(['B']));
    expect((await service.handle(begaran({ fileId: 'a' }))).status).toBe(200);
    expect((await service.handle(begaran({ fileId: 'b' }))).status).toBe(429);
  });

  it('samtidiga anrop kan inte ta samma sista plats i kvoten', async () => {
    const service = tjanst({ SVC_EXTRACT_CALLS_PER_APP_DAY: '2' });
    for (const namn of ['a', 'b', 'c', 'd']) laggFil(namn, docx([namn]));
    const svar = await Promise.all(['a', 'b', 'c', 'd'].map((namn) => service.handle(begaran({ fileId: namn }))));
    expect(svar.filter((s) => s.status === 200)).toHaveLength(2);
    expect(svar.filter((s) => s.status === 429)).toHaveLength(2);
  });

  it('ett misslyckat anrop kostar ingen kvot', async () => {
    const service = tjanst({ SVC_EXTRACT_CALLS_PER_APP_DAY: '1' });
    laggFil('trasig', byggZip([{ namn: '[Content_Types].xml', innehall: '<Types/>' }, { namn: 'word/document.xml', innehall: '<w:p>' }]));
    laggFil('bra', docx());
    expect((await service.handle(begaran({ fileId: 'trasig' }))).status).toBe(400);
    expect((await service.handle(begaran({ fileId: 'bra' }))).status).toBe(200);
  });

  it('bara POST utan extra segment', async () => {
    const service = tjanst();
    expect((await service.handle(begaran({ fileId: 'x' }, { method: 'GET' }))).status).toBe(405);
    expect((await service.handle(begaran({ fileId: 'x' }, { segments: ['något'] }))).status).toBe(404);
  });

  it('fientliga kroppar avvisas utan att någon fil slås upp', async () => {
    const service = tjanst();
    const dåliga: unknown[] = [
      'inte json alls',
      '[]',
      JSON.stringify({}),
      JSON.stringify({ fileId: 42 }),
      JSON.stringify({ fileId: '../../etc/passwd' }),
      JSON.stringify({ fileId: 'a/b' }),
      JSON.stringify({ fileId: 'fil\u0000' }),
      JSON.stringify({ fileId: 'f'.repeat(201) }),
      JSON.stringify({ fileId: 'fil', appId: APP_B }),
    ];
    for (const kroppen of dåliga) {
      const svar = await service.handle(begaran(kroppen));
      expect(svar.status, String(kroppen)).toBe(400);
    }
  });

  it('loggen bär aldrig text, filnamn eller hela app-id', async () => {
    laggFil('hemlig', docx(['Personnummer 19800101-0000 hos Anna Andersson']));
    await tjanst().handle(begaran({ fileId: 'hemlig' }));
    const allt = JSON.stringify(loggar);
    expect(allt).not.toContain('Personnummer');
    expect(allt).not.toContain('Andersson');
    expect(allt).not.toContain('hemlig');
    expect(allt).not.toContain(APP_A);
    expect(allt).toContain(APP_A.slice(0, 8));
  });
});
