# language: sv
@tjanst-history @pågår
Egenskap: Ändringshistorik — vem ändrade vad och när
  I offentlig sektor måste det gå att se vem som ändrat en uppgift, när, och vad den
  innehöll då. Plattformen skriver historiken i samma ögonblick som dokumentet ändras,
  så att en ändring aldrig kan ske utan att synas — och ett misslyckat försök aldrig
  syns som en ändring. Historiken visar namn, aldrig e-postadresser.

  Bakgrund:
    Givet att appen "ärenden" är publicerad
    Och att Anna är inloggad med adressen "anna.andersson@exempel.se"
    Och att Bertil är inloggad med adressen "bertil.berg@exempel.se"

  Scenario: Varje ändring av ett gemensamt dokument syns, nyast först
    Givet att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har skrivit om Annas dokument till {"status": "klar"}
    När Anna tittar på ändringshistoriken för Annas dokument
    Så visar ändringshistoriken i tur och ordning:
      | händelse | vem            | innehåll          |
      | ändrat   | bertil.berg    | {"status":"klar"} |
      | skapat   | anna.andersson | {"status":"ny"}   |
    Och innehåller ändringshistoriken inga e-postadresser

  Scenario: En radering syns med det innehåll dokumentet hade
    Givet att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har raderat Annas dokument
    När Anna tittar på ändringshistoriken för Annas dokument
    Så visar ändringshistoriken i tur och ordning:
      | händelse | vem            | innehåll        |
      | raderat  | bertil.berg    | {"status":"ny"} |
      | skapat   | anna.andersson | {"status":"ny"} |

  Scenario: Historiken för ett personligt dokument syns bara för den som äger det
    Givet att Anna har sparat dokumentet {"anteckning": "privat"} i den personliga kollektionen "anteckningar" i appen "ärenden"
    När Bertil tittar på ändringshistoriken för Annas dokument
    Så får han svaret "finns inte"

  Scenario: Kollektionens historik visar vad som hänt i den
    Givet att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har skrivit om Annas dokument till {"status": "pågår"}
    När Bertil tittar på ändringshistoriken för kollektionen "arenden" i appen "ärenden"
    Så visar ändringshistoriken i tur och ordning:
      | händelse | vem            | innehåll            |
      | ändrat   | bertil.berg    | {"status":"pågår"}  |
      | skapat   | anna.andersson | {"status":"ny"}     |

  Scenario: En ändring kan ångras, och ångrandet syns också i historiken
    Givet att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    Och att Bertil har skrivit om Annas dokument till {"status": "fel"}
    När Anna återställer Annas dokument till hur det var när det skapades
    Så innehåller Annas dokument nu {"status": "ny"}
    Och visar Annas ändringshistorik överst att anna.andersson återställde det till {"status":"ny"}

  Scenario: Den som inte får ändra ett dokument kan inte heller återställa det
    Givet att Anna har sparat dokumentet {"anteckning": "privat"} i den personliga kollektionen "anteckningar" i appen "ärenden"
    När Bertil försöker återställa Annas dokument till hur det var när det skapades
    Så får han svaret "finns inte"

  Scenario: Det går inte att återställa till en tidpunkt som inte finns i historiken
    Givet att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    När Anna återställer Annas dokument till en tidpunkt som inte finns i historiken
    Så får hon svaret "finns inte"

  Scenario: Ett misslyckat försök att ändra syns inte som en ändring
    Givet att Anna har sparat dokumentet {"anteckning": "privat"} i den personliga kollektionen "anteckningar" i appen "ärenden"
    Och att Bertil har försökt skriva om Annas dokument till {"anteckning": "kapad"}
    När Anna tittar på ändringshistoriken för Annas dokument
    Så visar ändringshistoriken i tur och ordning:
      | händelse | vem            | innehåll                 |
      | skapat   | anna.andersson | {"anteckning":"privat"}  |

  Scenario: En annan app ser inte appens historik
    Givet att appen "enkät" är publicerad
    Och att Anna har sparat dokumentet {"status": "ny"} i kollektionen "arenden" i appen "ärenden"
    När Anna tittar på ändringshistoriken för Annas dokument i appen "enkät"
    Så får hon svaret "finns inte"
