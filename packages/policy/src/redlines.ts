/**
 * Röda linjer: förbjuden användning stoppas INNAN språkmodellen får skriva en rad kod.
 *
 * Kategorierna följer EU:s AI-förordnings förbjudna användningar plus plattformens egen gräns
 * mot beslut om enskilda utan en människa. Prövningen är MÖNSTERBASERAD, som resten av det här
 * paketet, och därmed ett försvar på djupet — inte en garanti. Den förstår inte sammanhang.
 *
 * ## Riktningen på tveksamheten: hellre släppa igenom än stoppa fel
 *
 * De två felen är inte lika illa. En MISSAD träff betyder att appen byggs — och då möter den
 * plattformens CSP, ingen nätåtkomst alls, och en människa före publicering. En FALSK träff
 * betyder att den som ville bygga en mötesrumsbokning blir nekad, inte förstår varför, och aldrig
 * hör av sig. Det andra felet är tystare och därför värre. Därför:
 *
 *   - varje kategori kräver att texten beskriver en ANVÄNDNING, inte bara nämner ett ord;
 *   - en mening som innehåller ett nekande prövas inte alls;
 *   - reglerna börjar smalt, och kontrollrummet visar vad som stoppats så att en för bred regel
 *     upptäcks av den som förvaltar plattformen i stället för av en uppgiven användare.
 *
 * ## Att vi bara prövar början av texten
 *
 * Bara de första `REDLINE_LIMITS.maxCheckedChars` tecknen prövas. Det är ett medvetet val med ett
 * känt hål: den som VET om gränsen kan lägga sin beskrivning efter den. Den personen hade lika
 * gärna kunnat formulera om sig — mönster hindrar ändå ingen som försöker. Gränsen finns för att
 * en megabyte text inte ska kosta något att skicka in, och för att de verkliga skydden ligger
 * efter det här steget.
 *
 * ## Linjär tid
 *
 * Varje uttryck är en alternering av bokstavliga ord utan nästlade kvantifierare, och prövas med
 * `test` mot en text med en fast övre längd. Ingen indata kan göra prövningen långsam.
 */
import { REDLINE_CATEGORIES } from '@vibesandbox/contracts';
import type { RedlineCategory } from '@vibesandbox/contracts';

export const REDLINE_LIMITS = {
  /** Så många tecken av önskemålet som prövas. Se filhuvudet om varför gränsen finns. */
  maxCheckedChars: 4000,
} as const;

/** Styrtecken bär ingen mening och används för att bryta isär ord för ögat men inte för läsaren. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Osynliga tecken (nollbreddsmellanslag och liknande) döljer sig mitt i ett ord. */
const INVISIBLE_CHARACTERS = /[​-‏⁠﻿]/g;
const WHITESPACE = /\s+/g;

/**
 * Meningar avgränsas av punkt, frågetecken och utropstecken — inte av radbrytning. Ett önskemål
 * skrivet på flera rader är oftast EN mening, och skulle annars falla isär i fragment som inte
 * matchar något.
 */
const SENTENCE_BOUNDARY = /[.!?]+/;

/**
 * Nekanden. En mening som bär ett av dem prövas inte: "vi vill INTE ha ansiktsigenkänning" är
 * inte en beskrivning av ansiktsigenkänning. Nekandet gäller hela meningen, oavsett var det
 * står — "identifiera besökare med ansiktsigenkänning ska vi inte göra" slutar med nekandet.
 *
 * `utan` och `without` är undantagna när de INLEDER själva den förbjudna användningen: "utan
 * handläggare" och "utan att de märker det" är det som ÄR den röda linjen, inte ett nekande.
 */
const NEGATION = [
  /(?<!\p{L})(?:inte|aldrig|ingen|inget|inga|never)(?!\p{L})/u,
  /(?<!\p{L})utan(?!\p{L})(?!\s+(?:att|handläggare|handläggaren|mänsklig|manuell))/u,
  /(?<!\p{L})without(?!\p{L})(?!\s+(?:a\s+)?(?:caseworker|human|anyone))/u,
];

/**
 * En regel är en uppsättning uttryck som ALLA måste finnas i samma mening. En kategori stoppar
 * när någon av dess regler slår till. Att kräva flera uttryck är hela skillnaden mellan "texten
 * nämner ansiktsigenkänning" och "texten beskriver att ansiktsigenkänning ska användas".
 */
type Rule = readonly RegExp[];

