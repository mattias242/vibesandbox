## `llm` — språkmodell

Appen kan be plattformens språkmodell om en text: sammanfatta, skriva om i klarspråk,
klassificera. Allt går genom plattformen — appen anropar aldrig någon modell själv.

```ts
import { llm, SdkError } from '@vibesandbox/sdk';

llm.complete(input: string | LlmMessage[], options?: LlmOptions): Promise<string>
llm.completeJson<T>(input: string | LlmMessage[], options?: LlmOptions): Promise<T>

interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface LlmOptions {
  maxTokens?: number;    // 1–4000, standard 1000. Sätt lågt för korta svar.
  temperature?: number;  // 0–2, standard 0.2. Håll lågt för sakliga svar.
}
```

En text blir användarens meddelande. Med en lista styr du själv: lägg instruktionen i `system`
och användarens text i `user`. Ingen strömning — svaret kommer när det är klart (upp till en
minut). `completeJson` ber om JSON och tolkar svaret; beskriv formen i instruktionen och
kontrollera värdet innan du använder det.

### Exempel

```ts
// Sammanfatta ett ärende
const sammanfattning = await llm.complete([
  { role: 'system', content: 'Sammanfatta ärendet i högst tre meningar på svenska.' },
  { role: 'user', content: arende.beskrivning },
], { maxTokens: 300 });

// Klarspråka en text
const klarsprak = await llm.complete([
  { role: 'system', content: 'Skriv om texten i klarspråk: korta meningar, vardagliga ord, du-tilltal. Behåll allt sakinnehåll.' },
  { role: 'user', content: text },
]);

// Klassificera
const svar = await llm.completeJson<{ kategori: string }>([
  { role: 'system', content: 'Välj en kategori för ärendet: "belysning", "gata", "park" eller "övrigt". Svara med {"kategori": "..."}.' },
  { role: 'user', content: arende.beskrivning },
], { maxTokens: 50, temperature: 0 });
const kategori = ['belysning', 'gata', 'park'].includes(svar.kategori) ? svar.kategori : 'övrigt';
```

### Gör så här

- **Visa alltid att texten är maskingenererad**, t.ex. "Förslag från språkmodell — granska innan
  du använder det". Spara aldrig ett svar som om en människa skrivit det.
- **Låt användaren granska och ändra** svaret innan det sparas eller skickas vidare. Gör det till
  ett förslag i ett redigerbart fält, aldrig ett automatiskt beslut.
- **Skicka inte mer än nödvändigt**: bara den text som behövs för uppgiften, inte hela
  kollektioner eller andra användares data.
- **Personuppgifter maskeras** innan något lämnar servern: personnummer, telefonnummer,
  e-postadresser, kortnummer och IBAN ersätts med platshållare som `[PERSONNUMMER]`, och svaret
  innehåller samma platshållare (de byts inte tillbaka). Namn och adresser maskeras INTE.
- Visa ett tydligt läge medan appen väntar (knappen inaktiv, "Språkmodellen skriver …").

### Fel (`SdkError`, visa `message` för användaren)

| `code` | När |
|---|---|
| `rate_limited` | Användarens timkvot, appens dygnskvot eller för många samtidiga frågor. Försök igen senare. |
| `internal` | Språkmodellen svarar inte just nu, eller svaret gick inte att använda (t.ex. inte JSON). |
| `invalid_request` | Tom text, fel roll, för lång text (högst 40 000 tecken totalt, 50 meddelanden). |
| `too_large` | Förfrågan är alldeles för stor. Skicka mindre text. |
