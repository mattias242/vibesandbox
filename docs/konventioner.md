# Konventioner

## Arbetsordning

1. **Scenario först.** Beteendet beskrivs i `features/` på svenska (Gherkin, `# language: sv`)
   i verksamhetens språk — inte i teknikens. Scenarierna definierar "klart".
2. **Test före kod.** Skriv testet, se det falla, gör det grönt, städa.
3. **Små commits på `main`.** Halvfärdigt göms bakom en flagga, inte i en gren.
   `npm run check` ska vara grönt före varje commit.

## Kod

- **TypeScript som Node kör direkt** — inget byggsteg för serverkod. Det innebär:
  bara raderbar syntax (`erasableSyntaxOnly`): inga `enum`, inga parameteregenskaper,
  inga namnrymder. Relativa importer skrivs med `.ts`-ändelse. Typimporter med `import type`.
- **Få beroenden.** Serverkoden använder Nodes standardbibliotek: `node:http`, `node:sqlite`,
  `node:crypto`. Ett nytt beroende kräver en motivering i commit-meddelandet.
- **Inget webbramverk.** Gatewayn är säkerhetskritisk och ska gå att läsa i sin helhet.
- Paket importerar varandra via paketnamn (`@vibesandbox/contracts`), aldrig via relativa
  sökvägar över paketgränser. Allt som korsar en paketgräns beskrivs i `packages/contracts`.
- Kommentarer förklarar *varför*, särskilt vid säkerhetsbeslut. Språk: svenska i kommentarer,
  dokumentation och felmeddelanden till användare; engelska i identifierare.
- Felmeddelanden som når en användare är klarspråk på svenska och röjer inga interna detaljer.

## Säkerhetsregler som inte får brytas

- `TenantContext` skapas **endast** i `packages/gateway`, ur ett strikt validerat `Host`-huvud.
  Inget annat paket importerar `unsafeCreateTenantContext`.
- Inget i en förfrågans sökväg, fråga eller kropp får avgöra vilken app den hör till.
- Osäkerhet ⇒ neka. Saknad eller ogiltig inloggning ger 401, aldrig ett gissat standardvärde.
- Data från en app används aldrig för att bygga en filsökväg. Filer och databaser namnges av
  plattformen.
- Driftloggar innehåller aldrig e-postadresser, dokumentinnehåll eller sessionsvärden.
- Testinloggningen (`test`-leverantören) vägrar starta när `NODE_ENV=production`.

## Tester

- Enhetstester: `packages/<paket>/test/**/*.test.ts` med vitest.
- Varje test som rör disk använder en egen temporär katalog (`fs.mkdtemp`) och städar efter sig.
- Säkerhetsegenskaper testas med **fientliga indata**, inte bara med den lyckliga vägen:
  `../`, NUL-byte, överlånga värden, fel teckenkodning, dubbla huvuden, förfalskade huvuden.
