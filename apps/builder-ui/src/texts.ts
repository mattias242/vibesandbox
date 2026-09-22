/**
 * Texter som är löften till användaren. Varje påstående i SAFETY_POINTS ska vara sant för
 * plattformen som den faktiskt är byggd — `test/texts.test.ts` låser dem. Lägg inte till något
 * som inte gäller (t.ex. att en människa granskar koden, eller att namn tas bort).
 */

export const SUGGESTIONS: readonly string[] = [
  'En todo-lista för vårt team',
  'En enkel enkät',
  'En lista där vi bokar mötesrum',
];

export const SAFETY_POINTS: readonly string[] = [
  'Appen körs på plattformens egen server och kan inte skicka uppgifter vidare till andra adresser på internet.',
  'Koden skrivs av en AI-modell hos en svensk leverantör.',
  'Personnummer, telefonnummer, e-postadresser, kortnummer och IBAN tas bort ur det du skriver innan det skickas till modellen. Namn tas inte bort — skriv inte in personuppgifter.',
  'Koden kontrolleras automatiskt innan den byggs.',
  // Sant sedan klassningen byggdes: klassen sätts ÅT den som bygger, signalord sätter ett golv
  // som modellsvaret bara får höja, och ett otolkbart svar ger den strängaste klassen.
  // Sista meningen är förbehållet, i samma anda som "fångar inte allt" nedan: nivån bygger på
  // det önskemålet BESKRIVER. Vad appen sedan matas med vet ingen vid klassningen.
  'Varje app får en nivå efter hur känsliga uppgifter den ska hantera. Klassen sätts åt dig — du ' +
    'väljer den aldrig själv — och vissa ord i det du skriver höjer den. Går klassningen inte att ' +
    'göra behandlas appen som den känsligaste. Nivån är en bedömning av det du beskrivit, inte av ' +
    'det appen sedan används till.',
  // Sant sedan de röda linjerna byggdes: prövningen sitter före språkmodellen, inte efter.
  // Förbehållet är inte en artighet — prövningen är mönsterbaserad och förstår inte sammanhang.
  // Utan den sista meningen vore punkten ett löfte plattformen inte kan hålla.
  'Beskriver du något som är förbjudet stoppas det innan någon kod skrivs, och ingen app byggs. ' +
    'Kontrollen letar efter kända mönster och fångar inte allt.',
  'Varje app har sin egen lagring som andra appar inte kommer åt.',
  'Bara du ser din app tills du publicerar den. Sedan ser bara de du delar den med, efter att de loggat in.',
  // Konversationen är inte appen: den här punkten hindrar att punkten ovan läses som ett löfte
  // om att ingenting alls lämnar dig. Formuleringen ska stämma med knapparna i arbetsytan.
  'Säger du att byggverktyget inte hjälpte, skickas det du skriver och hela er konversation om appen till den som driver plattformen. Tummen upp räknas bara.',
];
