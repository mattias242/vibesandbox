/**
 * Genomsökning av en bygg-katalog inför import. Princip: hellre avvisa än gissa eller rätta.
 *
 * Bygget kommer ur en sandlåda som kört genererad kod, och ska behandlas som fientligt: en
 * symlänk eller hård länk kan peka på vilken fil som helst på servern, och det som importeras
 * blir läsbart för alla som får öppna appen. Därför:
 *
 *   - symlänkar avvisas alltid, även "ofarliga" som pekar inom bygget — inga undantag att resonera om
 *   - hårda länkar avvisas (antal länkar > 1): målet syns inte, så det går inte att avgöra var det ligger
 *   - bara vanliga filer och kataloger; inga enhetsfiler, rör eller socketar
 *   - punktfiler avvisas (`.env`, `.git`) — gatewayn serverar dem ändå aldrig
 *   - filändelsen måste finnas i allowlisten (innehallstyper.ts)
 *   - storlek, antal och djup är begränsade
 *
 * Varje fil öppnas med `O_NOFOLLOW` och kontrolleras via det ÖPPNA handtaget (`fstat`), och
 * innehållet läses ur samma handtag. Då kan filen inte bytas mot en symlänk mellan kontroll och
 * läsning.
 *
 * Hela bygget avvisas vid första felet. En import som tyst hoppar över filer ger en app som
 * nästan fungerar, och ett fel som ingen ser.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { API_PREFIX, AUTH_PREFIX } from '@vibesandbox/contracts';
import { ControlError } from './fel.ts';
import { contentTypeForFileName } from './innehallstyper.ts';

export interface ImportLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  /** Antal katalognivåer under roten. Gatewayn godtar högst 32 segment i en sökväg. */
  readonly maxDepth: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  maxDepth: 16,
};

/** Samma tak som gatewayn har för ett segment i en sökväg; längre namn kan ändå aldrig nås. */
const MAX_NAME_LENGTH = 255;

/** Utan den här filen har appen ingen startsida, och gatewayn skulle svara 404 på `/`. */
const REQUIRED_PATH = '/index.html';

/**
 * Toppnivånamn som plattformen själv äger på varje apps värd: data-API:t och inloggningsrutterna.
 * Härleds ur kontraktets prefix så att de inte kan glida isär. Gatewayn serverar aldrig appfiler
 * därifrån, men ett bygge som innehåller dem avvisas ändå — hellre ett tydligt fel vid import än
 * en fil som tyst aldrig går att nå, eller en falsk inloggningssida som väntar på ett misstag.
 */
const RESERVED_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([API_PREFIX, AUTH_PREFIX].map((prefix) => prefix.slice(1)));

export interface ScannedFile {
  /** Manifestnyckeln: `/` + namnen exakt som de står på disk, åtskilda av `/`. Aldrig normaliserad. */
  readonly path: string;
  /** SHA-256 av innehållet i hex. Avgör var filen lagras — sökvägen gör det aldrig. */
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
  readonly content: Buffer;
}

function rejected(message: string): ControlError {
  return new ControlError('import_rejected', message);
}

/** Visar ett namn ur bygget i ett felmeddelande utan att styrtecken följer med ut i en terminal. */
function shown(path: string): string {
  let result = '';
  for (const character of path.slice(0, 200)) {
    const code = character.charCodeAt(0);
    result += code < 0x20 || code === 0x7f ? '?' : character;
  }
  return result;
}

function assertName(name: string, shownPath: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw rejected(`Filnamnet är för långt: ${shownPath}`);
  if (name.startsWith('.')) throw rejected(`Punktfiler och punktkataloger får inte ingå i en app: ${shownPath}`);
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    // Styrtecken (inklusive NUL), DEL, snedstreck och bakåtstreck. Teckenkoder i stället för
    // escape-sekvenser, så att källfilen aldrig kan råka innehålla en rå NUL-byte.
    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) {
      throw rejected(`Filnamnet innehåller otillåtna tecken: ${shownPath}`);
    }
  }
}

