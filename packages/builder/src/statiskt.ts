/**
 * Byggverktygets eget webbgränssnitt: statiska filer ur `ui.directory`.
 *
 * Katalogen läses EN gång, vid start, till ett manifest i minnet: sökväg → innehåll och typ. En
 * förfrågan slås sedan upp som en EXAKT nyckel i manifestet — en disksökväg byggs aldrig av något i
 * förfrågan, och sökvägen normaliseras aldrig. `/../x`, `/．．/x` och `/assets//app.js` är helt
 * enkelt nycklar som inte finns.
 *
 * Vid inläsningen avvisas allt som inte är en vanlig fil direkt i katalogträdet: symlänkar (både
 * till filer och kataloger), punktfiler och filer med en ändelse utanför allowlisten. Katalogen
 * själv får inte heller vara en symlänk. Därmed kan inget utanför katalogen hamna i manifestet,
 * oavsett vad som ligger på disken.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PlatformResponse } from '@vibesandbox/contracts';
import type { BuilderLogger } from './logg.ts';

/**
 * Innehållstyp ur en allowlist på filändelse, skiftlägeskänsligt. En okänd ändelse läses aldrig
 * in — vi gissar aldrig och faller aldrig tillbaka på `application/octet-stream`.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['woff2', 'font/woff2'],
]);

/** Ett rimligt webbgränssnitt är långt under detta; taket skyddar minnet om fel katalog anges. */
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 8;

const INDEX_PATH = '/index.html';

/** Tillåtna namn på filer och kataloger. Bara ASCII; inga punktfiler. */
const NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

interface ManifestFile {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface StaticSite {
  handle(method: string, path: string): PlatformResponse;
}

function contentTypeFor(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return CONTENT_TYPES.get(name.slice(dot + 1));
}

function loadManifest(directory: string, log: BuilderLogger): Map<string, ManifestFile> | null {
  const root = resolve(directory);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return null;
  }
  // En symlänkad rotkatalog kunde peka var som helst; kräv en riktig katalog.
  if (!rootStat.isDirectory()) return null;
  const realRoot = realpathSync(root);

  const manifest = new Map<string, ManifestFile>();
  let totalBytes = 0;

  const skip = (reason: string): void => log({ level: 'warn', event: 'ui_file_skipped', reason });

  function walk(absolute: string, urlPrefix: string, depth: number): void {
    if (depth > MAX_DEPTH) {
      skip('too_deep');
      return;
    }
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (!NAME_PATTERN.test(entry.name)) {
        skip('name');
        continue;
      }
      const child = join(absolute, entry.name);
      // lstat, inte stat: en symlänk ska synas som symlänk, inte som det den pekar på.
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        skip('symlink');
        continue;
      }
      const url = `${urlPrefix}/${entry.name}`;
      if (stat.isDirectory()) {
        walk(child, url, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        skip('not_a_file');
        continue;
      }
      const contentType = contentTypeFor(entry.name);
      if (contentType === undefined) {
        skip('extension');
        continue;
      }
      // Dubbel kontroll: den verkliga sökvägen måste ligga under den verkliga rotkatalogen.
      const real = realpathSync(child);
      if (!real.startsWith(realRoot + sep)) {
        skip('outside');
        continue;
      }
      if (manifest.size >= MAX_FILES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
        skip('limit');
        continue;
      }
      const body = new Uint8Array(readFileSync(child));
      totalBytes += body.byteLength;
      manifest.set(url, { body, contentType });
    }
  }

  try {
    walk(root, '', 0);
  } catch {
    // En katalog som inte går att läsa ger samma svar som en saknad katalog.
    return null;
  }
  return manifest.has(INDEX_PATH) ? manifest : null;
}

const UNAVAILABLE_BODY =
  '<!doctype html><html lang="sv"><meta charset="utf-8"><title>Byggverktyget</title>' +
  '<p>Byggverktygets webbgränssnitt är inte installerat på servern ännu. Försök igen senare.</p></html>';

export function createStaticSite(directory: string, log: BuilderLogger): StaticSite {
  const manifest = loadManifest(directory, log);
  if (manifest === null) log({ level: 'error', event: 'ui_unavailable' });

  function respond(method: string, file: ManifestFile, cacheControl: string): PlatformResponse {
    return {
      status: 200,
      headers: { 'Content-Type': file.contentType, 'Cache-Control': cacheControl },
      ...(method === 'HEAD' ? {} : { body: file.body }),
    };
  }

  return {
    handle(method, path) {
      if (method !== 'GET' && method !== 'HEAD') {
        return {
          status: 405,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          body: 'Metoden stöds inte.',
        };
      }
      if (manifest === null) {
        return {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          ...(method === 'HEAD' ? {} : { body: UNAVAILABLE_BODY }),
        };
      }
      const lookup = path === '/' ? INDEX_PATH : path;
      const file = manifest.get(lookup);
      if (file !== undefined) {
        // index.html pekar ut de aktuella filerna och får aldrig cachas; övriga filer får
        // återanvändas efter en kontroll mot servern.
        return respond(method, file, lookup === INDEX_PATH ? 'no-store' : 'no-cache');
      }
      // SPA-fallback bara för sökvägar UTAN filändelse. En saknad `app.js` ska ge 404, inte en
      // HTML-sida som webbläsaren sedan försöker köra som skript.
      const lastSegment = path.slice(path.lastIndexOf('/') + 1);
      const index = manifest.get(INDEX_PATH);
      if (!lastSegment.includes('.') && index !== undefined) return respond(method, index, 'no-store');
      return {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        ...(method === 'HEAD' ? {} : { body: 'Sidan finns inte.' }),
      };
    },
  };
}
