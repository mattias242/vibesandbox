# language: sv
@tjanst-roles @pågår
Egenskap: Roller inuti en app
  En app kan behöva skilja på dem som använder den: en handläggare ser ärendelistan,
  en administratör ser inställningarna. Appen bestämmer vilka roller som finns, och
  ägaren bestämmer vem som har vilken roll. Alla medlemmar kan se vilka som finns i appen
  och vilka roller de har — med namn, aldrig med e-postadress.

  En roll styr vad appen visar. Den skyddar inte data: den som kommer åt appen kommer åt
  appens gemensamma data oavsett roll. Det är personliga kollektioner som skyddar data.

  Bakgrund:
    Givet att Anna äger appen "Ärenden" och har delat den med Bertil och Cecilia

  Scenario: Ägaren inför roller som alla i appen kan se
    När Anna inför rollerna "handlaggare" och "admin"
    Så ser Bertil att appen har rollerna "handlaggare" och "admin"

  Scenario: Ägaren ger en medlem en roll
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    När Anna ger Bertil rollen "handlaggare"
    Så har Bertil rollen "handlaggare" när han frågar appen vem han är
    Och har Cecilia inga roller när hon frågar appen vem hon är

  Scenario: Medlemmarna visas med namn och roll, aldrig med e-postadress
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att Anna har gett Cecilia rollen "admin"
    När Bertil hämtar appens medlemmar
    Så är Anna ägare, och Bertil och Cecilia användare, i listan
    Och har Cecilia rollen "admin" i listan
    Och innehåller listan inga e-postadresser

  Scenario: Den som inte äger appen kan inte införa roller
    När Bertil försöker införa rollen "admin"
    Så får han svaret "åtkomst nekad"

  Scenario: Den som inte äger appen kan inte dela ut roller, inte ens till sig själv
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    När Bertil försöker ge sig själv rollen "admin"
    Så får han svaret "åtkomst nekad"
    Och har Bertil inga roller när han frågar appen vem han är

  Scenario: En roll som appen inte har infört går inte att dela ut
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    När Anna försöker ge Bertil rollen "chef"
    Så får hon svaret "ogiltig begäran"

  Scenario: Roller går bara att ge till appens medlemmar
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    När Anna försöker ge rollen "admin" till någon som inte är medlem i appen
    Så får hon svaret "finns inte"

  Scenario: Den som tagits bort ur appen har inte kvar sina roller
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att Anna har gett Bertil rollen "admin"
    När Bertil tas bort ur appen
    Och Anna hämtar appens medlemmar
    Så finns Bertil inte i listan
    Och har ingen i listan rollen "admin"

  Scenario: En roll som tas bort försvinner från alla som hade den
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att Anna har gett Bertil rollen "admin"
    När Anna inför rollerna "handlaggare" och "granskare"
    Så har Bertil inga roller när han frågar appen vem han är

  Scenario: Förhandsvisningen har egna roller, så att ett utkast inte kan ändra den publicerade appens
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att appen "Ärenden" har ett utkast
    När Anna inför rollerna "test" och "prov" i förhandsvisningen
    Så ser Bertil att appen har rollerna "handlaggare" och "admin"

  Scenario: En annan app ser inte appens roller
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att Anna också äger appen "Kassan"
    När Anna frågar appen "Kassan" vilka roller den har
    Så har appen inga roller

  Scenario: En roll skyddar inte appens gemensamma data
    Givet att Anna har infört rollerna "handlaggare" och "admin"
    Och att Anna har sparat ett dokument i appens gemensamma kollektion "installningar"
    När Bertil, som inte har rollen "admin", listar kollektionen "installningar"
    Så ser han Annas dokument

  Scenariomall: Ett ogiltigt roll-id avvisas
    När Anna försöker införa en roll med id "<id>"
    Så får hon svaret "ogiltig begäran"

    Exempel:
      | id              |
      | ../admin        |
      | Admin           |
      | __proto__       |
      | admin/../chef   |
      | a b             |
      |                 |

  Scenario: En app kan inte ha hur många roller som helst
    När Anna försöker införa 21 roller
    Så får hon svaret "ogiltig begäran"
