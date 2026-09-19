/**
 * Byggagenten ska bara få veta om de plattformstjänster som är påslagna — annars skriver den
 * appar som anropar en tjänst som svarar 404.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceReference } from '../src/kunskap.ts';

describe('Tjänsternas dokumentation i agentens kunskap', () => {
  it('tar med dokumentationen för påslagna tjänster, i plattformens ordning, och hoppar över tomma', async () => {
    const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-kunskap-'));
    try {
      await writeFile(join(katalog, 'files.md'), '## files\nLadda upp filer.\n');
      await writeFile(join(katalog, 'llm.md'), '## llm\nFråga språkmodellen.\n');
      await writeFile(join(katalog, 'ocr.md'), '');
      const text = await serviceReference(['llm', 'ocr', 'files'], katalog);
      expect(text).toContain('Ladda upp filer.');
      expect(text).toContain('Fråga språkmodellen.');
      expect(text.indexOf('## files')).toBeLessThan(text.indexOf('## llm'));
    } finally {
      await rm(katalog, { recursive: true, force: true });
    }
  });

  it('avslagna tjänster nämns inte alls', async () => {
    const katalog = await mkdtemp(join(tmpdir(), 'vibesandbox-kunskap-'));
    try {
      await writeFile(join(katalog, 'files.md'), '## files\nLadda upp filer.\n');
      expect(await serviceReference([], katalog)).toBe('');
    } finally {
      await rm(katalog, { recursive: true, force: true });
    }
  });
});
