/**
 * Texter som är löften till användaren. Varje påstående i SAFETY_POINTS ska vara sant för
 * plattformen som den faktiskt är byggd — `test/texts.test.ts` låser dem. Lägg inte till något
 * som inte gäller (t.ex. att namn tas bort ur det du skriver).
 *
 * Att en människa läser koden stod länge här som ett exempel på vad plattformen INTE gör. Sedan
 * granskningen byggdes gör den det: ingen app går ut förrän en granskare har läst den och sagt ja
 * (`packages/builder/src/admin.ts`). Punkten om vem som ser appen är ändrad därefter — den sa
 * förut att bara du ser den tills du publicerar, och det är inte längre hela sanningen.
 */
import { REVIEW_STATES, type ReviewState } from '@vibesandbox/contracts';

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
  // Sant sedan granskningen byggdes. Punkten sa förut bara "bara du ser din app tills du
  // publicerar den" — men du publicerar inte längre själv, och den som granskar LÄSER koden.
  // Att inte säga det vore att låta henne tro att ingen annan sett appen.
  'Bara du ser din app medan du bygger den. Vill du publicera den begär du det, och då läser en ' +
    'förvaltare koden innan appen går ut. Sedan ser bara de du delar den med, efter att de loggat in.',
  // Konversationen är inte appen: den här punkten hindrar att punkten ovan läses som ett löfte
  // om att ingenting alls lämnar dig. Formuleringen ska stämma med knapparna i arbetsytan.
  'Säger du att byggverktyget inte hjälpte, skickas det du skriver och hela er konversation om appen till den som driver plattformen. Tummen upp räknas bara.',
];

// ── Begärd publicering: ägarens fyra lägen ─────────────────────────────────────
//
// Hon publicerar inte längre själv. Hon begär det, och någon läser koden. Texterna här är det
// enda hon har att gå på medan hon väntar, och tre av dem är lätta att skriva fel:
//
//   • `vantar` får inte låta som att hon missat ett steg. Det finns inget hon ska göra.
//   • `avvisad` ska bära granskarens skäl ORDAGRANT och säga vad hon kan göra härnäst. Ett avslag
//     utan väg vidare är en återvändsgränd.
//   • `tillbakadragen` är den farligaste. Ingen sa nej — ingen hann ens läsa. Läser hon det som
//     ett underkännande tror hon att appen är fel, när det enda som hänt är att hon byggde om.
//
// Inget av lägena är ett fel, och inget av dem skrivs som ett.

export const PUBLISH_REQUEST_BUTTON = 'Begär publicering';

/** Appen är redan ute. Det som begärs är att den NYA versionen ska ersätta den. */
export const PUBLISH_REQUEST_AGAIN_BUTTON = 'Begär publicering av senaste versionen';

export const PUBLISH_REQUEST_SENDING = 'Skickar…';

/** Står vid knappen, innan hon trycker: vad som faktiskt händer när hon gör det. */
export const PUBLISH_REQUEST_HINT =
  'När du begär publicering läser en människa koden innan appen går ut. Du får besked här.';

/** Samma sak sagt för en app som redan är publicerad — ändringen syns inte förrän den är läst. */
export const PUBLISH_REQUEST_AGAIN_HINT =
  'Ändringar syns för andra först när en ny version har lästs och publicerats.';

export interface ReviewOwnerText {
  /** Läget i några ord — det hon ser först. */
  readonly heading: string;
  /** Vad det betyder, och vad hon ska göra. Tom väg framåt är inget svar. */
  readonly body: string;
}

export const REVIEW_OWNER_TEXTS = {
  vantar: {
    heading: 'Väntar på granskning',
    body: 'Du har begärt att appen ska publiceras. Någon läser koden innan den går ut. Du behöver inte göra något — beskedet dyker upp här.',
  },
  godkand: {
    heading: 'Granskad och publicerad',
    body: 'Någon har läst koden och släppt ut appen. Nu kan du dela den med dina kollegor.',
  },
  avvisad: {
    heading: 'Publicerades inte',
    body: 'Den som läste koden tyckte att något behöver ändras först. Ändra det som står nedan och begär publicering igen — appen finns kvar precis som den är.',
  },
  // Ordet "nej" står här med flit, i nekad form. Det är just det hon annars läser in.
  tillbakadragen: {
    heading: 'Ingen hann läsa den',
    body: 'Du byggde om appen medan begäran låg i kö, så ingen hann läsa den version du begärde. Ingen har alltså sagt nej — begär publicering igen när du är nöjd, så läses den nya versionen.',
  },
} as const satisfies Record<ReviewState, ReviewOwnerText>;

/** Står före granskarens ord, så att det syns vems de är. */
export const REVIEW_REASON_LEAD = 'Så här skrev den som läste koden:';

/**
 * Lägets text. Ett läge vi inte känner igen läses som `vantar`: det enda vi då vet är att hon har
 * begärt något som ingen har berättat utgången av, och att säga "publicerad" eller "avvisad" om
 * det vore att hitta på ett besked åt henne.
 */
export function reviewOwnerText(state: string): ReviewOwnerText {
  // Kontraktets lista, inte `in`: `'toString' in objektet` är sant, och då hade ett skräpvärde
  // kunnat slå upp något som inte är en text alls.
  return REVIEW_STATES.includes(state as ReviewState) ? REVIEW_OWNER_TEXTS[state as ReviewState] : REVIEW_OWNER_TEXTS.vantar;
}
