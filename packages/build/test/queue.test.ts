import { describe, expect, it } from 'vitest';
import { createSerialQueue } from '../src/queue.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('kön: högst ett bygge åt gången, i tur och ordning', () => {
  it('kör uppgifterna en i taget, i den ordning de kom', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, index) =>
      queue.run(async () => {
        log.push(`start ${index}`);
        await gate.promise;
        log.push(`slut ${index}`);
        return index;
      }),
    );
    await Promise.resolve();
    expect(log).toEqual(['start 0']);
    gates[2]?.resolve();
    gates[1]?.resolve();
    await new Promise((done) => setTimeout(done, 5));
    expect(log).toEqual(['start 0']);
    gates[0]?.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(log).toEqual(['start 0', 'slut 0', 'start 1', 'slut 1', 'start 2', 'slut 2']);
  });

  it('en uppgift som kastar stoppar inte kön', async () => {
    const queue = createSerialQueue();
    const first = queue.run(async () => {
      throw new Error('fel');
    });
    const second = queue.run(async () => 'ok');
    await expect(first).rejects.toThrow('fel');
    await expect(second).resolves.toBe('ok');
  });

  it('en avbruten signal tar bort ett väntande bygge ur kön — det startar aldrig', async () => {
    const queue = createSerialQueue();
    const gate = deferred();
    let secondStarted = false;
    const first = queue.run(() => gate.promise);
    const controller = new AbortController();
    const second = queue.run(async () => {
      secondStarted = true;
    }, controller.signal);
    const third = queue.run(async () => 'tredje');
    expect(queue.pending).toBe(2);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.pending).toBe(1);
    gate.resolve();
    await first;
    await expect(third).resolves.toBe('tredje');
    expect(secondStarted).toBe(false);
  });

  it('en redan avbruten signal startar aldrig', async () => {
    const queue = createSerialQueue();
    let started = false;
    await expect(
      queue.run(async () => {
        started = true;
      }, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
  });

  it('uppgiften får signalen, så att ett pågående bygge kan avbrytas', async () => {
    const queue = createSerialQueue();
    const controller = new AbortController();
    const run = queue.run(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      controller.signal,
    );
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});
