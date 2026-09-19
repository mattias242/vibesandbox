/**
 * Svarsprotokollet mellan agenten och språkmodellen. Beskrivs för människor i `PROTOKOLL.md`.
 *
 *   Kort sammanfattning på svenska till användaren (all text utanför blocken).
 *   <vs-file path="src/App.tsx">
 *   …HELA filens innehåll…
 *   </vs-file>
 *   <vs-done/>
 *
 * Varför egna taggar och inte JSON eller verktygsanrop: öppna modeller gör fel i JSON-escapning
 * av stora kodmängder och i verktygsanrop, men skriver pålitligt text rad för rad. Taggarna
 * gäller bara när de står ENSAMMA på en rad, så kod som nämner dem i en sträng stör inte.
 * Slutmarkören är obligatorisk: en känd bugg hos vLLM ger ett avkapat eller tomt svar med
 * `finish_reason=stop`, och utan markören gick det inte att skilja det från ett färdigt svar.
 */

import { isAllowedSourcePath, TEMPLATE_OWNED_SOURCE_PATHS } from '@vibesandbox/contracts';
import type { SourceFiles } from '@vibesandbox/contracts';

export const PROTOCOL_LIMITS = {
  maxFiles: 30,
  maxFileBytes: 100 * 1024,
  maxTotalBytes: 400 * 1024,
} as const;

export type ParseOutcome =
  | { readonly ok: true; readonly summary: string; readonly files: SourceFiles }
  | { readonly ok: false; readonly problems: readonly string[] };

const OPEN_TAG = /^<vs-file path="([^"]*)">$/;
const CLOSE_TAG = '</vs-file>';
const DONE_TAG = '<vs-done/>';
/** Ett kodstaket, med eller utan språk: ``` eller ```tsx. */
const FENCE = /^```[\w+-]*$/;

const ELLIPSIS = String.raw`(?:\.{2,}|…)`;
const ONLY_ELLIPSIS = new RegExp(String.raw`^(?:${ELLIPSIS}\s*)+$`);
const STARTS_WITH_ELLIPSIS = new RegExp(String.raw`^${ELLIPSIS}`);
const PLACEHOLDER_WORDS = /\b(?:existing code|befintlig kod)\b/i;
const PLACEHOLDER_START = new RegExp(
  String.raw`^(?:${ELLIPSIS}\s*)?(?:rest of|resten av|same as before|samma som (?:förut|tidigare|innan)|oförändrad|unchanged)`,
  'i',
);

/** Texten i en rad som BARA är en kommentar, annars null. */
function commentBody(trimmed: string): string | null {
  const block = /^\{?\/\*(.*?)\*\/\}?$/.exec(trimmed);
  if (block !== null) return block[1] ?? '';
  const html = /^<!--(.*?)-->$/.exec(trimmed);
  if (html !== null) return html[1] ?? '';
  if (trimmed.startsWith('//')) return trimmed.slice(2);
  if (trimmed.startsWith('/*')) return trimmed.slice(2);
  return null;
}

/**
 * Är raden en platshållare för kod som modellen hoppat över? Sådana svar får aldrig byggas:
 * filen skulle ersätta en hel fil med en halv. Vanlig kod med spridning (`...lista`) och text
 * med ellips (`Hämtar …`) påverkas inte — bara rader som är enbart en ellips eller en
 * kommentar som ser ut som en utelämning.
 */
export function isOmissionLine(line: string): boolean {
  const trimmed = line.trim();
  if (ONLY_ELLIPSIS.test(trimmed)) return true;
  const comment = commentBody(trimmed);
  if (comment === null) return false;
  const body = comment.trim();
  if (body === '') return false;
  return ONLY_ELLIPSIS.test(body) || STARTS_WITH_ELLIPSIS.test(body) || PLACEHOLDER_WORDS.test(body) || PLACEHOLDER_START.test(body);
}

function stripFence(lines: string[]): string[] {
  if (lines.length >= 2 && FENCE.test(lines[0]!.trim()) && lines[lines.length - 1]!.trim() === '```') {
    return lines.slice(1, -1);
  }
  return lines;
}

