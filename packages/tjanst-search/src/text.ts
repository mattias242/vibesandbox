/**
 * Vilken text ur ett dokument som bäddas in, och hur modellen vill ha den.
 */
import type { JsonObject, JsonValue } from '@vibesandbox/contracts';

/**
 * Längdgräns för ett dokuments text. multilingual-e5 läser högst 512 tokens (Berget), och svensk
 * text ger ungefär 3–4 tecken per token; det som går över skulle modellen ändå kapa. Gränsen håller
 * också nere vad som skickas iväg och vad en app kan förbruka av kvoten per dokument.
 */
export const MAX_DOCUMENT_TEXT_CHARS = 1500;

/** Djupare än så letar vi inte efter text. data-api tillåter 64 nivåer; det här är en extra spärr. */
const MAX_DEPTH = 64;

/**
 * Alla strängvärden i dokumentet (eller i de namngivna toppfälten, i den ordning de anges),
 * radbrutna, högst `MAX_DOCUMENT_TEXT_CHARS` tecken. Nycklar, tal och sanningsvärden tas inte med:
 * de är sällan det man söker efter och skulle bara späda ut innebörden.
 */
export function documentText(data: JsonObject, fields?: readonly string[]): string {
  const parts: string[] = [];
  let length = 0;

  // Iterativt med egen stack: en fientligt djup struktur ska inte kunna spräcka anropsstacken.
  const visit = (root: JsonValue | undefined): void => {
    const stack: { value: JsonValue | undefined; depth: number }[] = [{ value: root, depth: 0 }];
    while (stack.length > 0 && length < MAX_DOCUMENT_TEXT_CHARS) {
      const { value, depth } = stack.pop()!;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
          length += trimmed.length + 1;
        }
      } else if (typeof value === 'object' && value !== null && depth < MAX_DEPTH) {
        const children = Array.isArray(value) ? (value as readonly JsonValue[]) : Object.values(value);
        // Baklänges på stacken, så att texten kommer i dokumentets ordning.
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ value: children[i], depth: depth + 1 });
      }
    }
  };

  if (fields === undefined) visit(data);
  else for (const field of fields) if (Object.hasOwn(data, field)) visit(data[field]);

  return truncate(parts.join('\n'), MAX_DOCUMENT_TEXT_CHARS);
}

/** Kapar utan att dela ett surrogatpar (en halv emoji är ogiltig UTF-16). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * multilingual-e5 är tränad med prefix och blir märkbart sämre utan dem: `query: ` på frågor och
 * `passage: ` på det som söks i. Instruktionsvarianten vill i stället ha en uppgiftsbeskrivning på
 * frågan och ingenting på dokumenten (modellkorten för intfloat/multilingual-e5-large[-instruct]).
 */
const INSTRUCTION = 'Given a search query, retrieve relevant passages that answer the query';

export function withPrefix(model: string, kind: 'query' | 'passage', text: string): string {
  const name = model.toLowerCase();
  if (!name.includes('e5')) return text;
  if (name.includes('instruct')) return kind === 'query' ? `Instruct: ${INSTRUCTION}\nQuery: ${text}` : text;
  return `${kind}: ${text}`;
}
