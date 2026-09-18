# ADR 0002: En domän med slumpade subdomäner

Status: **beslutat** · 2026-09-18

## Sammanhang

Varje app behöver en egen origin så att webbläsaren håller isär apparnas data, och appens
adress är samtidigt den hemliga delningslänken (26 tecken, 130 bitar slump). Frågan är om
apparna måste ligga på en annan registrerbar domän än byggverktyget — mönstret
"google.com / googleusercontent.com" — eller om allt kan ligga under en domän.

Förhandsvisningar av ogranskade utkast MÅSTE ligga på samma site som byggverktyget: en iframe
från en annan site får inte behålla sina kakor i Safari och Firefox. Opålitlig kod körs alltså
redan same-site med byggverktyget, och skydden för det behövs under alla omständigheter.

## Beslut

Allt ligger under en domän, en subdomännivå, ett wildcard-certifikat (`*.example.org`):

| Värdnamn | Innehåll |
|---|---|
| `bygg.example.org` | byggverktyget |
| `login.example.org` | inloggning med engångskod |
| `<id>.example.org` | plattformsägt skal för en publicerad app |
| `<id>--c.example.org` | appens innehåll, inramat av skalet |
| `p-<id>.example.org` | förhandsvisning av utkast |

Reserverade namn kan inte krocka med ett app-id, som alltid är exakt 26 tecken.
Koden behåller `BASE_DOMAIN` och `APP_DOMAIN` som separata inställningar, så att apparna kan
flyttas till en egen domän senare utan kodändring.

## Villkor som gör beslutet säkert

1. **Plattformen sätter och läser ENBART `__Host-`-kakor.** Webbläsaren vägrar `Domain=` på dem,
   så en app kan varken läsa, skriva över eller plantera en annan värds sessionskaka.
   Plattformen sätter aldrig en kaka med `Domain=`.
2. **Byggverktygets API litar aldrig på `SameSite`** (alla subdomäner är same-site). Varje
   skrivande anrop kräver rätt `Origin` och plattformens eget huvud.
3. **Appars CSP** (`connect-src 'self'`, `form-action 'self'`) hindrar appkod från att rikta
   anrop mot byggverktyget eller andra appar.
4. **Gatewayn ignorerar kakor den inte känner igen** och begränsar storleken på inkommande huvuden.

## Kända restrisker

- **Kakbombning:** appkod kan sätta stora kakor med `Domain=example.org` så att andra värdar
  svarar med fel tills kakorna rensas. Det är en driftstörning, inte en läcka, och kräver kod
  som passerat skanning och granskning. Hållbar åtgärd: registrera domänen i Public Suffix List,
  så att varje subdomän blir en egen site.
- **Rykte:** flaggas en enda app av webbläsarnas skyddslistor drabbas hela domänen.
- **Processisolering** i webbläsare sker per site, inte per origin.

Växer användningen utanför en pilot bör apparna flyttas till en egen domän eller domänen
PSL-registreras.
