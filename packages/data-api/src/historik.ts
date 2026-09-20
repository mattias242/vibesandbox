/**
 * Ändringshistoriken: vem ändrade vad och när.
 *
 * Varför här och inte i tjänsten `history`: historiken måste skrivas där dokumenten skrivs, i
 * SAMMA transaktion. Då kan en sparad ändring aldrig sakna sin rad, och en ändring som
 * misslyckas (nekad, för stor, full databas, krasch mitt i) kan aldrig ge någon. Tjänsten läser
 * bara det som står här.
 *
 * LAGRINGSKVOTEN. Historiken ligger i appens egen databasfil och räknas därför mot appens kvot
 * — det är SQLite:s `max_page_count` som verkställer den (se kvot.ts), inte vår kod. Det finns
 * inget sätt att låta en app fylla disken via historiken. Men historiken får inte heller göra
 * appen oanvändbar: ett dokument som skrivs om tusen gånger ger tusen kopior, och en radering
 * flyttar bara innehållet till historiken. Regeln är därför:
 *
 *   appens egna dokument går före historiken. Får en skrivning inte plats, gallras de ÄLDSTA
 *   historikraderna (i växande omgångar) och skrivningen görs om — med sin egen historikrad.
 *
 * Historiken använder alltså det utrymme dokumenten inte behöver. En skrivning nekas med
 * `quota_exceeded` först när dokumenten ensamma fyller kvoten, precis som utan historik.
 * Utöver det gallras rader äldre än kvarhållningstiden (`retentionDays`) vid varje skrivning,
 * och de syns aldrig vid läsning även om de ännu inte hunnit gallras.
 *
 * Allt här är synkront, som i dokument.ts (se handtag.ts).
 */
import type { HistoryEntry, HistoryEvent, HistoryPage, JsonObject, StoredDocument, TenantLimits } from '@vibesandbox/contracts';
import { createDocument, notFound, parseData, toStoredDocument } from './dokument.ts';
import type { CreateRequest, DocumentRequest } from './dokument.ts';
import { dataApiError, isDatabaseFull } from './fel.ts';
import type { TenantHandle } from './handtag.ts';
import {
  DELETE_DOCUMENT,
  EVICT_OLDEST_HISTORY,
  INSERT_HISTORY,
  LIST_COLLECTION_HISTORY,
  LIST_DOCUMENT_HISTORY,
  PRUNE_HISTORY,
  REINSERT_DOCUMENT,
  SELECT_DOCUMENT_FOR_DELETE,
  SELECT_DOCUMENT_OWNER,
  SELECT_HISTORY_AT,
  SELECT_LAST_HISTORY_AT,
  UPDATE_DOCUMENT,
} from './sql.ts';

type Row = Record<string, unknown>;

export const DEFAULT_RETENTION_DAYS = 365;
/** Hundra år. Längre än så är ett skrivfel i konfigurationen, inte ett beslut. */
const MAX_RETENTION_DAYS = 36_500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Så många utgångna rader gallras per skrivning. Resten tas vid nästa. */
const PRUNE_BATCH = 100;
/** Första omgången vid platsbrist; växer fyrfaldigt tills skrivningen får plats. */
const FIRST_EVICTION_BATCH = 16;

export interface HistorySettings {
  readonly retentionDays: number;
}

/**
 * Kvarhållningstiden ur konfigurationen: ett heltal eller texten ur miljövariabeln
 * (`SVC_HISTORY_RETENTION_DAYS`). Saknas den gäller standardvärdet. Allt annat stoppar uppstarten.
 *
 * En TOM sträng räknas som att värdet saknas: docker compose skickar in varje variabel, även de
 * som inte är ifyllda, och en tom variabel ska inte fälla plattformen vid start.
 */
export function parseRetentionDays(value: unknown): number {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return DEFAULT_RETENTION_DAYS;
  let days: number | undefined;
  if (typeof value === 'number') days = value;
  else if (typeof value === 'string' && /^[1-9][0-9]{0,5}$/.test(value)) days = Number(value);
  if (days === undefined || !Number.isSafeInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
    throw new TypeError(`Ogiltig kvarhållningstid för historiken: ange ett heltal mellan 1 och ${MAX_RETENTION_DAYS} dagar.`);
  }
  return days;
}

