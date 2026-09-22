/**
 * ALL SQL i paketet, som konstanta strängar.
 *
 * Varför samlat här: en granskare ska kunna läsa en enda fil och konstatera att ingen sats byggs
 * ihop av indata. Kollektionsnamn, dokument-id, ägare och innehåll går uteslutande in som
 * namngivna parametrar (`:namn`). Det finns en tabell för dokument och en för kollektioner —
 * aldrig en tabell per kollektion, för då hade ett kollektionsnamn behövt stå i SQL-texten.
 * Den enda stränginterpolationen i filen är konstanten OWNER_RULE, som definieras här nedan.
 *
 * Ägarregeln står i SQL, inte i JavaScript: i en `user`-kollektion matchar en sats bara rader
 * vars `owner` är den som frågar. Någon annans dokument "finns inte" för satsen, vilket är
 * precis det svar klienten ska få (`not_found` — existensen röjs aldrig).
 */

export const SCHEMA_VERSION = 1;

/**
 * `documents` är en vanlig rowid-tabell: dokument kan vara stora, och stora rader passar illa i
 * WITHOUT ROWID-tabeller. Primärnyckeln (collection, id) ger indexet som listning av gemensamma
 * kollektioner går mot; `documents_by_owner` är motsvarigheten för personliga kollektioner, så
 * att en användares listning aldrig behöver läsa förbi andras rader.
 */
