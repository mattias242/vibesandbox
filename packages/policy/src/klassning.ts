/**
 * Klassningen: hur känsliga uppgifter appen kommer att hantera.
 *
 * Språkmodellens anrop ligger i `@vibesandbox/agent` och lämnar modellens RÅA text, eller `null`
 * när något gick fel. OMDÖMET bor här: vilket ord som betyder vilken klass, vilket golv
 * önskemålets egna ord sätter, och vad som händer när svaret inte går att tolka. Delningen finns
 * för att den som läser den här filen ska kunna avgöra om klassningen är rätt utan att veta något
 * om hur ett modellanrop görs.
 *
 * ## Riktningen på tveksamheten: hellre för strängt än för milt
 *
 * Den är den OMVÄNDA mot röda linjer. En för sträng klass kostar nästan ingenting — appen byggs
 * ändå, den får bara en strängare rad i AI-registret och en strängare hantering runt sig. En för
 * MILD klass betyder att uppgifter om enskilda hanteras som om de vore offentliga, och det
 * upptäcks först när skadan är skedd. Därför faller varje tveksamhet åt det stränga hållet:
 *
 *   - signalord i önskemålet sätter ett GOLV som modellens svar bara får HÖJA, aldrig underskrida;
 *   - ett svar som inte går att tolka som exakt ett klassord ger `STRICTEST_CLASSIFICATION`;
 *   - det gäller ÄVEN när ett signalord satt ett lägre golv. Vet vi inte, så vet vi inte.
 *
 * ## Signalorden är ett GOLV, inte en klassning
 *
 * Listan nedan gör inte klassningen — den hindrar bara modellen från att svara för milt. Därför
 * får den vara grov utan att göra skada: ett ord som träffar för brett ger en app en strängare
 * klass än den behövde, inte en felaktigt öppen. Vad listan däremot inte får vara är ETT ÄMNE.
 * Varje ord pekar på en UPPGIFTSTYP som faktiskt hamnar i appens databas ("personnummer",
 * "orosanmälan", "vårdnadshavare") — inte på vad appen handlar om. Skillnaden är att "en guide
 * till vår elevhälsa" bär inga elevuppgifter medan "en kö för elevhälsan" gör det, och att ett
 * ämnesord hade stoppat båda utan att någon förstått varför klassen blev vad den blev.
 *
 * Listan är också KORT med flit. Den ska gå att läsa i sin helhet av den som förvaltar
 * plattformen, och varje tillägg ska gå att motivera med en uppgiftstyp.
 *
 * ## Att vi bara prövar början av texten
 *
 * Bara de första `CLASSIFICATION_LIMITS.maxCheckedChars` tecknen prövas, av samma skäl som i
 * `redlines.ts`: en megabyte text ska inte kosta något att skicka in. Hålet är känt — den som vet
 * om gränsen kan lägga sitt signalord efter den. Den personen hade lika gärna kunnat formulera om
 * sig, och golvet är ändå bara ett komplement till modellens omdöme.
 *
 * ## Linjär tid
 *
 * Varje uttryck är en alternering av bokstavliga ord utan nästlade kvantifierare, och prövas med
 * `test` mot en text med en fast övre längd. Ingen indata kan göra klassningen långsam.
 */
import { CLASSIFICATIONS, STRICTEST_CLASSIFICATION } from '@vibesandbox/contracts';
import type { Classification, ClassificationSource } from '@vibesandbox/contracts';

export const CLASSIFICATION_LIMITS = {
  /** Så många tecken av önskemålet som prövas. Se filhuvudet om varför gränsen finns. */
  maxCheckedChars: 4000,
} as const;

/**
 * Samma normalisering som `redlines.ts`. Den är MEDVETET duplicerad: att lyfta ut den hade
 * krävt en ändring i `redlines.ts`, och de två filerna prövar olika saker åt olika håll — den
 * ena får hellre missa, den andra hellre träffa för brett. En delad hjälpfunktion hade bundit
 * ihop dem så att en justering för det ena syftet tyst ändrat det andra.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const INVISIBLE_CHARACTERS = /[​-‏⁠﻿]/g;
const WHITESPACE = /\s+/g;

/**
 * Tecken som får stå runt modellens ord utan att göra svaret otolkbart: blanktecken, punkt och
 * annan meningsskiljande interpunktion, citattecken av alla sorter, och asterisker (en modell som
 * fetstilar sitt svar skriver `**kanslig**`). Formatering är inte tvekan — men allt INNANFÖR de
 * här tecknen måste vara exakt ett klassord.
 */
