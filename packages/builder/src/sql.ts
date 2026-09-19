/**
 * ALL SQL i byggverktyget, som konstanta strängar med namngivna parametrar (`:namn`).
 *
 * Varför samlat här: en granskare ska kunna läsa en enda fil och konstatera att ingen sats byggs
 * ihop av indata. Ägarregeln står i satserna (`owner_user_id = :owner`), så att en app som inte
 * ägs av den som frågar "inte finns" redan i databasen — samma svar som för en app som aldrig
 * funnits.
 */

/** Höjs vid varje schemaändring, tillsammans med ett nytt steg i `MIGRATIONS`. */
export const SCHEMA_VERSION = 1;

/**
 * Steg N tar databasen från schemaversion N till N+1. Nya steg läggs SIST; ett steg som har körts
 * i drift ändras aldrig.
 *
 * - `apps.name_is_default`: appen fick inget namn när den skapades. Första önskemålet blir då
 *   namnet — men ett namn som ägaren själv valt skrivs aldrig över.
 * - `apps.published_version`: vilken av byggverktygets revisioner som senast publicerades. Control
 *   är facit för vad som serveras; kolumnen finns för att byggverktyget ska kunna svara på
 *   "är appen publicerad?" utan att fråga control.
 * - `revisions` innehåller BARA gröna byggen. "Senaste revisionen" är därmed alltid det senaste
 *   gröna utkastet, och ett misslyckat försök kan aldrig bli det som publiceras.
 * - `job_events` är en egen tabell i stället för en JSON-kolumn på jobbet: händelser läggs till
 *   löpande, och `after` blir ett indexuppslag i stället för att hela listan skrivs om per händelse.
 * - `shares.email_hash` är en HMAC av den normaliserade adressen — adressen själv ägs av
 *   identitetspaketet och sparas aldrig här. Nyckeln ligger i `secrets`, så att en kopia av
 *   databasen inte räcker för att pröva kända adresser mot tabellen utan att också ha nyckeln
 *   (som ligger i samma fil — skyddet är mot regnbågstabeller, inte mot den som har hela filen).
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE secrets (
    name  TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) STRICT;

  CREATE TABLE apps (
    app_id            TEXT PRIMARY KEY,
    owner_user_id     TEXT NOT NULL,
    name              TEXT NOT NULL,
    name_is_default   INTEGER NOT NULL CHECK (name_is_default IN (0, 1)),
    published_version TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  ) STRICT;

  CREATE INDEX apps_by_owner ON apps (owner_user_id, updated_at);

  CREATE TABLE messages (
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, seq)
  ) STRICT;

  CREATE TABLE revisions (
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL,
    files      TEXT NOT NULL,
    version_id TEXT NOT NULL,
    job_id     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, revision)
  ) STRICT;

  CREATE TABLE jobs (
    job_id        TEXT PRIMARY KEY,
    app_id        TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    message_seq   INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    model         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
  ) STRICT;

  CREATE INDEX jobs_by_app ON jobs (app_id, created_at);
  CREATE INDEX jobs_by_status ON jobs (status);

  CREATE TABLE job_events (
    job_id TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    seq    INTEGER NOT NULL,
    event  TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE shares (
    id         INTEGER PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    shared_by  TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX shares_by_sharer ON shares (shared_by, created_at);
  `,
];

// ── Hemligheter ──────────────────────────────────────────────────────────────────

export const SELECT_SECRET = `SELECT value FROM secrets WHERE name = :name`;

export const INSERT_SECRET = `INSERT OR IGNORE INTO secrets (name, value) VALUES (:name, :value)`;

// ── Appar ────────────────────────────────────────────────────────────────────────

export const INSERT_APP = `
  INSERT INTO apps (app_id, owner_user_id, name, name_is_default, created_at, updated_at)
  VALUES (:appId, :owner, :name, :nameIsDefault, :now, :now)
`;

/**
 * `has_draft` och `published` räknas fram i satsen; en app som inte ägs av `:owner` ger ingen rad.
 */
const APP_COLUMNS = `
  a.app_id AS app_id, a.name AS name, a.name_is_default AS name_is_default, a.updated_at AS updated_at,
  a.published_version AS published_version,
  EXISTS (SELECT 1 FROM revisions r WHERE r.app_id = a.app_id) AS has_draft
`;

export const SELECT_OWNED_APP = `
  SELECT ${APP_COLUMNS} FROM apps a WHERE a.app_id = :appId AND a.owner_user_id = :owner
`;

export const LIST_OWNED_APPS = `
  SELECT ${APP_COLUMNS} FROM apps a
  WHERE a.owner_user_id = :owner
  ORDER BY a.updated_at DESC, a.rowid DESC
`;

/** Alla appar och deras ägare — bara för att ge ägarna åtkomst i control när byggverktyget startar. */
export const LIST_APP_OWNERS = `SELECT app_id, owner_user_id FROM apps ORDER BY rowid`;

