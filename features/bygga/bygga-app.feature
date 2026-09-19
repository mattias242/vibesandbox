# language: sv
Egenskap: Bygga en app genom att beskriva den
  Den som inte är utvecklare beskriver ett behov i vanlig svenska och får en fungerande app
  att prova direkt. Språkmodellen skriver koden, men plattformen bestämmer vad som får byggas.
  I scenarierna svarar en inspelad språkmodell, så att utfallet går att upprepa.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga

  Scenario: En mening blir en app att prova
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "En lista där vi bokar mötesrum"
    Så blir bygget klart
    Och Anna kan öppna förhandsvisningen av appen
    Och förhandsvisningen visar det språkmodellen skrev

  Scenario: Anna följer arbetet medan det pågår
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "En lista där vi bokar mötesrum"
    Så ser hon i tur och ordning att koden skrivs, kontrolleras och byggs

  Scenario: Kod som bryter mot reglerna byggs aldrig
    Givet att språkmodellen svarar med kod som skickar data till en extern adress
    När Anna ber om "Ett formulär som mejlar svaren till mig"
    Så blir det inget nytt utkast
    Och Anna får veta i klarspråk varför det inte gick

  Scenario: Modellen får rätta sina egna fel
    Givet att språkmodellen först svarar med kod som inte går att bygga och sedan med en rättad version
    När Anna ber om "En lista där vi bokar mötesrum"
    Så blir bygget klart efter två försök

  Scenario: Ett avkapat svar används aldrig
    Givet att språkmodellen svarar med en app som avbryts mitt i
    När Anna ber om "En lista där vi bokar mötesrum"
    Så blir det inget nytt utkast

  Scenario: En ändring bygger vidare på det som finns
    Givet att Anna har en app som byggts klart
    Och att språkmodellen svarar med en ändrad app
    När Anna ber om "Lägg till en kolumn för antal deltagare"
    Så får språkmodellen se appens nuvarande kod
    Och appens utkast är den ändrade versionen

  Scenario: Personnummer lämnar aldrig servern
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "En lista över elever, till exempel 900101-1234"
    Så innehåller inget som skickades till språkmodellen personnumret

  Scenario: Andra kan inte se eller ändra Annas appar i byggverktyget
    Givet att Anna har en app som byggts klart
    Och att Bertil är inloggad i byggverktyget och får bygga
    När Bertil försöker öppna Annas app i byggverktyget
    Så får han svaret "finns inte"

  Scenario: Utkastet ändrar inte den publicerade appen förrän Anna publicerar
    Givet att Anna har en app som byggts klart och publicerats
    Och att språkmodellen svarar med en ändrad app
    När Anna ber om "Byt rubrik"
    Så visar den publicerade appen fortfarande den gamla versionen
    När Anna publicerar
    Så visar den publicerade appen den nya versionen

  Scenario: Byggverktyget går inte att lura att skriva åt Anna från en annan app
    Givet att Anna har en app som byggts klart
    När en sida på en annan app skickar en begäran om ändring i Annas namn
    Så får anroparen svaret "åtkomst nekad"
