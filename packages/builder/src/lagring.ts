/**
 * Byggverktygets lagring: appar, samtal, revisioner, jobb, händelser, delningar och återkoppling.
 *
 * Varje funktion här är synkron. Uppslag som rör en användares app tar alltid ägaren som
 * parameter, och satserna i sql.ts matchar bara rader som ägs av den — "någon annans app" och
 * "ingen app" ger samma resultat: `null`.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { asClassification, classificationRank, CLASSIFICATION_SOURCES } from '@vibesandbox/contracts';
import type { AgentEvent, BuilderJobStatus, BuilderMessage, Classification, ClassificationSource, ConversationEntry, SourceFiles } from '@vibesandbox/contracts';
import type { BuilderDatabase, Row } from './databas.ts';
import * as adminSql from './sql-admin.ts';
import * as sql from './sql.ts';

export interface StoredApp {
  readonly appId: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly hasDraft: boolean;
  readonly publishedVersion: string | null;
}

export interface StoredRevision {
  readonly revision: number;
  readonly files: SourceFiles;
  readonly versionId: string;
}

export interface JobForRun {
  readonly jobId: string;
  readonly appId: string;
  readonly ownerUserId: string;
  readonly messageSeq: number;
  readonly status: BuilderJobStatus;
}

/** Sammanräkningen bakom `AdminOverview` — alla appar, oavsett ägare. */
export interface AdminCounts {
  readonly apps: number;
  readonly published: number;
  readonly drafts: number;
}

/** Tokens och jobb inom kontrollrummets tidsfönster. */
export interface AdminJobTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly jobs: number;
}

/**
 * En app sedd från kontrollrummet. `ownerUserId` följer med för att ägarens ADRESS ska kunna
 * hämtas ur control — den finns inte i byggverktygets databas. Hela `appId` stannar i det här
 * lagret: anroparen kapar det innan det når svaret.
 */
/** Ett stoppat önskemål. Texten som stoppades finns INTE här — se sql-admin.ts om varför. */
export interface StoredStop {
  readonly appId: string;
  readonly reason: string;
  readonly at: string;
}

export interface StoredAdminApp {
  readonly appId: string;
  readonly ownerUserId: string;
  readonly name: string;
  /** Sant om namnet är plattformens standardnamn — de första tecknen ur det första önskemålet. */
  readonly nameIsDefault: boolean;
  readonly updatedAt: string;
  readonly hasDraft: boolean;
  readonly published: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * En rad i AI-registret, RÅ ur databasen. Klassen och källan är `string | null` med flit: en rad
 * skriven av en äldre version av vår egen kod kan bära ett ord som inte längre finns i kontraktet,
 * och lagret ska inte tysta det. Prövningen — och fallet åt det stränga hållet — görs i admin.ts.
 */
export interface StoredRegisterRow {
  readonly appId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly nameIsDefault: boolean;
  readonly classification: string | null;
  readonly source: string | null;
  readonly classifiedAt: string | null;
  readonly published: boolean;
}

/** Ett granskningsärende, rått ur databasen. Klass och källa prövas av den som läser, som i registret. */
export interface StoredReview {
  readonly reviewId: string;
  readonly appId: string;
  readonly versionId: string;
  readonly state: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly name: string;
  readonly nameIsDefault: boolean;
  readonly ownerUserId: string;
  readonly classification: string | null;
  readonly classificationSource: string | null;
}

export interface JobOutcome {
  readonly status: 'done' | 'failed';
  readonly model?: string | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Kolumnen ${column} är inte text.`);
  return value;
}

/** Text eller `null`. Allt annat än en sträng läses som `null` — ett tal i kolumnen är inte ett ord. */
function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Kolumnen ${column} är inte ett tal.`);
  return value;
}

/**
 * En rad ur reviews. Kön (`LIST_PENDING_REVIEWS`) saknar några kolumner med flit — den ska inte
 * läsa varje apps källkod — så de fälten faller tillbaka på tomma värden. Det är säkert eftersom
 * kön bara visar väntande ärenden, som per definition inte är avgjorda.
 */
