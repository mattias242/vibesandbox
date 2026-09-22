# language: sv
Egenskap: Appen får ett namn som ägaren själv har valt
  En app utan namn får ett av plattformen: de första tecknen ur det första önskemålet. Det är
  bättre än ingenting i ägarens egen lista — det är hennes egen text om hennes egen app — men
  det är inte ett namn hon har valt. Och eftersom texten kan bära personuppgifter följer den
  inte med till kontrollrummet: där står "Namnlös app" i stället, och den som förvaltar
  plattformen ser en lista där ingenting går att skilja åt.

  Därför ska ägaren kunna döpa sin app. Ett namn hon har skrivit är hennes val om vad appen är,
  inte en avskrift av vad hon råkade be om, och det får därför visas överallt: i hennes lista, i
  kontrollrummet, i granskningskön och i mejlet när hon delar appen.

  Namnet går att sätta när som helst — vid skapandet, mitt i bygget, efter publiceringen. Det är
  en etikett, inte ett beslut, och ska gå att ändra sig om.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga

  Scenario: Anna döper sin app medan hon bygger
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    När Anna döper appen till "Bokning av mötesrum"
    Så heter appen "Bokning av mötesrum" i Annas lista

  Scenario: Ett namn Anna själv har valt syns i kontrollrummet
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    Och att Erik är administratör för plattformen
    När Anna döper appen till "Bokning av mötesrum"
    Så står Annas app som "Bokning av mötesrum" i kontrollrummet

  Scenario: Ett namn plattformen skrivit av syns inte i kontrollrummet
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    Och att Erik är administratör för plattformen
    När Erik öppnar kontrollrummet
    Så står Annas app som "Namnlös app" i kontrollrummet
    Och nämns inget av önskemålet i kontrollrummet

  Scenario: Anna ändrar sig om namnet
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    Och att Anna har döpt appen till "Bokning av mötesrum"
    När Anna döper appen till "Rumsbokning"
    Så heter appen "Rumsbokning" i Annas lista

  Scenario: Ett namn plattformen skrivit av skriver aldrig över ett Anna valt
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har döpt appen till "Bokning av mötesrum"
    När Anna ber om "En lista där vi bokar mötesrum"
    Så heter appen "Bokning av mötesrum" i Annas lista

  Scenario: Ett tomt namn är inget namn
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    När Anna försöker döpa appen till " "
    Så får hon svaret "ogiltig begäran"

  Scenario: Andra kan inte döpa om Annas app
    Givet att språkmodellen svarar med en giltig app
    Och att Anna har en app som byggts klart
    Och att Bertil är inloggad i byggverktyget och får bygga
    När Bertil försöker döpa om Annas app
    Så får han svaret "finns inte"
