# ADR 0001: Appar får bara använda godkända paket

Status: **förslag** · 2026-09-18

## Sammanhang

Appar genereras av en AI-modell. Modellen får inte kunna dra in godtyckliga tredjepartspaket:
ett kapat eller illasinnat paket är den enklaste vägen runt plattformens övriga skydd.
Det finns ingen auktoritativ, öppen lista över "säkra" npm-paket att luta sig mot.

## Beslut

1. **Allowlisten är mallens `package.json` och låsfil.** Exakta versioner med integritetshashar.
   Genererad kod kan inte ändra dem, och bygget körs utan nätverk — inget kan hämtas vid byggtid.
   Paket hämtas från npm endast när plattformens byggavbild byggs, med `npm ci --ignore-scripts`.
2. **Importspärr.** En ESLint-regel i `packages/policy` tillåter bara import från godkända
   paketnamn, plattformens SDK, `ui-kit` och relativa sökvägar. Utan den skulle transitiva
   beroenden i `node_modules` kunna importeras direkt.
3. **Paketkatalog som kod:** `packages/app-template/approved-packages.json` anger för varje direkt
   beroende syfte, licens, granskare, datum och motivering. CI stoppar om katalogen och
   `package.json` inte stämmer överens.
4. **Process för nytt paket:** begäran → kontroll mot kriterierna nedan → karenstid → ny
   mallversion → alla appar byggs om på den nya mallen. Ändringen görs som pull request och
   kräver granskning av en andra person.
5. **SBOM per bygge** (CycloneDX) sparas tillsammans med appens version i registret, så att det
   går att svara på "vilka appar innehåller paket X i version Y?".

## Kriterier för ett godkänt paket

- Licens förenlig med EUPL-1.2 (t.ex. MIT, BSD, Apache-2.0, ISC, MPL-2.0).
- Aktivt underhållet; kända sårbarheter åtgärdade.
- Få transitiva beroenden — varje transitivt paket är också attackyta.
- Inga installationsskript. Inga nätanrop som del av normal funktion.
- Fungerar helt i webbläsaren utan externa resurser (inga CDN:er, typsnitt eller kartplattor utifrån).
- **Karenstid:** ingen version yngre än 14 dagar tas in, som skydd mot nyligen kapade paket.

## Underlag vid bedömning

OpenSSF Scorecard, deps.dev, OSV-Scanner, `npm audit`, `npm audit signatures`.
Dessa ger underlag — inte godkännanden. Beslutet fattas av en människa och dokumenteras i katalogen.

## Konsekvenser

- Appar kan inte använda ett bibliotek som inte redan finns i mallen. Det är avsikten; listan
  hålls liten (storleksordningen 10–15 direkta paket) och växer genom granskade beslut.
- Säkerhetsuppdateringar kräver ombyggnad av alla appar, eftersom beroenden bakas in i varje
  apps bundle. Plattformen behöver därför en funktion för det, och mallversion per bygge i registret.
- Möjligt senare steg: egen registerspegel med allowlist, så att inte ens avbildsbygget talar
  direkt med det publika npm-registret.
