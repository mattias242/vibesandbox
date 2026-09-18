# language: sv
Egenskap: En app kan inte ta mer än sin del av servern
  Alla appar delar på en liten server. En app som växer okontrollerat — av misstag eller
  med flit — ska bara drabba sig själv.

  Bakgrund:
    Givet att appen "bokningar" är publicerad
    Och att appen "enkät" är publicerad
    Och att Anna är inloggad

  Scenario: Ett för stort dokument avvisas
    När Anna sparar ett dokument på 300 kB i appen "bokningar"
    Så får hon svaret "för stort"

  Scenario: En full app kan inte skriva mer, men de andra märker ingenting
    Givet att appen "bokningar" har nått sin lagringsgräns
    När Anna sparar ett dokument i appen "bokningar"
    Så får hon svaret "lagringsutrymmet är slut"
    Och Anna kan fortfarande spara ett dokument i appen "enkät"

  Scenario: En full app går fortfarande att läsa och städa i
    Givet att appen "bokningar" har nått sin lagringsgräns
    När Anna raderar ett dokument i appen "bokningar"
    Så lyckas raderingen

  Scenario: Långa listor delas upp i sidor
    Givet att appen "bokningar" innehåller 250 dokument i kollektionen "poster"
    När Anna listar kollektionen "poster" i appen "bokningar"
    Så får hon högst 100 dokument och en markör till nästa sida

  Scenario: Ogiltiga kollektionsnamn avvisas
    När Anna sparar ett dokument i kollektionen "../hemligt" i appen "bokningar"
    Så får hon svaret "ogiltig begäran"
