# language: sv
Egenskap: Avveckling och export — när en app ska sluta finnas
  En plattform som bara går att bygga på fylls. Appar som löste ett problem för två år sedan
  ligger kvar och samlar uppgifter om människor som för länge sedan slutat, och varje sådan app
  är någons ansvar som ingen längre känner till. Att kunna ta bort är inte en bekvämlighet — det
  är det som gör att resten går att förvalta.

  Exporten kommer först, och det är inte en artighet. Appdata i en kommun kan vara allmän
  handling, och då får den inte försvinna bara för att den som byggde appen tröttnat. Plattformen
  kan inte avgöra om just de här uppgifterna är det. Men den kan se till att det alltid finns en
  väg ut som inte kräver att någon läser databasen på servern.

  Exporten respekterar synligheten. En kollektion som är var och ens egen ger bara ägarens egna
  rader — precis som en vanlig läsning gör. Det är med flit: en export som gav ägaren allt hade
  upphävt hela regeln som gör att en enkät inte läcker mellan kollegor, och den regeln får man
  inte gå runt genom att kalla anropet något annat. En fullständig utlämning av en app som är
  allmän handling är en styrningsåtgärd som ännu inte finns.

  Avvecklingen raderar appens uppgifter och filer, och tar bort appen så att adressen slutar
  svara. Men registerposten ARKIVERAS, den raderas inte. Att appen har funnits, vem som ägde den
  och hur känslig den var är just det en tillsyn frågar efter. Raderingen gäller uppgifterna i
  appen, inte spåret av att appen fanns.

  En app som väntar på granskning och sedan avvecklas lämnar kön. Annars hade en granskare kunnat
  säga ja till en app som inte längre finns, och registret hade visat den som publicerad efteråt.

  Ordningen är inte godtycklig: uppgifterna först, appen sedan. Går raderingen fel ska appen
  fortfarande finnas och gå att försöka igen. En app som tagits bort men vars databas ligger kvar
  på disken är precis det ett gallringsbevis inte får ljuga om.

  Bekräftelsen är appens namn, ordagrant. En kryssruta klickas bort; ett namn måste skrivas, och
  den som skriver fel namn har inte den app hon tror framför sig.

  Bara ägaren avvecklar. Den som fått appen delad med sig kommer inte ens in i byggverktyget; en
  administratör kommer in men får samma svar som för en app som inte finns. Att förvalta
  plattformen är inte samma sak som att äga någons app.

  Vad som händer när raderingen går fel mitt i står inte här. Scenarierna kör plattformen på
  riktigt och kan inte få en disk att fallera; det prövas i stället i
  `packages/builder/test/avveckling.test.ts`, där båda halvvägslägena går att framkalla.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga
    Och att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app

  Scenario: Allt appen bär går att hämta ut
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har sparat två rader i sin app
    När Anna hämtar ut appens innehåll
    Så innehåller exporten båda raderna
    Och står appens namn och känslighetsnivå i exporten
    Och finns samtalet som byggde appen med i exporten

  Scenario: Exporten ger inte andras rader
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har delat appen med Bertil
    Och att Anna har sparat en egen rad i en kollektion som är var och ens egen
    Och att Bertil har sparat en egen rad i samma kollektion
    När Anna hämtar ut appens innehåll
    Så innehåller exporten bara Annas egen rad

  Scenario: En app utan uppgifter går ändå att exportera
    Givet att Anna har en app som byggts klart och publicerats
    När Anna hämtar ut appens innehåll
    Så är exporten tom men fullständig

  Scenario: Avvecklingen raderar uppgifterna och tar bort appen
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har sparat två rader i sin app
    När Anna avvecklar appen med dess namn
    Så finns appen inte längre för Anna
    Och svarar appens adress inte längre
    Och står det i gallringsbeviset att två rader raderades

  Scenario: Registerposten står kvar när appen är borta
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har avvecklat appen
    När Erik öppnar AI-registret
    Så står Annas app kvar i registret som avvecklad
    Och står det när den avvecklades
    Och står appens känslighetsnivå kvar

  Scenario: En avvecklad app lämnar granskningskön
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Anna avvecklar appen med dess namn
    Så finns det inga ärenden i granskningskön
    Och finns appen inte längre för Anna

  Scenario: Fel namn avvecklar ingenting
    Givet att Anna har en app som byggts klart
    När Anna försöker avveckla appen med namnet "nåt annat"
    Så får hon svaret "ogiltig begäran"
    Och finns appen kvar för Anna

  Scenario: En kryssruta räcker inte som bekräftelse
    Givet att Anna har en app som byggts klart
    När Anna försöker avveckla appen med en kryssruta i stället för namnet
    Så får hon svaret "ogiltig begäran"
    Och finns appen kvar för Anna

  Scenario: Den som fått appen delad med sig kommer inte ens in i byggverktyget
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har delat appen med Bertil
    När Bertil försöker avveckla Annas app med dess namn
    Så får han svaret "åtkomst nekad"
    Och finns appen kvar för Anna

  Scenario: Inte ens en administratör kan avveckla någon annans app
    Givet att Anna har en app som byggts klart
    När Erik försöker avveckla Annas app med dess namn
    Så får han svaret "finns inte"
    Och finns appen kvar för Anna

  Scenario: Gallringsbeviset loggas, men aldrig innehållet
    Givet att Anna har en app som byggts klart och publicerats
    Och att Anna har sparat en rad med texten "Kalle Karlsson 900101-1234" i sin app
    När Anna avvecklar appen med dess namn
    Så står gallringsbeviset i driftloggarna
    Och nämns inget av texten "Kalle Karlsson 900101-1234" i driftloggarna