async function readRegularFile(absolutePath: string, shownPath: string, limits: ImportLimits): Promise<Buffer> {
  let handle;
  try {
    // O_NOFOLLOW: om namnet har hunnit bli en symlänk sedan katalogen lästes misslyckas öppningen.
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw rejected(`Filen gick inte att läsa: ${shownPath}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw rejected(`Bara vanliga filer får ingå i en app: ${shownPath}`);
    if (stat.nlink > 1) throw rejected(`Hårda länkar får inte ingå i en app: ${shownPath}`);
    if (stat.size > limits.maxFileBytes) throw rejected(`Filen är för stor: ${shownPath}`);
    const content = await handle.readFile();
    // Filen kan ha vuxit mellan fstat och läsning; det är det lästa som räknas.
    if (content.length > limits.maxFileBytes) throw rejected(`Filen är för stor: ${shownPath}`);
    return content;
  } finally {
    await handle.close();
  }
}

/**
 * Läser och kontrollerar hela bygget. Inget skrivs någonstans härifrån; anroparen lagrar
 * resultatet först när ALLT har godkänts.
 */
export async function scanBuildDirectory(directory: string, limits: ImportLimits): Promise<ScannedFile[]> {
  if (typeof directory !== 'string' || directory.length === 0) throw rejected('Ingen bygg-katalog angavs.');

  let root: string;
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw rejected('Bygg-katalogen får inte vara en symlänk.');
    if (!stat.isDirectory()) throw rejected('Det som angavs som bygg-katalog är inte en katalog.');
    root = await realpath(directory);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw rejected('Bygg-katalogen finns inte eller går inte att läsa.');
  }
  const rootPrefix = root.endsWith(sep) ? root : root + sep;

  const files: ScannedFile[] = [];
  let totalBytes = 0;

  async function walk(absoluteDirectory: string, segments: readonly string[]): Promise<void> {
    if (segments.length > limits.maxDepth) throw rejected(`Katalogerna är för djupt nästlade: ${shown(segments.join('/'))}`);

    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    // Sorterad ordning ger samma manifest och samma felmeddelande varje gång, oavsett filsystem.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const entrySegments = [...segments, entry.name];
      const shownPath = shown(entrySegments.join('/'));
      const absolutePath = join(absoluteDirectory, entry.name);

      if (entry.isSymbolicLink()) throw rejected(`Symlänkar får inte ingå i en app: ${shownPath}`);
      assertName(entry.name, shownPath);
      if (segments.length === 0 && RESERVED_TOP_LEVEL_NAMES.has(entry.name)) {
        throw rejected(`Namnet är reserverat för plattformen och får inte ingå i en app: ${shownPath}`);
      }

      // Hängslen och livrem: utan symlänkar kan vi inte hamna utanför roten, men kontrollen är
      // billig och gäller även den dag någon ändrar genomsökningen.
      if (!absolutePath.startsWith(rootPrefix)) throw rejected(`Filen ligger utanför bygg-katalogen: ${shownPath}`);

      if (entry.isDirectory()) {
        await walk(absolutePath, entrySegments);
        continue;
      }
      if (!entry.isFile()) throw rejected(`Bara vanliga filer får ingå i en app: ${shownPath}`);

      const contentType = contentTypeForFileName(entry.name);
      if (contentType === undefined) {
        throw rejected(`Filtypen är inte tillåten i en app: ${shownPath}`);
      }

      if (files.length + 1 > limits.maxFiles) throw rejected('Bygget innehåller för många filer.');
      const content = await readRegularFile(absolutePath, shownPath, limits);
      totalBytes += content.length;
      if (totalBytes > limits.maxTotalBytes) throw rejected('Bygget är för stort.');

      files.push({
        path: `/${entrySegments.join('/')}`,
        hash: createHash('sha256').update(content).digest('hex'),
        size: content.length,
        contentType,
        content,
      });
    }
  }

  await walk(root, []);

  if (!files.some((file) => file.path === REQUIRED_PATH)) {
    throw rejected('Bygget saknar startsidan index.html.');
  }
  return files;
}
