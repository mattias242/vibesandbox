/**
 * Gränser för ett bygge. Standardvärdena är satta för driftservern: en VPS med 2 vCPU och 4 GB
 * minne, där plattformen, databasen och ett bygge åt gången ska få plats samtidigt.
 * Mätt 2026-09-19: startappen bygger på ~1–3 s och tar långt under 512 MB (se README).
 */
export interface BuildLimits {
  /** Hela bygget (typkontroll + Vite). Överskridet ⇒ processerna dödas och bygget misslyckas. */
  readonly timeoutMs: number;
  /** Tak för den byggda katalogen, i byte. */
  readonly maxOutputBytes: number;
  /** Minne för containern (docker) respektive Nodes heap (local/spool). */
  readonly memoryMb: number;
  /** CPU-andel för containern (docker). */
  readonly cpus: number;
  /** Högsta antal processer/trådar i containern (docker). tsc (Go) och rolldown använder trådar. */
  readonly pidsLimit: number;
  /** Storlek på /work (tmpfs) i containern: mallens filer, appens kod och dist/. */
  readonly workTmpfsMb: number;
  /** Storlek på /tmp (tmpfs) i containern. */
  readonly tmpTmpfsMb: number;
}

export const DEFAULT_LIMITS: BuildLimits = {
  timeoutMs: 120_000,
  maxOutputBytes: 5 * 1024 * 1024,
  memoryMb: 1536,
  cpus: 1.5,
  pidsLimit: 256,
  workTmpfsMb: 256,
  tmpTmpfsMb: 64,
};

export function resolveLimits(limits: Partial<BuildLimits> | undefined): BuildLimits {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Ogiltig byggräns ${name}: ${String(value)}`);
    }
  }
  return merged;
}
