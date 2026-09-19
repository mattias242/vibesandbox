/**
 * Jobben: `<dataDir>/transcribe.sqlite` (STRICT) och, medan ett jobb väntar eller pågår, en kopia av
 * ljudet i `<dataDir>/ljud/<jobId>`.
 *
 * Varför en kopia av ljudet? Jobbet ska överleva en omstart, och ljudet går bara att läsa genom
 * `files` med förfrågans `TenantContext` — som bara gatewayn får skapa. Att efter en omstart bygga
 * ett eget vore att kringgå den regeln. Kopian namnges av plattformen (jobb-id:t), är bara läsbar
 * för plattformens konto och tas bort så fort jobbet är klart eller misslyckat.
 *
 * Databasarbetet är synkront (`node:sqlite`): "finns det plats i kön?" följt av "lägg jobbet"
 * görs utan `await` emellan och kan inte flätas ihop med en annan förfrågan.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppId, TenantContext } from '@vibesandbox/contracts';
import type { TranscriptSegment } from './berget.ts';
import type { AudioFormat } from './ljud.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** Våra egna felkoder. Leverantörens text lagras aldrig. */
export type JobFailure = 'provider' | 'timeout' | 'restart' | 'audio_missing';

export const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Så många gånger körs ett jobb som avbrutits av en krasch innan det ges upp. */
export const MAX_ATTEMPTS = 2;

/** Slumpat, 128 bitar: går inte att gissa sig fram till. */
export function newJobId(): string {
  return randomBytes(16).toString('hex');
}

export interface Job {
  readonly jobId: string;
  readonly appId: string;
  readonly kind: string;
  readonly userId: string;
  readonly language: 'sv' | 'en' | undefined;
  readonly format: AudioFormat;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly text: string | undefined;
  readonly segments: readonly TranscriptSegment[] | undefined;
  readonly failure: JobFailure | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('published', 'draft')),
  user_id TEXT NOT NULL,
  language TEXT CHECK (language IN ('sv', 'en')),
  format TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  charged_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  text TEXT,
  segments TEXT,
  failure TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS jobs_app_created ON jobs (app_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at);
