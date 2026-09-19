/**
 * Den byggda katalogen: mäta den, och kopiera den till en plats som bara plattformen äger.
 * Katalogen kommer från en opålitlig process (eller container), så symboliska länkar följs
 * ALDRIG — en länk till `/etc/passwd` får inte bli en fil i appen — och bara vanliga filer
 * och kataloger godtas.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface TreeSize {
  readonly bytes: number;
  readonly files: number;
  /** Relativa sökvägar till sådant som inte är vanliga filer eller kataloger. */
  readonly rejected: readonly string[];
}

const MAX_DEPTH = 8;
const MAX_FILES = 2000;

export async function measureTree(root: string): Promise<TreeSize> {
  let bytes = 0;
  let files = 0;
  const rejected: string[] = [];
  async function walk(relative: string, depth: number): Promise<void> {
    for (const entry of await readdir(path.join(root, relative))) {
      const name = relative === '' ? entry : `${relative}/${entry}`;
      const info = await lstat(path.join(root, name));
      if (info.isDirectory() && depth < MAX_DEPTH) await walk(name, depth + 1);
      else if (info.isFile()) {
        bytes += info.size;
        files += 1;
      } else rejected.push(name);
      if (files > MAX_FILES) {
        rejected.push('(för många filer)');
        return;
      }
    }
  }
  await walk('', 0);
  return { bytes, files, rejected };
}

/**
 * Kopierar `source` till `destination` (som inte får finnas). Läser varje fil med O_NOFOLLOW och
 * kontrollerar storleken under kopieringen, så att en fil som byts ut eller växer medan vi läser
 * inte kan smita förbi taket.
 */
export async function copyTreeSafely(source: string, destination: string, maxBytes: number): Promise<void> {
  let total = 0;
  async function copy(relative: string, depth: number): Promise<void> {
    await mkdir(path.join(destination, relative));
    for (const entry of await readdir(path.join(source, relative))) {
      const name = relative === '' ? entry : path.join(relative, entry);
      const info = await lstat(path.join(source, name));
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) throw new Error('Den byggda katalogen är för djup.');
        await copy(name, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error(`Den byggda katalogen innehåller något som inte är en vanlig fil: ${name}`);
      const input = await open(path.join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const output = await open(path.join(destination, name), 'wx', 0o644);
        try {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > maxBytes) throw new Error('Den byggda katalogen är större än taket.');
            await output.write(buffer, 0, bytesRead);
          }
        } finally {
          await output.close();
        }
      } finally {
        await input.close();
      }
    }
  }
  await copy('', 0);
}