const RULES: Readonly<Record<RedlineCategory, readonly Rule[]>> = {
  'social-poangsattning': [
    [
      /(?:poängsätt|poangsatt|poängsatt|rangordna|betygsätt|(?<!\p{L})rank(?:a|as|ar|ade|ing|ed|s)?(?!\p{L})|(?<!\p{L})scor(?:e|es|ed|ing)(?!\p{L}))/u,
      /(?:invånar|medborgar|medarbetar|människor|personer|anställda|elever|klienter|brukare|citizens|people|employees|individuals|residents)/u,
    ],
  ],
  kansloigenkanning: [
    // Ordet i sig beskriver redan användningen — det finns ingen ofarlig känsloigenkänning.
    [/(?:känsloigenkänning|emotion recognition|sentiment analysis)/u],
    [
      /(?:läsa av|läser av|analyser|analyz|analyse|känna igen|detect|mäta|mäter|tolka)/u,
      /(?:känslor|känslorna|humör|sinnesstämning|emotion|mood)/u,
    ],
  ],
  biometri: [
    [
      // Medvetet UTAN ordet "igenkänning": det finns i "ansiktsigenkänning" och hade gjort varje
      // omnämnande till en träff, också frågan "vad är skillnaden mellan biometri och …?".
      /(?:identifier|identify|logga in|loggar in|log in|login|låsa upp|låser upp|unlock|verifier|authenticate|känna igen besökar)/u,
      /(?:ansiktsigenkänning|facial recognition|face recognition|fingeravtryck|fingerprint|irisskanning|biometrisk|biometri)/u,
    ],
  ],
  'prediktiv-brottsbekampning': [
    [
      /(?:förutsäg|förutspå|förutse|predict|räkna ut|beräkna|bedöma risk|riskbedöm)/u,
      /(?:brott|brottslig|återfall|recidivism|crime|crimes|criminal)/u,
    ],
  ],
  'automatiskt-beslut-om-enskild': [
    [
      /(?:automatisk|automatically|utan handläggar|utan mänsklig|without a caseworker|without human)/u,
      /(?:bevilja|beviljas|avslå|avslås|besluta|beslut|godkänn|approve|reject|deny|grant)/u,
      // Beslutet måste gälla en enskilds sak. Utan det här ledet stoppas "rummet godkänns
      // automatiskt om det är ledigt", och då står spärren i vägen för det plattformen finns till.
      /(?:ansökan|ansökning|ansökningar|bidrag|ärende|försörjningsstöd|application|benefit|claim)/u,
    ],
  ],
  manipulation: [
    [/(?:dark pattern|mörka mönster|subliminal)/u],
    [
      /(?:påverka|påverkar|manipuler|utnyttja|utnyttjar|influence|exploit)/u,
      /(?:märker|märka|omedvetet|sårbar|osäkra|utsatta|without knowing|without noticing)/u,
    ],
  ],
};

/**
 * Gör texten jämförbar: styrtecken och osynliga tecken bort, allt till gemener, blanktecken till
 * ett enda mellanslag. Radbrytningar blir mellanslag, inte meningsslut.
 *
 * Texten kapas FÖRE normaliseringen, så att en megabyte skräp aldrig behöver skrivas om.
 */
function normalize(request: string): string {
  return request
    .slice(0, REDLINE_LIMITS.maxCheckedChars)
    .replace(CONTROL_CHARACTERS, '')
    .replace(INVISIBLE_CHARACTERS, '')
    .toLowerCase()
    .replace(WHITESPACE, ' ');
}

function isNegated(sentence: string): boolean {
  return NEGATION.some((pattern) => pattern.test(sentence));
}

function matches(sentence: string, rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.every((pattern) => pattern.test(sentence)));
}

/**
 * Prövar ett önskemål mot de röda linjerna.
 *
 * `null` betyder inget hinder. En kategori betyder stoppa: jobbet ska avslutas innan agenten
 * startar, och den som bad om appen få veta varför i klarspråk.
 *
 * Träffar texten flera kategorier väljs den första i `REDLINE_CATEGORIES`-ordning — aldrig den
 * som råkar stå först i texten. Samma text ska alltid ge samma svar, så att ett stopp går att
 * känna igen och en regel går att utvärdera.
 */
export function checkRedlines(request: string): RedlineCategory | null {
  if (typeof request !== 'string' || request.length === 0) return null;
  const sentences = normalize(request)
    .split(SENTENCE_BOUNDARY)
    .filter((sentence) => sentence.trim().length > 0 && !isNegated(sentence));
  if (sentences.length === 0) return null;

  for (const category of REDLINE_CATEGORIES) {
    const rules = RULES[category];
    if (sentences.some((sentence) => matches(sentence, rules))) return category;
  }
  return null;
}
