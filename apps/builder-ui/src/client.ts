/**
 * Den enda API-klienten i webbläsaren, och små hjälpare som rör fönstret.
 */
import { ApiError, createApiClient } from './api.ts';

let reloading = false;

export const api = createApiClient({
  fetch: (input, init) => window.fetch(input, init),
  // Utan giltig inloggning skickar gatewayn webbläsaren till inloggningssidan när sidan laddas
  // om. Flera samtidiga 401 ska bara ge en omladdning.
  onUnauthenticated: () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  },
});

/** Väntan som avbryts direkt när signalen avbryts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Något gick fel. Försök igen om en stund.';
}

/** Ett meddelande som ska visas i nästa vy (t.ex. att det första önskemålet inte gick iväg). */
export const sessionFlash = new Map<string, string>();
