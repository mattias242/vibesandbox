# vibesandbox

En öppen plattform där den som inte är utvecklare kan beskriva ett behov i vanlig svenska
och få ett fungerande litet webbverktyg — och dela det med kollegor via en länk — utan att
verktyget kan skicka information vidare ut på internet.

> **Status: tidig POC.** Ingenting här är redo för skarp drift eller känslig information.

## Idén

Generativ AI gör det möjligt att bygga små, skräddarsydda verktyg på minuter. Det sker redan,
med eller utan stöd. vibesandbox är ett försök att visa hur det kan göras på ett sätt som går
att försvara i offentlig sektor:

- **Två delar:** ett *byggverktyg* (chatta fram en app) och en *driftplattform* (kör och dela den).
- **Appar är ren frontend** byggd från en fast mall. Ingen AI-genererad kod körs på servern.
- **Isolerad miljö per app:** egen adress, egen databas och egen filyta med kvoter.
  En app kan varken se en annan apps data eller plattformens.
- **Apparna kan inte ringa hem:** inga externa anrop tillåts, varken från server eller webbläsare.
- **Koden granskas automatiskt** före publicering; träffar kräver att en människa tittar.
- **Spårbar livscykel:** varje app har ägare, syfte, klassning och gallringsdatum — och kan
  lämnas över, exporteras som körbar källkod och avvecklas med radering.
- **Ingen inlåsning:** "Ladda ner källkod" ger ett projekt som går att köra utan plattformen.
- **Europeisk drift:** kodgenerering via EU-baserad modelleverantör bakom ett utbytbart gränssnitt.

## Arkitektur i korthet

```
webbläsare ─► caddy (wildcard-TLS) ─► platform      en Node-process
                                       ├ gateway     värdnamn → app, inloggning, CSP
                                       ├ data-api    dokument + filer per app, kvoter
                                       ├ control     appar, versioner, delning, register, audit
                                       └ agent/llm   kodgenerering med PII-maskning
                                      build-worker   engångscontainer per bygge, utan nätverk
```

TypeScript-monorepo (npm workspaces): Node + SQLite, React + Vite.
Se `docs/` för hotmodell och arkitekturbeslut (ADR).

## Arbetssätt

Beteendet definieras först som scenarier i `features/` (Gherkin på svenska), därefter tester,
därefter kod. Små commits direkt på `main`; halvfärdigt göms bakom flaggor.

## Licens

[EUPL-1.2](LICENSE) — Europeiska unionens öppna programvarulicens.
