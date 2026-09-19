/**
 * Högst ETT bygge åt gången, i den ordning de kom (FIFO). Servern har 2 vCPU och 4 GB;
 * två parallella byggen skulle konkurrera om minnet och göra båda långsamma.
 */

export interface SerialQueue {
  /** Kör `task` när det är dess tur. En avbruten signal tar bort en väntande uppgift ur kön. */
  run<T>(task: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Antal uppgifter som väntar (inte den som körs). */
  readonly pending: number;
}

interface Waiting {
  readonly start: () => void;
}

export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Avbrutet', 'AbortError');
}

export function createSerialQueue(): SerialQueue {
  const waiting: Waiting[] = [];
  let busy = false;

  function next(): void {
    const item = waiting.shift();
    if (item === undefined) {
      busy = false;
      return;
    }
    item.start();
  }

  return {
    get pending() {
      return waiting.length;
    },

    run<T>(task: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted === true) return Promise.reject(abortError(signal));
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          const index = waiting.indexOf(item);
          if (index >= 0) {
            waiting.splice(index, 1);
            reject(abortError(signal as AbortSignal));
          }
        };
        const item: Waiting = {
          start: () => {
            signal?.removeEventListener('abort', onAbort);
            busy = true;
            task(signal).then(resolve, reject).finally(next);
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (busy) waiting.push(item);
        else item.start();
      });
    },
  };
}