const SURROUNDING_NOISE = /^[\s.,:;!?"'`*«»„“”‘’()[\]-]+|[\s.,:;!?"'`*«»„“”‘’()[\]-]+$/g;

/**
 * Signalord för `kanslig`. Uppgiftstyper som i sig gör hanteringen känslig: hälsa, socialtjänst,
 * facklig tillhörighet, etnicitet och religion, biometri, brottslighet, och skyddad identitet.
 * Det är i stort sett artikel 9-kategorierna översatta till de ord en kommunanställd faktiskt
 * skriver när hen beskriver sin app.
 */
const SENSITIVE_SIGNALS: readonly RegExp[] = [
  // Identitetsbärare som ensamma kopplar allt annat i appen till en namngiven person. Stammarna
  // slutar före ändelsen därför att svenskans bestämda form tappar ett e: `personnummer` blir
  // `personnumret`, inte `personnummeret`. Ett ord som slutar på -er behöver samma behandling.
  /(?<!\p{L})(?:personnum|samordningsnum|personnr)/u,
  // Hälsa. `journal` men inte `journalist` — presslistor är inte vårdhandlingar.
  /(?<!\p{L})(?:diagnos|sjukfrånvaro|sjukskriv|sjukintyg|läkarintyg|journal(?!ist)|patientuppgift)/u,
  // Socialtjänst och stöd till enskilda. `lss` måste stå som eget ord för att inte råka finnas i ett annat.
  /(?<!\p{L})(?:elevhälsa|socialtjänst|orosanmäl|missbruk|funktionsnedsättning)/u,
  /(?<!\p{L})lss(?!\p{L})/u,
  // Facklig tillhörighet, etnicitet och religion — egna kategorier i dataskyddsregelverket.
  /(?<!\p{L})(?:facklig|fackförbund|fackligt medlemskap|etnicitet|etniskt ursprung|religion|religiös|sexuell läggning)/u,
  // Biometri och brottslighet.
  /(?<!\p{L})(?:biometri|fingeravtryck|(?:brotts|belastnings)regist)/u,
  // Skyddad identitet: den enda uppgiften där ett läckage kan vara livsfarligt.
  /(?<!\p{L})(?:skyddad identitet|skyddade personuppgifter|skyddad adress)/u,
];

/**
 * Signalord för `personuppgift`. Ord som säger att appen kommer att innehålla uppgifter om
 * NAMNGIVNA personer — antingen uppgiftstypen själv (`e-postadress`, `personuppgift`) eller den
 * personkrets uppgifterna handlar om (`elev`, `brukare`, `vårdnadshavare`).
 *
 * Personkretsorden är med därför att det är så önskemål faktiskt skrivs: ingen skriver "appen ska
 * lagra namn och e-postadress", man skriver "en kö där brukarna ser sin plats". Motsatsen —
 * `deltagare`, `kollega`, `arbetsgruppen` — är medvetet UTE: de beskriver lika ofta en app helt
 * utan register över vem som är vem, och golvet ska inte trigga på varje enkät i kommunen.
 */
const PERSONAL_SIGNALS: readonly RegExp[] = [
  /(?<!\p{L})(?:e-?postadress|mejladress|mailadress|personuppgift|namn och adress)/u,
  /(?<!\p{L})(?:medarbetar|anställd|elev|invånar|vårdnadshavar)/u,
  // `brukare` men inte verbet `brukar` ("vi brukar boka rummet på fredagar").
  /(?<!\p{L})brukar(?:e|en|na|nas)(?!\p{L})/u,
  // `kund` i alla böjningar utom ordet `kunde`. Prefixet finns också i `sekund`, därav guarden före.
  /(?<!\p{L})kund(?!e(?!\p{L}))/u,
];

/** Golven prövas från strängast till mildast: det första som träffar är golvet. */
const SIGNAL_FLOORS: readonly (readonly [Classification, readonly RegExp[]])[] = [
  ['kanslig', SENSITIVE_SIGNALS],
  ['personuppgift', PERSONAL_SIGNALS],
];

/**
 * Gör texten jämförbar: styrtecken och osynliga tecken bort, allt till gemener, blanktecken till
 * ett enda mellanslag. Texten kapas FÖRE normaliseringen, så att en megabyte skräp aldrig behöver
 * skrivas om.
 */
function normalize(text: string): string {
  return text
    .slice(0, CLASSIFICATION_LIMITS.maxCheckedChars)
    .replace(CONTROL_CHARACTERS, '')
    .replace(INVISIBLE_CHARACTERS, '')
    .toLowerCase()
    .replace(WHITESPACE, ' ');
}

/**
 * Hur sträng en klass är. `CLASSIFICATIONS` står i stigande stränghet, så positionen ÄR svaret.
 *
 * Ett okänt värde läses som den strängaste klassen. Det spelar ingen roll för anropen här inifrån
 * — de kan bara få giltiga värden — men funktionen ska tåla ett värde som kommit ur en databas
 * skriven av en äldre version av plattformen, och då är `-1` från `indexOf` fel åt det farliga
 * hållet.
 */
function severity(value: string): number {
  const index = CLASSIFICATIONS.indexOf(value as Classification);
  return index === -1 ? CLASSIFICATIONS.indexOf(STRICTEST_CLASSIFICATION) : index;
}

/**
 * Tolkar modellens råa svar. `null` betyder "gick inte att tolka" — inte "ingen klass".
 *
 * Tolkningen är SNÄV: när skräpet runt ordet är borta måste det som återstår vara exakt ett av
 * klassorden. Ett svar med flera klassord, eller en hel mening runt ordet, går inte att tolka.
 * Skälet står i ett enda exempel: "oppen, men hälsouppgifterna gör den kanslig" får aldrig läsas
 * som `oppen`. Att i stället plocka det FÖRSTA klassordet ur en mening hade gjort just det.
 *
 * Snävheten gäller också stavningen: `känslig` och `öppen` är inte klassord, bara `kanslig` och
 * `oppen`. Modellen får de exakta orden i prompten, och den enda kostnaden för att vägra tolka en
 * variant är en strängare klass.
 */
function readClassification(answer: string | null): Classification | null {
  if (typeof answer !== 'string' || answer.length === 0) return null;
  const word = normalize(answer).replace(SURROUNDING_NOISE, '');
  return CLASSIFICATIONS.find((candidate) => candidate === word) ?? null;
}

/**
 * Golvet signalorden i önskemålet sätter, eller `null` om inget signalord finns.
 *
 * Golvet är inte en klassning: det säger bara hur milt modellen som lägst får svara. Samma text
 * ger alltid samma golv, så att en app som klassats om går att förklara.
 */
export function signalFloor(request: string): Classification | null {
  if (typeof request !== 'string' || request.length === 0) return null;
  const text = normalize(request);
  for (const [classification, signals] of SIGNAL_FLOORS) {
    if (signals.some((signal) => signal.test(text))) return classification;
  }
  return null;
}

/**
 * Tolkar modellens svar mot golvet och ger appens klass plus hur den blev vad den blev.
 *
 * Tre utfall, i den ordning de prövas:
 *
 *   1. Svaret går inte att tolka (`null`, tomt, flera klassord, en mening) ⇒ strängaste klassen
 *      med källan `fail-closed`. Ett signalord med ett lägre golv ändrar inte det: golvet är ett
 *      golv, inte ett svar, och att falla TILL golvet när vi inte vet hade varit att gissa milt.
 *   2. Modellen svarar strängare än golvet ⇒ modellens svar gäller, källan är `modell`.
 *   3. Annars gäller golvet, källan är `signalord`. Också när modellen råkade svara exakt golvet:
 *      det som avgjorde var golvet, och registret ska visa det.
 */
export function classify(input: { request: string; answer: string | null }): {
  classification: Classification;
  source: ClassificationSource;
} {
  const answered = readClassification(input.answer);
  if (answered === null) return { classification: STRICTEST_CLASSIFICATION, source: 'fail-closed' };

  const floor = signalFloor(input.request);
  if (floor === null) return { classification: answered, source: 'modell' };

  return severity(answered) > severity(floor)
    ? { classification: answered, source: 'modell' }
    : { classification: floor, source: 'signalord' };
}