function cutoff(settings: HistorySettings): string {
  return new Date(Date.now() - settings.retentionDays * DAY_MS).toISOString();
}

// ── Skrivning ────────────────────────────────────────────────────────────────────

interface HistoryRow {
  readonly collection: string;
  readonly id: string;
  readonly owner: string;
  readonly userId: string;
  readonly event: HistoryEvent;
  readonly at: string;
  readonly dataText: string;
}

function insertHistory(handle: TenantHandle, row: HistoryRow): void {
  handle.statement(INSERT_HISTORY).run({
    collection: row.collection,
    id: row.id,
    owner: row.owner,
    user: row.userId,
    event: row.event,
    at: row.at,
    data: row.dataText,
  });
}

/**
 * Tiden för en ny rad i ett dokuments historik: nu, men alltid STRIKT senare än dokumentets
 * förra rad. Då identifierar `at` en version entydigt — två ändringar inom samma millisekund,
 * eller en klocka som ställts bakåt, ger ändå olika tider i rätt ordning, och `restore { at }`
 * kan aldrig träffa fel version.
 */
function nextAt(handle: TenantHandle, collection: string, id: string): string {
  const now = new Date().toISOString();
  const row: Row | undefined = handle.statement(SELECT_LAST_HISTORY_AT).get({ collection, id });
  const last = row?.['at'];
  if (typeof last !== 'string' || now > last) return now;
  return new Date(Date.parse(last) + 1).toISOString();
}

function prune(handle: TenantHandle, settings: HistorySettings): void {
  handle.statement(PRUNE_HISTORY).run({ cutoff: cutoff(settings), count: PRUNE_BATCH });
}

/**
 * Kör en skrivning; får den inte plats gallras de äldsta historikraderna och den görs om.
 * `write` måste gå att köra om från början — varje försök är en egen, hel transaktion.
 * Gallringen körs med raderingsreserven: den ska fungera även i en full databas.
 */
function whenFullEvictOldest<T>(handle: TenantHandle, write: () => T): T {
  let batch = FIRST_EVICTION_BATCH;
  for (;;) {
    try {
      return write();
    } catch (fel) {
      if (!isDatabaseFull(fel)) throw fel;
      const evicted = handle.withDeleteReserve(() =>
        handle.transaction(() => Number(handle.statement(EVICT_OLDEST_HISTORY).run({ count: batch }).changes)),
      );
      // Ingen historik kvar att ge: dokumenten fyller kvoten själva. Då gäller vanlig kvot.
      if (evicted === 0) throw fel;
      batch *= 4;
    }
  }
}

export function createWithHistory(
  handle: TenantHandle,
  limits: TenantLimits,
  settings: HistorySettings,
  request: CreateRequest,
): StoredDocument {
  return whenFullEvictOldest(handle, () =>
    createDocument(handle, limits, request, (id, now) => {
      prune(handle, settings);
      insertHistory(handle, {
        collection: request.collection,
        id,
        owner: request.userId,
        userId: request.userId,
        event: 'create',
        at: now,
        dataText: request.dataText,
      });
    }),
  );
}

export function replaceWithHistory(
  handle: TenantHandle,
  settings: HistorySettings,
  request: DocumentRequest,
  dataText: string,
): StoredDocument {
  return whenFullEvictOldest(handle, () =>
    handle.transaction(() => {
      prune(handle, settings);
      const now = nextAt(handle, request.collection, request.id);
      const row: Row | undefined = handle.statement(UPDATE_DOCUMENT).get({
        collection: request.collection,
        id: request.id,
        user: request.userId,
        data: dataText,
        now,
      });
      if (row === undefined) throw notFound();
      insertHistory(handle, {
        collection: request.collection,
        id: request.id,
        owner: readOwner(handle, request),
        userId: request.userId,
        event: 'replace',
        at: now,
        dataText,
      });
      return toStoredDocument(row);
    }),
  );
}

