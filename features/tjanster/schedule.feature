# language: sv
@tjanst-notify @tjanst-schedule @pågår
Egenskap: Påminnelser som skickas vid en viss tid
  En app körs bara när någon har den öppen. Ska appens medlemmar påminnas om något —
  städdagen på fredag, bokningen i morgon — lämnar appen påminnelsen till plattformen,
  som skickar den när det är dags, en gång, och bara till appens egna medlemmar.

  Bakgrund:
    Givet att appen "klubben" är publicerad
    Och att Anna är inloggad
    Och att Bertil är inloggad

  Scenario: En påminnelse till alla kommer fram när det är dags
    När Anna schemalägger en påminnelse till alla i appen "klubben" om ett ögonblick med ämnet "Städdag"
    Så får Anna en påminnelse med ämnet "Städdag"
    Och får Bertil en påminnelse med ämnet "Städdag"
    Och kommer varje påminnelse bara en gång

  Scenario: En tid som redan har passerat nekas
    När Anna schemalägger en påminnelse till alla i appen "klubben" för en tid som redan har passerat
    Så får hon svaret "ogiltig begäran"

  Scenario: En tid utan tidszon nekas
    När Anna schemalägger en påminnelse till alla i appen "klubben" för tiden "2027-01-15T09:00"
    Så får hon svaret "ogiltig begäran"

  Scenario: Var och en ser sina egna påminnelser, och ägaren ser alla
    Givet att Anna har schemalagt en påminnelse i appen "klubben" med ämnet "Styrelsemöte"
    Och att Bertil har schemalagt en påminnelse i appen "klubben" med ämnet "Bertils tvättid"
    När Bertil listar påminnelserna i appen "klubben"
    Så ser han bara påminnelsen "Bertils tvättid"
    När Anna listar påminnelserna i appen "klubben"
    Så ser hon påminnelserna "Styrelsemöte" och "Bertils tvättid"

  Scenario: En medlem kan inte ta bort någon annans påminnelse
    Givet att Anna har schemalagt en påminnelse i appen "klubben" med ämnet "Styrelsemöte"
    När Bertil tar bort Annas påminnelse i appen "klubben"
    Så får han svaret "finns inte"
    Och finns Annas påminnelse kvar

  Scenario: Ägaren kan ta bort en medlems påminnelse
    Givet att Bertil har schemalagt en påminnelse i appen "klubben" med ämnet "Bertils tvättid"
    När Anna tar bort Bertils påminnelse i appen "klubben"
    Så är Bertils påminnelse borttagen

  Scenario: En annan app kommer inte åt påminnelsen
    Givet att appen "grannen" är publicerad
    Och att Anna har schemalagt en påminnelse i appen "klubben" med ämnet "Styrelsemöte"
    När Anna tar bort Annas påminnelse i appen "grannen"
    Så får hon svaret "finns inte"
    Och finns Annas påminnelse kvar

  Scenario: I förhandsvisningen går påminnelser bara till ägaren
    Givet att Anna förhandsvisar ett utkast av appen "klubben"
    När Anna schemalägger en påminnelse till alla i förhandsvisningen av appen "klubben" om ett ögonblick med ämnet "Prov"
    Så får Anna en påminnelse med ämnet "Prov"
    Och får Bertil ingen påminnelse

  Scenario: En påminnelse från någon som inte längre är medlem skickas inte
    Givet att Bertil har schemalagt en påminnelse till alla i appen "klubben" om ett ögonblick med ämnet "Fest"
    När Anna tar bort Bertils åtkomst till appen "klubben"
    Så får Anna ingen påminnelse
    Och får Bertil ingen påminnelse
