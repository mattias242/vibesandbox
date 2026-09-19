/**
 * Tjänstens inställningar, ur `SVC_LLM_…`. Ett fel kastas vid start med ett meddelande som säger
 * vilken variabel det gäller och vad den ska vara — plattformen vägrar då att starta.
 */

export interface LlmSettings {
  /** Modellens fullständiga id hos Berget. Konfiguration, inte kod: modeller avvecklas med kort varsel. */
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high';
  /** Tak för hela anropet till språkmodellen, inklusive leverantörens omförsök. */
  readonly timeoutMs: number;
  readonly tokensPerAppDay: number;
  readonly tokensPerUserHour: number;
}

export const DEFAULT_TOKENS_PER_APP_DAY = 200_000;
export const DEFAULT_TOKENS_PER_USER_HOUR = 20_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TOKEN_LIMIT = 1_000_000_000;
const REASONING_EFFORTS: readonly LlmSettings['reasoningEffort'][] = ['low', 'medium', 'high'];

type Env = Readonly<Record<string, string | undefined>>;

/** Bara siffror: `1e6`, `1.5` och `0x10` är skrivfel, inte tal vi ska gissa oss fram till. */
function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} ska vara ett heltal mellan ${min} och ${max}.`);
  }
  return value;
}

export function readSettings(env: Env): LlmSettings {
  const model = env['SVC_LLM_MODEL']?.trim() ?? '';
  if (model === '') {
    throw new Error('Tjänsten llm kräver SVC_LLM_MODEL: språkmodellens fullständiga id hos Berget, t.ex. "zai-org/GLM-5.3-Flash".');
  }
  const effort = env['SVC_LLM_REASONING_EFFORT']?.trim() || 'low';
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error('SVC_LLM_REASONING_EFFORT ska vara low, medium eller high.');
  }
  return {
    model,
    reasoningEffort: effort as LlmSettings['reasoningEffort'],
    timeoutMs: integer(env, 'SVC_LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    tokensPerAppDay: integer(env, 'SVC_LLM_TOKENS_PER_APP_DAY', DEFAULT_TOKENS_PER_APP_DAY, 1, MAX_TOKEN_LIMIT),
    tokensPerUserHour: integer(env, 'SVC_LLM_TOKENS_PER_USER_HOUR', DEFAULT_TOKENS_PER_USER_HOUR, 1, MAX_TOKEN_LIMIT),
  };
}
