/**
 * Innehållsadresserat lager för apparnas byggda filer: `<dataDir>/versions/<hash[0:2]>/<hash>`.
 *
 * Filens plats på disk bestäms ENBART av SHA-256 av dess innehåll. Inget namn ur bygget och
 * ingenting ur en förfrågan blir någonsin en del av en sökväg — det är det som gör att en
 * katalogtraversering inte har något att traversera. Samma innehåll i flera versioner eller appar
 * lagras en gång.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlError } from './fel.ts';

const BLOB_DIRECTORY = 'versions';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface BlobStore {
  /** Idempotent: finns innehållet redan skrivs det över med identiskt innehåll. */
  write(hash: string, content: Uint8Array): Promise<void>;
  /** `null` om filen saknas på disk (manifestet pekar på något som försvunnit). */
  read(hash: string): Promise<Buffer | null>;
  remove(hash: string): Promise<void>;
}

export function createBlobStore(dataDir: string): BlobStore {
  const root = join(dataDir, BLOB_DIRECTORY);
  mkdirSync(root, { recursive: true });

  function pathFor(hash: string): { directory: string; file: string } {
    // Hashen kommer ur vår egen databas eller vår egen beräkning. Kontrollen finns ändå: en
    // trasig eller manipulerad databasrad får inte kunna bli en sökväg utanför lagret.
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      throw new ControlError('internal', 'Filregistret innehåller en ogiltig innehållshash.');
    }
    const directory = join(root, hash.slice(0, 2));
    return { directory, file: join(directory, hash) };
  }

  return {
    async write(hash, content) {
      const { directory, file } = pathFor(hash);
      await mkdir(directory, { recursive: true });
      // Skriv till ett tillfälligt namn och byt namn: en läsare ser antingen hela filen eller
      // ingen fil, aldrig en halvskriven. Punkt först i namnet, så att det aldrig kan förväxlas
      // med en hash.
      const temporary = join(directory, `.tmp-${randomBytes(8).toString('hex')}`);
      try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o640 });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async read(hash) {
      try {
        return await readFile(pathFor(hash).file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async remove(hash) {
      await rm(pathFor(hash).file, { force: true });
    },
  };
}
