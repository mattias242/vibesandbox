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
