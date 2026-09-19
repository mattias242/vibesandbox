# Plattformstjänster för appar

Appar når inte internet. Det en app behöver utöver sin egen kod är **plattformstjänster** under
`/_api/<namn>/…` på appens egen värd. Kontrakten står i `packages/contracts/src/index.ts`
(sök "Plattformstjänster för appar").

## Vad gatewayn redan gjort när tjänsten anropas

Hyresgäst (ur värdnamnet), inloggning, åtkomst till appen (`access`: `owner`/`user`), CSRF för
skrivande metoder, kroppsgräns (`maxBodyBytes`, annars 413). Tjänsten får `tenant`, `identity`
och `access` och litar ALDRIG på app-id eller användar-id i sökväg, fråga eller kropp.
Svarshuvuden: bara `Content-Type`, `Cache-Control`, `Content-Disposition` släpps igenom.
Inga omdirigeringar. Ett kast blir 500 med fast text.

## Var allt ligger (en tjänst = sina egna filer)

| Vad | Fil |
|---|---|
| Tjänsten | `packages/tjanst-<namn>/src/**`, tester i `packages/tjanst-<namn>/test/**` |
| Fabriken | `export const factory: AppServiceFactory` i `packages/tjanst-<namn>/src/index.ts` |
| SDK för appar | `packages/sdk/src/tjanster/<namn>.ts` — anropa bara via `callService` i `./anrop.ts` |
| SDK-tester | `packages/sdk/test/tjanst-<namn>.test.ts` |
| Byggagentens dokumentation | `packages/sdk/tjanster/<namn>.md` — kort, exakt, med exempel; visas bara när tjänsten är påslagen |
| Scenarier (BDD) | `features/tjanster/<namn>.feature`, taggad `@tjanst-<namn>` |
| Steg | `features/steg/tjanster/<namn>.ts`; fejkar registreras med `forberedTjanst` (features/steg/stod/tjanster.ts) |
| Steg flera tjänster behöver | `features/steg/tjanster/gemensamt.ts` — sök alltid (`grep -rn` i features/steg) innan du definierar ett steg; samma text två gånger gör scenariot tvetydigt |

Allt annat är gemensamt och ändras inte av en enskild tjänst: kontrakten, gatewayn, plattformens
uppkoppling (`apps/platform/src/tjanster.ts`), världen och krokarna i `features/steg`.
Behöver en tjänst något av det — skriv det i rapporten.

## Regler

- **Påslagen med flagga:** `APP_SERVICES=files,llm,…`. Avslagen = skapas inte och finns inte (404).
  `main` ska alltid gå att driftsätta.
- **Egna inställningar** läses ur `dependencies.env` med prefixet `SVC_<NAMN>_` (t.ex. `SVC_LLM_MODEL`).
  Saknas något nödvändigt: kasta i fabriken med ett begripligt meddelande på svenska.
- **Egen lagring** i `dependencies.dataDir` (`node:sqlite`, STRICT-tabeller). Allt nycklas på
  `tenant.appId` + `tenant.kind` — en app ser aldrig en annan apps data, och utkast och publicerat
  delar inte data.
- **Kvoter per app** för allt som kostar (lagring, tokens, anrop). Överskriden kvot ⇒ `quota_exceeded`
  eller `rate_limited` med klarspråk.
- **Fel** som `ApiErrorBody` (`{ error: { code, message } }`), koder ur `ApiErrorCode`, statusar ur
  `API_ERROR_STATUS`. Meddelanden är klarspråk på svenska och röjer inga interna detaljer.
- **Loggar** (`dependencies.log`): aldrig e-postadresser, dokument- eller filinnehåll, prompter,
  svar från språkmodellen eller nycklar. App-id förkortas till 8 tecken.
- **Berget** (`dependencies.berget`): OpenAI-kompatibelt. Personuppgifter maskeras innan något
  skickas (`createMaskingProvider` i `@vibesandbox/llm` eller maskningsfunktionerna där).
  Tester använder en fejk — aldrig det riktiga API:t.
- **Fientliga indata** testas: fel typ, överlånga värden, NUL, `../`, fel skiftläge, någon annans id.
- **TDD och BDD:** scenariot först (taggat `@pågår` tills det är grönt), sedan test, sedan kod.
  `npm run check` ska vara grönt.
