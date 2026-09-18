# language: sv
Egenskap: Varje app har sin egen isolerade datamiljö
  En app ska kunna lagra data, men aldrig se eller röra en annan apps data.
  Vilken app ett anrop hör till avgörs av adressen i webbläsaren — aldrig av
  något som appens kod själv skickar med.

  Bakgrund:
    Givet att appen "bokningar" är publicerad
    Och att appen "enkät" är publicerad
    Och att Anna är inloggad

  Scenario: En app ser bara sina egna dokument
    Givet att Anna har sparat dokumentet {"rum": "Stora salen"} i kollektionen "poster" i appen "bokningar"
    När Anna listar kollektionen "poster" i appen "enkät"
    Så är listan tom

  Scenario: Ett annat app-id i anropets innehåll ändrar ingenting
    Givet att Anna har sparat dokumentet {"rum": "Stora salen"} i kollektionen "poster" i appen "bokningar"
    När Anna listar kollektionen "poster" i appen "enkät" och skickar med app-id för "bokningar" i frågesträngen
    Så är listan tom

  Scenario: Ett förfalskat vidarebefordrat värdnamn ignoreras
    Givet att Anna har sparat dokumentet {"rum": "Stora salen"} i kollektionen "poster" i appen "bokningar"
    När Anna listar kollektionen "poster" i appen "enkät" med huvudet "X-Forwarded-Host" satt till adressen för "bokningar"
    Så är listan tom

  Scenario: Ett dokument-id från en annan app ger inget
    Givet att Anna har sparat dokumentet {"rum": "Stora salen"} i kollektionen "poster" i appen "bokningar"
    När Anna hämtar samma dokument-id i kollektionen "poster" i appen "enkät"
    Så får hon svaret "finns inte"

  Scenario: En adress som inte hör till någon app avvisas
    När Anna öppnar en adress med ett app-id som inte finns
    Så får hon svaret "finns inte"
    Och ingen databas har skapats för det app-id:t

  Scenario: Ett ogiltigt värdnamn avvisas innan något annat händer
    När ett anrop kommer med värdnamnet "../../etc.appar.test"
    Så får anroparen svaret "ogiltig begäran"

  Scenario: Utkast och publicerad version delar aldrig data
    Givet att Anna har sparat dokumentet {"rum": "Stora salen"} i kollektionen "poster" i appen "bokningar"
    När Anna listar kollektionen "poster" i förhandsvisningen av appen "bokningar"
    Så är listan tom
