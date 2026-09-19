/**
 * Att följa ett jobb. Beslutet efter varje hämtning (`nextPoll`) är en ren funktion så att den
 * går att testa; `followJob` är slingan runt den, med väntan och avbrott injicerade.
 */
import type { AgentEvent, BuilderJob, BuilderJobStatus } from '@vibesandbox/contracts';
import { ApiError } from './api.ts';

export const POLL_INTERVAL_MS = 1000;
export const MAX_BACKOFF_MS = 15_000;
/** Ungefär en och en halv minut utan kontakt: då är det bättre att säga det än att tyst vänta. */
export const MAX_CONSECUTIVE_FAILURES = 10;

export interface PollState {
  readonly after: number;
  readonly failures: number;
}

export type StopReason = 'done' | 'failed' | 'unauthenticated' | 'gone' | 'unreachable' | 'aborted';

export type PollOutcome = { readonly kind: 'job'; readonly job: BuilderJob } | { readonly kind: 'error'; readonly status: number };

export interface PollDecision {
  readonly state: PollState;
  readonly next: { readonly type: 'continue'; readonly delayMs: number } | { readonly type: 'stop'; readonly reason: StopReason };
}

export function nextPoll(state: PollState, outcome: PollOutcome): PollDecision {
  if (outcome.kind === 'job') {
    const { job } = outcome;
    const after = Number.isSafeInteger(job.next) && job.next > state.after ? job.next : state.after;
    const nextState = { after, failures: 0 };
    if (job.status === 'done' || job.status === 'failed') return { state: nextState, next: { type: 'stop', reason: job.status } };
    return { state: nextState, next: { type: 'continue', delayMs: POLL_INTERVAL_MS } };
  }

  if (outcome.status === 401) return { state, next: { type: 'stop', reason: 'unauthenticated' } };
  // 403/404: jobbet finns inte (längre) för den här användaren. Att fråga igen ändrar inget.
  if (outcome.status === 403 || outcome.status === 404) return { state, next: { type: 'stop', reason: 'gone' } };

  const failures = state.failures + 1;
  const nextState = { after: state.after, failures };
  if (failures >= MAX_CONSECUTIVE_FAILURES) return { state: nextState, next: { type: 'stop', reason: 'unreachable' } };
  const delayMs = Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** failures);
  return { state: nextState, next: { type: 'continue', delayMs } };
}

export interface JobUpdate {
  readonly status: BuilderJobStatus;
  /** Alla händelser hittills, i ordning. */
  readonly events: readonly AgentEvent[];
}

export interface FollowJobOptions {
  readonly jobId: string;
  readonly getJob: (jobId: string, after: number) => Promise<BuilderJob>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onUpdate: (update: JobUpdate) => void;
  readonly signal?: AbortSignal;
}

export interface FollowJobResult {
  readonly reason: StopReason;
  readonly status: BuilderJobStatus | undefined;
  readonly events: readonly AgentEvent[];
}

export async function followJob(options: FollowJobOptions): Promise<FollowJobResult> {
  const events: AgentEvent[] = [];
  let status: BuilderJobStatus | undefined;
  let state: PollState = { after: 0, failures: 0 };
  const aborted = () => options.signal?.aborted === true;

  for (;;) {
    if (aborted()) return { reason: 'aborted', status, events };

    let outcome: PollOutcome;
    try {
      const job = await options.getJob(options.jobId, state.after);
      outcome = { kind: 'job', job };
    } catch (error) {
      outcome = { kind: 'error', status: error instanceof ApiError ? error.status : 0 };
    }
    if (aborted()) return { reason: 'aborted', status, events };

    if (outcome.kind === 'job') {
      // Bara händelser som är nya för oss: servern skickar från index `after`.
      events.push(...outcome.job.events);
      status = outcome.job.status;
      options.onUpdate({ status, events: [...events] });
    }

    const decision = nextPoll(state, outcome);
    state = decision.state;
    if (decision.next.type === 'stop') return { reason: decision.next.reason, status, events };
    await options.sleep(decision.next.delayMs);
  }
}
