# language: sv
Egenskap: En app kan läsa texten i en uppladdad bild eller PDF
  Ett kvitto, en skannad blankett eller ett foto av en whiteboard ska kunna bli text som appen
  kan spara och söka i. Appen laddar upp filen med filtjänsten och ber plattformen läsa den.
  Bilden skickas till plattformens godkända svenska personuppgiftsbiträde (Berget); den kan inte
  maskeras innan, så det ska vara tydligt för den som bygger appen. Läsningen kostar pengar,
  så varje app har en daglig gräns och samma fil läses inte två gånger.

  Scenariona som laddar upp filer kräver filtjänsten och körs när den finns i samma gren.

  @pågår
  Scenario: Textigenkänning kan inte slås på utan filtjänsten
    När plattformen startas med textigenkänning men utan filtjänsten
    Så vägrar plattformen starta och förklarar att båda måste slås på

  @tjanst-files @tjanst-ocr @pågår
  Scenario: Texten i ett uppladdat kvitto läses
    Givet att appen "Utlägg" är publicerad
    Och att Anna är inloggad
    Och att Anna har laddat upp en bild av ett kvitto i appen "Utlägg"
    När Anna ber appen "Utlägg" läsa texten i kvittot
    Så får hon texten som står på kvittot

  @tjanst-files @tjanst-ocr @pågår
  Scenario: Samma fil läses bara en gång
    Givet att appen "Utlägg" är publicerad
    Och att Anna är inloggad
    Och att Anna har laddat upp en bild av ett kvitto i appen "Utlägg"
    När Anna ber appen "Utlägg" läsa texten i kvittot två gånger
    Så får hon samma text båda gångerna
    Och har bilden bara skickats för textigenkänning en gång

  @tjanst-files @tjanst-ocr @pågår
  Scenario: En fil från en annan app går inte att läsa
    Givet att appen "Utlägg" är publicerad
    Och att appen "Kalendern" är publicerad
    Och att Anna är inloggad
    Och att Anna har laddat upp en bild av ett kvitto i appen "Kalendern"
    När Anna ber appen "Utlägg" läsa texten i kvittot
    Så får hon svaret "finns inte"
    Och har ingen bild skickats för textigenkänning

  @tjanst-files @tjanst-ocr @pågår
  Scenario: En fil som inte är en bild eller PDF avvisas
    Givet att appen "Utlägg" är publicerad
    Och att Anna är inloggad
    Och att Anna har laddat upp en textfil i appen "Utlägg"
    När Anna ber appen "Utlägg" läsa texten i textfilen
    Så får hon svaret "ogiltig begäran"
    Och har ingen bild skickats för textigenkänning

  @tjanst-files @tjanst-ocr @pågår
  Scenario: Ett fel hos Berget blir ett begripligt besked utan interna detaljer
    Givet att appen "Utlägg" är publicerad
    Och att Anna är inloggad
    Och att Anna har laddat upp en bild av ett kvitto i appen "Utlägg"
    Och att textigenkänningen hos Berget är ur funktion
    När Anna ber appen "Utlägg" läsa texten i kvittot
    Så får hon veta att textigenkänningen inte är tillgänglig just nu
    Och innehåller svaret inget av det Berget svarade

  @tjanst-files @tjanst-ocr @pågår
  Scenario: Appens dagliga gräns för textigenkänning
    Givet att appen "Utlägg" är publicerad
    Och att Anna är inloggad
    Och att appen "Utlägg" redan har läst så många sidor som den får i dag
    Och att Anna har laddat upp en bild av ett kvitto i appen "Utlägg"
    När Anna ber appen "Utlägg" läsa texten i kvittot
    Så får hon veta att gränsen för i dag är nådd
    Och har ingen bild skickats för textigenkänning
