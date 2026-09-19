# language: sv
@tjanst-notify @pågår
Egenskap: En app kan skicka aviseringar via mejl till sina medlemmar
  En app kan mejla dem som har tillgång till den — till exempel "mötet är flyttat". Mejlet
  kommer från plattformens betrodda adress, så det får aldrig kunna användas för nätfiske:
  mottagarna är alltid appens egna medlemmar, texten är ren text utan främmande länkar, och
  det syns tydligt vem som skickade det och varför mottagaren får det. Appen får aldrig veta
  någons e-postadress. Den som inte vill ha aviseringar kan stänga av dem.

  Bakgrund:
    Givet att appen "Klubben" är publicerad
    Och att Anna är inloggad
    Och att Bertil är inloggad

  Scenario: Ett meddelande till alla i appen når alla medlemmar
    När Anna aviserar alla i appen "Klubben" med ämnet "Mötet är flyttat" och texten "Vi ses på torsdag i stället."
    Så svarar tjänsten att 2 mejl skickades
    Och Bertil får ett mejl med ämnet "Mötet är flyttat"
    Och mejlet till Bertil visar att det kommer från "anna" och länkar till appen "Klubben"
    Och mejlet till Bertil berättar varför han får det och hur han stänger av aviseringarna

  Scenario: Ett meddelande till appens ägare
    När Bertil aviserar ägaren i appen "Klubben" med ämnet "Fråga" och texten "Kan jag ta med en gäst?"
    Så svarar tjänsten att 1 mejl skickades
    Och Anna får ett mejl med ämnet "Fråga"
    Och Bertil får inget mejl

  Scenario: Appen får aldrig se någons e-postadress
    När Anna aviserar alla i appen "Klubben" med ämnet "Hej" och texten "Välkomna!"
    Så innehåller svaret ingen av medlemmarnas e-postadresser

  Scenario: Den som inte hör till appen får inget mejl, och det röjs inte vilka som finns
    Givet att appen "Kalendern" är publicerad
    Och att Cecilia bara har tillgång till appen "Kalendern"
    När Anna aviserar Cecilia i appen "Klubben" med ämnet "Hej" och texten "Hallå där."
    Så svarar tjänsten att 0 mejl skickades
    Och Cecilia får inget mejl
    Och svaret är detsamma som för ett användar-id som inte finns alls

  Scenariomall: En webbadress i texten avvisas, även förklädd
    När Anna aviserar alla i appen "Klubben" med ämnet "Viktigt" och texten "Logga in här: <adress>"
    Så får hon svaret "ogiltig begäran"
    Och meddelandet förklarar att mejlet inte får innehålla webbadresser
    Och inget mejl skickas

    Exempel:
      | adress                        |
      | https://klubben.example/login |
      | hxxp://klubben[.]example      |
      | www.klubben-login.example     |
      | klubbens-inloggning.se        |
      | bänkid-inloggning.se          |
      | ｋｌｕｂｂｅｎ．ｃｏｍ            |

  Scenario: Appens egen adress får stå i texten
    När Anna aviserar alla i appen "Klubben" med appens egen adress i texten
    Så svarar tjänsten att 2 mejl skickades

  Scenario: En radbrytning i ämnet kan inte lägga till egna mejlhuvuden
    När Anna aviserar alla i appen "Klubben" med ett ämne som försöker lägga till ett mejlhuvud
    Så svarar tjänsten att 2 mejl skickades
    Och inget skickat mejl har en radbrytning i ämnet

  Scenario: En alldeles för lång text avvisas
    När Anna aviserar alla i appen "Klubben" med en text på 20 000 tecken
    Så får hon svaret "ogiltig begäran"
    Och inget mejl skickas

  Scenario: Den som stängt av aviseringarna får inga mejl
    Givet att Bertil har stängt av aviseringarna från appen "Klubben"
    När Anna aviserar alla i appen "Klubben" med ämnet "Hej" och texten "Välkomna!"
    Så svarar tjänsten att 1 mejl skickades
    Och Bertil får inget mejl
    Och Bertil ser att hans aviseringar från appen "Klubben" är avstängda

  Scenario: En avsändare som når sin gräns får vänta, och "alla" räknas per mottagare
    Givet att Bertil redan har skickat 4 aviseringar till ägaren av appen "Klubben" den senaste timmen
    När Bertil aviserar alla i appen "Klubben" med ämnet "Hej" och texten "En gång till."
    Så får Bertil veta i klarspråk att han har skickat för många aviseringar
    Och inget mejl skickas

  Scenario: Ett ogranskat utkast mejlar bara ägaren själv
    Givet att appen "Klubben" har ett utkast
    När Anna aviserar alla från förhandsvisningen av appen "Klubben" med ämnet "Test" och texten "Provar."
    Så svarar tjänsten att 1 mejl skickades
    Och svaret säger att bara ägaren fick mejlet eftersom det är ett utkast
    Och Anna får ett mejl med ämnet "Test"
    Och Bertil får inget mejl
