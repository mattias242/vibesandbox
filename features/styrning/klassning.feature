# language: sv
Egenskap: Informationsklassning — hur känsliga uppgifter en app hanterar
  En app som bokar mötesrum och en app som samlar in sjukintyg är inte samma sak att förvalta,
  men i byggverktyget ser de likadana ut: någon skrev en mening, och det blev en app. Utan ett
  svar på hur känslig varje app är går plattformen inte att styra — och frågan kommer, från en
  tillsyn eller från den som ska godkänna att appen får användas.

  Nivån sätts ÅT den som bygger. Hon väljer den aldrig själv, och det är hela poängen: den som
  precis har löst sitt problem har varken lust eller anledning att sätta en strängare nivå på sig
  själv, och en självdeklaration hade blivit en ruta att klicka bort. Plattformen läser i stället
  beskrivningen, och gör bedömningen i bakgrunden.

  Tre regler bär upp det, och det är dem scenarierna nedan prövar.

  Ett ord i beskrivningen sätter en LÄGSTA nivå. Står det "personnummer" spelar det ingen roll
  vad bedömningen landar på — nivån blir minst så sträng. Bedömningen får höja över golvet, aldrig
  under det. Orden är grova med flit: de är ett golv, inte en klassning, och att sätta för strängt
  kostar nästan ingenting.

  Går bedömningen inte att göra gäller den strängaste nivån. Ett svar som inte går att tolka, ett
  fel hos språkmodellen, en tidsgräns — allt landar på samma ställe. "Vet ej" får aldrig bli
  "förmodligen ofarlig", för det är precis den appen ingen sedan tittar till. Av samma skäl står
  en app som ingen ännu har beskrivit som den strängaste nivån.

  Nivån höjs men sänks aldrig. Den som märker att ett ord väckte en strängare nivå ska inte kunna
  backa tillbaka genom att skriva om sig. Priset står vi för: en bedömning som gick fel åt det
  stränga hållet sitter kvar, och därför står det i registret HUR nivån sattes — så att den som
  förvaltar plattformen kan se skillnad på ett omdöme och ett misslyckande.

  Bedömningen sker efter de röda linjerna och före agenten. Ett stoppat önskemål bedöms inte alls:
  spärren före modellen vore meningslös om nästa steg ändå skickade texten dit.

  Registret svarar på att appen finns, vem som äger den och hur känslig den är — aldrig på vad
  någon har skrivit i den. Samma gräns som för stoppen: önskemålet kan bära personuppgifter, och
  styrningen får inte bli vägen som arkiverar dem.

  Bakgrund:
    Givet att Anna är inloggad i byggverktyget och får bygga
    Och att Erik är administratör för plattformen

  Scenario: Appen får den nivå bedömningen landar på
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "personuppgifter"
    När Anna ber om "En lista över vilka som anmält sig till utbildningen"
    Så blir bygget klart
    Och står Annas app som "personuppgifter" i AI-registret
    Och står det att plattformen läste beskrivningen

  Scenario: Ett ord i beskrivningen sätter en lägsta nivå som bedömningen inte får underskrida
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "öppen"
    När Anna ber om "Ett formulär där vi fyller i personnumret på deltagarna"
    Så står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att ett ord i beskrivningen satte nivån

  Scenario: Bedömningen får höja över den lägsta nivån
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "känsliga uppgifter"
    När Anna ber om "En lista över medarbetarnas kontaktuppgifter"
    Så står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att plattformen läste beskrivningen

  Scenario: Går bedömningen inte att göra gäller den strängaste nivån
    Givet att språkmodellen svarar med en giltig app
    Och att språkmodellen inte kan svara på hur känslig appen är
    När Anna ber om "En lista där vi bokar mötesrum"
    Så blir bygget klart
    Och står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att det inte gick att avgöra

  Scenario: Ett svar som inte går att tolka är inte ett svar
    Givet att språkmodellen svarar med en giltig app
    Och att språkmodellen svarar "oppen, men uppgifterna om hälsa gör den kanslig" om hur känslig appen är
    När Anna ber om "En lista där vi bokar mötesrum"
    Så står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att det inte gick att avgöra

  Scenario: Nivån höjs av ett senare önskemål
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "öppen"
    Och att Anna har beskrivit appen som "En lista där vi bokar mötesrum"
    Och att språkmodellen svarar med en ändrad app
    Och att plattformen bedömer önskemålet som "personuppgifter"
    När Anna ber om "Lägg till vem som bokade"
    Så står Annas app som "personuppgifter" i AI-registret

  Scenario: Nivån sänks aldrig av ett senare önskemål
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "personuppgifter"
    Och att Anna har beskrivit appen som "En lista över vilka som anmält sig till utbildningen"
    Och att språkmodellen svarar med en ändrad app
    Och att plattformen bedömer önskemålet som "öppen"
    När Anna ber om "Ta bort kolumnen med namn"
    Så blir bygget klart
    Och står Annas app som "personuppgifter" i AI-registret

  Scenario: Ett stoppat önskemål bedöms inte alls
    Givet att språkmodellen svarar med en giltig app
    När Anna ber om "Poängsätt alla elever efter hur de beter sig"
    Så fick språkmodellen aldrig se önskemålet
    Och står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att det inte gick att avgöra

  Scenario: En app som ingen har beskrivit står som strängast, utan tidpunkt
    Givet att Anna har börjat en app utan att beskriva den
    När Erik öppnar AI-registret
    Så står Annas app som "känsliga uppgifter" i AI-registret
    Och står det att det inte gick att avgöra
    Och står det ingen tidpunkt vid Annas app

  Scenario: Registret visar vem som äger appen och om den är ute
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "intern"
    Och att Anna har beskrivit appen som "En checklista inför uppstarten"
    Och att Anna har publicerat sin app
    När Erik öppnar AI-registret
    Så står Annas adress vid hennes app i registret
    Och står det att Annas app är publicerad
    Och står det när nivån sattes
    Och visas bara början av app-id:t i registret

  Scenario: Registret visar inte vad som skrevs
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "personuppgifter"
    Och att Anna har beskrivit appen som "En lista över vilka som anmält sig, börja med Anna Andersson"
    När Erik öppnar AI-registret
    Så nämns inget av önskemålet "En lista över vilka som anmält sig, börja med Anna Andersson" i registret

  Scenario: Den som bara får bygga ser inte registret
    Givet att Bertil är inloggad i byggverktyget och får bygga
    När Bertil öppnar AI-registret
    Så får han svaret "åtkomst nekad"

  Scenario: Beskrivningen hamnar aldrig i driftloggarna, inte heller nivån den fick
    Givet att språkmodellen svarar med en giltig app
    Och att plattformen bedömer önskemålet som "personuppgifter"
    När Anna ber om "En lista över vilka som anmält sig till utbildningen"
    Så står nivån i driftloggarna
    Och nämns inget av önskemålet "En lista över vilka som anmält sig till utbildningen" i driftloggarna
