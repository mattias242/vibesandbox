/**
 * Hårda fall: beteenden som gatewayn lovar men som de övriga testfilerna inte täcker.
 * Varje block svarar mot en rad i säkerhetsgenomgången av paketet — utgångna inloggningar,
 * dubbla huvuden, `Origin`, HEAD/OPTIONS, kroppar som ljuger om sin storlek, att en oinloggad
 * inte kan avgöra om en app finns, vad som får hamna i driftloggen, och att även de svar som
 * Nodes egen HTTP-tolk ger bär plattformens skyddsregler.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, CSRF_HEADER } from '@vibesandbox/contracts';
import type { ApiErrorBody, Identity } from '@vibesandbox/contracts';
import {
  RECOMMENDED_SERVER_OPTIONS,
  createGateway,
  createTestIdentityProvider,
  handleClientError,
  signTestIdentity,
} from '../src/index.ts';
import type { GatewayLogEntry } from '../src/index.ts';
import { allaHuvuden, anropa, anropaRatt, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { AnropSvar, Testserver } from './hjalp.ts';
import {
  skapaAppId,
  skapaFejkadIdentityProvider,
  skapaGodkannandeIdentityProvider,
  skapaIdentitet,
  skapaNekandeIdentityProvider,
  skapaTestUppsattning,
  textfil,
  vardnamnForApp,
} from './fejkar.ts';

const HEMLIGHET = 'harda-fall-hemlighet-som-ar-minst-32-tecken';
const DOKUMENTVAG = '/_api/collections/poster/docs';

function forvantaIngaCorsHuvuden(svar: AnropSvar) {
  const corsHuvuden = Object.keys(svar.huvuden).filter((namn) => namn.startsWith('access-control-'));
  expect(corsHuvuden).toEqual([]);
}

/** Skickar exakt dessa bytes. Behövs för kroppar som INTE är giltig UTF-8; `anropaRatt` tar bara strängar. */
function skickaBytes(port: number, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const bitar: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => socket.write(bytes));
    socket.on('data', (bit: Buffer) => bitar.push(bit));
    socket.on('close', () => resolve(Buffer.concat(bitar).toString('latin1')));
    socket.on('error', (fel) => (bitar.length > 0 ? resolve(Buffer.concat(bitar).toString('latin1')) : reject(fel)));
  });
}

