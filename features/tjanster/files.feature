# language: sv
@tjanst-files @pågår
Egenskap: Filer och bilagor i appar
  En app kan låta sina användare ladda upp filer — bilder, dokument, kalkylark och
  ljudinspelningar — och visa eller ladda ned dem igen. Filerna hör till appen: en annan app
  kommer aldrig åt dem, och utkastet delar inte filer med den publicerade appen. En personlig
  fil ser bara den som laddade upp den.

  Plattformen litar inte på vad en fil säger att den är, utan tittar på innehållet. Filtyper
  som kan bära skript (SVG-bilder och webbsidor) tas inte emot alls.

  Bakgrund:
    Givet att appen "Bokningar" är publicerad
    Och att Anna är inloggad
    Och att Bertil är inloggad

  Scenario: En uppladdad bild kan visas direkt i appen
    När Anna laddar upp bilden "semester.png" i appen "Bokningar"
    Så sparas filen som "semester.png" av typen "image/png"
    Och kan filen visas direkt i webbläsaren

  Scenario: Ett dokument laddas ned som bilaga
    När Anna laddar upp dokumentet "protokoll.pdf" i appen "Bokningar"
    Så sparas filen som "protokoll.pdf" av typen "application/pdf"
    Och laddas filen ned som en bilaga med namnet "protokoll.pdf"

  Scenario: Gemensamma filer ser alla som använder appen
    Givet att Bertil har laddat upp bilden "karta.png" i appen "Bokningar"
    När Anna listar filerna i appen "Bokningar"
    Så finns filen "karta.png" i listan

  Scenario: En personlig fil syns inte för någon annan
    Givet att Anna har laddat upp den personliga filen "lönespec.pdf" i appen "Bokningar"
    När Bertil listar filerna i appen "Bokningar"
    Så finns inte filen "lönespec.pdf" i listan

  Scenario: En personlig fil går inte att hämta eller ta bort för någon annan, inte ens med dess id
    Givet att Anna har laddat upp den personliga filen "lönespec.pdf" i appen "Bokningar"
    När Bertil försöker hämta och ta bort Annas fil
    Så får han svaret "finns inte"

  Scenario: Den som laddat upp en personlig fil ser den själv
    Givet att Anna har laddat upp den personliga filen "lönespec.pdf" i appen "Bokningar"
    När Anna listar filerna i appen "Bokningar"
    Så finns filen "lönespec.pdf" i listan

  Scenario: En SVG-bild som utger sig för att vara en vanlig bild tas inte emot
    När Anna laddar upp en SVG-bild som kallar sig "logga.png" i appen "Bokningar"
    Så får hon svaret "ogiltig begäran"

  Scenario: En webbsida tas inte emot, vad den än kallar sig
    När Anna laddar upp en webbsida som kallar sig "sida.html" i appen "Bokningar"
    Så får hon svaret "ogiltig begäran"

  Scenario: Innehållet avgör vad en fil är, inte vad den påstår
    När Anna laddar upp ett PDF-dokument som påstår att det är en bild i appen "Bokningar"
    Så får hon svaret "ogiltig begäran"

  Scenario: Ett filnamn kan inte peka ut en annan plats
    När Anna laddar upp bilden "../../../etc/passwd.png" i appen "Bokningar"
    Så sparas filen som "passwd.png" av typen "image/png"

  Scenario: En annan app kommer inte åt filen
    Givet att appen "Lokaler" är publicerad
    Och att Anna har laddat upp bilden "semester.png" i appen "Bokningar"
    När Anna hämtar samma fil i appen "Lokaler"
    Så får hon svaret "finns inte"

  Scenario: Utkastet delar inte filer med den publicerade appen
    Givet att Anna har laddat upp bilden "semester.png" i appen "Bokningar"
    När Anna hämtar samma fil i förhandsvisningen av appen "Bokningar"
    Så får hon svaret "finns inte"

  Scenario: Appens ägare kan ta bort en fil som någon annan laddat upp
    Givet att Bertil har laddat upp bilden "karta.png" i appen "Bokningar"
    När Anna tar bort Bertils fil
    Så är filen borta

  Scenario: Den som varken laddat upp filen eller äger appen kan inte ta bort den
    Givet att Anna har laddat upp bilden "semester.png" i appen "Bokningar"
    När Bertil försöker ta bort Annas fil
    Så får han svaret "åtkomst nekad"

  Scenario: En för stor fil tas inte emot
    När Anna laddar upp en fil som är större än gränsen i appen "Bokningar"
    Så får hon svaret "för stort"

  Scenario: En fil med skadlig kod tas inte emot
    När Anna laddar upp en fil med skadlig kod i appen "Bokningar"
    Så får hon svaret "ogiltig begäran"

  # @senare: tjänsten svarar 507 `quota_exceeded` enligt kontraktets API_ERROR_STATUS, men
  # gatewayns allowlista för tjänsters statuskoder saknar 507 och gör om svaret till 500.
  # Taggen tas bort när gatewayn släpper igenom 507 (stegen finns redan).
  @senare
  Scenario: När appens utrymme för filer är slut tas inga fler filer emot
    Givet att appen "Bokningar" har fyllt sitt utrymme för filer
    När Anna laddar upp bilden "en-till.png" i appen "Bokningar"
    Så får hon svaret "lagringsutrymmet är slut"
