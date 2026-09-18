/**
 * Testhjälp för @vibesandbox/control. Ingen produktionskod importerar detta.
 *
 * `unsafeCreateTenantContext` är annars förbehållet gatewayn — här är det uttryckligen tillåtet,
 * eftersom det är enda vägen att bygga ett TenantContext i ett enhetstest.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppId, TenantContext, TenantKind } from '@vibesandbox/contracts';

export function tenant(appId: AppId, kind: TenantKind = 'published'): TenantContext {
  return unsafeCreateTenantContext(appId, kind);
}

export interface TempKatalog {
  readonly katalog: string;
  stada(): Promise<void>;
}

/** En tom, temporär katalog. Kör `stada` i afterEach. */
export async function skapaTempKatalog(prefix = 'vibesandbox-control-'): Promise<TempKatalog> {
  const katalog = await mkdtemp(join(tmpdir(), prefix));
  return { katalog, stada: () => rm(katalog, { recursive: true, force: true }) };
}

/** Skriver ett filträd: nyckeln är en relativ sökväg med `/`, värdet är filens innehåll. */
export async function skrivTrad(rot: string, filer: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [relativ, innehall] of Object.entries(filer)) {
    const mal = join(rot, ...relativ.split('/'));
    await mkdir(dirname(mal), { recursive: true });
    await writeFile(mal, innehall);
  }
}

/** Den minsta bygg-katalog som går att importera. */
export const MINSTA_APP: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>App</title><script type="module" src="./assets/app.js"></script>',
  'assets/app.js': 'console.log("hej");',
};

/** Alla filer (inte kataloger) under en katalog, som sökvägar relativa roten, sorterade. */
export async function allaFiler(rot: string): Promise<string[]> {
  const poster = await readdir(rot, { recursive: true, withFileTypes: true });
  return poster
    .filter((post) => post.isFile())
    .map((post) => join(post.parentPath, post.name).slice(rot.length + 1))
    .sort();
}

export function text(body: Uint8Array): string {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
}