function pathProblem(path: string): string | null {
  if (TEMPLATE_OWNED_SOURCE_PATHS.includes(path)) {
    return `Filen ${path} ägs av mallen och får inte skrivas. Lägg koden i src/App.tsx eller i egna filer under src/.`;
  }
  if (!isAllowedSourcePath(path)) {
    return `Sökvägen ${path} är inte tillåten. Använd src/…, bara a–z, A–Z, 0–9, _ och - i namnen, och ändelsen .tsx, .ts eller .css.`;
  }
  return null;
}

export function parseResponse(raw: string): ParseOutcome {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const problems: string[] = [];
  const summary: string[] = [];
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  let current: { path: string; lines: string[] } | null = null;
  let done = false;
  let textAfterDone = false;

  function finish(block: { path: string; lines: string[] }): void {
    fileCount++;
    const content = stripFence(block.lines).join('\n');
    const problem = pathProblem(block.path);
    if (problem !== null) problems.push(problem);
    if (seen.has(block.path)) problems.push(`Filen ${block.path} finns två gånger i svaret. Skriv varje fil en gång.`);
    seen.add(block.path);
    const bytes = Buffer.byteLength(content, 'utf8');
    totalBytes += bytes;
    if (bytes > PROTOCOL_LIMITS.maxFileBytes) {
      problems.push(`Filen ${block.path} är för stor (${Math.ceil(bytes / 1024)} kB, högst ${PROTOCOL_LIMITS.maxFileBytes / 1024} kB). Dela upp den i mindre filer.`);
    }
    if (content.split('\n').some(isOmissionLine)) {
      problems.push(
        `Filen ${block.path} innehåller en utelämning (t.ex. "// ..." eller "// resten av koden"). Skriv alltid HELA filen, utan att hoppa över något.`,
      );
    }
    if (problem === null) files[block.path] = content;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const open = OPEN_TAG.exec(trimmed);

    if (done) {
      if (trimmed !== '' && !FENCE.test(trimmed) && !textAfterDone) {
        textAfterDone = true;
        problems.push(`Det kom text efter ${DONE_TAG}. ${DONE_TAG} ska stå sist, efter alla filer.`);
      }
      continue;
    }

    if (current !== null) {
      if (trimmed === CLOSE_TAG) {
        finish(current);
        current = null;
      } else if (open !== null || trimmed === DONE_TAG) {
        problems.push(`Blocket för ${current.path} stängs aldrig. Avsluta varje fil med en egen rad ${CLOSE_TAG}.`);
        current = null;
        if (open !== null) current = { path: open[1] ?? '', lines: [] };
        else done = true;
      } else {
        current.lines.push(line);
      }
      continue;
    }

    if (open !== null) current = { path: open[1] ?? '', lines: [] };
    else if (trimmed === DONE_TAG) done = true;
    else if (trimmed === CLOSE_TAG) problems.push(`En rad ${CLOSE_TAG} står utanför ett block.`);
    else if (!FENCE.test(trimmed)) summary.push(line);
  }

  if (current !== null) problems.push(`Blocket för ${current.path} stängs aldrig. Avsluta varje fil med en egen rad ${CLOSE_TAG}.`);
  if (!done) problems.push(`Svaret saknar slutmarkören ${DONE_TAG} på en egen rad sist.`);
  if (fileCount === 0 && problems.length === 0) problems.push('Svaret innehöll inga filer. Skriv de filer som behöver ändras, hela.');
  if (fileCount > PROTOCOL_LIMITS.maxFiles) problems.push(`Svaret har ${fileCount} filer; högst ${PROTOCOL_LIMITS.maxFiles} är tillåtet.`);
  if (totalBytes > PROTOCOL_LIMITS.maxTotalBytes) {
    problems.push(`Svaret har för mycket kod totalt (${Math.ceil(totalBytes / 1024)} kB, högst ${PROTOCOL_LIMITS.maxTotalBytes / 1024} kB). Håll appen mindre.`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, summary: summary.join('\n').replace(/\n{3,}/g, '\n\n').trim(), files };
}

/** Filerna i protokollets format, sorterade efter sökväg — så som modellen ska svara. */
export function formatFiles(files: SourceFiles): string {
  return Object.keys(files)
    .sort()
    .map((path) => `<vs-file path="${path}">\n${files[path]}\n${CLOSE_TAG}`)
    .join('\n');
}
