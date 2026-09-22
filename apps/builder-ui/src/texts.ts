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
import { APP_NAME_LIMITS, REVIEW_STATES, type ReviewState } from '@vibesandbox/contracts';
import { formatCount } from './format.ts';

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

// ── Appens namn ─────────────────────────────────────────────────────────────────
//
// En app som ägaren inte döpt får sitt namn av plattformen: de första tecknen ur hennes första
// önskemål. Det är begripligt i hennes egen lista — det är hennes egen text om hennes egen app —
// men det är inte ett namn hon har VALT, och därför följer det inte med till kontrollrummet.
//
// Texterna här säger inte det rakt ut. Att appen heter något provisoriskt är inget hon behöver
// åtgärda, och en uppmaning att döpa den hade läst som en tillsägelse. Knappen står där, och den
// som vill använda den gör det.

export const RENAME_BUTTON = 'Byt namn';

export const RENAME_LABEL = 'Vad ska appen heta?';

export const RENAME_SAVE = 'Spara namnet';

export const RENAME_SAVING = 'Sparar…';

export const RENAME_CANCEL = 'Avbryt';

/** Ett tomt fält är inget namn. Sagt som ett påpekande, inte som en anklagelse. */
export const RENAME_EMPTY = 'Skriv vad appen ska heta.';

/** Gränsen sagd med sin siffra: ett besked om "för långt" utan mått är inget att rätta sig efter. */
export function renameTooLong(): string {
  return `Namnet får vara högst ${APP_NAME_LIMITS.maxChars} tecken. Korta ner det lite.`;
}

/** Sagt när namnet sparats, för den som inte ser att rubriken ändrats. */
export const RENAME_DONE = 'Namnet är sparat.';

/** Står vid fältet: varför det är värt att döpa appen, utan att göra det till ett krav. */
export const RENAME_HINT =
  'Namnet syns i din lista och för den som förvaltar plattformen. Har du inte valt ett heter appen början av det du först bad om.';

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

// ── Avveckling och export: när appen ska sluta finnas ──────────────────────────
//
// Det här är den enda ytan i byggverktyget där ingenting går att ångra, och texterna är skrivna
// därefter. Tre regler har styrt dem:
//
//   • Exporten står FÖRE avvecklingen, i samma ruta. Det appen bär kan vara allmän handling, och
//     då får det inte försvinna för att någon tröttnat. Plattformen kan inte avgöra om just de
//     här uppgifterna är det — men vägen ut ska alltid finnas, och den ska synas först.
//   • Det ska stå EXAKT vad som raderas och exakt vad som blir kvar. "Appen tas bort" är inte
//     sant nog: registerposten står kvar med flit, och det ska ägaren veta innan hon trycker,
//     inte upptäcka efteråt.
//   • Ingen skrämsel, ingen förminskning. Inga versaler, inga utropstecken — men inte heller
//     "ta bort appen" som om det vore att stänga en flik. Avveckling ska vara lite jobbigt att
//     göra, och bekräftelsen är appens namn skrivet för hand: den som skriver fel namn har inte
//     den app hon tror framför sig.

export const DECOMMISSION_HEADING = 'Avveckla appen';

/** Står först i rutan: vad den är till för, och att ordningen mellan de två knapparna betyder något. */
export const DECOMMISSION_LEAD =
  'Behövs appen inte längre kan du avveckla den. Ladda ner innehållet först — efter avvecklingen ' +
  'finns det inte kvar någonstans att hämta det ifrån.';

export const EXPORT_BUTTON = 'Ladda ner appens innehåll';

export const EXPORT_BUSY = 'Hämtar…';

/**
 * Varför exporten finns, och varför den står före knappen som raderar. Meningen om allmän handling
 * är själva skälet — utan den ser nedladdningen ut som en bekvämlighet i stället för en skyldighet
 * någon kan ha. Förbehållet är lika viktigt: plattformen VET inte, och ska inte låtsas veta.
 */
export const EXPORT_WHY =
  'Uppgifter i en app hos en kommun kan vara allmän handling, och sådant får inte försvinna bara ' +
  'för att den som byggde appen har tröttnat. Plattformen kan inte avgöra om just dina uppgifter ' +
  'är det — men det ska alltid finnas en väg ut. Filen innehåller allt appen bär: det som lagts ' +
  'in i den, vilka filer som sparats och samtalet där appen byggdes.';