`;

type Row = Record<string, unknown>;

function toJob(row: Row): Job {
  const segments = typeof row['segments'] === 'string' ? (JSON.parse(row['segments']) as TranscriptSegment[]) : undefined;
  return {
    jobId: String(row['job_id']),
    appId: String(row['app_id']),
    kind: String(row['kind']),
    userId: String(row['user_id']),
    language: row['language'] === 'sv' || row['language'] === 'en' ? row['language'] : undefined,
    format: row['format'] as AudioFormat,
    status: row['status'] as JobStatus,
    attempts: Number(row['attempts']),
    text: typeof row['text'] === 'string' ? row['text'] : undefined,
    segments,
    failure: typeof row['failure'] === 'string' ? (row['failure'] as JobFailure) : undefined,
  };
}

export interface JobStore {
  create(job: {
    jobId: string;
    tenant: TenantContext;
    userId: string;
    language: 'sv' | 'en' | undefined;
    format: AudioFormat;
    chargedSeconds: number;
    now: number;
  }): void;
  get(tenant: TenantContext, jobId: string): Job | undefined;
  /** Köade och pågående jobb för appen (båda sorterna). */
  pending(appId: AppId): number;
  /** Debiterade sekunder för appen sedan `since` (båda sorterna — det är samma apps kostnad). */
  chargedSince(appId: AppId, since: number): number;
  /** Tar nästa köade jobb som inte redan körs och markerar det som pågående. */
  claimNext(): Job | undefined;
  finish(jobId: string, result: { text: string; segments: readonly TranscriptSegment[]; chargedSeconds: number | undefined }, now: number): void;
  fail(jobId: string, failure: JobFailure, now: number, chargedSeconds?: number): void;
  /** Ett jobb som avbröts för att plattformen stängs: tillbaka i kön, försöket räknas inte. */
  requeue(jobId: string): void;
  /** Vid start: jobb som stod som pågående när processen dog. */
  recover(now: number): { requeued: number; failed: string[] };
  /** Tar bort färdiga jobb äldre än `before`. */
  purge(before: number): number;
  unfinished(): Set<string>;
  close(): void;
}

export function openJobStore(dataDir: string): JobStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'transcribe.sqlite'), { timeout: 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const one = (sql: string, ...params: (string | number | null)[]): Row | undefined =>
    db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).run(...params);

  return {
    create({ jobId, tenant, userId, language, format, chargedSeconds, now }) {
      run(
        `INSERT INTO jobs (job_id, app_id, kind, user_id, language, format, status, charged_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        jobId,
        tenant.appId,
        tenant.kind,
        userId,
        language ?? null,
        format,
        chargedSeconds,
        now,
      );
    },

    get(tenant, jobId) {
      const row = one('SELECT * FROM jobs WHERE job_id = ? AND app_id = ? AND kind = ?', jobId, tenant.appId, tenant.kind);
      return row === undefined ? undefined : toJob(row);
    },

    pending(appId) {
      return Number(one("SELECT COUNT(*) AS n FROM jobs WHERE app_id = ? AND status IN ('queued', 'running')", appId)?.['n'] ?? 0);
    },

    chargedSince(appId, since) {
      return Number(one('SELECT COALESCE(SUM(charged_seconds), 0) AS s FROM jobs WHERE app_id = ? AND created_at >= ?', appId, since)?.['s'] ?? 0);
    },

    claimNext() {
      const row = one("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1");
      if (row === undefined) return undefined;
      run("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE job_id = ?", String(row['job_id']));
      return toJob({ ...row, status: 'running', attempts: Number(row['attempts']) + 1 });
    },

    finish(jobId, result, now) {
      run(
        `UPDATE jobs SET status = 'done', text = ?, segments = ?, finished_at = ?,
           charged_seconds = COALESCE(?, charged_seconds) WHERE job_id = ?`,
        result.text,
        JSON.stringify(result.segments),
        now,
        result.chargedSeconds ?? null,
        jobId,
      );
    },

    fail(jobId, failure, now, chargedSeconds) {
      run(
        `UPDATE jobs SET status = 'failed', failure = ?, finished_at = ?, text = NULL, segments = NULL,
           charged_seconds = COALESCE(?, charged_seconds) WHERE job_id = ?`,
        failure,
        now,
        chargedSeconds ?? null,
        jobId,
      );
    },

    requeue(jobId) {
      run("UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0) WHERE job_id = ? AND status = 'running'", jobId);
    },

    recover(now) {
      const failed = (db.prepare("SELECT job_id FROM jobs WHERE status = 'running' AND attempts >= ?").all(MAX_ATTEMPTS) as Row[]).map(
        (r) => String(r['job_id']),
      );
      for (const jobId of failed) this.fail(jobId, 'restart', now);
      const requeued = run("UPDATE jobs SET status = 'queued' WHERE status = 'running'").changes;
      return { requeued: Number(requeued), failed };
    },

    purge(before) {
      return Number(run("DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < ?", before).changes);
    },

    unfinished() {
      const rows = db.prepare("SELECT job_id FROM jobs WHERE status IN ('queued', 'running')").all() as Row[];
      return new Set(rows.map((r) => String(r['job_id'])));
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}

/** Kopiorna av ljudet. Namnet är alltid ett jobb-id som plattformen skapat. */
export interface AudioStore {
  write(jobId: string, audio: Uint8Array): Promise<void>;
  read(jobId: string): Promise<Uint8Array | undefined>;
  remove(jobId: string): Promise<void>;
  /** Tar bort kopior som inget väntande jobb hör till (t.ex. efter en krasch mitt i en borttagning). */
  removeAllExcept(keep: ReadonlySet<string>): void;
}

export function openAudioStore(dataDir: string): AudioStore {
  const directory = join(dataDir, 'ljud');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = (jobId: string): string => {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error('Ogiltigt jobb-id.');
    return join(directory, jobId);
  };
  return {
    async write(jobId, audio) {
      await writeFile(path(jobId), audio, { mode: 0o600, flag: 'wx' });
    },
    async read(jobId) {
      try {
        return new Uint8Array(await readFile(path(jobId)));
      } catch {
        return undefined;
      }
    },
    async remove(jobId) {
      await rm(path(jobId), { force: true });
    },
    removeAllExcept(keep) {
      for (const name of readdirSync(directory)) {
        if (!keep.has(name)) rmSync(join(directory, name), { force: true, recursive: true });
      }
    },
  };
}
