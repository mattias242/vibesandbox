/**
 * ALL SQL i byggverktyget, som konstanta strängar med namngivna parametrar (`:namn`).
 *
 * Varför samlat här: en granskare ska kunna läsa en enda fil och konstatera att ingen sats byggs
 * ihop av indata. Ägarregeln står i satserna (`owner_user_id = :owner`), så att en app som inte
 * ägs av den som frågar "inte finns" redan i databasen — samma svar som för en app som aldrig
 * funnits.
 */

/** Höjs vid varje schemaändring, tillsammans med ett nytt steg i `MIGRATIONS`. */
export const SCHEMA_VERSION = 6;

/**
 * Steg N tar databasen från schemaversion N till N+1. Nya steg läggs SIST; ett steg som har körts
 * i drift ändras aldrig.
 *
 * - `apps.name_is_default`: namnet är PLATTFORMENS, inte ägarens. Gav ägaren inget namn när appen
 *   skapades blir de första tecknen ur det första önskemålet namnet, och flaggan står kvar på 1.
 *   Den säger alltså inte "saknar namn" utan "det här namnet är vår avskrift av vad någon skrev",
 *   och det är därför kontrollrummet inte visar det (se `visatNamn` i admin.ts). Ett namn som
 *   ägaren själv valt har flaggan 0 och skrivs aldrig över.
 * - `apps.published_version`: vilken av byggverktygets revisioner som senast publicerades. Control
 *   är facit för vad som serveras; kolumnen finns för att byggverktyget ska kunna svara på
 *   "är appen publicerad?" utan att fråga control.
 * - `revisions` innehåller BARA gröna byggen. "Senaste revisionen" är därmed alltid det senaste
 *   gröna utkastet, och ett misslyckat försök kan aldrig bli det som publiceras.
 * - `job_events` är en egen tabell i stället för en JSON-kolumn på jobbet: händelser läggs till
 *   löpande, och `after` blir ett indexuppslag i stället för att hela listan skrivs om per händelse.
 * - `feedback` är återkoppling på BYGGVERKTYGET, en rad per tumme: vem, vilken app, om det
 *   hjälpte och när. Fritexten finns INTE här — den mejlas till plattformens ägare och stannar
 *   i mejlet. Raderna behövs ändå: uppskattningarna ska gå att räkna, och gränsen per timme
 *   kräver en tidpunkt per återkoppling.
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
  `
  CREATE TABLE feedback (
    id         INTEGER PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    helpful    INTEGER NOT NULL CHECK (helpful IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX feedback_by_user ON feedback (user_id, created_at);
  `,
  // 3: ett stoppat önskemål är inte ett byggfel. Utan en egen kolumn hade stoppen legat bland de
  // misslyckade jobb som ska felsökas, och kontrollrummets felbild blivit obrukbar. NULL = vanligt
  // jobb; befintliga rader är därför redan rätt.
  `
  ALTER TABLE jobs ADD COLUMN stop_reason TEXT;

  CREATE INDEX jobs_by_stop ON jobs (stop_reason, created_at);
  `,
  // 4: appens informationsklass. NULL betyder aldrig klassad — inte "ofarlig". Den som läser
  // kolumnen ska läsa NULL som den strängaste klassen, precis som ett okänt värde. Kolumnerna
  // saknar CHECK med flit: en framtida klass ska inte kräva att tabellen skrivs om, och läsningen
  // prövar ändå värdet mot kontraktet. Befintliga rader blir NULL och är därmed redan rätt.
  `
  ALTER TABLE apps ADD COLUMN classification TEXT;
  ALTER TABLE apps ADD COLUMN classification_source TEXT;
  ALTER TABLE apps ADD COLUMN classified_at TEXT;

  -- name_is_default betyder härefter "namnet är plattformens avskrift av ett önskemål", inte
  -- "appen saknar namn ännu". För rader skrivna före den här versionen går de två fallen inte att
  -- skilja åt: flaggan nollställdes när appen döptes. Därför sätts den till 1 för allt som redan
  -- har ett önskemål bakom sig. Det är fail-closed åt rätt håll — priset är att en app som ägaren
  -- själv döpte står som "Namnlös app" i kontrollrummet, vilket är en förlorad etikett och inte
  -- en förlorad uppgift. Ägaren ser sitt namn som förut i sin egen lista.
  UPDATE apps SET name_is_default = 1
  WHERE name_is_default = 0 AND EXISTS (SELECT 1 FROM messages m WHERE m.app_id = apps.app_id);
  `,
  // 5: granskning före publicering. Ärendet pekar på en VERSION, inte på appen: godkännandet
  // publicerar exakt den kod som lästes, aldrig det som råkar vara senast byggt när beslutet
  // fattas. `version_id` är därför inte en främmande nyckel mot revisions — en revision kan
  // städas bort, och ärendet ska ändå gå att läsa som historik över vad som beslutades.
  //
  // Det partiella indexet håller regeln "högst ett väntande ärende per app" i DATABASEN i stället
  // för i en kontroll som två samtidiga anrop kan hinna förbi.
  `
  CREATE TABLE reviews (
    review_id    TEXT PRIMARY KEY,
    app_id       TEXT NOT NULL REFERENCES apps (app_id) ON DELETE CASCADE,
    version_id   TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('vantar', 'godkand', 'avvisad', 'tillbakadragen')),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decided_by   TEXT,
    decided_at   TEXT,
    reason       TEXT
  ) STRICT;

  CREATE UNIQUE INDEX reviews_one_pending_per_app ON reviews (app_id) WHERE state = 'vantar';

  CREATE INDEX reviews_queue ON reviews (state, requested_at);

  CREATE INDEX reviews_by_app ON reviews (app_id, requested_at);
  `,
  // 6: avveckling. Raden blir KVAR när appen avvecklas — det är hela poängen. Uppgifterna i
  // appen raderas, men spåret av att appen fanns, vem som ägde den och hur känslig den var är
  // precis det en tillsyn frågar efter. NULL = appen lever.
  `
  ALTER TABLE apps ADD COLUMN decommissioned_at TEXT;

  CREATE INDEX apps_decommissioned ON apps (decommissioned_at);
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

/**
 * En avvecklad app finns inte för sin ägare. Det är inte att dölja något — det finns ingenting
 * kvar att göra med den, och att visa ett skal som inte går att öppna, bygga om eller dela vore
 * grymmare än att den försvinner. Registret visar den, och det är där frågan hör hemma.
 */
