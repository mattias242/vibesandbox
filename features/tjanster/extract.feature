# language: sv
Egenskap: En app kan hämta texten ur en bifogad fil
  Ett protokoll i Word, ett kalkylblad med ärenden eller en PDF med ett beslut ska kunna bli text
  som appen kan visa, spara och söka i — utan att någon skriver av den för hand. Texten hämtas
  inne i plattformen: filen lämnar aldrig huset och det kostar ingenting hos någon leverantör.
  En inskannad fil är en bild av ett papper och innehåller ingen text att hämta; då hänvisar
  plattformen till textigenkänningen i stället.

  Scenariona som bifogar filer kräver filtjänsten och körs när den finns i samma gren.
  Presentationer (pptx) saknas här: filtjänsten tar ännu inte emot dem vid uppladdning.

  Scenario: Texthämtning kan inte slås på utan filtjänsten
    När plattformen startas med texthämtning men utan filtjänsten
    Så vägrar plattformen starta och förklarar att filtjänsten också måste slås på

  @tjanst-files @tjanst-extract
  Scenario: Texten i ett bifogat Word-dokument hämtas
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat ett Word-dokument i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur dokumentet
    Så får hon texten ur dokumentet, ett stycke per rad

  @tjanst-files @tjanst-extract
  Scenario: Texten i ett bifogat kalkylblad hämtas rad för rad
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat ett kalkylblad i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur kalkylbladet
    Så får hon kalkylbladets rader med en tabb mellan cellerna

  @tjanst-files @tjanst-extract
  Scenario: Samma fil hämtas inte två gånger
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat ett Word-dokument i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur dokumentet två gånger
    Så får hon samma text ur dokumentet båda gångerna

  @tjanst-files @tjanst-extract
  Scenario: En fil från en annan app går inte att hämta text ur
    Givet att appen "Diariet" är publicerad
    Och att appen "Kalendern" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat ett Word-dokument i appen "Kalendern"
    När Anna ber appen "Diariet" hämta texten ur dokumentet
    Så får hon svaret "finns inte"

  @tjanst-files @tjanst-extract
  Scenario: En fil som varken är ett Office-dokument eller en PDF avvisas
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat en anteckning i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur anteckningen
    Så får hon svaret "ogiltig begäran"

  @tjanst-files @tjanst-extract
  Scenario: En inskannad PDF saknar text att hämta och hänvisar vidare
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att Anna har bifogat en inskannad PDF i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur den inskannade filen
    Så får hon veta att filen saknar text att hämta och att den behöver läsas som en bild

  @tjanst-files @tjanst-extract
  Scenario: Appens dagliga gräns för texthämtning
    Givet att appen "Diariet" är publicerad
    Och att Anna är inloggad
    Och att appen "Diariet" redan har hämtat text så många gånger som den får i dag
    Och att Anna har bifogat ett Word-dokument i appen "Diariet"
    När Anna ber appen "Diariet" hämta texten ur dokumentet
    Så får hon veta att gränsen för texthämtning i dag är nådd
