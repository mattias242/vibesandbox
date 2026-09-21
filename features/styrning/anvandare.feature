# language: sv
Egenskap: Kontrollrummet — vilka adresser som får logga in, och med vilken roll
  Plattformen släpper bara in adresser som någon uttryckligen har bjudit in. Det är ett medvetet
  val, men registret över dem har hittills bara gått att ändra från kommandoraden på servern: den
  som förvaltar plattformen har fått logga in på maskinen för att släppa in en ny byggare, och har
  inte kunnat se vilka som redan kommer in utan att läsa databasen.

  Den här skivan flyttar in det i kontrollrummet: se vilka adresser som får logga in, bjuda in nya,
  och ändra vad någon får göra. Det är första gången kontrollrummet ÄNDRAR något — förra skivan var
  ren läsning — och det är därför försiktighetsreglerna nedan finns.

  En inbjudan höjer, men sänker aldrig. Att bjuda in någon som redan finns är ett vanligt misstag
  ("jag trodde inte hon fanns"), och det misstaget får inte kunna ta ifrån någon det hen redan har.
  Ska någon få mindre görs det uttryckligen på personens egen rad — ett beslut, inte en tabbe i ett
  formulär.

  Den egna raden går inte att sänka alls. En administratör som sänker sig själv låser ut sig ur
  kontrollrummet, och vägen tillbaka går bara över kommandoraden på servern. Det är den sista
  dörren, och den ska inte gå att stänga inifrån.

  En ändrad roll gäller från nästa handling, också för den som redan sitter inloggad. Rollen läses
  där den står — i registret över vilka som får logga in — inte ur den inloggning personen en gång
  fick. Annars vore en sänkning bara ett löfte om att något skulle sluta gälla vid nästa inloggning.

  Rollen som administratör ger fortfarande insyn, aldrig åtkomst: den som förvaltar plattformen ser
  att apparna finns och vilka adresser som kommer in, men kommer inte in i någons app. Adresserna
  är personuppgifter. De visas för den som förvaltar plattformen, och hamnar aldrig i en driftlogg.

  Bakgrund:
    Givet att Erik lades in som administratör när plattformen sattes upp

  Scenario: Administratören ser vilka adresser som får logga in, och med vilken roll
    Givet att Erik har bjudit in Anna som byggare
    Och att Erik har bjudit in Cecilia som läsare
    När Erik öppnar adresslistan i kontrollrummet
    Så står Anna som byggare i adresslistan
    Och står Cecilia som läsare i adresslistan
    Och står Erik som administratör i adresslistan
    Och är Eriks egen rad markerad som hans egen
    Och finns det inga andra adresser i listan

  Scenario: En inbjuden byggare kommer in och kan bygga
    Givet att Erik har bjudit in Anna som byggare
    Och att språkmodellen svarar med en giltig app
    När Anna ber om "En lista där vi bokar mötesrum"
    Så blir bygget klart
    Och står Anna som byggare i adresslistan

  Scenario: Den som bjuds in med en högre roll får den högre rollen
    Givet att Erik har bjudit in Cecilia som läsare
    När Erik bjuder in Cecilia som byggare
    Så står Cecilia som byggare i adresslistan

  Scenario: En inbjudan sänker aldrig en roll som redan är högre
    Givet att Erik har bjudit in Anna som byggare
    När Erik bjuder in Anna som läsare
    Så står Anna kvar som byggare i adresslistan

  Scenario: Administratören kan inte sänka sin egen roll
    När Erik försöker sätta sin egen roll till byggare
    Så får han svaret "ogiltig begäran"
    Och står Erik kvar som administratör i adresslistan
    Och kommer Erik fortfarande in i kontrollrummet

  Scenario: En sänkt roll gäller direkt, också för den som redan är inloggad
    Givet att Erik har bjudit in Bertil som byggare
    Och att Bertil har byggt en app i byggverktyget
    När Erik sätter Bertils roll till läsare
    Och Bertil ber om en ändring i sin app
    Så får han svaret "åtkomst nekad"
    Och finns Bertils app kvar i kontrollrummet

  Scenario: Den som bara får bygga kan inte ändra vem som får logga in
    Givet att Erik har bjudit in Anna som byggare
    Och att Erik har bjudit in Bertil som läsare
    När Anna försöker ändra vem som får logga in
    Så får hon svaret "åtkomst nekad"
    Och står Bertil kvar som läsare i adresslistan
    Och saknas Cecilias adress i adresslistan

  Scenario: Översikten räknar adresserna per roll
    Givet att Erik har bjudit in Anna som byggare
    Och att Erik har bjudit in Bertil som byggare
    Och att Erik har bjudit in Cecilia som läsare
    När Erik öppnar kontrollrummet
    Så räknar översikten adresserna:
      | administratörer | 1 |
      | byggare         | 2 |
      | läsare          | 1 |

  Scenario: En app vars ägaradress saknas i driftregistret visas ändå med rätt adress
    Givet att Erik har bjudit in Anna som byggare
    Och att Anna har byggt en app i byggverktyget
    Och att driftregistret tappat adressen till Annas app
    När Erik öppnar kontrollrummet
    Så står Annas adress vid hennes app i kontrollrummet

  Scenario: En adress som inte finns någonstans lämnas tom — den gissas aldrig
    Givet att Bertil har byggt en app i byggverktyget
    Och att driftregistret tappat adressen till Bertils app
    När Erik öppnar kontrollrummet
    Så står ingen adress vid Bertils app i kontrollrummet
    Och nämns Bertils adress ingenstans i kontrollrummet

  Scenario: Adresserna hamnar aldrig i driftloggarna
    Givet att Erik har bjudit in Anna som byggare
    Och att Erik har bjudit in Cecilia som läsare
    När Erik öppnar adresslistan i kontrollrummet
    Så nämns ingen av adresserna i driftloggarna
