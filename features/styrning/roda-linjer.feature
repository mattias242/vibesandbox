# language: sv
Egenskap: Röda linjer — det plattformen inte bygger, oavsett vem som ber om det
  Den som beskriver en app i vanlig svenska vet sällan var gränsen går. Det är inte hennes jobb
  att veta det: hon har ett problem att lösa, och plattformen finns för att hon ska slippa läsa
  juridik för att lösa det. Men några användningar av AI är förbjudna — poängsättning av
  människor, känsloigenkänning på jobbet, biometrisk identifiering, förutsägelser om vem som ska
  begå brott — och några drar vi vår egen gräns vid, som beslut om en enskilds ärende utan att en
  människa prövar det.

  Därför prövas önskemålet INNAN språkmodellen får se det. Det är hela poängen med var spärren
  sitter: prövas texten efteråt har den redan lämnat servern, och då är det en efterhandskontroll
  i stället för ett skydd. Ingen kod skrivs, inget utkast rörs, ingen modell anropas.

  Beskedet ska läsas som ett beslut, inte som en krasch. Den som möter det har inte gjort något
  tekniskt fel och ska inte tro att hon ska försöka igen om en stund — hon ska förstå att det här
  inte blir någon app, och att hon kan beskriva behovet på ett annat sätt.

  Prövningen är mönsterbaserad och förstår inte sammanhang. Den kan ha fel, och därför lutar den
  åt att släppa igenom hellre än att stoppa fel: ett missat stopp möter ändå plattformens övriga
  skydd och en människa före publicering, medan ett felaktigt stopp lämnar någon nekad utan att
  förstå varför. Ett nekande är inget önskemål — "vi vill inte ha ansiktsigenkänning" är inte en
  beskrivning av ansiktsigenkänning.

  Kontrollrummet visar stoppen, så att en för bred regel upptäcks av den som förvaltar plattformen
  i stället för av en uppgiven användare. Det visar kategorin och tidpunkten — aldrig vad som
  skrevs. Önskemålet kan bära personuppgifter, och ett stopp får inte bli vägen som sparar undan
  just det någon inte borde ha skrivit. Av samma skäl hamnar texten aldrig i en driftlogg.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga

  Scenario: Ett önskemål över en röd linje byggs inte
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "Poängsätt alla elever efter hur de beter sig"
    Så blir det inget nytt utkast
    Och får Anna veta att det här inte är tillåtet, inte att något gick sönder

  Scenario: Språkmodellen får aldrig se ett stoppat önskemål
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "Logga in med ansiktsigenkänning i receptionen"
    Så fick språkmodellen aldrig se önskemålet
    Och blir det inget nytt utkast

  Scenario: Ett stoppat önskemål lämnar ett befintligt utkast orört
    Givet att Anna har en app som byggts klart
    Och att språkmodellen svarar med en giltig app
    När Anna ber om "Systemet ska automatiskt bevilja eller avslå ansökningar om försörjningsstöd"
    Så står appens utkast kvar orört
    Och får Anna veta att det här inte är tillåtet, inte att något gick sönder

  Scenario: Stoppet syns i kontrollrummet med kategori och tidpunkt
    Givet att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app
    Och att Anna har bett om "Poängsätt alla elever efter hur de beter sig"
    När Erik öppnar listan över stoppade önskemål i kontrollrummet
    Så står där ett stopp för "poängsättning av människor"
    Och står det när stoppet skedde
    Och visas bara början av app-id:t vid stoppet

  Scenario: Kontrollrummet visar inte vad som skrevs
    Givet att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app
    Och att Anna har bett om "Poängsätt alla elever efter hur de beter sig, börja med Anna Andersson"
    När Erik öppnar listan över stoppade önskemål i kontrollrummet
    Så nämns inget av önskemålet "Poängsätt alla elever efter hur de beter sig, börja med Anna Andersson" i kontrollrummet

  Scenario: En vanlig app byggs som förut
    Givet att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app
    När Anna ber om "En todo-lista för arbetsgruppen"
    Så blir bygget klart
    Och Anna kan öppna förhandsvisningen av appen
    Och finns det inga stoppade önskemål i kontrollrummet

  Scenario: Den som bara får bygga ser inga stopp
    Givet att Bertil är inloggad i byggverktyget och får bygga
    När Bertil öppnar listan över stoppade önskemål i kontrollrummet
    Så får han svaret "åtkomst nekad"

  Scenario: Ett stopp är inte ett byggfel och syns inte bland dem som ska felsökas
    Givet att Erik är administratör för plattformen
    Och att språkmodellen svarar med kod som skickar data till en extern adress
    Och att Anna har bett om "Ett formulär som mejlar svaren till mig"
    Och att Anna har bett om "Poängsätt alla elever efter hur de beter sig"
    När Erik öppnar kontrollrummet
    Så räknar översikten bara byggfelet, inte stoppet

  Scenario: Önskemålets text hamnar aldrig i driftloggarna
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "Poängsätt alla elever efter hur de beter sig"
    Så har inget av önskemålet "Poängsätt alla elever efter hur de beter sig" hamnat i driftloggarna

  Scenario: Ett nekande är inget önskemål
    Givet att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app
    När Anna ber om "Vi vill inte ha ansiktsigenkänning. Bokning av mötesrum är det vi behöver"
    Så blir bygget klart
    Och finns det inga stoppade önskemål i kontrollrummet
