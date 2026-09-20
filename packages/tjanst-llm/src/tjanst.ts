/**
 * `POST /_api/llm/complete` — språkmodell för appar via Berget.
 *
 * Gatewayn har redan avgjort app (ur värdnamnet), inloggning, åtkomst och CSRF. Här återstår:
 *
 * 1. Strikt tolkning med gränser (validering.ts). Ett ogiltigt anrop kostar ingenting.
 * 2. Maskning av personuppgifter i ALLA meddelanden, fail-closed. För byggverktyget maskar
 *    `createMaskingProvider` bara rollen `user` och hoppar över `<vs-file>`-block — det vore en
 *    väg förbi maskningen här, där också appens "system"-meddelanden kommer från appen och kan
 *    bära användarens data. Därför maskas allt här först; `createMaskingProvider` ligger kvar
 *    ytterst som ett andra skyddsnät.
 * 3. Kvot: uppskattning reserveras före anropet, faktisk åtgång räknas efter (kvot.ts), och
 *    högst `MAX_CONCURRENT_PER_APP` samtidiga anrop per app, så att en app inte kan ta hela
 *    förbindelsen till språkmodellen.
 * 4. Anropet, med tidsgräns. Leverantörens fel blir 503 med en fast text — leverantörens egen
 *    feltext läses aldrig (se @vibesandbox/llm) och når därför aldrig appen eller loggen.
 * 5. Svaret: nyckeln tas bort om den mot förmodan finns i texten; i JSON-läget måste svaret vara
 *    giltig JSON. Svaret AVMASKAS INTE: maskningen är enkelriktad (platshållare, ingen tabell
 *    tillbaka), och att sätta tillbaka uppgifter i en text som modellen skrivit fritt vore att
 *    gissa var de hör hemma. Appen har själv originalet om den behöver det.
 *
 * Loggar: tokens, modell, app-prefix, användar-id, tid och felkod — aldrig prompter eller svar.
 */
import type {
  ApiErrorCode,
  AppService,
  AppServiceDependencies,
  AppServiceRequest,
  AppServiceResponse,
  ChatMessage,
  CompletionResult,
  LlmProvider,
} from '@vibesandbox/contracts';
import { API_ERROR_STATUS } from '@vibesandbox/contracts';
import { LlmError, createMaskingProvider, createOpenAiCompatibleProvider, maskPersonalData } from '@vibesandbox/llm';
import type { MaskResult } from '@vibesandbox/llm';
import type { LlmSettings } from './installningar.ts';
import { openQuotaLedger } from './kvot.ts';
import type { Reservation } from './kvot.ts';
import { MAX_BODY_BYTES, isJsonContentType, parseCompleteRequest } from './validering.ts';
import type { CompleteRequest } from './validering.ts';

export const SERVICE_NAME = 'llm';
/** Samtidiga anrop per app (och version). VPS:en är liten och Bergets gränser gäller hela plattformen. */
export const MAX_CONCURRENT_PER_APP = 4;

const JSON_INSTRUCTION =
  'Svara ENBART med giltig JSON: ett JSON-objekt eller en JSON-lista. Ingen förklaring, inga kodblock, ' +
  'ingen text före eller efter.';

const MESSAGES = {
  unavailable: 'Språkmodellen svarar inte just nu. Försök igen om en stund.',
  timeout: 'Språkmodellen svarar inte just nu — den tog för lång tid på sig. Försök igen, gärna med en kortare text.',
  notJson: 'Språkmodellens svar gick inte att använda: appen bad om JSON men fick något annat. Försök igen, eller förenkla frågan.',
  masking: 'Texten kunde inte kontrolleras för personuppgifter, så inget skickades till språkmodellen.',
  userHour: 'Du har använt språkmodellen mycket den senaste timmen. Vänta en stund och försök igen.',
  appDay: 'Appen har använt hela sin dagliga kvot för språkmodellen. Försök igen i morgon.',
  busy: 'Språkmodellen är upptagen med andra frågor från appen. Vänta en stund och försök igen.',
  notFound: 'Det finns ingen sådan funktion i tjänsten llm. Använd POST /_api/llm/complete.',
  method: 'Tjänsten llm tar bara emot POST.',
  query: 'Tjänsten llm tar inga parametrar i adressen. Skicka allt i kroppen som JSON.',
  contentType: 'Förfrågan ska skickas som JSON (Content-Type: application/json).',
} as const;

