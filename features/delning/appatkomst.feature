# language: sv
Egenskap: Bara de som fått appen delad med sig kommer åt den
  Varje app har en ägare, den som byggde den. Ägaren bestämmer vilka som får
  använda appen genom att dela den med deras e-postadress. Att vara inloggad
  på plattformen räcker inte, och att känna till appens adress räcker inte.
  Utkastet är ägarens arbetsmaterial och visas bara för ägaren.

  Bakgrund:
    Givet att Anna har en app som byggts klart och publicerats

  Scenario: Den som fått appen delad med sig kan använda den
    Givet att Anna har delat appen med Bertil
    När Bertil öppnar Annas publicerade app
    Så visas appens innehåll

  Scenario: Den som fått appen delad med sig kan spara data i den
    Givet att Anna har delat appen med Bertil
    När Bertil sparar ett dokument i Annas publicerade app
    Så lyckas det

  Scenario: Inloggad men inte inbjuden nekas, med samma svar som för en app som inte finns
    Givet att Cecilia är inloggad på plattformen
    När Cecilia öppnar Annas publicerade app
    Så får hon samma svar som för en app som inte finns

  Scenario: Den som inte är inbjuden kommer inte heller åt appens data
    Givet att Cecilia är inloggad på plattformen
    När Cecilia listar en kollektion i Annas publicerade app
    Så får hon samma svar som för en app som inte finns

  Scenario: Plattformens administratör har ingen genväg förbi delningen
    Givet att Erik är administratör för plattformen
    När Erik öppnar Annas publicerade app
    Så får han samma svar som för en app som inte finns

  Scenario: Utkastet visas bara för ägaren
    Givet att Anna har delat appen med Bertil
    När Bertil öppnar förhandsvisningen av Annas app
    Så får han samma svar som för en app som inte finns

  Scenario: Ägaren kommer åt både utkast och publicerad app
    När Anna öppnar Annas publicerade app
    Så visas appens innehåll
    Och Anna kan öppna förhandsvisningen av appen

  Scenario: Flera personer kan ha fått samma app delad med sig
    Givet att Anna har delat appen med Bertil
    Och att Anna har delat appen med Cecilia
    När Anna tittar på vilka som har åtkomst till appen
    Så ser hon Bertils och Cecilias adresser

  Scenario: Ägaren tar bort någons åtkomst och den upphör direkt
    Givet att Anna har delat appen med Bertil
    Och att Bertil har öppnat Annas publicerade app
    När Anna tar bort Bertils åtkomst till appen
    Och Bertil öppnar Annas publicerade app igen
    Så får han samma svar som för en app som inte finns

  Scenario: Den som fått appen delad med sig kan inte dela den vidare
    Givet att Anna har delat appen med Bertil
    Och att Bertil är inloggad i byggverktyget och får bygga
    När Bertil försöker dela Annas app med Cecilia
    Så får han svaret "finns inte"

  Scenario: Ägaren kan inte ta bort sin egen åtkomst
    När Anna försöker ta bort sin egen åtkomst till appen
    Så får hon svaret "ogiltig begäran"
    Och Anna kan fortfarande öppna Annas publicerade app
