/**
 * Manuellt provanrop mot språkmodellen — INTE en del av testerna.
 *
 *   BERGET_API_KEY=… LLM_BASE_URL=<leverantörens bas-URL, med /v1> node packages/llm/scripts/prova.ts
 *
 * Valfritt: LLM_MODEL (fullständigt id), LLM_REASONING_EFFORT (standard low).
 * Nyckeln läses ur miljön och skrivs aldrig ut. Bas-URL:en står inte i koden: repot är publikt
 * och driftens adresser hör hemma i konfigurationen.
 */

import { createMaskingProvider, createOpenAiCompatibleProvider, LlmError } from '../src/index.ts';

const apiKey = process.env['BERGET_API_KEY'] ?? '';
const baseUrl = process.env['LLM_BASE_URL'] ?? '';
if (apiKey === '' || baseUrl === '') {
  console.error('Sätt BERGET_API_KEY och LLM_BASE_URL i miljön först.');
  process.exit(1);
}

const provider = createMaskingProvider(
  createOpenAiCompatibleProvider({
    baseUrl,
    apiKey,
    model: process.env['LLM_MODEL'] ?? 'zai-org/GLM-5.3-Flash',
    reasoningEffort: process.env['LLM_REASONING_EFFORT'] ?? 'low',
    timeoutMs: 60_000,
  }),
);

const started = Date.now();
let first: number | undefined;
let chars = 0;

try {
  const result = await provider.complete({
    messages: [
      {
        role: 'system',
        content:
          'Svara med en kort sammanfattning på svenska, sedan filen hela mellan en rad <vs-file path="src/App.tsx"> och en rad </vs-file>, och sist en rad <vs-done/>. Ingen annan text.',
      },
      { role: 'user', content: 'En React-komponent `export function App()` som visar rubriken "Hej" och en knapp som räknar klick.' },
    ],
    maxTokens: 2000,
    temperature: 0.2,
    onText: (chunk) => {
      first ??= Date.now() - started;
      chars += chunk.length;
    },
  });
  const seconds = (Date.now() - started) / 1000;
  console.log(result.text);
  console.log('---');
  console.log(`modell: ${result.model}`);
  console.log(`slut: ${result.finishReason}, slutmarkör: ${result.text.includes('<vs-done/>') ? 'ja' : 'NEJ'}`);
  console.log(`tid: ${seconds.toFixed(1)} s, första text efter ${((first ?? 0) / 1000).toFixed(1)} s, ${chars} tecken`);
  if (result.usage !== undefined) {
    console.log(`tokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} ut (${(result.usage.outputTokens / seconds).toFixed(0)}/s)`);
  } else {
    console.log('tokens: leverantören angav inga');
  }
} catch (error) {
  // Bara kod och klarspråk — LlmError bär aldrig nyckel, prompt eller svar.
  if (error instanceof LlmError) console.error(`Fel (${error.code}${error.status === undefined ? '' : `, HTTP ${error.status}`}): ${error.message}`);
  else console.error('Oväntat fel.');
  process.exit(1);
}