export const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS collections (
    name       TEXT NOT NULL PRIMARY KEY,
    scope      TEXT NOT NULL CHECK (scope IN ('app', 'user')),
    created_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS documents (
    collection TEXT NOT NULL REFERENCES collections (name) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    owner      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS documents_by_owner ON documents (collection, owner, id);
`;

export const SELECT_COLLECTION_SCOPE = `
  SELECT scope FROM collections WHERE name = :collection
`;

/** Kollektionernas namn och synlighet, i den ordning de skapades. Bara för export. */
export const LIST_COLLECTIONS = `
  SELECT name, scope FROM collections ORDER BY created_at, name
`;

export const COUNT_COLLECTIONS = `
  SELECT count(*) AS antal FROM collections
`;

export const INSERT_COLLECTION = `
  INSERT INTO collections (name, scope, created_at) VALUES (:collection, :scope, :now)
`;

/**
 * Kollektionens största id — går mot primärnyckelns index, så det är ett enda uppslag.
 * Används för att nästa id alltid ska bli större (skapandeordning, se id.ts).
 */
export const SELECT_LAST_DOCUMENT_ID = `
  SELECT max(id) AS senaste FROM documents WHERE collection = :collection
`;

export const INSERT_DOCUMENT = `
  INSERT INTO documents (collection, id, owner, data, created_at, updated_at)
  VALUES (:collection, :id, :owner, :data, :now, :now)
`;

/** Gemensam kollektion: alla dokument, i id-ordning efter markörens position. */
export const LIST_APP_DOCUMENTS = `
  SELECT id, data, created_at, updated_at
  FROM documents
  WHERE collection = :collection AND id > :after
  ORDER BY id
  LIMIT :limit
`;

/** Personlig kollektion: samma sak, men bara den frågandes egna rader. */
export const LIST_USER_DOCUMENTS = `
  SELECT id, data, created_at, updated_at
  FROM documents
  WHERE collection = :collection AND owner = :user AND id > :after
  ORDER BY id
  LIMIT :limit
`;

/**
 * De tre satserna nedan tar inget scope från anroparen. Villkoret slår upp kollektionens LÅSTA
 * scope i samma sats: raden matchar om kollektionen är gemensam ELLER raden ägs av den som frågar.
 * Finns inte kollektionen blir underfrågan NULL och ingenting matchar.
 */
const OWNER_RULE = `
  (owner = :user OR (SELECT scope FROM collections WHERE name = :collection) = 'app')
`;

export const SELECT_DOCUMENT = `
  SELECT id, data, created_at, updated_at
  FROM documents
  WHERE collection = :collection AND id = :id AND ${OWNER_RULE}
`;

export const UPDATE_DOCUMENT = `
  UPDATE documents
  SET data = :data, updated_at = :now
  WHERE collection = :collection AND id = :id AND ${OWNER_RULE}
  RETURNING id, data, created_at, updated_at
`;

export const DELETE_DOCUMENT = `
  DELETE FROM documents
  WHERE collection = :collection AND id = :id AND ${OWNER_RULE}
`;

// ── Ändringshistorik (bara när lagringen skapats med historiken påslagen) ─────────

/**
 * Historiken ligger i SAMMA databasfil som dokumenten. Det är det enda sättet att skriva den i
 * samma transaktion som ändringen: SQLite i WAL-läge gör inte transaktioner över flera filer
 * atomiska. Följden är att historiken räknas mot appens lagringskvot (se `historik.ts`).
 *
 * Tabellen skapas bara när historiken är påslagen och ingår inte i SCHEMA_VERSION: en databas
 * där historiken aldrig slagits på ser ut exakt som förut, och en äldre version av plattformen
 * kan fortfarande läsa en databas som har tabellen.
 *
 * `owner` är DOKUMENTETS ägare (för synligheten i personliga kollektioner, samma regel som för
 * dokumenten); `user_id` är den som gjorde ändringen. AUTOINCREMENT: `seq` återanvänds aldrig,
 * inte ens när de äldsta raderna gallrats bort, så ordningen och markörerna håller.
 */
export const CREATE_HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS history (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    doc_id     TEXT NOT NULL,
    owner      TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    event      TEXT NOT NULL CHECK (event IN ('create', 'replace', 'delete', 'restore')),
    at         TEXT NOT NULL,
    data       TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS history_by_document ON history (collection, doc_id, seq);
  CREATE INDEX IF NOT EXISTS history_by_collection ON history (collection, seq);
  CREATE INDEX IF NOT EXISTS history_by_time ON history (at);
`;

export const INSERT_HISTORY = `
  INSERT INTO history (collection, doc_id, owner, user_id, event, at, data)
  VALUES (:collection, :id, :owner, :user, :event, :at, :data)
`;

/** Tiden för dokumentets senaste historikrad — går mot `history_by_document`. */
export const SELECT_LAST_HISTORY_AT = `
  SELECT at FROM history WHERE collection = :collection AND doc_id = :id ORDER BY seq DESC LIMIT 1
`;

/** Ägaren till ett dokument som den frågande redan fått skriva till (samma transaktion). */
export const SELECT_DOCUMENT_OWNER = `
  SELECT owner FROM documents WHERE collection = :collection AND id = :id
`;

/** Innehåll och ägare FÖRE en radering — med ägarregeln, så att någon annans dokument "inte finns". */
export const SELECT_DOCUMENT_FOR_DELETE = `
  SELECT owner, data
  FROM documents
  WHERE collection = :collection AND id = :id AND ${OWNER_RULE}
`;

/** Ett återställt dokument som raderats: samma id, samma ägare som förut. */
export const REINSERT_DOCUMENT = `
  INSERT INTO documents (collection, id, owner, data, created_at, updated_at)
  VALUES (:collection, :id, :owner, :data, :now, :now)
  RETURNING id, data, created_at, updated_at
`;

const HISTORY_COLUMNS = 'seq, collection, doc_id, user_id, event, at, data';

/** Ett dokuments historik, nyast först, före markörens position och inom kvarhållningstiden. */
export const LIST_DOCUMENT_HISTORY = `
  SELECT ${HISTORY_COLUMNS}
  FROM history
  WHERE collection = :collection AND doc_id = :id AND seq < :before AND at >= :cutoff AND ${OWNER_RULE}
  ORDER BY seq DESC
  LIMIT :limit
`;

/** Kollektionens historik. `:since` är '' när den saknas — alla ISO-tider sorterar efter ''. */
export const LIST_COLLECTION_HISTORY = `
  SELECT ${HISTORY_COLUMNS}
  FROM history
  WHERE collection = :collection AND seq < :before AND at >= :cutoff AND at > :since AND ${OWNER_RULE}
  ORDER BY seq DESC
  LIMIT :limit
`;

/**
 * Raden en återställning utgår från: exakt den tiden. Tiderna är strikt stigande per dokument
 * (se `nextAt` i historik.ts), så det finns högst en. Ordningen är ett extra skydd för rader
 * skrivna innan dess: en radering har inget innehåll att återställa till och väljs sist.
 */
export const SELECT_HISTORY_AT = `
  SELECT owner, event, data
  FROM history
  WHERE collection = :collection AND doc_id = :id AND at = :at AND at >= :cutoff AND ${OWNER_RULE}
  ORDER BY event = 'delete', seq DESC
  LIMIT 1
`;

/** Gallring efter tid, i begränsade omgångar så att ingen enskild skrivning blir långsam. */
export const PRUNE_HISTORY = `
  DELETE FROM history
  WHERE seq IN (SELECT seq FROM history WHERE at < :cutoff ORDER BY at LIMIT :count)
`;

/** Gallring efter plats: de äldsta raderna, när appen annars inte kan spara (se `historik.ts`). */
export const EVICT_OLDEST_HISTORY = `
  DELETE FROM history
  WHERE seq IN (SELECT seq FROM history ORDER BY seq LIMIT :count)
`;