/** Vad som faktiskt hämtas, sagt kort vid knappen. En JSON-fil är inget ord att slänga ur sig. */
export const EXPORT_FORMAT_NOTE =
  'Du får en fil som går att spara och öppna senare. Den är gjord för att kunna läsas av ett ' +
  'program — behöver du den i en tabell kan någon göra en sådan av filen.';

/**
 * Vad som raderas. Räknat, inte sammanfattat: "appen tas bort" hade lämnat ägaren att själv gissa
 * om samtalet följer med. Det gör det.
 */
export const DECOMMISSION_WARNING =
  'Det här går inte att ångra. Det som raderas är uppgifterna som lagts in i appen, filerna som ' +
  'sparats i den, koden appen består av och samtalet där du byggde den. Adressen slutar svara, ' +
  'och appen försvinner ur din lista och ur listan hos dem du har delat den med.';

/**
 * Vad som blir kvar. Står som ett eget stycke och inte som en bisats: det är en följd ägaren har
 * rätt att känna till innan hon trycker, och den är avsiktlig — inte något plattformen glömt.
 */
export const DECOMMISSION_REMAINS =
  'Det här står kvar: att appen har funnits, vem som ägde den och vilken nivå den hade finns kvar ' +
  'i plattformens register. Det är med flit. Den som ska granska hur plattformen används måste ' +
  'kunna se att appen har funnits och att den togs bort. Själva uppgifterna i appen finns inte ' +
  'kvar där — bara spåret av att appen fanns.';

export const DECOMMISSION_CONFIRM_LABEL = 'Skriv appens namn för att bekräfta';

/** Vid rutan: precis vad som ska skrivas, och att det ska stämma bokstav för bokstav. */
export function decommissionConfirmHint(appName: string): string {
  return `Skriv ${appName} precis som det står, med samma stora och små bokstäver. Knappen nedanför öppnas när det stämmer.`;
}

export const DECOMMISSION_BUTTON = 'Avveckla appen för alltid';

export const DECOMMISSION_BUSY = 'Avvecklar…';

export const DECOMMISSION_DONE_HEADING = 'Appen är avvecklad';

/** Beskedet efteråt. Säger vad som hände och vad som står kvar — samma två saker som varningen. */
export const DECOMMISSION_DONE_BODY =
  'Uppgifterna och filerna är raderade och adressen svarar inte längre. Att appen har funnits ' +
  'står kvar i plattformens register.';

/** Länken vidare. Appen finns inte längre, så det finns ingenting att stanna kvar på. */
export const DECOMMISSION_DONE_LINK = 'Till mina appar';

/**
 * Gallringsbeviset i ord. Siffrorna räknades innan raderingen — efteråt finns inget att räkna —
 * och de står här därför att "appen är borta" inte säger någonting om hur mycket som försvann.
 */
export function decommissionEvidenceText(documentsDeleted: number, filesDeleted: number): string {
  const rader = documentsDeleted === 1 ? '1 sparad uppgift' : `${formatCount(documentsDeleted)} sparade uppgifter`;
  const filer = filesDeleted === 1 ? '1 fil' : `${formatCount(filesDeleted)} filer`;
  return `${rader} och ${filer} raderades.`;
}

/**
 * Namnet på filen ägaren får. Appens namn OCH datumet, eftersom en export utan datum är omöjlig
 * att skilja från en annan när den legat i hämtningsmappen ett halvår.
 *
 * Namnet är appens, och appens namn är skrivet av en människa: mellanslag, punkter och snedstreck
 * hör inte hemma i ett filnamn, så allt som inte är en bokstav eller en siffra blir ett bindestreck.
 * Bokstäverna behålls som de är — å, ä och ö är bokstäver, och en app som heter "Anmälan" ska inte
 * bli "anm-lan".
 */
export function exportFileName(appName: string, at: Date): string {
  const stem =
    appName
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'app';
  const day = Number.isNaN(at.getTime()) ? 'utan-datum' : at.toISOString().slice(0, 10);
  return `${stem}-${day}.json`;
}
