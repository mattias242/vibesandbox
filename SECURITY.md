# Säkerhet

vibesandbox finns till för att köra AI-genererade verktyg på ett säkert sätt. Brister i
isoleringen är därför de allvarligaste fel projektet kan ha, och rapporter om dem är välkomna.

## Rapportera en sårbarhet

Använd **GitHubs privata sårbarhetsrapportering** (fliken *Security* → *Report a vulnerability*).
Öppna inte en publik issue för säkerhetsproblem.

Beskriv gärna vad som går att göra, hur det återskapas och vilken version (commit) det gäller.
Du får svar så snart som möjligt, normalt inom en vecka.

## Vad som räknas som allvarligt

- En app som kan läsa eller skriva en annan apps data eller filer.
- En app (server- eller webbläsarsida) som kan skicka information till en extern adress.
- Kod som körs under bygget och når nätverket eller filer utanför sin arbetskatalog.
- Förbigången inloggning, delning eller granskning före publicering.
- Personuppgifter som når modelleverantören omaskerade.

## Status

Projektet är en tidig POC och ska inte användas för känslig information.
