# language: sv
Egenskap: Granskning — en människa läser koden innan appen går ut
  Allt före det här steget är maskiner. De röda linjerna prövar önskemålet mot mönster,
  policyreglerna prövar koden mot mönster, klassningen frågar en språkmodell. Var och en fångar
  det förutsägbara. Ingen av dem förstår vad appen är till för.

  Därför publicerar den som bygger inte själv. Hon begär publicering, och en granskare läser
  koden och avgör. Det är den sista spärren, och den enda som är en människa.

  Granskningen gäller en VERSION, inte en app. Godkännandet släpper ut exakt den kod som lästes —
  aldrig det som råkar vara senast byggt när beslutet fattas. Bygger ägaren om medan ärendet
  väntar dras det tillbaka: granskaren ska inte läsa kod som redan är ersatt, och ägaren ska inte
  tro att någon läser. Ett tillbakadraget ärende är inget nej. Ingen sa nej — ingen hann läsa.

  Ett nej kräver ett skäl, och skälet går ordagrant till ägaren. Ett avslag utan skäl lämnar
  någon med en app hon inte vet vad som är fel på, och nästa försök blir en gissning.

  En granskare får inte avgöra sin egen app så länge det finns någon annan att be. En
  administratör som bygger något är i det läget ägare, inte granskare, och ett godkännande av sig
  själv är ingen granskning alls.

  Men fyraögonsprincipen förutsätter fyra ögon. Är man plattformens ende administratör finns ingen
  annan att be, och spärren blir då inte en granskning utan en låst dörr utan nyckel: appen kan
  aldrig gå ut, hur ofarlig den än är. Därför gäller spärren när det finns en annan administratör,
  och bara då. Den som är ensam får avgöra sitt eget — och beslutet loggas som just det, så att
  det går att se i efterhand att ingen annan läste.

  Kön visar inte koden. Den visar vem som väntar och hur känslig appen är — nivån och HUR den
  sattes, så att granskaren ser skillnad på ett omdöme och ett misslyckande innan hon börjar läsa.
  Koden syns när hon öppnar ett ärende, och det är den enda platsen i hela kontrollrummet där en
  apps innehåll visas. Det är inte ett undantag från regeln om insyn utan åtkomst — det ÄR
  granskningen.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga
    Och att Erik är administratör för plattformen
    Och att språkmodellen svarar med en giltig app

  Scenario: Den som bygger publicerar inte själv
    Givet att Anna har en app som byggts klart
    När Anna begär publicering
    Så är appen inte publicerad
    Och väntar appen på granskning

  Scenario: Appen går ut när granskaren säger ja
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik godkänner Annas app
    Så är appen publicerad
    Och får Anna veta att appen är granskad och publicerad

  Scenario: Ett nej stoppar appen, och skälet går ordagrant till den som byggde
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik avvisar Annas app med skälet "Listan visar alla medarbetares frånvaro för alla — begränsa den till den egna gruppen"
    Så är appen inte publicerad
    Och står skälet "Listan visar alla medarbetares frånvaro för alla — begränsa den till den egna gruppen" ordagrant i Annas samtal

  Scenario: Ett nej utan skäl går inte att lämna
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik försöker avvisa Annas app utan skäl
    Så får han svaret "ogiltig begäran"
    Och väntar appen fortfarande på granskning

  Scenario: Granskaren ser koden när hon öppnar ärendet
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik öppnar Annas ärende i granskningskön
    Så ser han appens källkod

  Scenario: Kön visar inte koden
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik öppnar granskningskön
    Så står där ett ärende för Annas app
    Och syns ingen källkod i kön
    Och visas bara början av app-id:t i kön

  Scenario: Kön visar hur känslig appen är, och hur den nivån sattes
    Givet att plattformen bedömer önskemålet som "personuppgifter"
    Och att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik öppnar granskningskön
    Så står Annas ärende som "personuppgifter" i kön
    Och står det att plattformen läste beskrivningen

  Scenario: Bygger ägaren om dras ärendet tillbaka — och det är inget nej
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    Och att språkmodellen svarar med en ändrad app
    När Anna ber om "Byt rubrik"
    Så är Annas ärende tillbakadraget
    Och finns det inga ärenden i granskningskön
    Och är appen inte publicerad

  Scenario: Ett tillbakadraget ärende går att begära på nytt
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    Och att språkmodellen svarar med en ändrad app
    Och att Anna har bett om att få rubriken bytt
    När Anna begär publicering
    Så väntar appen på granskning

  Scenario: En app som redan väntar går inte att skicka in två gånger
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Anna begär publicering
    Så får hon svaret "konflikt"
    Och står det bara ett ärende i granskningskön

  Scenario: En granskare får inte avgöra sin egen app när det finns någon annan att be
    Givet att Erik har en egen app som byggts klart
    Och att Erik har begärt publicering av sin egen app
    Och att Doris också är administratör för plattformen
    När Erik försöker godkänna sin egen app
    Så får han svaret "ogiltig begäran"
    Och är hans app inte publicerad

  Scenario: Plattformens ende administratör får avgöra sin egen app
    Givet att Erik har en egen app som byggts klart
    Och att Erik har begärt publicering av sin egen app
    Och att Erik är plattformens ende administratör
    När Erik godkänner sin egen app
    Så är hans app publicerad
    Och står det i driftloggarna att ingen annan läste

  Scenario: Den andra administratören får avgöra Eriks app
    Givet att Erik har en egen app som byggts klart
    Och att Erik har begärt publicering av sin egen app
    Och att Doris också är administratör för plattformen
    När Doris godkänner Eriks app
    Så är hans app publicerad

  Scenario: Den som bara får bygga ser ingen granskningskö
    Givet att Bertil är inloggad i byggverktyget och får bygga
    När Bertil öppnar granskningskön
    Så får han svaret "åtkomst nekad"

  Scenario: Beslutet loggas, men aldrig skälet
    Givet att Anna har en app som byggts klart
    Och att Anna har begärt publicering
    När Erik avvisar Annas app med skälet "Formuläret samlar in personnummer utan att det behövs"
    Så står beslutet i driftloggarna
    Och nämns inget av skälet "Formuläret samlar in personnummer utan att det behövs" i driftloggarna
