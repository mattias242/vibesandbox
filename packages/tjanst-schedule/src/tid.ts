/**
 * Tider för påminnelser. En tid tas emot som en ISO-tid MED tidszon (ett entydigt ögonblick) och
 * upprepas i Europe/Stockholm: "varje fredag kl 9" är kl 9 i Sverige både vinter och sommar.
 * Bara `Intl` används — inga beroenden, och Nodes tidszonsdatabas följer med Node.
 */

export type Repeat = 'daily' | 'weekly' | 'monthly';

export const REPEATS: readonly Repeat[] = ['daily', 'weekly', 'monthly'];

export const TIME_ZONE = 'Europe/Stockholm';

/**
 * Strikt ISO 8601: datum, tid och Z eller ±hh:mm. Ingen tid utan zon — den vore tvetydig — och
 * inga namngivna zoner eller femsiffriga år, som `Date.parse` annars släpper igenom.
 */
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Ögonblicket i millisekunder, eller `null` för allt som inte är en giltig ISO-tid med tidszon. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = ISO_PATTERN.exec(value);
  if (m === null) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = Number(m[6] ?? '0');
  const millis = Number((m[7] ?? '0').padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] !== 'Z') {
    const offHours = Number(m[10]);
    const offMinutes = Number(m[11]);
    if (offHours > 14 || offMinutes > 59) return null;
    offset = (m[9] === '-' ? -1 : 1) * (offHours * HOUR + offMinutes * MINUTE);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset;
}

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Väggtiden i Stockholm vid ögonblicket `instant`. */
export function stockholmWallTime(instant: number): WallTime {
  const parts: Record<string, number> = {};
  for (const part of FORMAT.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
    millisecond: ((instant % 1000) + 1000) % 1000,
  };
}

/** Stockholms förskjutning mot UTC vid ögonblicket `instant` (ms). */
function offsetAt(instant: number): number {
  const w = stockholmWallTime(instant);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond) - instant;
}

/**
 * Ögonblicket för en väggtid i Stockholm. Som `Temporal`s "compatible": en tid som inte finns (när
 * klockan ställs fram) flyttas fram lika mycket som glappet, och en tid som finns två gånger (när
 * klockan ställs tillbaka) blir den första — en påminnelse ska hellre komma än utebli, och aldrig
 * två gånger.
 */
function wallTimeToInstant(w: WallTime): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
  const before = offsetAt(naive - DAY);
  const after = offsetAt(naive + DAY);
  const candidates = [naive - before, naive - after].filter((t) => offsetAt(t) === naive - t);
  if (candidates.length > 0) return Math.min(...candidates);
  return naive - before;
}

/** Väggtiden `steps` dagar/veckor/månader efter `anchor`. Den 31:a blir sista dagen i kortare månader. */
function shift(anchor: WallTime, repeat: Repeat, steps: number): WallTime {
  if (repeat === 'monthly') {
    const index = anchor.year * 12 + (anchor.month - 1) + steps;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return { ...anchor, year, month, day: Math.min(anchor.day, daysInMonth(year, month)) };
  }
  const days = repeat === 'daily' ? steps : steps * 7;
  const date = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + days));
  return { ...anchor, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Längsta möjliga steg, så att uppskattningen nedan aldrig hoppar över ett tillfälle. */
const LONGEST_STEP: Readonly<Record<Repeat, number>> = { daily: DAY + HOUR, weekly: 7 * DAY + HOUR, monthly: 31 * DAY + HOUR };

/**
 * Första tillfället STRIKT efter `after` för en påminnelse som först gick vid `first`. Alla
 * tillfällen räknas från det första (inte från det förra), så att den 31:a förblir den 31:a och
 * 09:00 förblir 09:00 även efter en sommartidsövergång.
 */
export function nextOccurrence(first: number, repeat: Repeat, after: number): number {
  const anchor = stockholmWallTime(first);
  let steps = Math.max(1, Math.floor((after - first) / LONGEST_STEP[repeat]));
  for (;;) {
    const candidate = wallTimeToInstant(shift(anchor, repeat, steps));
    if (candidate > after) return candidate;
    steps += 1;
  }
}
