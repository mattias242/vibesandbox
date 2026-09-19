/**
 * Filnamn från användaren. De används ALDRIG för att bygga en sökväg — innehållet på disk namnges
 * av plattformen — men visas för andra användare och skickas i `Content-Disposition`. Därför:
 * inga sökvägsled, inga kontrolltecken, inga citattecken, inga osynliga eller riktningsvändande
 * tecken (som kan få "faktura‮fdp.exe" att se ut som en PDF), och en längdgräns.
 */
import type { FileType } from './filtyper.ts';

/** I tecken (kodpunkter), inklusive ändelsen. */
export const MAX_FILE_NAME_LENGTH = 120;

const FALLBACK_STEM = 'fil';

/** Kontrolltecken (C0, DEL, C1), osynliga tecken och riktningstecken. */
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
/** Citattecken och tecken som inte hör hemma i ett filnamn på något vanligt system. */
const FORBIDDEN = /["'`<>:*?|]/g;

function truncate(text: string, maxCodePoints: number): string {
  const chars = Array.from(text);
  return chars.length <= maxCodePoints ? text : chars.slice(0, maxCodePoints).join('');
}

export function sanitizeFileName(raw: string, type: FileType): string {
  // Sista ledet i en sökväg, oavsett snedstreckets riktning.
  const last = raw.normalize('NFC').replace(/\\/g, '/').split('/').pop() ?? '';
  let name = last
    .replace(INVISIBLE_OR_CONTROL, '')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Inga dolda filer och inga namn som bara är punkter; inga punkter eller mellanslag sist.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  let suffix: string;
  if (extension !== '' && type.extensions.includes(extension)) {
    // Behåll användarens skrivsätt (".PNG") men kapa aldrig ändelsen.
    suffix = name.slice(dot);
    name = name.slice(0, dot);
  } else {
    // Ändelsen följer innehållet: "sida.html" som är text blir "sida.html.txt".
    suffix = `.${type.extensions[0] ?? 'bin'}`;
  }
  const stem = truncate(name, MAX_FILE_NAME_LENGTH - Array.from(suffix).length).trim();
  return `${stem === '' ? FALLBACK_STEM : stem}${suffix}`;
}

/**
 * Samma namn med bara skrivbara ASCII-tecken, för `Content-Disposition`. Svarshuvuden bär inte
 * godtycklig Unicode, och gatewayns mönster tillåter inte `filename*`. å/ä/ö blir a/a/o, annat `_`.
 */
export function asciiFileName(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return ascii.trim() === '' ? FALLBACK_STEM : ascii;
}