export function deleteWithHistory(handle: TenantHandle, settings: HistorySettings, request: DocumentRequest): void {
  // Radering måste fungera även när kvoten är förbrukad — som utan historik (se dokument.ts).
  whenFullEvictOldest(handle, () =>
    handle.withDeleteReserve(() =>
      handle.transaction(() => {
        prune(handle, settings);
        const parameters = { collection: request.collection, id: request.id, user: request.userId };
        const before: Row | undefined = handle.statement(SELECT_DOCUMENT_FOR_DELETE).get(parameters);
        if (before === undefined) throw notFound();
        const { owner, data } = before;
        if (typeof owner !== 'string' || typeof data !== 'string') throw new Error('oväntad radform i documents');
        const result = handle.statement(DELETE_DOCUMENT).run(parameters);
        if (Number(result.changes) === 0) throw notFound();
        insertHistory(handle, {
          collection: request.collection,
          id: request.id,
          owner,
          userId: request.userId,
          event: 'delete',
          at: nextAt(handle, request.collection, request.id),
          dataText: data,
        });
      }),
    ),
  );
}

/**
 * Återställer innehållet från raden med exakt tiden `at`. Samma ägarregel som vid ersättning:
 * raden syns bara för den som får se dokumentet, och ett dokument som finns skrivs bara om det
 * går att ersätta. Ett raderat dokument återskapas med samma id och samma ägare som förut.
 */
export function restoreWithHistory(
  handle: TenantHandle,
  settings: HistorySettings,
  request: DocumentRequest,
  at: string,
): StoredDocument {
  return whenFullEvictOldest(handle, () =>
    handle.transaction(() => {
      prune(handle, settings);
      const source: Row | undefined = handle.statement(SELECT_HISTORY_AT).get({
        collection: request.collection,
        id: request.id,
        user: request.userId,
        at,
        cutoff: cutoff(settings),
      });
      if (source === undefined) {
        throw dataApiError('not_found', 'Det finns ingen version av dokumentet från den tidpunkten.');
      }
      const { owner, event, data } = source;
      if (typeof owner !== 'string' || typeof data !== 'string') throw new Error('oväntad radform i history');
      if (event === 'delete') {
        throw dataApiError('invalid_request', 'Välj en tidpunkt då dokumentet fanns — inte själva raderingen.');
      }

      const now = nextAt(handle, request.collection, request.id);
      const parameters = { collection: request.collection, id: request.id, user: request.userId, data, now };
      let row: Row | undefined = handle.statement(UPDATE_DOCUMENT).get(parameters);
      let documentOwner = owner;
      if (row === undefined) {
        // Raden syntes för den frågande, alltså får hen se dokumentet. Att UPDATE ändå inte
        // träffade betyder att dokumentet är raderat — finns id:t (någon annans) stoppar
        // primärnyckeln återskapandet, och det blir ett fel i stället för en överskrivning.
        row = handle.statement(REINSERT_DOCUMENT).get({ collection: request.collection, id: request.id, owner, data, now });
        if (row === undefined) throw notFound();
      } else {
        documentOwner = readOwner(handle, request);
      }
      insertHistory(handle, {
        collection: request.collection,
        id: request.id,
        owner: documentOwner,
        userId: request.userId,
        event: 'restore',
        at: now,
        dataText: data,
      });
      return toStoredDocument(row);
    }),
  );
}

function readOwner(handle: TenantHandle, request: DocumentRequest): string {
  const row: Row | undefined = handle.statement(SELECT_DOCUMENT_OWNER).get({ collection: request.collection, id: request.id });
  const owner = row?.['owner'];
  if (typeof owner !== 'string') throw new Error('dokumentet försvann mitt i transaktionen');
  return owner;
}

// ── Läsning ──────────────────────────────────────────────────────────────────────

export const EMPTY_HISTORY: HistoryPage = Object.freeze({ entries: Object.freeze([]) });

export interface HistoryListRequest {
  readonly collection: string;
  readonly userId: string;
  readonly pageSize: number;
  /** `seq` från markören, eller `undefined` för första (nyaste) sidan. */
  readonly beforeSeq: number | undefined;
}

