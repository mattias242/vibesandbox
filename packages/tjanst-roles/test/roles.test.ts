/**
 * Tjänsten `roles` anropad direkt, som gatewayn anropar den: med `tenant`, `identity` och `access`
 * redan avgjorda. Medlemslistan är en fejk som testet ändrar i, som control gör när ägaren delar
 * eller tar bort åtkomst.
 *
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — i ett enhetstest är det enda
 * vägen att bygga ett TenantContext.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type {
  AppAccessRole,
  AppId,
  AppService,
  AppServiceDependencies,
  AppServiceResponse,
  Identity,
  TenantKind,
} from '@vibesandbox/contracts';
import { factory } from '../src/index.ts';

const APP = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' as AppId;
const ANNAN_APP = 'bbbbbbbbbbbbbbbbbbbbbbbbbb' as AppId;

const ANNA: Identity = { userId: 'anv-anna', email: 'anna.a@example.org', roles: ['builder'] };
const BERTIL: Identity = { userId: 'anv-bertil', email: 'bertil@example.org', roles: ['viewer'] };
const CECILIA: Identity = { userId: 'anv-cecilia', email: 'cecilia@example.org', roles: ['viewer'] };

type Medlem = { userId: string; role: AppAccessRole; email: string | null };

let katalog: string;
let tjanst: AppService;
let medlemmar: Map<AppId, Medlem[]>;
let loggar: Record<string, unknown>[];

function standardMedlemmar(): Medlem[] {
  return [
    { userId: ANNA.userId, role: 'owner', email: ANNA.email },
    { userId: BERTIL.userId, role: 'user', email: BERTIL.email },
    { userId: CECILIA.userId, role: 'user', email: CECILIA.email },
  ];
}

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-roles-'));
  medlemmar = new Map([
    [APP, standardMedlemmar()],
    [ANNAN_APP, [{ userId: ANNA.userId, role: 'owner', email: ANNA.email }]],
  ]);
  loggar = [];
  const beroenden: AppServiceDependencies = {
    dataDir: katalog,
    env: {},
    log: (entry) => loggar.push({ ...entry }),
    now: () => new Date('2026-09-19T12:00:00Z'),
    members: { members: async (appId) => medlemmar.get(appId) ?? [] },
    store: {} as AppServiceDependencies['store'],
    publishedUrl: (appId) => `https://${appId}.appar.test`,
  };
  tjanst = factory(beroenden).service;
});

afterEach(async () => {
  await tjanst.close?.();
  await rm(katalog, { recursive: true, force: true });
});

interface Anrop {
  readonly vem?: Identity;
  readonly metod?: string;
  readonly vag?: string;
  /** Segmenten som gatewayn redan avkodat — för värden som inte går att skriva i en `vag`. */
  readonly segment?: readonly string[];
  readonly json?: unknown;
  readonly kropp?: string;
  readonly typ?: string | null;
  readonly app?: AppId;
  readonly sort?: TenantKind;
  readonly fraga?: string;
}

async function anropa(anrop: Anrop = {}): Promise<{ status: number; json: unknown; svar: AppServiceResponse }> {
  const vem = anrop.vem ?? ANNA;
  const app = anrop.app ?? APP;
  const lista = medlemmar.get(app) ?? [];
  const access: AppAccessRole = lista.find((m) => m.userId === vem.userId)?.role ?? 'user';
  const metod = anrop.metod ?? 'GET';
  const kropp = anrop.kropp ?? (anrop.json === undefined ? undefined : JSON.stringify(anrop.json));
  const headers: Record<string, string> = {};
  const typ = anrop.typ === undefined ? 'application/json' : anrop.typ;
  if (kropp !== undefined && typ !== null) headers['content-type'] = typ;
  const svar = await tjanst.handle({
    method: metod,
    segments: anrop.segment ?? (anrop.vag ?? '').split('/').filter((s) => s.length > 0),
    query: anrop.fraga ?? '',
    headers,
    tenant: unsafeCreateTenantContext(app, anrop.sort ?? 'published'),
    identity: vem,
    access,
    ...(kropp === undefined ? {} : { body: new TextEncoder().encode(kropp) }),
  });
  const text = typeof svar.body === 'string' ? svar.body : svar.body === undefined ? '' : new TextDecoder().decode(svar.body);
  return { status: svar.status, json: text === '' ? undefined : JSON.parse(text), svar };
}

