/**
 * Byggverktygets lagring: appar, samtal, revisioner, jobb, händelser, delningar och återkoppling.
 *
 * Varje funktion här är synkron. Uppslag som rör en användares app tar alltid ägaren som
 * parameter, och satserna i sql.ts matchar bara rader som ägs av den — "någon annans app" och
 * "ingen app" ger samma resultat: `null`.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AgentEvent, BuilderJobStatus, BuilderMessage, ConversationEntry, SourceFiles } from '@vibesandbox/contracts';
import type { BuilderDatabase, Row } from './databas.ts';
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

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Kolumnen ${column} är inte ett tal.`);
  return value;
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
        db.run(sql.RENAME_DEFAULT_APP, { appId, name: defaultName });
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
