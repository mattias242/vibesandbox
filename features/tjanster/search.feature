# language: sv
@tjanst-search
Egenskap: Sökning i en apps dokument efter innebörd
  En app med ärenden, en kunskapsbank eller anteckningar behöver kunna hitta det som handlar
  om samma sak, även när orden inte är exakt desamma. Plattformen söker åt appen — men bara
  bland de dokument den som söker ändå får se, och utan att någon annans personliga
  anteckningar någonsin kan dyka upp som träff.

  Bakgrund:
    Givet att appen "ärenden" är publicerad
    Och att Anna är inloggad
    Och att Bertil är inloggad

  Scenario: Det mest liknande ärendet kommer först
    Givet att Anna har sparat dokumentet {"rubrik": "Kaffemaskinen läcker vatten i köket"} i kollektionen "arenden" i appen "ärenden"
    Och att Anna har sparat dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"} i kollektionen "arenden" i appen "ärenden"
    När Bertil söker efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Så är den första träffen dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"}

  Scenario: Någon annans personliga anteckningar blir aldrig en träff
    Givet att Anna har sparat dokumentet {"text": "Koden till cykellåset är 4711"} i den personliga kollektionen "anteckningar" i appen "ärenden"
    När Bertil söker efter "koden till cykellåset" i den personliga kollektionen "anteckningar" i appen "ärenden"
    Så får han inga träffar

  Scenario: Den som skrev en personlig anteckning hittar den
    Givet att Anna har sparat dokumentet {"text": "Koden till cykellåset är 4711"} i den personliga kollektionen "anteckningar" i appen "ärenden"
    När Anna söker efter "koden till cykellåset" i den personliga kollektionen "anteckningar" i appen "ärenden"
    Så är den första träffen dokumentet {"text": "Koden till cykellåset är 4711"}

  Scenario: En annan apps dokument syns inte
    Givet att appen "kassan" är publicerad
    Och att Anna har sparat dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"} i kollektionen "arenden" i appen "ärenden"
    När Bertil söker efter "stulen cykel" i kollektionen "arenden" i appen "kassan"
    Så får han inga träffar

  Scenario: Ett ändrat ärende hittas på sitt nya innehåll
    Givet att Anna har sparat dokumentet {"rubrik": "Kaffemaskinen läcker vatten i köket"} i kollektionen "arenden" i appen "ärenden"
    Och att Anna har sparat dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har sökt efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Och att Anna har ändrat sitt senaste dokument till {"rubrik": "Skrivaren på plan två har fastnat"}
    När Bertil söker efter "skrivaren har fastnat" i kollektionen "arenden" i appen "ärenden"
    Så är den första träffen dokumentet {"rubrik": "Skrivaren på plan två har fastnat"}

  Scenario: Ett raderat ärende blir ingen träff
    Givet att Anna har sparat dokumentet {"rubrik": "Kaffemaskinen läcker vatten i köket"} i kollektionen "arenden" i appen "ärenden"
    Och att Anna har sparat dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har sökt efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Och att Anna har raderat sitt senaste dokument
    När Bertil söker efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Så finns Annas raderade dokument inte bland träffarna

  Scenario: Ett kollektionsnamn som försöker ta sig ut ur appen nekas
    När Bertil söker efter "stulen cykel" i kollektionen "../arenden" i appen "ärenden"
    Så får han svaret "ogiltig begäran"

  Scenario: En för lång fråga nekas
    När Bertil söker efter en fråga på 5000 tecken i kollektionen "arenden" i appen "ärenden"
    Så får han svaret "ogiltig begäran"

  Scenario: En orimligt stor sökning stoppas innan den ens läses
    När Bertil söker efter en fråga på 100000 tecken i kollektionen "arenden" i appen "ärenden"
    Så får han svaret "för stort"

  Scenario: Telefonnummer lämnar inte plattformen
    Givet att Anna har sparat dokumentet {"text": "Ring mig på 070-123 45 67 om cykeln"} i kollektionen "arenden" i appen "ärenden"
    När Bertil söker efter "cykeln 070-123 45 67" i kollektionen "arenden" i appen "ärenden"
    Så har sökleverantören inte fått se telefonnumret "070-123 45 67"

  Scenario: När sökleverantören inte svarar får användaren veta det i klarspråk
    Givet att Anna har sparat dokumentet {"rubrik": "Cykeln blev stulen från cykelstället"} i kollektionen "arenden" i appen "ärenden"
    Och att sökleverantören inte svarar
    När Bertil söker efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Så får han beskedet att sökningen inte går att använda just nu

  Scenario: Den som söker för ofta får vänta en stund
    När Bertil söker efter "stulen cykel" 6 gånger i rad i kollektionen "arenden" i appen "ärenden"
    Så får han beskedet att det blev för många sökningar

  Scenario: En app som bäddat in för mycket text i dag får vänta till i morgon
    Givet att Anna har sparat 6 långa dokument i kollektionen "arenden" i appen "ärenden"
    När Bertil söker efter "stulen cykel" i kollektionen "arenden" i appen "ärenden"
    Så får han beskedet att appens sökkvot för i dag är slut