export function readDocumentHistory(
  handle: TenantHandle,
  settings: HistorySettings,
  request: HistoryListRequest & { readonly id: string },
): HistoryPage {
  const rows: Row[] = handle.statement(LIST_DOCUMENT_HISTORY).all({
    collection: request.collection,
    id: request.id,
    user: request.userId,
    before: request.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    cutoff: cutoff(settings),
    limit: request.pageSize + 1,
  });
  // Ingen synlig rad alls ⇒ dokumentet "finns inte" för den frågande — samma svar oavsett om det
  // aldrig funnits, är någon annans eller har gallrats bort. En tom SENARE sida är däremot bara tom.
  if (rows.length === 0 && request.beforeSeq === undefined) throw notFound();
  return toPage(rows, request.pageSize, (seq) => encodeHistoryCursor('d', request.collection, request.id, seq));
}

export function readCollectionHistory(
  handle: TenantHandle,
  settings: HistorySettings,
  request: HistoryListRequest & { readonly since: string | undefined },
): HistoryPage {
  const rows: Row[] = handle.statement(LIST_COLLECTION_HISTORY).all({
    collection: request.collection,
    user: request.userId,
    before: request.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    cutoff: cutoff(settings),
    since: request.since ?? '',
    limit: request.pageSize + 1,
  });
  return toPage(rows, request.pageSize, (seq) => encodeHistoryCursor('c', request.collection, '-', seq));
}

function toPage(rows: Row[], pageSize: number, cursorFor: (seq: number) => string): HistoryPage {
  const page = rows.slice(0, pageSize);
  const entries = page.map(toEntry);
  const lastSeq = page.at(-1)?.['seq'];
  if (rows.length > pageSize && typeof lastSeq === 'number') return { entries, nextCursor: cursorFor(lastSeq) };
  return { entries };
}

function toEntry(row: Row): HistoryEntry {
  const { collection, doc_id: documentId, user_id: userId, event, at, data } = row;
  if (
    typeof collection !== 'string' ||
    typeof documentId !== 'string' ||
    typeof userId !== 'string' ||
    typeof at !== 'string' ||
    typeof data !== 'string' ||
    !isHistoryEvent(event)
  ) {
    throw new Error('oväntad radform i history');
  }
  const parsed: JsonObject = parseData(data);
  return { collection, documentId, event, at, userId, data: parsed };
}

function isHistoryEvent(value: unknown): value is HistoryEvent {
  return value === 'create' || value === 'replace' || value === 'delete' || value === 'restore';
}

// ── Tider och markörer ───────────────────────────────────────────────────────────

const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Exakt den form plattformen själv skriver (`toISOString`). Allt annat — även "nästan" — avvisas. */
export function validateIsoTime(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIME_PATTERN.test(value)) throw invalidTime();
  const time = new Date(value);
  if (Number.isNaN(time.getTime()) || time.toISOString() !== value) throw invalidTime();
  return value;
}

function invalidTime(): Error {
  return dataApiError('invalid_request', 'Ogiltig tidpunkt. Ange tiden som den står i historiken, t.ex. 2026-09-01T10:00:00.000Z.');
}

/**
 * Markören bär bara en position (`seq`), aldrig en behörighet — samma modell som markor.ts.
 * Vilken kollektion, vilket dokument och vilken ägare som gäller kommer alltid ur anropet och
 * står som villkor i SQL. Sort, kollektion och dokument ingår för att fånga ärliga misstag.
 */
const HISTORY_CURSOR_PATTERN = /^h1:([dc]):([a-z][a-z0-9_-]{0,63}):([0-9a-hjkmnp-tv-z]{26}|-):([1-9][0-9]{0,15})$/;
const MAX_CURSOR_LENGTH = 200;

function encodeHistoryCursor(kind: 'd' | 'c', collection: string, id: string, seq: number): string {
  return Buffer.from(`h1:${kind}:${collection}:${id}:${seq}`, 'utf8').toString('base64url');
}

export function decodeHistoryCursor(cursor: unknown, kind: 'd' | 'c', collection: string, id: string): number {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidCursor();
  }
  const payload = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(payload, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
  const match = HISTORY_CURSOR_PATTERN.exec(payload);
  if (match === null || match[1] !== kind || match[2] !== collection || match[3] !== id) throw invalidCursor();
  const seq = Number(match[4]);
  if (!Number.isSafeInteger(seq)) throw invalidCursor();
  return seq;
}

function invalidCursor(): Error {
  return dataApiError('invalid_request', 'Ogiltig markör för sidindelning. Börja om från första sidan.');
}
