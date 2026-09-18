/**
 * Hastighetsbegränsning med glidande fönster, i minnet.
 *
 * I minnet räcker: det finns EN serverprocess (VPS XS), och en omstart som nollställer räknarna
 * ger en angripare högst ett nytt fönster — medan koderna ändå bara gäller i tio minuter och har
 * fem försök var. Nycklarna är HMAC:ar, aldrig adresser eller IP-nummer i klartext.
 *
 * Minnet är begränsat: en nyckel utan händelser inom fönstret tas bort, och växer tabellen ändå
 * över taket sopas hela tabellen från utgångna poster. Hålls den fortfarande full nekas nya
 * nycklar (fail-closed) i stället för att minnet får växa fritt.
 */

export interface RateLimiter {
  /** Räknar en händelse om den ryms. `false` ⇒ gränsen är nådd och inget räknades. */
  tryConsume(key: string, limit: number, now: number): boolean;
  /** Ryms en händelse till? Räknar ingenting. */
  wouldAllow(key: string, limit: number, now: number): boolean;
}

const MAX_KEYS = 50_000;

export function createRateLimiter(windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();

  function prune(key: string, now: number): number[] {
    const list = hits.get(key);
    if (list === undefined) return [];
    const fresh = list.filter((at) => at > now - windowMs);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
    return fresh;
  }

  function sweep(now: number): void {
    for (const key of [...hits.keys()]) prune(key, now);
  }

  return {
    wouldAllow(key, limit, now) {
      return prune(key, now).length < limit;
    },
    tryConsume(key, limit, now) {
      const fresh = prune(key, now);
      if (fresh.length >= limit) return false;
      if (fresh.length === 0) {
        if (hits.size >= MAX_KEYS) sweep(now);
        if (hits.size >= MAX_KEYS) return false;
      }
      hits.set(key, [...fresh, now]);
      return true;
    },
  };
}