function toReview(row: Row): StoredReview {
  return {
    reviewId: text(row, 'review_id'),
    appId: text(row, 'app_id'),
    versionId: optionalText(row, 'version_id') ?? '',
    state: text(row, 'state'),
    requestedBy: optionalText(row, 'requested_by') ?? '',
    requestedAt: text(row, 'requested_at'),
    decidedBy: optionalText(row, 'decided_by'),
    decidedAt: optionalText(row, 'decided_at'),
    reason: optionalText(row, 'reason'),
    name: text(row, 'name'),
    nameIsDefault: integer(row, 'name_is_default') === 1,
    ownerUserId: text(row, 'owner_user_id'),
    classification: optionalText(row, 'classification'),
    classificationSource: optionalText(row, 'classification_source'),
  };
}

function toApp(row: Row): StoredApp {
  const published = row['published_version'];
  return {
    appId: text(row, 'app_id'),
    name: text(row, 'name'),
    updatedAt: text(row, 'updated_at'),
    hasDraft: integer(row, 'has_draft') === 1,
    publishedVersion: typeof published === 'string' ? published : null,
  };
}

const STATUSES: readonly BuilderJobStatus[] = ['queued', 'running', 'done', 'failed'];

function toStatus(value: string): BuilderJobStatus {
  const status = STATUSES.find((candidate) => candidate === value);
  if (status === undefined) throw new Error('Okänd jobbstatus i databasen.');
  return status;
}

const EMAIL_HASH_SECRET = 'share-email-hmac';