export const TOUCH_APP = `UPDATE apps SET updated_at = :now WHERE app_id = :appId`;

export const RENAME_DEFAULT_APP = `
  UPDATE apps SET name = :name, name_is_default = 0 WHERE app_id = :appId AND name_is_default = 1
`;

export const SET_PUBLISHED = `
  UPDATE apps SET published_version = :versionId, updated_at = :now WHERE app_id = :appId
`;

// ── Meddelanden ──────────────────────────────────────────────────────────────────

export const NEXT_MESSAGE_SEQ = `
  SELECT coalesce(max(seq), 0) + 1 AS next FROM messages WHERE app_id = :appId
`;

export const INSERT_MESSAGE = `
  INSERT INTO messages (app_id, seq, role, text, created_at) VALUES (:appId, :seq, :role, :text, :now)
`;

export const LIST_MESSAGES = `
  SELECT role, text, created_at FROM messages WHERE app_id = :appId ORDER BY seq
`;

/** Samtalet FÖRE ett visst önskemål — det agenten får som historik. */
export const LIST_MESSAGES_BEFORE = `
  SELECT role, text FROM messages WHERE app_id = :appId AND seq < :seq ORDER BY seq
`;

export const SELECT_MESSAGE = `
  SELECT text FROM messages WHERE app_id = :appId AND seq = :seq
`;

// ── Revisioner ───────────────────────────────────────────────────────────────────

export const SELECT_LATEST_REVISION = `
  SELECT revision, files, version_id FROM revisions WHERE app_id = :appId ORDER BY revision DESC LIMIT 1
`;

export const INSERT_REVISION = `
  INSERT INTO revisions (app_id, revision, files, version_id, job_id, created_at)
  VALUES (
    :appId,
    (SELECT coalesce(max(revision), 0) + 1 FROM revisions WHERE app_id = :appId),
    :files, :versionId, :jobId, :now
  )
`;

// ── Jobb ─────────────────────────────────────────────────────────────────────────

export const SELECT_ACTIVE_JOB_FOR_APP = `
  SELECT job_id FROM jobs WHERE app_id = :appId AND status IN ('queued', 'running') LIMIT 1
`;

export const INSERT_JOB = `
  INSERT INTO jobs (job_id, app_id, message_seq, status, created_at)
  VALUES (:jobId, :appId, :messageSeq, 'queued', :now)
`;

export const SELECT_LATEST_JOB_FOR_APP = `
  SELECT job_id, status FROM jobs WHERE app_id = :appId ORDER BY created_at DESC, rowid DESC LIMIT 1
`;

/** Jobbet och dess app, men bara om appen ägs av `:owner` — annars "finns" jobbet inte. */
export const SELECT_OWNED_JOB = `
  SELECT j.job_id AS job_id, j.app_id AS app_id, j.status AS status
  FROM jobs j JOIN apps a ON a.app_id = j.app_id
  WHERE j.job_id = :jobId AND a.owner_user_id = :owner
`;

/** Det kön behöver för att köra ett jobb. */
export const SELECT_JOB_FOR_RUN = `
  SELECT j.job_id AS job_id, j.app_id AS app_id, j.message_seq AS message_seq, j.status AS status,
         a.owner_user_id AS owner_user_id
  FROM jobs j JOIN apps a ON a.app_id = j.app_id
  WHERE j.job_id = :jobId
`;

export const MARK_JOB_RUNNING = `
  UPDATE jobs SET status = 'running', started_at = :now WHERE job_id = :jobId AND status = 'queued'
`;

/**
 * Bara ett jobb som fortfarande är aktivt kan avslutas. Två processer mot samma katalog (en
 * kraschad som lever kvar och en ny) kan då inte skriva över varandras slutbesked.
 */
export const FINISH_JOB = `
  UPDATE jobs
  SET status = :status, finished_at = :now, model = :model, input_tokens = :inputTokens, output_tokens = :outputTokens
  WHERE job_id = :jobId AND status IN ('queued', 'running')
`;

export const LIST_ACTIVE_JOBS = `
  SELECT job_id, app_id FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, rowid
`;

export const COUNT_JOB_EVENTS = `SELECT count(*) AS antal FROM job_events WHERE job_id = :jobId`;

export const INSERT_JOB_EVENT = `
  INSERT INTO job_events (job_id, seq, event) VALUES (:jobId, :seq, :event)
`;

export const LIST_JOB_EVENTS_AFTER = `
  SELECT event FROM job_events WHERE job_id = :jobId AND seq >= :after ORDER BY seq
`;

// ── Delningar ────────────────────────────────────────────────────────────────────

export const INSERT_SHARE = `
  INSERT INTO shares (app_id, shared_by, email_hash, created_at) VALUES (:appId, :sharedBy, :emailHash, :now)
`;

export const COUNT_SHARES_SINCE = `
  SELECT count(*) AS antal FROM shares WHERE shared_by = :sharedBy AND created_at > :since
`;
