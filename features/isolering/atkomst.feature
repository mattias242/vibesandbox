# language: sv
Egenskap: Ingen kommer åt en app utan att vara inloggad
  Den hemliga länken räcker inte ensam. Den som öppnar en app måste också vara
  inloggad. Är plattformen osäker på vem någon är, nekar den.

  Bakgrund:
    Givet att appen "bokningar" är publicerad

  Scenario: Anrop utan inloggning nekas
    När någon som inte är inloggad listar kollektionen "poster" i appen "bokningar"
    Så får anroparen svaret "inte inloggad"

  Scenario: En manipulerad inloggning nekas
    När någon med en manipulerad inloggning listar kollektionen "poster" i appen "bokningar"
    Så får anroparen svaret "inte inloggad"

  Scenario: Appens sidor visas inte för den som inte är inloggad
    När någon som inte är inloggad öppnar startsidan för appen "bokningar"
    Så visas inte appens innehåll

  Scenario: Appen får veta vem användaren är, men inte mer än nödvändigt
    Givet att Anna är inloggad med adressen "anna.andersson@exempel.se"
    När appen "bokningar" frågar vem användaren är
    Så får den ett användar-id och visningsnamnet "anna.andersson"
    Och svaret innehåller inte e-postadressen

  Scenario: Skrivande anrop utan plattformens skyddshuvud nekas
    Givet att Anna är inloggad
    När Anna sparar ett dokument i appen "bokningar" utan skyddshuvudet mot förfalskade anrop
    Så får hon svaret "åtkomst nekad"