export const SELECT_OWNED_APP = `
  SELECT ${APP_COLUMNS} FROM apps a
  WHERE a.app_id = :appId AND a.owner_user_id = :owner AND a.decommissioned_at IS NULL
`;

export const LIST_OWNED_APPS = `
  SELECT ${APP_COLUMNS} FROM apps a
  WHERE a.owner_user_id = :owner AND a.decommissioned_at IS NULL
  ORDER BY a.updated_at DESC, a.rowid DESC
`;

/** Alla appar och deras ägare — bara för att ge ägarna åtkomst i control när byggverktyget startar. */
export const LIST_APP_OWNERS = `SELECT app_id, owner_user_id FROM apps ORDER BY rowid`;

export const TOUCH_APP = `UPDATE apps SET updated_at = :now WHERE app_id = :appId`;

/**
 * Ger appen ett namn ur det FÖRSTA önskemålet. `:seq` är önskemålets ordningsnummer, så att bara
 * det första döper appen — tidigare gjordes det genom att nollställa `name_is_default`, men då
 * blev plattformens avskrift av önskemålet omöjlig att skilja från ett namn ägaren valt, och
 * kontrollrummet visade texten vidare.
 *
 * Ett namn ägaren valt har flaggan 0 från början och matchas därför aldrig av satsen.
 */
export const RENAME_DEFAULT_APP = `
  UPDATE apps SET name = :name WHERE app_id = :appId AND name_is_default = 1 AND :seq = 1
`;

/**
 * Ägaren döper sin app. `name_is_default = 0` är hela poängen: namnet är härefter hennes val, inte
 * plattformens avskrift av ett önskemål, och får därför visas i kontrollrummet. Flaggan går aldrig
 * tillbaka till 1 — en app som en gång fått ett valt namn kan inte återfå ett avskrivet.
 */
export const RENAME_APP = `
  UPDATE apps SET name = :name, name_is_default = 0, updated_at = :now WHERE app_id = :appId
`;

export const SET_PUBLISHED = `
  UPDATE apps SET published_version = :versionId, updated_at = :now WHERE app_id = :appId
`;

// ── Klassning ────────────────────────────────────────────────────────────────────

/** Appens klass som den står nu. NULL i kolumnerna = aldrig klassad. */
export const SELECT_CLASSIFICATION = `
  SELECT classification, classification_source, classified_at FROM apps WHERE app_id = :appId
`;

/**
 * Sätter klassen. Jämförelsen som avgör OM den ska sättas görs i JS mot kontraktets ordning, inte
 * här: ordningen bor i `CLASSIFICATIONS` och ska inte finnas avskriven i en CASE-sats som kan
 * glömmas bort när en klass tillkommer. Satsen körs i samma transaktion som läsningen ovanför.
 *
 * `updated_at` rörs INTE. En klassning är inget den som äger appen har gjort, och ska inte flytta
 * appen till toppen av hens lista som om något hänt med den.
 */
