# @vibesandbox/llm

Språkmodellsleverantörer för byggverktyget, och maskning av personuppgifter innan något lämnar
servern. Inga körtidsberoenden. Gränssnittet (`LlmProvider`, `CompletionRequest`,
`CompletionResult`) finns i `@vibesandbox/contracts`.

```ts
import { createMaskingProvider, createOpenAiCompatibleProvider } from '@vibesandbox/llm';

const provider = createMaskingProvider(
  createOpenAiCompatibleProvider({
    baseUrl: config.llmBaseUrl,        // t.ex. "https://<leverantör>/v1"
    apiKey: config.llmApiKey,          // ur miljön, aldrig i koden
    model: config.llmModel,            // FULLSTÄNDIGT id, t.ex. "zai-org/GLM-5.3-Flash"
    reasoningEffort: 'low',
    timeoutMs: 120_000,
  }),
);
```

Lägg **alltid** `createMaskingProvider` ytterst. Det är den som gör att användarens text maskas
innan den skickas.

## Vad som maskas

`maskPersonalData(text)` ersätter uppgifter med en bestämd form:

| Uppgift | Känns igen | Ersätts med |
|---|---|---|
| Personnummer | 10 eller 12 siffror med giltigt datum. Med `-`/`+` (`ÅÅMMDD-NNNN`) maskas det alltid; utan skiljetecken bara om kontrollsiffran (Luhn) stämmer | `[PERSONNUMMER]` |
| Samordningsnummer | som personnummer, men dagen plus 60 | `[PERSONNUMMER]` |
| Telefonnummer | svenska: `+46`, `0046` eller `0`, mobil och fast, med eller utan blanksteg och bindestreck | `[TELEFON]` |
| E-postadress | `namn@domän.tld` | `[E-POST]` |
| Kortnummer | 13–19 siffror, giltig Luhn | `[KORTNUMMER]` |
| IBAN | landskod, kontrollsiffror, giltig mod-97 | `[IBAN]` |

Fel kontrollsiffra ⇒ inte maskat, för kort, IBAN och personnummer skrivna som en obruten
sifferföljd: tio siffror i rad är ofta något annat (ett ärendenummer), och att maska allt som
liknar ett nummer skulle göra vanliga tal oläsliga för modellen. **Undantag:** formen
`ÅÅMMDD-NNNN` med giltigt datum maskas även med fel kontrollsiffra. Den formen är entydigt ett
personnummer — ofta felskrivet eller påhittat i ett exempel (`900101-1234` klarar inte Luhn),
men ändå något användaren menade som ett personnummer.

**Hellre för mycket än för lite.** Ett ordernummer som råkar klara Luhn-kontrollen maskas som
kortnummer. Det är rätt håll att fela åt: en platshållare för mycket kostar lite (modellen ser
`[KORTNUMMER]` i stället för ett ordernummer), medan en personuppgift som väl skickats iväg inte
går att ta tillbaka.

## Vad som INTE maskas

- **Namn.** "Anna Andersson" maskas inte. Namn har ingen form som går att känna igen säkert, och
  en lista över förnamn skulle både missa och förstöra vanliga ord. Användaren ska inte skriva in
  riktiga personers uppgifter i sina önskemål; byggverktyget säger det, och maskningen är ett
  skyddsnät, inte en garanti.
- Adresser, fritext om personer, hälsouppgifter och liknande.
- **Systemprompten** — plattformens egen text.
- **Källkod i fil-block**: rader mellan en ensam `<vs-file path="…">`-rad och en ensam
  `</vs-file>`-rad. Koden har modellen själv skrivit utifrån redan maskad text, och maskning skulle
  förstöra den. Ett block som aldrig stängs maskas som vanlig text. Den som bygger meddelandet
  (agenten) ser till att användarens egen text aldrig kan innehålla sådana rader.

`createMaskingProvider` är **fail-closed**: kastar maskningen skickas ingenting, och felet blir
`LlmError` med koden `masking_failed`.

## Leverantörer

### `createOpenAiCompatibleProvider(options)`

För API:er som följer OpenAI:s `POST /chat/completions` med strömning (SSE), t.ex. vLLM-baserade
tjänster.

| Inställning | Betydelse |
|---|---|
| `baseUrl` | Bas-URL utan `/chat/completions`. |
| `apiKey` | Skickas som `Authorization: Bearer …`. Syns aldrig i fel eller loggar. |
| `model` | Modellens fullständiga id. Konfiguration: modeller avvecklas med några veckors varsel. |
| `reasoningEffort` | `low`/`medium`/`high`. Sätt den — leverantörens standard är ofta högsta, och `max_tokens` delas mellan tankar och svar. |
| `timeoutMs` | Tak för hela anropet, inklusive strömmen. |
| `fetch` | Valfri, för tester. |

Beteende:

- Bara `choices[0].delta.content` används. Tankefälten (`reasoning_content`, `reasoning`) läses
  aldrig, och `<think>…</think>` skalas bort ur texten.
- `finish_reason` blir `stop`, `length` eller `other`. `length` betyder att svaret kapades — det
  får aldrig tolkas som komplett.
- Vid 429, 502, 503 och 504 (och nätverksfel före svaret) görs högst två nya försök, med
  `Retry-After` om den finns (tak 10 s). **Aldrig** efter att strömmen har börjat.
- Fel blir `LlmError` med en kod (`auth`, `rate_limited`, `unavailable`, `bad_request`,
  `bad_response`, `network`, `timeout`, `aborted`, …) och ett fast meddelande på svenska.
  Leverantörens felkropp läses aldrig och `cause` sätts aldrig — de kan eka prompten.

### `createFakeProvider(script)`

Inspelad språkmodell för tester och scenarier. Svarar med texterna i tur och ordning (sträng,
eller `{ text, finishReason?, usage? }`, ett `Error` att kasta, eller `{ hang: true }` som väntar
på avbrott), strömmar dem i bitar via `onText` och sparar varje förfrågan i `requests`.

## Byta leverantör

1. Är den nya leverantören OpenAI-kompatibel: byt `baseUrl`, `apiKey` och `model` i
   konfigurationen. Ingen kodändring.
2. Annars: skriv en ny funktion som returnerar en `LlmProvider` (`name` och `complete`). Den ska
   strömma via `onText`, ge `finishReason` ärligt och kasta `LlmError` utan känsligt innehåll.
   Lägg den innanför `createMaskingProvider`.

## Provanrop

`scripts/prova.ts` gör ett manuellt anrop och skriver ut svar, tid och tokens. Det ingår inte i
testerna och kräver en riktig nyckel:

```sh
BERGET_API_KEY=… LLM_BASE_URL=https://<leverantör>/v1 node packages/llm/scripts/prova.ts
```
