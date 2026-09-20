/**
 * Plattformstjänster för appar under `/_api/<namn>/…` (contracts `AppService`).
 *
 * En tjänst nås först när gatewayn avgjort hyresgäst, inloggning, åtkomst till appen och CSRF —
 * precis som data-API:t. Det tjänsten får veta om VEM och VILKEN APP kommer bara därifrån.
 * Det tjänsten svarar går genom en allowlista: plattformens skyddshuvuden vinner alltid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@vibesandbox/contracts';
import type { AppService, AppServiceRequest, AppServiceResponse } from '@vibesandbox/contracts';
import { createGateway } from '../src/index.ts';
import { anropa, enHuvud, json, startaTestserver } from './hjalp.ts';
import type { Testserver } from './hjalp.ts';
import {
  STANDARDANVANDARE,
  skapaGodkannandeIdentityProvider,
  skapaAppId,
  skapaTestUppsattning,
  vardnamnForApp,
  vardnamnForForhandsvisning,
} from './fejkar.ts';

interface FejkadTjanst extends AppService {
  readonly anrop: AppServiceRequest[];
}

function skapaTjanst(
  namn: string,
  svar: (anrop: AppServiceRequest) => AppServiceResponse | Promise<AppServiceResponse> = () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{"ok":true}',
  }),
  maxBodyBytes = 1024,
): FejkadTjanst {
  const anrop: AppServiceRequest[] = [];
  return {
    name: namn,
    maxBodyBytes,
    anrop,
    async handle(request) {
      anrop.push(request);
      return svar(request);
    },
  };
}

describe('Plattformstjänster för appar', () => {
  let server: Testserver | undefined;

  afterEach(async () => {
    await server?.stang();
    server = undefined;
  });

  async function starta(tjanster: readonly AppService[], atkomst: 'owner' | 'user' | null = 'user') {
    const appId = skapaAppId('tjanst');
    const uppsattning = skapaTestUppsattning({ services: tjanster, identityProvider: skapaGodkannandeIdentityProvider() });
    uppsattning.register.registrera(appId, { published: true, draft: true });
    if (atkomst !== null) uppsattning.register.bevilja(appId, STANDARDANVANDARE.userId, atkomst);
    server = await startaTestserver(createGateway(uppsattning.options));
    return { appId, port: server.port, register: uppsattning.register };
  }

  it('tjänsten får segmenten efter sitt namn, frågan, appen ur värdnamnet, identiteten och rollen', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer/abc/innehall?format=text' });

    expect(svar.status).toBe(200);
    expect(json(svar)).toEqual({ ok: true });
    expect(tjanst.anrop).toHaveLength(1);
    const anrop = tjanst.anrop[0]!;
    expect(anrop.method).toBe('GET');
    expect(anrop.segments).toEqual(['abc', 'innehall']);
    expect(anrop.query).toBe('format=text');
    expect(anrop.tenant.appId).toBe(appId);
    expect(anrop.tenant.kind).toBe('published');
    expect(anrop.identity.userId).toBe(STANDARDANVANDARE.userId);
    expect(anrop.access).toBe('user');
    expect(anrop.body).toBeUndefined();
  });

  it('på förhandsvisningen är det utkastets hyresgäst och ägarens roll', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst], 'owner');

    const svar = await anropa({ port, host: vardnamnForForhandsvisning(appId), path: '/_api/filer' });

    expect(svar.status).toBe(200);
    expect(tjanst.anrop[0]?.tenant.kind).toBe('draft');
    expect(tjanst.anrop[0]?.access).toBe('owner');
  });

  it('den som saknar åtkomst till appen når aldrig tjänsten, och får samma svar som för en app som inte finns', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst], null);

    const nekad = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer' });
    const saknas = await anropa({ port, host: vardnamnForApp(skapaAppId('finns-inte')), path: '/_api/filer' });

    expect(nekad.status).toBe(404);
    expect(nekad.kropp).toBe(saknas.kropp);
    expect(tjanst.anrop).toHaveLength(0);
  });

  it('en tjänst som inte är påslagen finns inte: samma svar som en okänd API-rutt', async () => {
    const { appId, port } = await starta([skapaTjanst('filer')]);

    const avslagen = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/ocr/las' });
    const okand = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/finns-inte/las' });

    expect(avslagen.status).toBe(okand.status);
    expect(avslagen.kropp).toBe(okand.kropp);
  });

  it('data-API:ts egna rutter går fortfarande till data-API:t', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/whoami' });

    expect(svar.status).toBe(200);
    expect(tjanst.anrop).toHaveLength(0);
  });

  it('skrivande anrop utan skyddshuvudet nekas innan tjänsten anropas', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), method: 'POST', path: '/_api/filer', body: 'x' });

    expect(svar.status).toBe(403);
    expect(tjanst.anrop).toHaveLength(0);
  });

  it('en kropp upp till tjänstens gräns når tjänsten oförändrad', async () => {
    const tjanst = skapaTjanst('filer', undefined, 16);
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({
      port,
      host: vardnamnForApp(appId),
      method: 'POST',
      path: '/_api/filer',
      headers: { [CSRF_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
      body: '0123456789abcdef',
    });

    expect(svar.status).toBe(200);
    expect(Buffer.from(tjanst.anrop[0]!.body!).toString('utf8')).toBe('0123456789abcdef');
    expect(tjanst.anrop[0]!.headers['content-type']).toBe('application/octet-stream');
  });

  it('en kropp över tjänstens gräns ger 413 och når aldrig tjänsten', async () => {
    const tjanst = skapaTjanst('filer', undefined, 16);
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({
      port,
      host: vardnamnForApp(appId),
      method: 'POST',
      path: '/_api/filer',
      headers: { [CSRF_HEADER]: '1' },
      body: '0123456789abcdefX',
    });

    expect(svar.status).toBe(413);
    expect(tjanst.anrop).toHaveLength(0);
  });

  it('kakor och inloggningshuvuden lämnas aldrig vidare till tjänsten', async () => {
    const tjanst = skapaTjanst('filer');
    const { appId, port } = await starta([tjanst]);

    await anropa({
      port,
      host: vardnamnForApp(appId),
      path: '/_api/filer',
      headers: { Cookie: 'hemlig=1', Authorization: 'Bearer hemlig' },
    });

    const huvuden = tjanst.anrop[0]!.headers;
    expect(huvuden['cookie']).toBeUndefined();
    expect(huvuden['authorization']).toBeUndefined();
  });

  it('bara tillåtna svarshuvuden släpps igenom, och plattformens skyddsregler vinner', async () => {
    const tjanst = skapaTjanst('filer', () => ({
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="rapport.pdf"',
        'Set-Cookie': 'kapad=1',
        'Content-Security-Policy': "default-src *",
        'Access-Control-Allow-Origin': '*',
      },
      body: new Uint8Array([37, 80, 68, 70]),
    }));
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer/rapport' });

    expect(svar.status).toBe(200);
    expect(enHuvud(svar, 'content-type')).toBe('application/pdf');
    expect(enHuvud(svar, 'content-disposition')).toBe('attachment; filename="rapport.pdf"');
    expect(enHuvud(svar, 'set-cookie')).toBeUndefined();
    expect(enHuvud(svar, 'access-control-allow-origin')).toBeUndefined();
    expect(enHuvud(svar, 'content-security-policy')).not.toContain('default-src *');
    expect(enHuvud(svar, 'x-content-type-options')).toBe('nosniff');
  });

  it.each([
    ['en ogiltig Content-Disposition', { 'Content-Disposition': 'attachment; filename="a"\r\nX-Evil: 1' }],
    ['en Content-Type med radbrytning', { 'Content-Type': 'text/html\r\nX-Evil: 1' }],
  ])('ett svar med %s blir 500 utan detaljer', async (_beskrivning, headers) => {
    const tjanst = skapaTjanst('filer', () => ({ status: 200, headers, body: 'x' }));
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer' });

    expect(svar.status).toBe(500);
    expect(svar.kropp).not.toContain('X-Evil');
  });

  it('en tjänst som kastar ger 500 med fast text — felets meddelande läcker aldrig', async () => {
    const tjanst = skapaTjanst('filer', () => {
      throw new Error('hemlig intern detalj');
    });
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer' });

    expect(svar.status).toBe(500);
    expect(svar.kropp).not.toContain('hemlig intern detalj');
  });

  it.each([
    [507, 'quota_exceeded'],
    [503, 'unavailable'],
    [429, 'rate_limited'],
  ])('tjänstens %i med koden %s når appen oförändrad', async (status, kod) => {
    const tjanst = skapaTjanst('filer', () => ({
      status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: kod, message: 'Klarspråk.' } }),
    }));
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer' });

    expect(svar.status).toBe(status);
    expect(json(svar)).toEqual({ error: { code: kod, message: 'Klarspråk.' } });
  });

  it('ett svar med en status utanför allowlistan blir 500', async () => {
    const tjanst = skapaTjanst('filer', () => ({ status: 302, headers: {}, body: '' }));
    const { appId, port } = await starta([tjanst]);

    const svar = await anropa({ port, host: vardnamnForApp(appId), path: '/_api/filer' });

    expect(svar.status).toBe(500);
  });

  it.each([
    ['ett reserverat namn', [skapaTjanst('collections')]],
    ['ett namn med versaler', [skapaTjanst('Filer')]],
    ['ett namn med punkt', [skapaTjanst('fil.er')]],
    ['två tjänster med samma namn', [skapaTjanst('filer'), skapaTjanst('filer')]],
    ['en gräns över taket', [skapaTjanst('filer', undefined, 26 * 1024 * 1024)]],
    ['en negativ gräns', [skapaTjanst('filer', undefined, -1)]],
  ])('gatewayn vägrar starta med %s', (_beskrivning, tjanster) => {
    expect(() => createGateway(skapaTestUppsattning({ services: tjanster }).options)).toThrow();
  });
});
