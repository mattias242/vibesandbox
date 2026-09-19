/**
 * Mejl: Mailguns HTTP-API via vanlig `fetch` (som följer driftens egress-proxy), och en utkorg för
 * tester och lokal utveckling.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMailgunSender, createOutboxSender } from '../src/index.ts';

const NYCKEL = 'key-hemlig-mailgun-nyckel-1234567890';

interface Anrop {
  readonly url: string;
  readonly init: RequestInit;
}

function fejkadFetch(svar: () => Response | Promise<Response>): { fetch: typeof fetch; anrop: Anrop[] } {
  const anrop: Anrop[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    anrop.push({ url: String(url), init: init ?? {} });
    return svar();
  }) as typeof fetch;
  return { fetch: f, anrop };
}

const MEJL = { to: 'anna@example.org', subject: 'Din kod', text: 'Koden är 123456.' };

describe('Mailgun', () => {
  it('postar ett formulär till EU-API:t med basic auth och spårning avstängd', async () => {
    const { fetch, anrop } = fejkadFetch(() => new Response('{"id":"x"}', { status: 200 }));
    const sender = createMailgunSender({ apiKey: NYCKEL, domain: 'mg.example.org', from: 'Vibesandbox <noreply@mg.example.org>', region: 'eu', fetch });
    await sender.send(MEJL);

    expect(anrop).toHaveLength(1);
    expect(anrop[0]?.url).toBe('https://api.eu.mailgun.net/v3/mg.example.org/messages');
    const init = anrop[0]?.init;
    expect(init?.method).toBe('POST');
    const huvuden = new Headers(init?.headers);
    expect(huvuden.get('authorization')).toBe(`Basic ${Buffer.from(`api:${NYCKEL}`).toString('base64')}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Ingen egen agent/dispatcher: då följer anropet miljöns proxy.
    expect(init).not.toHaveProperty('dispatcher');
    const kropp = new URLSearchParams(String(init?.body));
    expect(kropp.get('from')).toBe('Vibesandbox <noreply@mg.example.org>');
    expect(kropp.get('to')).toBe(MEJL.to);
    expect(kropp.get('subject')).toBe(MEJL.subject);
    expect(kropp.get('text')).toBe(MEJL.text);
    expect(kropp.get('o:tracking')).toBe('no');
    expect(kropp.get('o:tracking-clicks')).toBe('no');
    expect(kropp.get('o:tracking-opens')).toBe('no');
    expect(kropp.has('html')).toBe(false);
  });

  it('ger ett klarspråksfel utan nyckel, adress eller innehåll när Mailgun svarar fel', async () => {
    const { fetch } = fejkadFetch(() => new Response(`Forbidden ${NYCKEL}`, { status: 401 }));
    const sender = createMailgunSender({ apiKey: NYCKEL, domain: 'mg.example.org', from: 'noreply@mg.example.org', region: 'eu', fetch });
    const fel = await sender.send(MEJL).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(fel).toBeInstanceOf(Error);
    expect(fel?.message).toMatch(/Mejlet kunde inte skickas/);
    expect(fel?.message).toContain('401');
    for (const hemligt of [NYCKEL, MEJL.to, '123456']) expect(`${fel?.message}${fel?.stack}`).not.toContain(hemligt);
  });

  it('ger ett klarspråksfel när nätet fallerar eller tidsgränsen går ut', async () => {
    const { fetch } = fejkadFetch(() => {
      throw new TypeError(`fetch failed ${NYCKEL}`);
    });
    const sender = createMailgunSender({ apiKey: NYCKEL, domain: 'mg.example.org', from: 'noreply@mg.example.org', region: 'eu', fetch, timeoutMs: 50 });
    const fel = await sender.send(MEJL).catch((e: unknown) => e as Error);
    expect(fel?.message).toMatch(/Mejlet kunde inte skickas/);
    expect(`${fel?.message}${fel?.stack}`).not.toContain(NYCKEL);
    expect(fel).not.toHaveProperty('cause');
  });

  it('vägrar konstiga inställningar vid start', () => {
    const bas = { apiKey: NYCKEL, domain: 'mg.example.org', from: 'noreply@mg.example.org', region: 'eu' as const };
    expect(() => createMailgunSender({ ...bas, apiKey: '' })).toThrow();
    expect(() => createMailgunSender({ ...bas, domain: 'mg.example.org/../x' })).toThrow();
    expect(() => createMailgunSender({ ...bas, domain: 'evil.example.org#' })).toThrow();
    expect(() => createMailgunSender({ ...bas, from: 'a@b\r\nBcc: x@example.org' })).toThrow();
    expect(() => createMailgunSender({ ...bas, region: 'us' as 'eu' })).toThrow();
  });

  it('vägrar mottagare och ämnen med radbrytningar', async () => {
    const { fetch, anrop } = fejkadFetch(() => new Response('{}', { status: 200 }));
    const sender = createMailgunSender({ apiKey: NYCKEL, domain: 'mg.example.org', from: 'noreply@mg.example.org', region: 'eu', fetch });
    await expect(sender.send({ ...MEJL, to: 'a@example.org, b@example.org' })).rejects.toThrow();
    await expect(sender.send({ ...MEJL, subject: 'x\r\nBcc: y' })).rejects.toThrow();
    expect(anrop).toHaveLength(0);
  });
});

describe('utkorgen', () => {
  let katalog: string | undefined;
  afterEach(async () => {
    if (katalog !== undefined) await rm(katalog, { recursive: true, force: true });
    katalog = undefined;
  });

  it('sparar mejlen i minnet', async () => {
    const utkorg = createOutboxSender();
    await utkorg.send(MEJL);
    expect(utkorg.messages).toEqual([MEJL]);
  });

  it('skriver dessutom varje mejl som en fil, läsbar bara för ägaren', async () => {
    katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-utkorg-'));
    const utkorg = createOutboxSender({ directory: join(katalog, 'utkorg') });
    await utkorg.send(MEJL);
    await utkorg.send({ ...MEJL, text: 'Andra' });
    const filer = (await readdir(join(katalog, 'utkorg'))).sort();
    expect(filer).toHaveLength(2);
    for (const fil of filer) expect(fil).toMatch(/^[A-Za-z0-9_.-]+\.txt$/);
    const innehall = await readFile(join(katalog, 'utkorg', filer[0] ?? ''), 'utf8');
    expect(innehall).toContain('Till: anna@example.org');
    expect(innehall).toContain('Koden är 123456.');
    if (process.platform !== 'win32') expect((await stat(join(katalog, 'utkorg', filer[0] ?? ''))).mode & 0o077).toBe(0);
  });
});
