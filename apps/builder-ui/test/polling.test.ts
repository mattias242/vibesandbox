/**
 * Att följa ett jobb: hämta ungefär varje sekund tills det är klart, backa av vid fel och sluta
 * när det inte längre finns något att följa (401/403/404).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, BuilderJob, BuilderJobStatus } from '@vibesandbox/contracts';
import { ApiError } from '../src/api.ts';
import { followJob, nextPoll, POLL_INTERVAL_MS, MAX_BACKOFF_MS, MAX_CONSECUTIVE_FAILURES } from '../src/polling.ts';

function job(status: BuilderJobStatus, events: AgentEvent[], next: number): BuilderJob {
  return { jobId: 'j', appId: 'a', status, events, next };
}

describe('nextPoll — beslutet efter varje hämtning', () => {
  const start = { after: 0, failures: 0 };

  it('ett pågående jobb hämtas igen om en sekund, från nästa händelse', () => {
    const decision = nextPoll(start, { kind: 'job', job: job('running', [{ type: 'progress', outputChars: 1 }], 1) });
    expect(decision).toEqual({ state: { after: 1, failures: 0 }, next: { type: 'continue', delayMs: POLL_INTERVAL_MS } });
    expect(POLL_INTERVAL_MS).toBe(1000);
  });

  it('done och failed avslutar', () => {
    expect(nextPoll(start, { kind: 'job', job: job('done', [], 3) }).next).toEqual({ type: 'stop', reason: 'done' });
    expect(nextPoll(start, { kind: 'job', job: job('failed', [], 3) }).next).toEqual({ type: 'stop', reason: 'failed' });
  });

  it('401, 403 och 404 avslutar — det finns inget att följa', () => {
    expect(nextPoll(start, { kind: 'error', status: 401 }).next).toEqual({ type: 'stop', reason: 'unauthenticated' });
    expect(nextPoll(start, { kind: 'error', status: 403 }).next).toEqual({ type: 'stop', reason: 'gone' });
    expect(nextPoll(start, { kind: 'error', status: 404 }).next).toEqual({ type: 'stop', reason: 'gone' });
  });

  it('andra fel backar av exponentiellt, med ett tak', () => {
    let state = start;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const decision = nextPoll(state, { kind: 'error', status: i % 2 === 0 ? 500 : 0 });
      state = decision.state;
      if (decision.next.type !== 'continue') throw new Error('borde fortsätta');
      delays.push(decision.next.delayMs);
    }
    expect(delays).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
    expect(MAX_BACKOFF_MS).toBe(15000);
    // after ändras inte av ett fel.
    expect(state.after).toBe(0);
  });

  it('429 backar också av', () => {
    const decision = nextPoll(start, { kind: 'error', status: 429 });
    expect(decision.next).toEqual({ type: 'continue', delayMs: 2000 });
  });

  it('ett lyckat svar nollställer felräkningen', () => {
    const failed = nextPoll(start, { kind: 'error', status: 500 }).state;
    expect(nextPoll(failed, { kind: 'job', job: job('running', [], 0) }).state.failures).toBe(0);
  });

  it('ger upp efter många fel i följd', () => {
    let state = start;
    let last = nextPoll(state, { kind: 'error', status: 503 });
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      state = last.state;
      last = nextPoll(state, { kind: 'error', status: 503 });
    }
    expect(last.next).toEqual({ type: 'stop', reason: 'unreachable' });
  });

  it('ett next som går bakåt eller är skräp flyttar aldrig after bakåt', () => {
    const state = { after: 5, failures: 0 };
    expect(nextPoll(state, { kind: 'job', job: job('running', [], 2) }).state.after).toBe(5);
    expect(nextPoll(state, { kind: 'job', job: job('running', [], Number.NaN) }).state.after).toBe(5);
  });
});

describe('followJob — själva slingan', () => {
  it('samlar händelser i ordning, väntar mellan hämtningarna och slutar vid done', async () => {
    const responses = [
      job('queued', [], 0),
      job('running', [{ type: 'status', message: 'Skriver' }], 1),
      job('running', [{ type: 'progress', outputChars: 100 }, { type: 'files', paths: ['src/App.tsx'] }], 3),
      job('done', [{ type: 'done', ok: true, message: 'Klart' }], 4),
    ];
    const afters: number[] = [];
    const getJob = vi.fn(async (_id: string, after: number) => {
      afters.push(after);
      const response = responses.shift();
      if (response === undefined) throw new Error('för många anrop');
      return response;
    });
    const sleeps: number[] = [];
    const updates: Array<{ status: BuilderJobStatus; count: number }> = [];

    const result = await followJob({
      jobId: 'j',
      getJob,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onUpdate: (update) => updates.push({ status: update.status, count: update.events.length }),
    });

    expect(afters).toEqual([0, 0, 1, 3]);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(result.reason).toBe('done');
    expect(result.events.map((event) => event.type)).toEqual(['status', 'progress', 'files', 'done']);
    expect(updates.at(-1)).toEqual({ status: 'done', count: 4 });
  });

  it('backar av vid serverfel och fortsätter sedan', async () => {
    const getJob = vi
      .fn<(id: string, after: number) => Promise<BuilderJob>>()
      .mockRejectedValueOnce(new ApiError(503, 'Något gick fel'))
      .mockRejectedValueOnce(new ApiError(0, 'Ingen uppkoppling'))
      .mockResolvedValueOnce(job('failed', [{ type: 'done', ok: false, message: 'Gick inte' }], 1));
    const sleeps: number[] = [];
    const result = await followJob({ jobId: 'j', getJob, sleep: async (ms) => void sleeps.push(ms), onUpdate: () => {} });
    expect(sleeps).toEqual([2000, 4000]);
    expect(result.reason).toBe('failed');
  });

  it('slutar direkt vid 404', async () => {
    const getJob = vi.fn().mockRejectedValue(new ApiError(404, 'Finns inte'));
    const sleep = vi.fn(async () => {});
    const result = await followJob({ jobId: 'j', getJob, sleep, onUpdate: () => {} });
    expect(result.reason).toBe('gone');
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('ett oväntat fel som inte är ApiError räknas som ett tillfälligt fel', async () => {
    const getJob = vi
      .fn<(id: string, after: number) => Promise<BuilderJob>>()
      .mockRejectedValueOnce(new Error('konstigt'))
      .mockResolvedValueOnce(job('done', [], 0));
    const result = await followJob({ jobId: 'j', getJob, sleep: async () => {}, onUpdate: () => {} });
    expect(result.reason).toBe('done');
  });

  it('kan avbrytas (t.ex. när användaren byter app)', async () => {
    const controller = new AbortController();
    const getJob = vi.fn(async () => job('running', [], 0));
    const result = await followJob({
      jobId: 'j',
      getJob,
      sleep: async () => {
        controller.abort();
      },
      onUpdate: () => {},
      signal: controller.signal,
    });
    expect(result.reason).toBe('aborted');
    expect(getJob).toHaveBeenCalledTimes(1);
  });
});
