/**
 * Vilken sorts fil är det här — avgjort av filens EGNA byte, aldrig av filnamnet eller av den
 * typ som står på filen. En app kan ladda upp vad som helst under vilket namn som helst, och
 * en fil som påstår sig vara ett Word-dokument men är något annat ska aldrig behandlas som ett.
 *
 * Office-filer är zip-arkiv, och vad slags dokument det är syns på vilka filer som ligger i
 * arkivet: `word/document.xml`, `xl/workbook.xml` eller `ppt/presentation.xml`.
 */

export type ExtractKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

/** Zip-signaturen. Den tomma varianten (`PK\u0005\u0006`) är ett tomt arkiv och duger inte. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

/** Vilket Office-dokument arkivets innehållsförteckning visar, eller `null`. */
export function officeKind(names: readonly string[]): ExtractKind | null {
  const has = new Set(names);
  const kinds: ExtractKind[] = [];
  if (has.has('word/document.xml')) kinds.push('docx');
  if (has.has('xl/workbook.xml')) kinds.push('xlsx');
  if (has.has('ppt/presentation.xml')) kinds.push('pptx');
  // Ett arkiv som utger sig för att vara två saker samtidigt är ingendera.
  return kinds.length === 1 ? (kinds[0] as ExtractKind) : null;
}
