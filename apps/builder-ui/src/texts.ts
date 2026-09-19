/**
 * Texter som är löften till användaren. Varje påstående i SAFETY_POINTS ska vara sant för
 * plattformen som den faktiskt är byggd — `test/texts.test.ts` låser dem. Lägg inte till något
 * som inte gäller (t.ex. att en människa granskar koden, eller att uppgifter klassas).
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
  'Varje app har sin egen lagring som andra appar inte kommer åt.',
  'Bara du ser din app tills du publicerar den. Sedan ser bara de du delar den med, efter att de loggat in.',
];
