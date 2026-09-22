# language: sv
Egenskap: Kontrollrummet — insyn i plattformen utan att logga in på servern
  Byggverktyget vilar på att var och en bara ser sitt eget. Det fungerar för den som bygger,
  men lämnar den som ansvarar för plattformen blind: hur många appar finns det, vem äger dem,
  och vad har de kostat? Utan svar på det går det inte att veta om plattformen ska byggas ut,
  städas eller stängas av. I dag hämtas svaren genom att någon SSH:ar in på servern och läser
  databasen — ett handgrepp som kräver full behörighet till allt för att få veta något litet.

  Kontrollrummet är den insynen, i webbläsaren. Den här skivan är ren läsning: den svarar på
  vad som finns, aldrig på vad som står i apparna. Det är en medveten avvägning — att veta att
  en app finns är något helt annat än att komma åt vad någon har skrivit i den.

  Därför gäller två gränser samtidigt. Kontrollrummet kräver mer än att få bygga: bara den som
  förvaltar plattformen kommer in. Och det öppnar ingen dörr in i apparna: åtkomsten till en app
  avgörs av ägarskap och delning, aldrig av en plattformsroll. Den som förvaltar plattformen får
  se att appen finns — inte se in i den.

  Listan bär numera hela app-id:t och två länkar per app: en till arbetsytan där appen byggs, och
  en till appen som den körs. Det är en medveten uppmjukning av en tidigare regel, och den ska
  läsas rätt. Länkarna är genvägar, inte nycklar. Den som förvaltar plattformen bygger också själv
  och får appar delade med sig, och för dem är en lista utan vägar in bara en lista att skriva av
  för hand. För alla andra appar leder länken till samma "finns inte" som en gissad adress hade
  gett. Att känna ett app-id har aldrig varit det som ger åtkomst — det avgörs i varje förfrågan,
  av åtkomstlistan.

  Bakgrund:
    Givet att Anna har byggt en app i byggverktyget
    Och att Bertil har byggt en app i byggverktyget

  Scenario: Administratören ser alla appar, inte bara sina egna
    Givet att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så ser han både Annas och Bertils app, var och en med sin ägare
    Och finns det inga andra appar i listan

  Scenario: Den som bara får bygga ser inget kontrollrum
    När Bertil öppnar kontrollrummet
    Så får han svaret "åtkomst nekad"

  Scenario: Den som bara får titta ser inget kontrollrum
    Givet att Cecilia är inloggad på plattformen
    När Cecilia öppnar kontrollrummet
    Så får hon svaret "åtkomst nekad"

  Scenario: Den som inte är inloggad ser inget kontrollrum
    När någon som inte är inloggad öppnar kontrollrummet
    Så får anroparen svaret "inte inloggad"

  Scenario: Kontrollrummet leder till varje app, både till arbetsytan och till appen som körs
    Givet att Anna har publicerat sin app
    Och att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så står det för varje app en väg till arbetsytan och en till appen som den körs

  Scenario: Översikten räknar appar, publicerade och utkast
    Givet att Anna har publicerat sin app
    Och att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så visar översikten:
      | appar       | 2 |
      | publicerade | 1 |
      | utkast      | 1 |

  Scenario: Översikten och listan är överens om vad apparna kostat
    Givet att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så står det för varje app vad bygget av den kostat i tokens
    Och är översiktens summa lika med apparnas tillsammans

  Scenario: En administratör som inte äger någon app ser ändå alla appar
    Givet att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så är Eriks egen applista i byggverktyget tom
    Och ser han ändå både Annas och Bertils app, var och en med sin ägare

  Scenario: Länken i kontrollrummet är ingen nyckel
    Givet att Anna har publicerat sin app
    Och att Erik är administratör för plattformen
    Och att Erik har sett Annas app i kontrollrummet
    När Erik försöker gå in i Annas app
    Så får han samma svar som för en app som inte finns
    Och kommer Erik inte in i Annas app i byggverktyget heller
    Och står Annas app kvar i Eriks kontrollrum
