/**
 * Lagringskvoten uttryckt i SQLite-sidor.
 *
 * Kvoten verkställs av SQLite självt genom `PRAGMA max_page_count`: databasfilen KAN inte växa
 * förbi gränsen, oavsett vad vår egen kod gör eller missar. En skrivning som inte får plats
 * misslyckas med SQLITE_FULL, rullas tillbaka och översätts till `quota_exceeded`.
 *
 * Problemet med en hård gräns är att även en RADERING i sällsynta fall behöver en ny sida (när
 * B-trädet balanseras om kan en nod delas). En full databas som inte går att radera ur vore en
 * återvändsgränd för användaren. Lösningen är en reserv INOM kvoten:
 *
 *   vanliga skrivningar får använda   totalt − reserv   sidor
 *   raderingar får använda            totalt            sidor
 *
 * Filen blir alltså aldrig större än `maxDatabaseBytes`, och en radering har alltid några sidor
 * tillgodo. Sidorna en radering frigör hamnar på SQLite:s frilista och återanvänds av nästa
 * skrivning; filen krymper inte, men den växer inte heller.
 *
 * WAL-filen ligger utanför `max_page_count`. Den hålls kort med `wal_autocheckpoint` och
 * `journal_size_limit` (se `handtag.ts`), så hyresgästens totala diskavtryck är begränsat till
 * ungefär: maxDatabaseBytes + max(WAL-gränsen, en transaktion ≈ maxDocumentBytes) + 32 KiB (-shm).
 */
import type { TenantLimits } from '@vibesandbox/contracts';

const STANDARD_PAGE_SIZE = 4096;
const SMALL_PAGE_SIZE = 1024;

/**
 * Under den här kvoten används små sidor. Med 4 KiB-sidor tar bara schemat (fem sidor) drygt
 * 20 KiB; en liten kvot skulle då vara förbrukad innan första dokumentet, och reserven för
 * radering skulle inte få plats.
 */
const SMALL_DATABASE_BYTES = 1024 * 1024;

export interface PageBudget {
  /** Högsta antal sidor för skapande och ersättning. */
  readonly writePages: number;
  /** Högsta antal sidor under en radering — hela kvoten. */
  readonly deletePages: number;
  /** Så många sidor får WAL-filen samla på sig innan den förs över till databasfilen. */
  readonly walCheckpointPages: number;
}

/** Sidstorleken väljs när databasen skapas och kan sedan inte ändras. */
export function pageSizeForNewDatabase(limits: TenantLimits): number {
  return limits.maxDatabaseBytes < SMALL_DATABASE_BYTES ? SMALL_PAGE_SIZE : STANDARD_PAGE_SIZE;
}

/**
 * `pageSize` ska vara den sidstorlek databasen FAKTISKT har (läst med `PRAGMA page_size`), inte
 * den vi skulle ha valt i dag — kvoten kan ha ändrats sedan databasen skapades.
 */
export function pageBudget(limits: TenantLimits, pageSize: number): PageBudget {
  const totalPages = Math.max(1, Math.floor(limits.maxDatabaseBytes / pageSize));
  const reservePages = clamp(Math.floor(totalPages / 8), 2, 16);
  return {
    writePages: Math.max(1, totalPages - reservePages),
    deletePages: totalPages,
    walCheckpointPages: clamp(Math.floor(totalPages / 4), 16, 256),
  };
}

/** Kastar vid uppenbart trasig konfiguration — hellre ett stopp vid start än en kvot som inte gäller. */
export function assertValidLimits(limits: TenantLimits): void {
  const values: ReadonlyArray<[string, unknown]> = [
    ['maxDocumentBytes', limits.maxDocumentBytes],
    ['maxDatabaseBytes', limits.maxDatabaseBytes],
    ['maxCollections', limits.maxCollections],
    ['maxPageSize', limits.maxPageSize],
  ];
  for (const [name, value] of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Ogiltig gräns: ${name} måste vara ett positivt heltal.`);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