export function createStorage(db: BuilderDatabase) {
  // HMAC-nyckeln skapas första gången och läses sedan ur databasen (se sql.ts).
  db.run(sql.INSERT_SECRET, { name: EMAIL_HASH_SECRET, value: randomBytes(32) });
  const secretRow = db.get(sql.SELECT_SECRET, { name: EMAIL_HASH_SECRET });
  const secret = secretRow?.['value'];
  if (!(secret instanceof Uint8Array)) throw new Error('Nyckeln för delningar saknas.');
  const emailKey = Buffer.from(secret);

  return {
    // ── Appar ──────────────────────────────────────────────────────────────────

    insertApp(appId: string, owner: string, name: string, nameIsDefault: boolean, now: string): void {
      db.run(sql.INSERT_APP, { appId, owner, name, nameIsDefault: nameIsDefault ? 1 : 0, now });
    },

    findOwnedApp(appId: string, owner: string): StoredApp | null {
      const row = db.get(sql.SELECT_OWNED_APP, { appId, owner });
      return row === undefined ? null : toApp(row);
    },

    listOwnedApps(owner: string): StoredApp[] {
      return db.all(sql.LIST_OWNED_APPS, { owner }).map(toApp);
    },

    listAppOwners(): { appId: string; owner: string }[] {
      return db.all(sql.LIST_APP_OWNERS, {}).map((row) => ({ appId: text(row, 'app_id'), owner: text(row, 'owner_user_id') }));
    },

    markPublished(appId: string, versionId: string, now: string): void {
      db.run(sql.SET_PUBLISHED, { appId, versionId, now });
    },

    // ── Samtal ─────────────────────────────────────────────────────────────────

    listMessages(appId: string): BuilderMessage[] {
      return db.all(sql.LIST_MESSAGES, { appId }).map((row) => ({
        role: text(row, 'role') === 'assistant' ? 'assistant' : 'user',
        text: text(row, 'text'),
        createdAt: text(row, 'created_at'),
      }));
    },

    historyBefore(appId: string, seq: number): ConversationEntry[] {
      return db.all(sql.LIST_MESSAGES_BEFORE, { appId, seq }).map((row) => ({
        role: text(row, 'role') === 'assistant' ? 'assistant' : 'user',
        text: text(row, 'text'),
      }));
    },

    messageText(appId: string, seq: number): string | null {
      const row = db.get(sql.SELECT_MESSAGE, { appId, seq });
      return row === undefined ? null : text(row, 'text');
    },

    addAssistantMessage(appId: string, message: string, now: string): void {
      db.transaction(() => {
        const next = integer(db.get(sql.NEXT_MESSAGE_SEQ, { appId }) ?? {}, 'next');
        db.run(sql.INSERT_MESSAGE, { appId, seq: next, role: 'assistant', text: message, now });
        db.run(sql.TOUCH_APP, { appId, now });
      });
    },

    /**
     * Sparar önskemålet och skapar jobbet i EN transaktion, efter kontrollen att inget annat jobb
     * är aktivt för appen. `null` ⇒ ett jobb pågår redan; då sparas ingenting.
     */
    enqueueRequest(appId: string, jobId: string, request: string, defaultName: string, now: string): boolean {
      return db.transaction(() => {
        if (db.get(sql.SELECT_ACTIVE_JOB_FOR_APP, { appId }) !== undefined) return false;
        const seq = integer(db.get(sql.NEXT_MESSAGE_SEQ, { appId }) ?? {}, 'next');
        db.run(sql.INSERT_MESSAGE, { appId, seq, role: 'user', text: request, now });
        db.run(sql.INSERT_JOB, { jobId, appId, messageSeq: seq, now });
        db.run(sql.RENAME_DEFAULT_APP, { appId, name: defaultName, seq });
        db.run(sql.TOUCH_APP, { appId, now });
        return true;
      });
    },

    // ── Revisioner ─────────────────────────────────────────────────────────────

    latestRevision(appId: string): StoredRevision | null {
      const row = db.get(sql.SELECT_LATEST_REVISION, { appId });
      if (row === undefined) return null;
      const parsed: unknown = JSON.parse(text(row, 'files'));
      // fromEntries skapar egna egenskaper, så en sökväg som `__proto__` kan inte röra prototypen.
      const files: SourceFiles =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : {};
      return { revision: integer(row, 'revision'), files, versionId: text(row, 'version_id') };
    },

    /** Ett grönt bygge: ny revision, assistentens svar och jobbets slut — allt eller inget. */
    completeGreenJob(
      appId: string,
      jobId: string,
      files: SourceFiles,
      versionId: string,
      summary: string,
      outcome: JobOutcome,
      now: string,
    ): boolean {
      return db.transaction(() => {
        const finished = finishJob(jobId, outcome, now);
        if (!finished) return false;
        db.run(sql.INSERT_REVISION, { appId, files: JSON.stringify(files), versionId, jobId, now });
        // Ett nytt bygge drar tillbaka en väntande granskning. Granskaren ska inte läsa kod som
        // redan är ersatt, och ägaren ska inte tro att någon läser. I samma transaktion som
        // revisionen: annars finns ett ögonblick där ärendet pekar på kod som inte är den senaste.
        db.run(sql.WITHDRAW_PENDING_REVIEW, { appId, now });
        const next = integer(db.get(sql.NEXT_MESSAGE_SEQ, { appId }) ?? {}, 'next');
        db.run(sql.INSERT_MESSAGE, { appId, seq: next, role: 'assistant', text: summary, now });
        db.run(sql.TOUCH_APP, { appId, now });
        return true;
      });
    },

    // ── Jobb ───────────────────────────────────────────────────────────────────

    latestJob(appId: string): { jobId: string; status: BuilderJobStatus } | null {
      const row = db.get(sql.SELECT_LATEST_JOB_FOR_APP, { appId });
      return row === undefined ? null : { jobId: text(row, 'job_id'), status: toStatus(text(row, 'status')) };
    },

    findOwnedJob(jobId: string, owner: string): { jobId: string; appId: string; status: BuilderJobStatus } | null {
      const row = db.get(sql.SELECT_OWNED_JOB, { jobId, owner });
      if (row === undefined) return null;
      return { jobId: text(row, 'job_id'), appId: text(row, 'app_id'), status: toStatus(text(row, 'status')) };
    },

    jobForRun(jobId: string): JobForRun | null {
      const row = db.get(sql.SELECT_JOB_FOR_RUN, { jobId });
      if (row === undefined) return null;
      return {
        jobId: text(row, 'job_id'),
        appId: text(row, 'app_id'),
        ownerUserId: text(row, 'owner_user_id'),
        messageSeq: integer(row, 'message_seq'),
        status: toStatus(text(row, 'status')),
      };
    },

    markRunning(jobId: string, now: string): boolean {
      return db.run(sql.MARK_JOB_RUNNING, { jobId, now }).changes === 1;
    },

    /** Avslutar ett jobb som inte blev grönt, med ett besked i samtalet. */
    /**
     * Som `failJob`, men för ett önskemål som stoppats av en röd linje. Skälet skrivs i
     * `stop_reason`, så att stoppet aldrig räknas som ett byggfel: ingen tur kördes, ingen modell
     * anropades, och det finns ingenting att felsöka. Meddelandet till den som bad om appen är
     * detsamma som vid ett fel — hen ska få ett svar i samtalet.
     */
    stopJob(appId: string, jobId: string, message: string, reason: string, now: string, doneEvent: AgentEvent): boolean {
      return db.transaction(() => {
        const stopped = db.run(sql.STOP_JOB, { jobId, reason, now }).changes > 0;
        if (!stopped) return false;
        appendEvent(jobId, doneEvent);
        const next = integer(db.get(sql.NEXT_MESSAGE_SEQ, { appId }) ?? {}, 'next');
        db.run(sql.INSERT_MESSAGE, { appId, seq: next, role: 'assistant', text: message, now });
        db.run(sql.TOUCH_APP, { appId, now });
        return true;
      });
    },

    failJob(appId: string, jobId: string, message: string, outcome: JobOutcome, now: string, doneEvent: AgentEvent | null): boolean {
      return db.transaction(() => {
        const finished = finishJob(jobId, outcome, now);
        if (!finished) return false;
        if (doneEvent !== null) appendEvent(jobId, doneEvent);
        const next = integer(db.get(sql.NEXT_MESSAGE_SEQ, { appId }) ?? {}, 'next');
        db.run(sql.INSERT_MESSAGE, { appId, seq: next, role: 'assistant', text: message, now });
        db.run(sql.TOUCH_APP, { appId, now });
        return true;
      });
    },

    listActiveJobs(): { jobId: string; appId: string }[] {
      return db.all(sql.LIST_ACTIVE_JOBS).map((row) => ({ jobId: text(row, 'job_id'), appId: text(row, 'app_id') }));
    },

    appendEvent,

    eventsAfter(jobId: string, after: number): { events: AgentEvent[]; next: number } {
      const count = integer(db.get(sql.COUNT_JOB_EVENTS, { jobId }) ?? {}, 'antal');
      if (after >= count) return { events: [], next: count };
      const events = db.all(sql.LIST_JOB_EVENTS_AFTER, { jobId, after }).map((row) => JSON.parse(text(row, 'event')) as AgentEvent);
      return { events, next: count };
    },

    // ── Delningar ──────────────────────────────────────────────────────────────

    sharesSince(sharedBy: string, since: string): number {
      return integer(db.get(sql.COUNT_SHARES_SINCE, { sharedBy, since }) ?? {}, 'antal');
    },

    recordShare(appId: string, sharedBy: string, email: string, now: string): void {
      const emailHash = createHmac('sha256', emailKey).update(email.trim().toLowerCase(), 'utf8').digest('hex');
      db.run(sql.INSERT_SHARE, { appId, sharedBy, emailHash, now });
    },

    // ── Återkoppling på byggverktyget ──────────────────────────────────────────

    feedbackSince(userId: string, since: string): number {
      return integer(db.get(sql.COUNT_FEEDBACK_SINCE, { userId, since }) ?? {}, 'antal');
    },

    /**
     * En rad per tumme. Texten tas INTE emot här: den är på väg till plattformens ägare i ett
     * mejl och ska inte också ligga kvar i byggverktygets databas.
     */
    recordFeedback(appId: string, userId: string, helpful: boolean, now: string): void {
      db.run(sql.INSERT_FEEDBACK, { appId, userId, helpful: helpful ? 1 : 0, now });
    },

    // ── Kontrollrummet (adminvyn) ──────────────────────────────────────────────
    //
    // De fyra läsningarna nedan tar INGEN ägare: de ser medvetet över alla appar. Satserna ligger
    // samlade i sql-admin.ts, och vägen hit går bara genom `requireAdmin` i api.ts.

    countAllApps(): AdminCounts {
      const row = db.get(adminSql.COUNT_ALL_APPS, {}) ?? {};
      return { apps: integer(row, 'apps'), published: integer(row, 'published'), drafts: integer(row, 'drafts') };
    },

    jobTotalsSince(since: string): AdminJobTotals {
      const row = db.get(adminSql.SUM_JOB_TOKENS_SINCE, { since }) ?? {};
      return {
        inputTokens: integer(row, 'input_tokens'),
        outputTokens: integer(row, 'output_tokens'),
        jobs: integer(row, 'jobs'),
      };
    },

    failedJobsSince(since: string): number {
      return integer(db.get(adminSql.COUNT_FAILED_JOBS_SINCE, { since }) ?? {}, 'failed');
    },

    listAllApps(): StoredAdminApp[] {
      return db.all(adminSql.LIST_ALL_APPS, {}).map((row) => ({
        appId: text(row, 'app_id'),
        ownerUserId: text(row, 'owner_user_id'),
        name: text(row, 'name'),
        nameIsDefault: integer(row, 'name_is_default') === 1,
        updatedAt: text(row, 'updated_at'),
        hasDraft: integer(row, 'has_draft') === 1,
        published: typeof row['published_version'] === 'string',
        inputTokens: integer(row, 'input_tokens'),
        outputTokens: integer(row, 'output_tokens'),
      }));
    },

    listStops(limit: number): StoredStop[] {
      return db.all(adminSql.LIST_STOPS, { limit }).map((row) => ({
        appId: text(row, 'app_id'),
        reason: text(row, 'stop_reason'),
        at: text(row, 'created_at'),
      }));
    },

    /**
     * Sätter appens klass — men BARA uppåt. `rank` är kontraktets ordning och kommer utifrån, så
     * att den bara står skriven på ett ställe.
     *
     * Läsningen och skrivningen ligger i samma transaktion. Utan den kunde två jobb mot samma app
     * läsa samma gamla klass och den senare skriva över den strängare: höjningsregeln hade då
     * gällt "oftast", vilket är samma sak som inte alls för en regel som ska gå att lita på.
     *
     * Svaret säger vad klassen BLEV, inte vad som skrevs — anroparen ska kunna logga utfallet utan
     * att läsa om raden.
     */
    raiseClassification(
      appId: string,
      next: { classification: Classification; source: ClassificationSource },
      now: string,
    ): { classification: Classification; source: ClassificationSource; raised: boolean } {
      return db.transaction(() => {
        const row = db.get(sql.SELECT_CLASSIFICATION, { appId });
        if (row === undefined) return { ...next, raised: false };
        const current = optionalText(row, 'classification');
        // Lika strängt är ingen höjning. En omklassning som landar på samma klass ska inte flytta
        // `classified_at` framåt: tidpunkten svarar på när klassen SATTES, inte när den senast
        // bekräftades, och en app som byggs om varje dag ska inte se nyklassad ut varje dag.
        //
        // `classificationRank` läser ett okänt ord ur kolumnen som den STRÄNGASTE klassen. En rad
        // skriven av en äldre version av vår egen kod kan alltså inte sänkas av det här anropet.
        if (current !== null && classificationRank(next.classification) <= classificationRank(current)) {
          // Svaret beskriver det som STÅR, inte det som föreslogs: en avvisad bedömning får inte
          // läcka ut som om den vore appens källa. Står det ett ord vi inte känner igen i kolumnen
          // är det inte en källa — då är svaret `fail-closed`, samma regel som registret följer.
          const currentSource = optionalText(row, 'classification_source');
          return {
            classification: asClassification(current),
            source: CLASSIFICATION_SOURCES.includes(currentSource as ClassificationSource)
              ? (currentSource as ClassificationSource)
              : 'fail-closed',
            raised: false,
          };
        }
        db.run(sql.SET_CLASSIFICATION, { appId, classification: next.classification, source: next.source, now });
        return { ...next, raised: true };
      });
    },

    // ── Granskning ─────────────────────────────────────────────────────────────

    /**
     * Begär granskning av appens senaste gröna utkast. `null` betyder att det redan finns ett
     * väntande ärende — det partiella indexet i databasen är facit, inte en kontroll här.
     *
     * Versionen låses fast NU. Godkännandet publicerar exakt den, inte det som råkar vara senast
     * byggt när granskaren hinner titta.
     */
    requestReview(appId: string, reviewId: string, versionId: string, requestedBy: string, now: string): string | null {
      return db.transaction(() => {
        if (db.get(sql.SELECT_PENDING_REVIEW, { appId }) !== undefined) return null;
        db.run(sql.INSERT_REVIEW, { reviewId, appId, versionId, requestedBy, now });
        return reviewId;
      });
    },

    /** Appens senaste ärende, oavsett läge — det ägaren ser. `null` om hon aldrig begärt något. */
    latestReview(appId: string): { state: string; requestedAt: string; decidedAt: string | null; reason: string | null } | null {
      const row = db.get(sql.SELECT_LATEST_REVIEW_FOR_APP, { appId });
      if (row === undefined) return null;
      return {
        state: text(row, 'state'),
        requestedAt: text(row, 'requested_at'),
        decidedAt: optionalText(row, 'decided_at'),
        reason: optionalText(row, 'reason'),
      };
    },

    review(reviewId: string): StoredReview | null {
      const row = db.get(sql.SELECT_REVIEW, { reviewId });
      return row === undefined ? null : toReview(row);
    },

    /** Källkoden ett ärende gäller. `null` om revisionen är borta — då finns inget att granska. */
    reviewFiles(appId: string, versionId: string): SourceFiles | null {
      const row = db.get(sql.SELECT_REVISION_FILES, { appId, versionId });
      if (row === undefined) return null;
      const parsed: unknown = JSON.parse(text(row, 'files'));
      return parsed as SourceFiles;
    },

    /**
     * Avgör ett ärende. `false` betyder att det inte längre väntade — någon annan hann före, eller
     * ägaren byggde om. Villkoret sitter i satsen, så två granskare kan inte båda avgöra.
     */
    decideReview(reviewId: string, state: string, decidedBy: string, reason: string | null, now: string): boolean {
      return db.run(sql.DECIDE_REVIEW, { reviewId, state, decidedBy, reason, now }).changes > 0;
    },

    listPendingReviews(limit: number): StoredReview[] {
      return db.all(adminSql.LIST_PENDING_REVIEWS, { limit }).map(toReview);
    },

    listRegister(): StoredRegisterRow[] {
      return db.all(adminSql.LIST_REGISTER, {}).map((row) => ({
        appId: text(row, 'app_id'),
        ownerUserId: text(row, 'owner_user_id'),
        name: text(row, 'name'),
        nameIsDefault: integer(row, 'name_is_default') === 1,
        classification: optionalText(row, 'classification'),
        source: optionalText(row, 'classification_source'),
        classifiedAt: optionalText(row, 'classified_at'),
        published: typeof row['published_version'] === 'string',
      }));
    },
  };

  function finishJob(jobId: string, outcome: JobOutcome, now: string): boolean {
    return (
      db.run(sql.FINISH_JOB, {
        jobId,
        status: outcome.status,
        now,
        model: outcome.model ?? null,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
      }).changes === 1
    );
  }

  /**
   * Taket skyddar databasen mot en agent som strömmar tusentals framstegshändelser. Den sista
   * platsen är reserverad för `done`, så att beskedet om hur det gick alltid kommer fram.
   */
  function appendEvent(jobId: string, event: AgentEvent): void {
    const count = integer(db.get(sql.COUNT_JOB_EVENTS, { jobId }) ?? {}, 'antal');
    if (count >= MAX_EVENTS) return;
    if (count >= MAX_EVENTS - 1 && event.type !== 'done') return;
    db.run(sql.INSERT_JOB_EVENT, { jobId, seq: count, event: JSON.stringify(event) });
  }
}

/** Högst så många händelser sparas per jobb. */
export const MAX_EVENTS = 500;

export type Storage = ReturnType<typeof createStorage>;
