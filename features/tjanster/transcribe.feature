# language: sv
#
# Tjänsten `files` byggs parallellt och finns inte i den här grenen. Tills den finns körs
# scenarierna mot tjänsten `transcribe` direkt, med en fejkad filtjänst ("har laddat upp") och en
# fejkad Berget på en lokal port. Därför taggen @transcribe i stället för @tjanst-transcribe:
# @tjanst-transcribe slår på tjänsten i den riktiga plattformen, som vägrar starta utan `files`.
# När `files` finns: tagga @tjanst-files @tjanst-transcribe, låt "har laddat upp" gå genom
# /_api/files och låt stegen anropa /_api/transcribe över HTTP — scenarierna ändras inte.
@transcribe @pågår
Egenskap: Tal till text för uppladdade ljudfiler
  En app kan låta sina användare göra om en inspelning — ett möte, en intervju — till text.
  Ljudet skrivs ut av Berget, plattformens svenska personuppgiftsbiträde. Den som startade
  utskriften ser resultatet, liksom appens ägare; ingen annan.

  Bakgrund:
    Givet att appen "protokoll" har tal till text påslaget
    Och att Anna äger appen "protokoll" och Bertil och Cecilia använder den

  Scenario: En inspelning blir text med tidsangivelser
    Givet att Bertil har laddat upp en inspelning av ett möte i appen "protokoll"
    När Bertil ber om en utskrift av inspelningen
    Så tar tjänsten emot beställningen och ger ett jobb att följa
    Och när jobbet är klart kan Bertil läsa texten med tidsangivelser

  Scenario: Bara den som startade utskriften och appens ägare kan läsa den
    Givet att Bertil har laddat upp en inspelning av ett möte i appen "protokoll"
    Och att Bertil har fått en färdig utskrift av inspelningen
    Så kan Anna läsa utskriften
    Men för Cecilia finns utskriften inte

  Scenario: En fil från en annan app går inte att skriva ut
    Givet att Bertil har laddat upp en inspelning av ett möte i appen "enkät"
    När Bertil ber om en utskrift av inspelningen i appen "protokoll"
    Så får han svaret att filen inte finns

  Scenario: En fil som inte är ljud avvisas
    Givet att Bertil har laddat upp en pdf i appen "protokoll"
    När Bertil ber om en utskrift av filen
    Så får han svaret att bara ljudfiler kan skrivas ut

  Scenario: En för stor inspelning avvisas innan något skickas till Berget
    Givet att Bertil har laddat upp en inspelning som är större än Berget tar emot
    När Bertil ber om en utskrift av inspelningen
    Så får han svaret att filen är för stor
    Och ingenting har skickats till Berget

  Scenario: Appens ljudminuter för dygnet tar slut
    Givet att appen "protokoll" får skriva ut 10 minuter ljud per dygn
    Och att Bertil redan har fått 8 minuter ljud utskrivna i dag
    Och att Bertil har laddat upp en inspelning på 5 minuter
    När Bertil ber om en utskrift av inspelningen
    Så får han svaret att dygnets ljudminuter är slut

  Scenario: Ett fel hos Berget ger ett begripligt besked — aldrig Bergets egen text
    Givet att Berget svarar med ett internt fel
    Och att Bertil har laddat upp en inspelning av ett möte i appen "protokoll"
    När Bertil ber om en utskrift av inspelningen
    Så misslyckas jobbet med ett begripligt besked på svenska
    Och beskedet innehåller ingenting av det Berget svarade

  Scenario: En omstart mitt i en utskrift gör inte att den går förlorad
    Givet att Bertil har laddat upp en inspelning av ett möte i appen "protokoll"
    Och att Berget arbetar långsamt
    När Bertil ber om en utskrift av inspelningen
    Och plattformen startas om medan utskriften pågår
    Så blir jobbet klart efter omstarten och Bertil kan läsa texten

  Scenario: Varken ljud eller text hamnar i driftloggen
    Givet att Bertil har laddat upp en inspelning av ett möte i appen "protokoll"
    Och att Bertil har fått en färdig utskrift av inspelningen
    Så innehåller driftloggen varken ljudet eller texten