describe('hårda fall', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  /** En publicerad app med startsida, och en inloggad användare, om inget annat anges. */
  async function starta(overrides: Parameters<typeof skapaTestUppsattning>[0] = {}) {
    const appId = skapaAppId(`harda-fall-${Math.random()}`);
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider(), ...overrides });
    uppsattning.register.registrera(appId, { published: true });
    uppsattning.filer.satt(appId, 'published', '/index.html', textfil('<html>startsidan</html>'));
    server = await startaTestserver(createGateway(uppsattning.options));
    return { appId, uppsattning, port: server.port, host: vardnamnForApp(appId) };
  }

  describe('testinloggningens utgångstid', () => {
    it('en korrekt signerad men utgången inloggning ⇒ 401, och store anropas aldrig', async () => {
      const { uppsattning, port, host } = await starta({
        identityProvider: createTestIdentityProvider({ secret: HEMLIGHET }),
      });
      const utgangen = signTestIdentity(skapaIdentitet(), HEMLIGHET, { expiresInSeconds: -1 });

      const svar = await anropa({ port, host, path: DOKUMENTVAG, headers: { Authorization: utgangen } });

      expect(svar.status).toBe(401);
      expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('samma inloggning med tid kvar godtas (kontrollen ovan beror alltså på tiden)', async () => {
      const { port, host } = await starta({ identityProvider: createTestIdentityProvider({ secret: HEMLIGHET }) });
      const giltig = signTestIdentity(skapaIdentitet(), HEMLIGHET, { expiresInSeconds: 60 });

      const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Authorization: giltig } });

      expect(svar.status).toBe(200);
    });
  });

  it('dubbla Authorization-huvuden ⇒ 400, och identitetsleverantören tillfrågas aldrig', async () => {
    const { uppsattning, port, host } = await starta({
      identityProvider: createTestIdentityProvider({ secret: HEMLIGHET }),
    });
    const giltig = signTestIdentity(skapaIdentitet(), HEMLIGHET);
    const annan = signTestIdentity(skapaIdentitet({ userId: 'nagon-annan' }), HEMLIGHET);

    const svar = await anropa({ port, host, path: '/_api/whoami', headers: { Authorization: [giltig, annan] } });

    expect(svar.status).toBe(400);
    expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
    expect(uppsattning.identityProvider.anrop).toHaveLength(0);
  });

  describe('Origin på skrivande anrop', () => {
    type OriginFor = (host: string) => string;

    async function spara(origin: OriginFor | undefined) {
      const miljo = await starta();
      const svar = await anropa({
        port: miljo.port,
        host: miljo.host,
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { [CSRF_HEADER]: '1', ...(origin === undefined ? {} : { Origin: origin(miljo.host) }) },
        json: { data: { rum: 'Stora salen' } },
      });
      return { svar, store: miljo.uppsattning.store };
    }

    const fall: ReadonlyArray<[string, OriginFor | undefined, number]> = [
      ['appens egen origin (https)', (host) => `https://${host}`, 201],
      ['appens egen origin med port', (host) => `http://${host}:8443`, 201],
      ['inget Origin-huvud alls (icke-webbläsare) men CSRF-huvudet finns', undefined, 201],
      ['en syskonapp under samma domän', () => `https://${vardnamnForApp(skapaAppId('syskonapp'))}`, 403],
      ['Origin: null (sandlådad ram)', () => 'null', 403],
      ['egen origin som prefix till en annan värd', (host) => `https://${host}.ond.test`, 403],
      ['annat protokoll', (host) => `ftp://${host}`, 403],
    ];

    it.each(fall)('%s ⇒ %i', async (_beskrivning, origin, forvantadStatus) => {
      const { svar, store } = await spara(origin);

      expect(svar.status).toBe(forvantadStatus);
      if (forvantadStatus === 403) {
        expect(json<ApiErrorBody>(svar).error.code).toBe('forbidden');
        expect(store.anrop).toHaveLength(0);
      } else {
        expect(store.anrop.map((a) => a.metod)).toEqual(['createDocument']);
      }
    });
  });

  describe('HEAD och OPTIONS', () => {
    it('HEAD på en statisk fil ger samma huvuden som GET men ingen kropp', async () => {
      const { port, host } = await starta();

      const get = await anropa({ port, host, path: '/' });
      const head = await anropa({ port, host, method: 'HEAD', path: '/' });

      expect(head.status).toBe(200);
      expect(head.kropp).toBe('');
      expect(enHuvud(head, 'Content-Type')).toBe(enHuvud(get, 'Content-Type'));
      expect(enHuvud(head, 'Content-Length')).toBe(String(Buffer.byteLength(get.kropp, 'utf8')));
      expect(enHuvud(head, 'Content-Security-Policy')).toBe(APP_CONTENT_SECURITY_POLICY);
    });

    it('HEAD i API:t ⇒ 405, och store anropas aldrig', async () => {
      const { uppsattning, port, host } = await starta();

      const svar = await anropa({ port, host, method: 'HEAD', path: DOKUMENTVAG });

      expect(svar.status).toBe(405);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('OPTIONS (preflight från en annan webbplats) ⇒ 405 method_not_allowed och ALDRIG något Access-Control-huvud', async () => {
      const { uppsattning, port, host } = await starta();

      const svar = await anropa({
        port,
        host,
        method: 'OPTIONS',
        path: DOKUMENTVAG,
        headers: {
          Origin: 'https://ond.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': CSRF_HEADER,
        },
      });

      expect(svar.status).toBe(405);
      expect(json<ApiErrorBody>(svar).error.code).toBe('method_not_allowed');
      expect(enHuvud(svar, 'Allow')).toBeDefined();
      forvantaIngaCorsHuvuden(svar);
      expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    });

    it('inte heller lyckade svar eller andra nekanden bär något Access-Control-huvud', async () => {
      const { port, host } = await starta();
      const ond = { Origin: 'https://ond.test' };

      forvantaIngaCorsHuvuden(await anropa({ port, host, path: '/_api/whoami', headers: ond }));
      forvantaIngaCorsHuvuden(await anropa({ port, host, path: '/', headers: ond }));
      forvantaIngaCorsHuvuden(await anropa({ port, host, method: 'POST', path: DOKUMENTVAG, headers: ond }));
    });
  });

  describe('förfrågningskroppen', () => {
    it('chunked kropp UTAN Content-Length över gränsen ⇒ 413 (bytes räknas, längdhuvudet behövs inte)', async () => {
      const { uppsattning, port, host } = await starta();
      const bit = 'x'.repeat(0x10000);
      const kropp = `${`10000\r\n${bit}\r\n`.repeat(24)}0\r\n\r\n`; // 1,5 MB

      const svar = await anropaRatt({
        port,
        requestrad: `POST ${DOKUMENTVAG} HTTP/1.1`,
        huvuden: [
          `Host: ${host}`,
          `${CSRF_HEADER}: 1`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: close',
        ],
        kropp,
        tidsgrans: 8000,
      });

      expect(svar.status).toBe(413);
      expect(json<ApiErrorBody>(svar).error.code).toBe('too_large');
      expect(uppsattning.store.anrop).toHaveLength(0);
    }, 10000);

    it.each([
      ['ett app-id bredvid data', { data: { rum: 'A' }, appId: 'en-annan-app' }],
      ['ett scope bredvid data', { data: { rum: 'A' }, scope: 'app' }],
    ])('extra fält i kroppen (%s) ⇒ 400', async (_beskrivning, kropp) => {
      const { uppsattning, port, host } = await starta();

      const svar = await anropa({ port, host, method: 'POST', path: DOKUMENTVAG, headers: { [CSRF_HEADER]: '1' }, json: kropp });

      expect(svar.status).toBe(400);
      expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
      expect(uppsattning.store.anrop).toHaveLength(0);
    });

    it('ogiltig UTF-8 i kroppen ⇒ 400 (blir aldrig tysta ersättningstecken i ett sparat dokument)', async () => {
      const { uppsattning, port, host } = await starta();
      // 0xC3 inleder ett tvåbytestecken men följs av ett citattecken: ogiltig UTF-8, men giltig
      // JSON för den som avkodar förlåtande.
      const kropp = Buffer.concat([Buffer.from('{"data":{"rum":"'), Buffer.from([0xc3]), Buffer.from('"}}')]);
      const huvud = [
        `POST ${DOKUMENTVAG} HTTP/1.1`,
        `Host: ${host}`,
        `${CSRF_HEADER}: 1`,
        'Content-Type: application/json',
        `Content-Length: ${kropp.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

      const svar = await skickaBytes(port, Buffer.concat([Buffer.from(huvud, 'latin1'), kropp]));

      expect(svar).toMatch(/^HTTP\/1\.1 400 /);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });
  });

  it.each([
    ['scope', '?scope=app&scope=user'],
    ['limit', '?limit=1&limit=100000'],
    ['cursor', '?cursor=a&cursor=b'],
  ])('frågeparametern %s angiven två gånger ⇒ 400 (varken första eller sista väljs)', async (_namn, fraga) => {
    const { uppsattning, port, host } = await starta();

    const svar = await anropa({ port, host, path: `${DOKUMENTVAG}${fraga}` });

    expect(svar.status).toBe(400);
    expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
    expect(uppsattning.store.anrop).toHaveLength(0);
  });

  describe('en oinloggad kan inte avgöra om en app finns', () => {
    it('okänt app-id utan inloggning ⇒ 401 (inte 404), och registret anropas ALDRIG', async () => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaNekandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));
      const okand = vardnamnForApp(skapaAppId('finns-inte-oinloggad'));

      for (const path of ['/_api/whoami', '/']) {
        const svar = await anropa({ port: server.port, host: okand, path });
        expect(svar.status).toBe(401);
        expect(json<ApiErrorBody>(svar).error.code).toBe('unauthenticated');
      }

      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
      expect(uppsattning.filer.anrop).toHaveLength(0);
    });

    it('svaret är identiskt för en app som finns och en som inte finns', async () => {
      const { port, host } = await starta({ identityProvider: skapaNekandeIdentityProvider() });
      const okand = vardnamnForApp(skapaAppId('finns-inte-jamforelse'));

      const finns = await anropa({ port, host, path: '/_api/whoami' });
      const finnsInte = await anropa({ port, host: okand, path: '/_api/whoami' });

      expect(finnsInte.status).toBe(finns.status);
      expect(finnsInte.kropp).toBe(finns.kropp);
      expect(Object.keys(finnsInte.huvuden).sort()).toEqual(Object.keys(finns.huvuden).sort());
    });

    it('inloggad mot okänt app-id får fortfarande 404', async () => {
      const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
      server = await startaTestserver(createGateway(uppsattning.options));

      const svar = await anropa({
        port: server.port,
        host: vardnamnForApp(skapaAppId('finns-inte-inloggad')),
        path: '/_api/whoami',
      });

      expect(svar.status).toBe(404);
      expect(uppsattning.register.anrop).toHaveLength(1);
    });
  });

  describe('ett svar från identitetsleverantören som inte ser ut som en identitet ⇒ 401', () => {
    const trasiga: ReadonlyArray<[string, unknown]> = [
      ['undefined', undefined],
      ['tomt objekt', {}],
      ['tomt userId', { userId: '', email: 'a@exempel.se', roles: [] }],
      ['userId är inte en sträng', { userId: 42, email: 'a@exempel.se', roles: [] }],
      ['e-post saknas', { userId: 'u', roles: [] }],
      ['roller är inte en lista', { userId: 'u', email: 'a@exempel.se', roles: 'admin' }],
      ['sant', true],
    ];

    it.each(trasiga)('%s', async (_beskrivning, svarFranLeverantor) => {
      const { uppsattning, port, host } = await starta({
        identityProvider: skapaFejkadIdentityProvider(() => svarFranLeverantor as Identity | null),
      });

      const svar = await anropa({ port, host, path: DOKUMENTVAG });

      expect(svar.status).toBe(401);
      expect(uppsattning.register.anrop).toHaveLength(0);
      expect(uppsattning.store.anrop).toHaveLength(0);
    });
  });

  it.each(['/.env', '/.git/config', '/assets/.hemlig', '/.well-known/x'])(
    'punktfilen %s ⇒ 400, och filregistret tillfrågas aldrig',
    async (path) => {
      const { uppsattning, port, host } = await starta();

      const svar = await anropa({ port, host, path });

      expect(svar.status).toBe(400);
      expect(uppsattning.filer.anrop).toHaveLength(0);
    },
  );

  describe('driftloggen', () => {
    it('innehåller aldrig e-post, Authorization-värde, sökväg, kropp eller mer än 8 tecken av app-id', async () => {
      const poster: GatewayLogEntry[] = [];
      const epost = 'anna.andersson@exempel.se';
      const identitet = skapaIdentitet({ userId: 'anv-anna', email: epost });
      const { appId, port, host, uppsattning } = await starta({
        identityProvider: createTestIdentityProvider({ secret: HEMLIGHET }),
        logger: (post) => poster.push(post),
      });
      const token = signTestIdentity(identitet, HEMLIGHET);
      const auth = { Authorization: token };
      const kroppsmarkor = 'KANSLIGT-DOKUMENTINNEHALL';
      const vagmarkor = 'personnummer-19121212-1212';

      // En blandning av lyckat, nekat och kraschat — alla ska loggas, inget ska läcka.
      await anropa({ port, host, path: '/_api/whoami', headers: auth });
      await anropa({ port, host, path: `/arenden/${vagmarkor}`, headers: auth });
      await anropa({ port, host, path: `/_api/collections/${vagmarkor}/docs?cursor=${vagmarkor}`, headers: auth });
      await anropa({
        port,
        host,
        method: 'POST',
        path: DOKUMENTVAG,
        headers: { ...auth, [CSRF_HEADER]: '1', Cookie: 'session=KAKVARDE-SOM-INTE-FAR-LOGGAS' },
        json: { data: { anteckning: kroppsmarkor } },
      });
      await anropa({ port, host, path: '/_api/whoami', headers: { Authorization: `${token}x` } });
      uppsattning.store.kastaVidNastaAnrop(new Error(`SQL-fel med ${epost} och ${kroppsmarkor}`));
      await anropa({ port, host, path: DOKUMENTVAG, headers: auth });

      const dump = JSON.stringify(poster);
      expect(poster.filter((p) => p.event === 'request')).toHaveLength(6);
      expect(poster.some((p) => p.event === 'internal_error')).toBe(true);
      expect(dump).toContain('anv-anna'); // userId ÄR det som ska användas
      expect(dump).toContain(appId.slice(0, 8));
      expect(dump).not.toContain(appId.slice(0, 9));
      expect(dump).not.toContain(epost);
      expect(dump).not.toContain('exempel.se');
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(token.slice(5, 25));
      expect(dump).not.toContain('KAKVARDE');
      expect(dump).not.toContain(kroppsmarkor);
      expect(dump).not.toContain(vagmarkor);
      expect(dump).not.toContain('SQL-fel');
    });

    it('en identitetsleverantör som kastar loggas som fel — utan felmeddelandet', async () => {
      const poster: GatewayLogEntry[] = [];
      const { port, host } = await starta({
        identityProvider: skapaFejkadIdentityProvider(() => {
          throw new Error('kunde inte slå upp hemlig.person@exempel.se');
        }),
        logger: (post) => poster.push(post),
      });

      const svar = await anropa({ port, host, path: '/_api/whoami' });

      expect(svar.status).toBe(401);
      expect(poster.some((p) => p.event === 'identity_provider_failed' && p.level === 'error')).toBe(true);
      expect(JSON.stringify(poster)).not.toContain('exempel.se');
    });

    it('en logger som kastar påverkar inte svaret', async () => {
      const { port, host } = await starta({
        logger: () => {
          throw new Error('loggdisken är full');
        },
      });

      const svar = await anropa({ port, host, path: '/_api/whoami' });

      expect(svar.status).toBe(200);
    });
  });
});

describe('serverinställningar och clientError-hanteraren', () => {
  let nodeServer: Server | undefined;

  afterEach(async () => {
    const stangs = nodeServer;
    nodeServer = undefined;
    if (stangs) {
      stangs.closeAllConnections();
      await new Promise<void>((resolve) => stangs.close(() => resolve()));
    }
  });

  /** Servern skapad så som apps/platform ska skapa den — inte som testhjälparen gör. */
  async function startaRiktigServer() {
    const uppsattning = skapaTestUppsattning({ identityProvider: skapaGodkannandeIdentityProvider() });
    const server = createServer(RECOMMENDED_SERVER_OPTIONS, createGateway(uppsattning.options));
    server.on('clientError', handleClientError);
    nodeServer = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const adress = server.address();
    if (adress === null || typeof adress === 'string') throw new Error('ingen port');
    return { port: adress.port, uppsattning, server };
  }

  function forvantaSkyddsregler(svar: AnropSvar) {
    expect(enHuvud(svar, 'Content-Security-Policy')).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(enHuvud(svar, 'X-Content-Type-Options')).toBe('nosniff');
    expect(enHuvud(svar, 'Referrer-Policy')).toBe('no-referrer');
    expect(enHuvud(svar, 'Cache-Control')).toBe('no-store');
    expect(enHuvud(svar, 'Connection')).toBe('close');
    expect(allaHuvuden(svar, 'Set-Cookie')).toEqual([]);
  }

  it('inställningarna är satta på servern', async () => {
    const { server } = await startaRiktigServer();

    expect(server.headersTimeout).toBe(RECOMMENDED_SERVER_OPTIONS.headersTimeout);
    expect(server.requestTimeout).toBe(RECOMMENDED_SERVER_OPTIONS.requestTimeout);
    expect(server.keepAliveTimeout).toBe(RECOMMENDED_SERVER_OPTIONS.keepAliveTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });

  const trasiga: ReadonlyArray<[string, string, readonly string[]]> = [
    ['NUL-byte i Host-huvudet', 'GET /_api/whoami HTTP/1.1', [`Host: a${String.fromCharCode(0)}b.appar.test`]],
    ['obegriplig förfrågningsrad', 'DETTA ÄR INTE HTTP', ['Host: x.appar.test']],
    ['blanktecken i huvudnamn', 'GET / HTTP/1.1', ['Host: x.appar.test', 'X Trasigt: 1']],
  ];

  it.each(trasiga)('%s ⇒ 400 MED skyddsreglerna, och hanteraren nås aldrig', async (_beskrivning, requestrad, huvuden) => {
    const { port, uppsattning } = await startaRiktigServer();

    const svar = await anropaRatt({ port, requestrad, huvuden: [...huvuden, 'Connection: close'] });

    expect(svar.status).toBe(400);
    expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
    forvantaSkyddsregler(svar);
    expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    expect(uppsattning.register.anrop).toHaveLength(0);
  });

  it('saknat Host-huvud ⇒ 400 MED skyddsreglerna (Node svarar annars själv, förbi både hanterare och clientError)', async () => {
    const { port, uppsattning } = await startaRiktigServer();

    const svar = await anropaRatt({ port, requestrad: 'GET /_api/whoami HTTP/1.1', huvuden: ['Connection: close'] });

    expect(svar.status).toBe(400);
    expect(json<ApiErrorBody>(svar).error.code).toBe('invalid_request');
    expect(enHuvud(svar, 'Content-Security-Policy')).toBe(APP_CONTENT_SECURITY_POLICY);
    expect(enHuvud(svar, 'X-Content-Type-Options')).toBe('nosniff');
    expect(enHuvud(svar, 'Referrer-Policy')).toBe('no-referrer');
    expect(uppsattning.identityProvider.anrop).toHaveLength(0);
    expect(uppsattning.register.anrop).toHaveLength(0);
  });

  it('huvuden över storleksgränsen (kakbombning) ⇒ 431 MED skyddsreglerna', async () => {
    const { port, uppsattning } = await startaRiktigServer();
    const bomb = `Cookie: fyllnad=${'x'.repeat(RECOMMENDED_SERVER_OPTIONS.maxHeaderSize * 2)}`;

    const svar = await anropaRatt({
      port,
      requestrad: 'GET /_api/whoami HTTP/1.1',
      huvuden: [`Host: ${vardnamnForApp(skapaAppId('kakbomb'))}`, bomb, 'Connection: close'],
    });

    expect(svar.status).toBe(431);
    forvantaSkyddsregler(svar);
    expect(svar.kropp).not.toContain('fyllnad');
    expect(uppsattning.identityProvider.anrop).toHaveLength(0);
  });

  it('en välformad förfrågan fungerar som vanligt på en server med de här inställningarna', async () => {
    const { port, uppsattning } = await startaRiktigServer();
    const appId = skapaAppId('riktig-server-ok');
    uppsattning.register.registrera(appId, { published: true });

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/whoami' });

    expect(svar.status).toBe(200);
  });
});