function felkod(json: unknown): unknown {
  return (json as { error?: { code?: unknown } }).error?.code;
}

async function definiera(ids: readonly string[], sort: TenantKind = 'published'): Promise<void> {
  const { status } = await anropa({ metod: 'PUT', vag: 'definitions', json: ids.map((id) => ({ id, name: id.toUpperCase() })), sort });
  expect(status).toBe(200);
}

async function tilldela(userId: string, roller: readonly string[]): Promise<void> {
  const { status } = await anropa({ metod: 'PUT', vag: `members/${userId}`, json: { roles: roller } });
  expect(status).toBe(200);
}

describe('tjänsten roles', () => {
  it('heter roles och tar bara emot små kroppar', () => {
    expect(tjanst.name).toBe('roles');
    expect(tjanst.maxBodyBytes).toBeGreaterThan(0);
    expect(tjanst.maxBodyBytes).toBeLessThanOrEqual(64 * 1024);
  });

  describe('rolldefinitioner', () => {
    it('en ny app har inga roller', async () => {
      const { status, json, svar } = await anropa({ vag: 'definitions' });
      expect(status).toBe(200);
      expect(json).toEqual([]);
      expect(svar.headers['Content-Type']).toMatch(/^application\/json/);
      expect(svar.headers['Cache-Control']).toBe('no-store');
    });

    it('ägaren inför roller och alla medlemmar ser dem, i den ordning ägaren angav', async () => {
      const defs = [
        { id: 'handlaggare', name: 'Handläggare' },
        { id: 'admin', name: 'Admin' },
      ];
      const satt = await anropa({ metod: 'PUT', vag: 'definitions', json: defs });
      expect(satt.status).toBe(200);
      expect(satt.json).toEqual(defs);
      expect((await anropa({ vem: BERTIL, vag: 'definitions' })).json).toEqual(defs);
    });

    it('namnet trimmas', async () => {
      const { json } = await anropa({ metod: 'PUT', vag: 'definitions', json: [{ id: 'admin', name: '  Admin  ' }] });
      expect(json).toEqual([{ id: 'admin', name: 'Admin' }]);
    });

    it('en användare som inte äger appen får inte införa roller (403)', async () => {
      const { status, json } = await anropa({ vem: BERTIL, metod: 'PUT', vag: 'definitions', json: [{ id: 'admin', name: 'Admin' }] });
      expect(status).toBe(403);
      expect(felkod(json)).toBe('forbidden');
      expect((await anropa({ vag: 'definitions' })).json).toEqual([]);
    });

    it.each([
      ['../admin'],
      ['admin/../chef'],
      ['Admin'],
      ['ADMIN'],
      ['__proto__'],
      ['admin\u0000'],
      ['a b'],
      [''],
      ['-admin'],
      ['a'.repeat(33)],
      ['åäö'],
      ['admin\n'],
    ])('roll-id %j avvisas', async (id) => {
      const { status, json } = await anropa({ metod: 'PUT', vag: 'definitions', json: [{ id, name: 'X' }] });
      expect(status).toBe(400);
      expect(felkod(json)).toBe('invalid_request');
    });

    it.each([
      ['inget namn', [{ id: 'admin' }]],
      ['tomt namn', [{ id: 'admin', name: '   ' }]],
      ['för långt namn', [{ id: 'admin', name: 'x'.repeat(61) }]],
      ['NUL i namnet', [{ id: 'admin', name: 'Ad\u0000min' }]],
      ['kontrolltecken i namnet', [{ id: 'admin', name: 'Ad\u001bmin' }]],
      ['id som tal', [{ id: 7, name: 'Sju' }]],
      ['samma id två gånger', [{ id: 'admin', name: 'A' }, { id: 'admin', name: 'B' }]],
      ['okänt fält', [{ id: 'admin', name: 'A', extra: true }]],
      ['inte en lista', { id: 'admin', name: 'A' }],
      ['null', null],
      ['en sträng i listan', ['admin']],
    ])('%s avvisas', async (_namn, kropp) => {
      const { status } = await anropa({ metod: 'PUT', vag: 'definitions', json: kropp });
      expect(status).toBe(400);
    });

    it('högst 20 roller', async () => {
      const tjugo = Array.from({ length: 20 }, (_, i) => ({ id: `roll-${i}`, name: `Roll ${i}` }));
      expect((await anropa({ metod: 'PUT', vag: 'definitions', json: tjugo })).status).toBe(200);
      const tjugoett = [...tjugo, { id: 'roll-20', name: 'Roll 20' }];
      const { status, json } = await anropa({ metod: 'PUT', vag: 'definitions', json: tjugoett });
      expect(status).toBe(400);
      expect(felkod(json)).toBe('invalid_request');
    });

    it('prototypnycklar som roll-id ger ingen särbehandling: constructor är ett vanligt id', async () => {
      await definiera(['constructor']);
      expect((await anropa({ vag: 'definitions' })).json).toEqual([{ id: 'constructor', name: 'CONSTRUCTOR' }]);
    });

    it('en kropp som inte är JSON avvisas', async () => {
      const { status } = await anropa({ metod: 'PUT', vag: 'definitions', kropp: '[{"id":' });
      expect(status).toBe(400);
    });

    it.each([['text/plain'], ['application/json; charset=latin1'], [null]])('en kropp med typen %j avvisas, som i data-API:t', async (typ) => {
      const { status } = await anropa({ metod: 'PUT', vag: 'definitions', kropp: '[]', typ });
      expect(status).toBe(400);
    });

    it('en kropp som inte är giltig UTF-8 avvisas', async () => {
      const svar = await tjanst.handle({
        method: 'PUT',
        segments: ['definitions'],
        query: '',
        headers: { 'content-type': 'application/json' },
        tenant: unsafeCreateTenantContext(APP, 'published'),
        identity: ANNA,
        access: 'owner',
        body: new Uint8Array([0x5b, 0x22, 0xff, 0xfe, 0x22, 0x5d]),
      });
      expect(svar.status).toBe(400);
    });
  });

  describe('tilldelning', () => {
    beforeEach(async () => {
      await definiera(['handlaggare', 'admin']);
    });

    it('ägaren ger en medlem roller, och medlemmen ser dem som sina', async () => {
      const { status, json } = await anropa({ metod: 'PUT', vag: `members/${BERTIL.userId}`, json: { roles: ['handlaggare'] } });
      expect(status).toBe(200);
      expect(json).toEqual({ userId: BERTIL.userId, displayName: 'bertil', access: 'user', roles: ['handlaggare'] });
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toEqual({ userId: BERTIL.userId, access: 'user', roles: ['handlaggare'] });
      expect((await anropa({ vem: CECILIA, vag: 'me' })).json).toEqual({ userId: CECILIA.userId, access: 'user', roles: [] });
    });

    it('en ny tilldelning ersätter den gamla; en tom lista tar bort alla roller', async () => {
      await tilldela(BERTIL.userId, ['handlaggare', 'admin']);
      await tilldela(BERTIL.userId, ['admin']);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: ['admin'] });
      await tilldela(BERTIL.userId, []);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: [] });
    });

    it('rollerna ges i definitionernas ordning, oavsett i vilken ordning de tilldelades', async () => {
      await tilldela(BERTIL.userId, ['admin', 'handlaggare']);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: ['handlaggare', 'admin'] });
    });

    it('ägaren kan ge sig själv en roll', async () => {
      await tilldela(ANNA.userId, ['admin']);
      expect((await anropa({ vag: 'me' })).json).toEqual({ userId: ANNA.userId, access: 'owner', roles: ['admin'] });
    });

    it('en användare får inte dela ut roller, inte ens till sig själv (403)', async () => {
      const { status, json } = await anropa({ vem: BERTIL, metod: 'PUT', vag: `members/${BERTIL.userId}`, json: { roles: ['admin'] } });
      expect(status).toBe(403);
      expect(felkod(json)).toBe('forbidden');
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: [] });
    });

    it.each([['chef'], ['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty'], ['Admin'], ['../admin']])(
      'en roll som inte är införd (%j) går inte att dela ut',
      async (roll) => {
        const { status, json } = await anropa({ metod: 'PUT', vag: `members/${BERTIL.userId}`, json: { roles: [roll] } });
        expect(status).toBe(400);
        expect(felkod(json)).toBe('invalid_request');
        expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: [] });
      },
    );

    it.each([
      ['roles saknas', {}],
      ['roles är ingen lista', { roles: 'admin' }],
      ['roll som tal', { roles: [1] }],
      ['samma roll två gånger', { roles: ['admin', 'admin'] }],
      ['okänt fält', { roles: ['admin'], userId: 'anv-cecilia' }],
      ['för många roller', { roles: Array.from({ length: 21 }, () => 'admin') }],
      ['inte ett objekt', ['admin']],
    ])('%s avvisas', async (_namn, kropp) => {
      const { status } = await anropa({ metod: 'PUT', vag: `members/${BERTIL.userId}`, json: kropp });
      expect(status).toBe(400);
    });

    it('en __proto__-nyckel i kroppen ger ingen roll', async () => {
      const { status } = await anropa({
        metod: 'PUT',
        vag: `members/${BERTIL.userId}`,
        kropp: '{"roles":[],"__proto__":{"roles":["admin"]}}',
      });
      expect(status).toBe(400);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: [] });
    });

    it.each([['anv-okand'], ['__proto__'], ['constructor'], ['..'], ['anv-bertil\u0000'], ['ANV-BERTIL'], ['x'.repeat(500)]])(
      'den som inte är medlem (%j) får inga roller: finns inte',
      async (userId) => {
        const { status, json } = await anropa({ metod: 'PUT', segment: ['members', userId], json: { roles: ['admin'] } });
        expect(status).toBe(404);
        expect(felkod(json)).toBe('not_found');
      },
    );

    it('userId tas ur segmentet som det står — tjänsten avkodar det inte en gång till', async () => {
      const { status } = await anropa({ metod: 'PUT', segment: ['members', `${BERTIL.userId}%00`], json: { roles: ['admin'] } });
      expect(status).toBe(404);
    });

    it('den som tas bort ur appen har inte kvar sina roller, inte heller om hen bjuds in igen', async () => {
      await tilldela(BERTIL.userId, ['admin']);
      medlemmar.set(APP, standardMedlemmar().filter((m) => m.userId !== BERTIL.userId));
      const lista = (await anropa({ vag: 'members' })).json as { userId: string; roles: string[] }[];
      expect(lista.map((m) => m.userId)).not.toContain(BERTIL.userId);
      expect(lista.some((m) => m.roles.includes('admin'))).toBe(false);
      // Borttagen: tilldelning ger "finns inte".
      expect((await anropa({ metod: 'PUT', vag: `members/${BERTIL.userId}`, json: { roles: ['admin'] } })).status).toBe(404);
      // Inbjuden igen: börjar utan roller.
      medlemmar.set(APP, standardMedlemmar());
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: [] });
    });

    it('en roll som tas bort ur definitionerna försvinner från alla som hade den, och kommer inte tillbaka om den införs igen', async () => {
      await tilldela(BERTIL.userId, ['handlaggare', 'admin']);
      await definiera(['handlaggare', 'granskare']);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: ['handlaggare'] });
      await definiera(['handlaggare', 'granskare', 'admin']);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: ['handlaggare'] });
    });
  });

  describe('medlemmar', () => {
    it('alla medlemmar med visningsnamn (e-postens lokala del), åtkomst och roller — aldrig e-postadressen', async () => {
      await definiera(['admin']);
      await tilldela(CECILIA.userId, ['admin']);
      medlemmar.get(APP)?.push({ userId: 'anv-utan-adress', role: 'user', email: null });
      const { status, json } = await anropa({ vem: BERTIL, vag: 'members' });
      expect(status).toBe(200);
      expect(json).toEqual([
        { userId: ANNA.userId, displayName: 'anna.a', access: 'owner', roles: [] },
        { userId: BERTIL.userId, displayName: 'bertil', access: 'user', roles: [] },
        { userId: CECILIA.userId, displayName: 'cecilia', access: 'user', roles: ['admin'] },
        { userId: 'anv-utan-adress', displayName: 'Användare', access: 'user', roles: [] },
      ]);
      expect(JSON.stringify(json)).not.toContain('@');
      expect(JSON.stringify(json)).not.toContain('example.org');
    });

    it('/me för den inloggade', async () => {
      expect((await anropa({ vem: CECILIA, vag: 'me' })).json).toEqual({ userId: CECILIA.userId, access: 'user', roles: [] });
    });
  });

  describe('isolering', () => {
    it('en annan app ser inte appens roller eller tilldelningar', async () => {
      await definiera(['admin']);
      await tilldela(ANNA.userId, ['admin']);
      expect((await anropa({ app: ANNAN_APP, vag: 'definitions' })).json).toEqual([]);
      expect((await anropa({ app: ANNAN_APP, vag: 'me' })).json).toMatchObject({ roles: [] });
    });

    it('en annan app kan inte dela ut en roll bara för att samma roll-id finns i den första', async () => {
      await definiera(['admin']);
      const { status } = await anropa({ app: ANNAN_APP, metod: 'PUT', vag: `members/${ANNA.userId}`, json: { roles: ['admin'] } });
      expect(status).toBe(400);
    });

    it('utkastet har egna roller och kan inte ändra den publicerade appens', async () => {
      await definiera(['admin']);
      await tilldela(BERTIL.userId, ['admin']);
      await definiera(['test'], 'draft');
      expect((await anropa({ vag: 'definitions' })).json).toEqual([{ id: 'admin', name: 'ADMIN' }]);
      expect((await anropa({ vag: 'definitions', sort: 'draft' })).json).toEqual([{ id: 'test', name: 'TEST' }]);
      expect((await anropa({ vem: BERTIL, vag: 'me' })).json).toMatchObject({ roles: ['admin'] });
    });

    it('rollerna finns kvar när tjänsten startas om', async () => {
      await definiera(['admin']);
      await tjanst.close?.();
      tjanst = factory({
        dataDir: katalog,
        env: {},
        log: () => {},
        now: () => new Date(),
        members: { members: async (appId) => medlemmar.get(appId) ?? [] },
        store: {} as AppServiceDependencies['store'],
        publishedUrl: (appId) => appId,
      }).service;
      expect((await anropa({ vag: 'definitions' })).json).toEqual([{ id: 'admin', name: 'ADMIN' }]);
    });
  });

  describe('rutter', () => {
    it.each([
      ['GET', ''],
      ['GET', 'okand'],
      ['GET', 'members/anv-bertil/extra'],
      ['GET', 'definitions/x'],
      ['GET', 'me/x'],
    ])('%s /%s finns inte', async (metod, vag) => {
      const { status, json } = await anropa({ metod, vag });
      expect(status).toBe(404);
      expect(felkod(json)).toBe('not_found');
    });

    it.each([
      ['POST', 'definitions'],
      ['DELETE', 'definitions'],
      ['PUT', 'me'],
      ['POST', 'members'],
      ['GET', 'members/anv-bertil'],
    ])('%s /%s: fel metod', async (metod, vag) => {
      const { status, json } = await anropa({ metod, vag, json: [] });
      expect(status).toBe(405);
      expect(felkod(json)).toBe('method_not_allowed');
    });

    it('en frågesträng nekas', async () => {
      expect((await anropa({ vag: 'members', fraga: 'x=1&x=2' })).status).toBe(400);
    });

    it('HEAD fungerar som GET', async () => {
      expect((await anropa({ metod: 'HEAD', vag: 'definitions' })).status).toBe(200);
    });
  });

  describe('loggar', () => {
    it('loggar ändringar med förkortat app-id, utan e-postadresser eller roll-namn', async () => {
      await definiera(['admin']);
      await tilldela(BERTIL.userId, ['admin']);
      const text = JSON.stringify(loggar);
      expect(loggar.length).toBeGreaterThan(0);
      expect(text).not.toContain('@');
      expect(text).not.toContain(APP);
      expect(text).toContain(APP.slice(0, 8));
    });
  });
});
