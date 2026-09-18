/**
 * Leverantör som maskar personuppgifter i användarens meddelanden innan de når den inre
 * leverantören. FAIL-CLOSED: går maskningen inte att genomföra skickas ingenting.
 *
 * Maskas: varje meddelande med roll `user`.
 * Maskas inte: systemprompten (plattformens egen text) och källkod i fil-block, dvs. rader
 * mellan en ENSAM `<vs-file path="…">`-rad och en ENSAM `</vs-file>`-rad. Koden är skriven av
 * modellen själv utifrån redan maskad text; att maska den skulle förstöra den (t.ex. en
 * exempeladress i ett `placeholder`). Ett block som aldrig stängs räknas INTE som kod — annars
 * vore en ensam öppningsrad en väg runt maskningen. Den som bygger meddelandet (agenten)
 * ansvarar för att användarens egen text inte kan innehålla sådana rader.
 */

import type { ChatMessage, LlmProvider } from '@vibesandbox/contracts';
import { LlmError } from './fel.ts';
import { maskPersonalData } from './maskning.ts';
import type { MaskResult } from './maskning.ts';

export const FILE_BLOCK_OPEN = /^<vs-file path="[^"\n]*">$/;
export const FILE_BLOCK_CLOSE = /^<\/vs-file>$/;

export interface MaskingOptions {
  /** För tester: maskningsfunktionen. */
  readonly mask?: (text: string) => MaskResult;
}

/** Maskar texten men lämnar fullständiga fil-block orörda. */
function maskOutsideFileBlocks(text: string, mask: (text: string) => MaskResult): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length > 0) out.push(mask(prose.join('\n')).text);
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FILE_BLOCK_OPEN.test(line.trim())) {
      let end = i + 1;
      while (end < lines.length && !FILE_BLOCK_CLOSE.test(lines[end]!.trim())) end++;
      if (end < lines.length) {
        flushProse();
        out.push(...lines.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    prose.push(line);
    i++;
  }
  flushProse();
  return out.join('\n');
}

export function createMaskingProvider(inner: LlmProvider, options: MaskingOptions = {}): LlmProvider {
  const mask = options.mask ?? maskPersonalData;
  return {
    name: inner.name,
    async complete(request) {
      let messages: ChatMessage[];
      try {
        messages = request.messages.map((m) => (m.role === 'user' ? { role: m.role, content: maskOutsideFileBlocks(m.content, mask) } : m));
      } catch {
        // Felet släpps: det kan innehålla just den text som skulle maskas.
        throw new LlmError('masking_failed');
      }
      return inner.complete({ ...request, messages });
    },
  };
}