export const SET_CLASSIFICATION = `
  UPDATE apps
  SET classification = :classification, classification_source = :source, classified_at = :now
  WHERE app_id = :appId
`;

// ── Avveckling ───────────────────────────────────────────────────────────────────

/**
 * Arkiverar appen. Utkastet och publiceringen nollas: appen serveras inte längre någonstans, och
 * en rad som säger att den är publicerad när den inte finns vore osann i registret.
 *
 * `name` och klassningen rörs INTE. De är vad registret ska kunna svara med efteråt.
 */
export const DECOMMISSION_APP = `
  UPDATE apps
  SET decommissioned_at = :now, published_version = NULL, updated_at = :now
  WHERE app_id = :appId AND decommissioned_at IS NULL
`;

/** Appens revisioner bort: källkoden är en del av det som ska gallras. */
export const DELETE_REVISIONS = `DELETE FROM revisions WHERE app_id = :appId`;

/** Samtalet bort. Det kan bära personuppgifter och är det mest ordrika appen har. */
export const DELETE_MESSAGES = `DELETE FROM messages WHERE app_id = :appId`;

// ── Granskning ───────────────────────────────────────────────────────────────────

export const INSERT_REVIEW = `
  INSERT INTO reviews (review_id, app_id, version_id, state, requested_by, requested_at)
  VALUES (:reviewId, :appId, :versionId, 'vantar', :requestedBy, :now)
`;

/** Appens väntande ärende, om det finns ett. Högst ett — se det partiella indexet. */
export const SELECT_PENDING_REVIEW = `
  SELECT review_id, version_id, requested_at FROM reviews WHERE app_id = :appId AND state = 'vantar'
`;

/** Det senaste ärendet för appen, oavsett läge — det ägaren ser i sitt byggverktyg. */
export const SELECT_LATEST_REVIEW_FOR_APP = `
  SELECT state, requested_at, decided_at, reason FROM reviews
  WHERE app_id = :appId
  ORDER BY requested_at DESC, rowid DESC
  LIMIT 1
`;

/**
 * Drar tillbaka appens väntande ärende. Körs när ett nytt bygge landar: granskaren ska inte läsa
 * kod som redan är ersatt, och ägaren ska inte tro att någon läser.
 */
export const WITHDRAW_PENDING_REVIEW = `
  UPDATE reviews SET state = 'tillbakadragen', decided_at = :now WHERE app_id = :appId AND state = 'vantar'
`;

/**
 * Avgör ett ärende. Villkoret `state = 'vantar'` är låset: två granskare som trycker samtidigt
 * kan inte båda avgöra, och den andra får veta att ärendet redan är avgjort.
 */
export const DECIDE_REVIEW = `
  UPDATE reviews
  SET state = :state, decided_by = :decidedBy, decided_at = :now, reason = :reason
  WHERE review_id = :reviewId AND state = 'vantar'
`;

/** Ett ärende med allt granskaren behöver, inklusive vilken app och vilken version det gäller. */
export const SELECT_REVIEW = `
  SELECT r.review_id AS review_id, r.app_id AS app_id, r.version_id AS version_id, r.state AS state,
         r.requested_by AS requested_by, r.requested_at AS requested_at,
         r.decided_by AS decided_by, r.decided_at AS decided_at, r.reason AS reason,
         a.name AS name, a.name_is_default AS name_is_default, a.owner_user_id AS owner_user_id,
         a.classification AS classification, a.classification_source AS classification_source
  FROM reviews r JOIN apps a ON a.app_id = r.app_id
  WHERE r.review_id = :reviewId
`;

/** Källkoden som ETT ärende gäller — den granskaren ska läsa. */
export const SELECT_REVISION_FILES = `
  SELECT files FROM revisions WHERE app_id = :appId AND version_id = :versionId
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
/** Ett stopp avslutar jobbet utan att någon tur körts: ingen modell, inga tokens. */
export const STOP_JOB = `
  UPDATE jobs
  SET status = 'failed', finished_at = :now, stop_reason = :reason
  WHERE job_id = :jobId AND status IN ('queued', 'running')
`;

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

// ── Återkoppling på byggverktyget ────────────────────────────────────────────────

export const INSERT_FEEDBACK = `
  INSERT INTO feedback (app_id, user_id, helpful, created_at) VALUES (:appId, :userId, :helpful, :now)
`;

export const COUNT_FEEDBACK_SINCE = `
  SELECT count(*) AS antal FROM feedback WHERE user_id = :userId AND created_at > :since
`;