export interface LlmServiceOptions {
  /** Språkmodellen FÖRE maskning — för tester. Standard: Berget via den OpenAI-kompatibla leverantören. */
  readonly provider?: LlmProvider;
  /** För tester: tidsgräns kortare än vad inställningarna tillåter. */
  readonly timeoutMs?: number;
  /** För tester: maskningsfunktionen (t.ex. en som kastar, för att pröva fail-closed). */
  readonly mask?: (text: string) => MaskResult;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

function respond(status: number, body: unknown): AppServiceResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function error(code: ApiErrorCode, message: string, status: number = API_ERROR_STATUS[code]): AppServiceResponse {
  return respond(status, { error: { code, message } });
}

/**
 * Fel från språkmodellen ⇒ 503 `unavailable`: tillfälligt borta, försök igen.
 */
function unavailable(message: string): AppServiceResponse {
  return error('unavailable', message, 503);
}

/** Grov och hellre för hög: svenska ligger kring 3–4 tecken per token. Plus lite per meddelande. */
export function estimateInputTokens(messages: readonly ChatMessage[]): number {
  let tokens = 3;
  for (const m of messages) tokens += 4 + Math.ceil(m.content.length / 3);
  return tokens;
}

/** JSON ur modellens svar. Ett omslutande kodblock (```json … ```) tolereras; allt annat måste vara JSON. */
export function extractJson(text: string): string | null {
  let candidate = text.trim();
  const fence = /^```[a-zA-Z]*[ \t]*\n([\s\S]*)\n[ \t]*```$/.exec(candidate);
  if (fence !== null) candidate = (fence[1] ?? '').trim();
  if (candidate === '') return null;
  try {
    return JSON.stringify(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function createService(deps: AppServiceDependencies, settings: LlmSettings, options: LlmServiceOptions = {}): AppService {
  const berget = deps.berget;
  if (berget === undefined && options.provider === undefined) {
    throw new Error('Tjänsten llm kräver en nyckel till Berget (BERGET_API_KEY), men ingen är inställd på servern.');
  }
  const mask = options.mask ?? maskPersonalData;
  const inner =
    options.provider ??
    createOpenAiCompatibleProvider({
      baseUrl: berget!.baseUrl,
      apiKey: berget!.apiKey,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: options.timeoutMs ?? settings.timeoutMs,
      name: 'berget',
    });
  const provider = createMaskingProvider(inner, { mask });
  const apiKey = berget?.apiKey;
  const ledger = openQuotaLedger(deps.dataDir, settings);
  const inFlight = new Map<string, number>();
  const controllers = new Set<AbortController>();

  function logBase(request: AppServiceRequest): Record<string, string> {
    return { app: request.tenant.appId.slice(0, 8), kind: request.tenant.kind, userId: request.identity.userId };
  }

  /** Nyckeln får aldrig nå appen, inte ens om modellen på något sätt fått den och upprepar den. */
  function redact(text: string): string {
    return apiKey === undefined || apiKey === '' ? text : text.split(apiKey).join('[DOLT]');
  }

  async function complete(request: AppServiceRequest, parsed: CompleteRequest): Promise<AppServiceResponse> {
    // Maskning FÖRE kvoten: ett anrop som inte kan skickas ska inte kosta något.
    let messages: ChatMessage[];
    try {
      messages = parsed.messages.map((m) => ({ role: m.role, content: mask(m.content).text }));
    } catch {
      // Felet släpps: det kan innehålla just den text som skulle maskas.
      deps.log({ level: 'error', event: 'llm_masking_failed', ...logBase(request) });
      return error('internal', MESSAGES.masking);
    }
    if (parsed.format === 'json') messages = [{ role: 'system', content: JSON_INSTRUCTION }, ...messages];

    const estimatedInput = estimateInputTokens(messages);
    const reserved = ledger.reserve(request.tenant, request.identity.userId, estimatedInput + parsed.maxTokens, deps.now());
    if (!reserved.ok) {
      deps.log({ level: 'warn', event: 'llm_quota', ...logBase(request), limit: reserved.limit });
      return error('rate_limited', reserved.limit === 'user-hour' ? MESSAGES.userHour : MESSAGES.appDay);
    }
    const reservation: Reservation = reserved.reservation;

    const controller = new AbortController();
    controllers.add(controller);
    const started = Date.now();
    let result: CompletionResult;
    try {
      result = await provider.complete({ messages, maxTokens: parsed.maxTokens, temperature: parsed.temperature, signal: controller.signal });
    } catch (caught) {
      // Texten skickades (eller kan ha skickats): indata räknas, inte hela uppskattningen.
      const sent = !(caught instanceof LlmError && caught.code === 'masking_failed');
      ledger.settle(reservation, sent ? estimatedInput : 0);
      const code = caught instanceof LlmError ? caught.code : 'unknown';
      // Bara koden loggas — aldrig meddelandet, som i ett okänt fel kan bära vad som helst.
      deps.log({ level: 'warn', event: 'llm_failed', ...logBase(request), code, durationMs: Date.now() - started });
      if (code === 'masking_failed') return error('internal', MESSAGES.masking);
      return unavailable(code === 'timeout' ? MESSAGES.timeout : MESSAGES.unavailable);
    } finally {
      controllers.delete(controller);
    }

    const usage = result.usage ?? { inputTokens: estimatedInput, outputTokens: Math.ceil(result.text.length / 3) };
    ledger.settle(reservation, usage.inputTokens + usage.outputTokens);
    deps.log({
      level: 'info',
      event: 'llm_complete',
      ...logBase(request),
      model: result.model,
      format: parsed.format,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      finishReason: result.finishReason,
      durationMs: Date.now() - started,
    });

    const text = redact(result.text);
    if (parsed.format === 'json') {
      // Ett kapat svar är aldrig komplett JSON, även om det råkar gå att tolka.
      const json = result.finishReason === 'length' ? null : extractJson(text);
      if (json === null) return unavailable(MESSAGES.notJson);
      return respond(200, { text: json, usage });
    }
    return respond(200, { text, usage, ...(result.finishReason === 'length' ? { truncated: true } : {}) });
  }

  return {
    name: SERVICE_NAME,
    maxBodyBytes: MAX_BODY_BYTES,

    async handle(request) {
      if (request.segments.length !== 1 || request.segments[0] !== 'complete') return error('not_found', MESSAGES.notFound);
      if (request.method !== 'POST') return error('method_not_allowed', MESSAGES.method);
      if (request.query !== '') return error('invalid_request', MESSAGES.query);
      if (!isJsonContentType(request.headers['content-type'])) return error('invalid_request', MESSAGES.contentType);
      const parsed = parseCompleteRequest(request.body);
      if (!parsed.ok) return error('invalid_request', parsed.message);

      const key = `${request.tenant.appId}:${request.tenant.kind}`;
      const running = inFlight.get(key) ?? 0;
      if (running >= MAX_CONCURRENT_PER_APP) return error('rate_limited', MESSAGES.busy);
      inFlight.set(key, running + 1);
      try {
        return await complete(request, parsed.request);
      } finally {
        const left = (inFlight.get(key) ?? 1) - 1;
        if (left <= 0) inFlight.delete(key);
        else inFlight.set(key, left);
      }
    },

    async close() {
      // Pågående anrop avbryts, så att plattformen inte väntar på språkmodellen vid avstängning.
      for (const controller of controllers) controller.abort();
      ledger.close();
    },
  };
}
