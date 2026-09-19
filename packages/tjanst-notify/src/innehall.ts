/**
 * Nätfiskeskyddet för aviseringar. Mejlen skickas från plattformens betrodda adress, så en app
 * (ogranskad, genererad kod) får aldrig kunna använda dem för att locka någon till en falsk
 * inloggningssida. Därför:
 *
 * - Ren text. Ämne och text normaliseras (NFKC) och rensas från kontrolltecken och osynliga tecken
 *   (nollbreddstecken, riktningsstyrning, mjukt bindestreck) INNAN de prövas — det som prövas är
 *   exakt det som skickas, och ett osynligt tecken kan inte dela en adress så att den slinker förbi.
 * - Ämnet blir en enda rad: en radbrytning i ämnet kan aldrig bli ett eget mejlhuvud.
 * - Inga webbadresser, inte ens förklädda (`hxxp://`, `evil[.]com`, `www.`, fullbreddstecken,
 *   internationella domännamn, e-postadresser, IP-adresser). Det enda undantaget är appens egen
 *   publicerade adress. Hellre ett avvisat meddelande för mycket än en länk för mycket — och
 *   avvisningen förklaras i klarspråk, så att appen kan skriva om.
 */

export const MAX_SUBJECT_LENGTH = 150;
export const MAX_TEXT_LENGTH = 5000;

export type ContentResult =
  | { readonly ok: true; readonly subject: string; readonly text: string }
  | { readonly ok: false; readonly message: string };

/** Osynliga tecken (Unicode-kategorin Cf) och privata tecken — tas bort helt. */
const INVISIBLE = /[\p{Cf}\p{Co}]/gu;
/** Kontrolltecken som inte är blanktecken — tas bort helt. */
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/** Radslut av alla slag. */
const LINE_BREAKS = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;

function baseClean(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, '');
}

function cleanSubject(raw: string): string {
  return baseClean(raw).replace(LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();
}

function cleanText(raw: string): string {
  return baseClean(raw)
    .replace(LINE_BREAKS, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Webbadresser ─────────────────────────────────────────────────────────────────

/** Alla landsdomäner (ISO 3166 och några till). Tvåbokstavsändelser utanför listan (t.ex. "t.ex") godtas. */
const COUNTRY_TLDS: ReadonlySet<string> = new Set(
  (
    'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ' +
    'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk ' +
    'fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir ' +
    'is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ' +
    'ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl ' +
    'pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc ' +
    'td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
  ).split(' '),
);

/** Punkter som webbläsare tolkar som punkt i ett domännamn, och förklädda punkter. */
const DOT_LOOKALIKES = /[\u3002\uff0e\uff61]/g;
const DEFANGED_DOTS = /[[({]\s*(?:\.|dot|punkt)\s*[\])}]|\s(?:dot|punkt)\s/g;

const SCHEME_SEPARATOR = /:\s*[/\\]\s*[/\\]/;
const OBFUSCATED_HTTP = /(?<![a-z])h[tx*]{2}ps?(?![a-z])/;
const DANGEROUS_SCHEMES = /(?<![a-z])(?:mailto|javascript|vbscript|file|ftp|sftp)\s*:/;
const WWW = /(?<![\p{L}\p{N}])www\d{0,3}\./u;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d])/;
/** `etikett.etikett…ändelse`. Ändelsen prövas för sig i `isTopLevelDomain`. */
const DOMAIN = /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+(\p{L}[\p{L}\p{N}-]*)(?![\p{L}\p{N}_-])/gu;

function isTopLevelDomain(label: string): boolean {
  if (label.startsWith('xn--')) return true;
  // Internationell ändelse (t.ex. ".рф"): alltid en adress.
  if (/[^\u0000-\u007f]/.test(label)) return label.length >= 2;
  if (!/^[a-z]+$/.test(label)) return false;
  if (label.length === 2) return COUNTRY_TLDS.has(label);
  // Tre bokstäver eller fler: nya generiska ändelser registreras hela tiden (.zip, .mov, .bank …),
  // så varje sådan räknas som en adress. Priset är att "fil.pdf" avvisas — det är avsiktligt.
  return label.length >= 3;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tar bort förekomster av appens egen adress (samma schema, värd och port), med valfri sökväg.
 * Direkt efter värden får inget komma som kunde fortsätta värdnamnet (`.evil.com`, `@evil.com`,
 * `:8443`) — annars räknas det inte som appens adress.
 */
function withoutOwnAddress(text: string, ownUrl: string): string {
  let origin: string;
  try {
    origin = new URL(ownUrl).origin.toLowerCase();
  } catch {
    return text;
  }
  const own = new RegExp(`${escapeRegExp(origin)}(?:/[^\\s]*)?(?![\\p{L}\\p{N}_@:-]|\\.[\\p{L}\\p{N}])`, 'gu');
  return text.replace(own, ' ');
}

/** Finns något i texten som en mejlklient kan göra till en länk, utöver appens egen adress? */
export function containsWebAddress(raw: string, ownUrl: string): boolean {
  const text = withoutOwnAddress(baseClean(raw).toLowerCase(), ownUrl)
    .replace(DOT_LOOKALIKES, '.')
    .replace(DEFANGED_DOTS, '.');
  if (SCHEME_SEPARATOR.test(text) || OBFUSCATED_HTTP.test(text) || DANGEROUS_SCHEMES.test(text)) return true;
  if (WWW.test(text) || IPV4.test(text) || text.includes('//')) return true;
  for (const match of text.matchAll(DOMAIN)) {
    if (isTopLevelDomain(match[1] ?? '')) return true;
  }
  return false;
}

const ADDRESS_MESSAGE =
  'Aviseringen får inte innehålla webbadresser, e-postadresser eller något som liknar en (t.ex. "namn.se" ' +
  'eller "fil.pdf") — bara appens egen adress. Skriv till exempel "öppna appen" i stället.';

/** Rensar och prövar ämne och text. Det som godkänns är exakt det som ska skickas. */
export function checkContent(input: { readonly subject: unknown; readonly text: unknown }, ownUrl: string): ContentResult {
  if (typeof input.subject !== 'string' || typeof input.text !== 'string') {
    return { ok: false, message: 'Aviseringen behöver ett ämne och en text.' };
  }
  const subject = cleanSubject(input.subject);
  const text = cleanText(input.text);
  if (subject.length === 0) return { ok: false, message: 'Ämnet är tomt.' };
  if (text.length === 0) return { ok: false, message: 'Texten är tom.' };
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, message: `Ämnet är för långt — högst ${MAX_SUBJECT_LENGTH} tecken.` };
  }
  if (text.length > MAX_TEXT_LENGTH) return { ok: false, message: `Texten är för lång — högst ${MAX_TEXT_LENGTH} tecken.` };
  if (containsWebAddress(subject, ownUrl) || containsWebAddress(text, ownUrl)) return { ok: false, message: ADDRESS_MESSAGE };
  return { ok: true, subject, text };
}
