/**
 * Kontrollrummets texter och de små beslut som går att pröva utan webbläsare.
 *
 * Applistan är ren läsning: den ÄNDRAR ingenting i någon app. Den ger två vägar in — till
 * arbetsytan och till appen som den körs — och båda är genvägar, inte nycklar. Vem som kommer in
 * avgörs av ägarskap och delning, inte av att en länk finns, och texten vid listan säger det rakt
 * ut så att ingen tror sig ha fått en behörighet hen inte har.
 *
 * Adresslistan är vyns enda del som ändrar något. Den ändrar först när servern svarat: varje
 * funktion här tar emot SERVERNS rad och bygger besked eller ny lista av den, aldrig av det
 * någon hann klicka på.
 */
import {
  ADMIN_TOKEN_WINDOW_DAYS,
  CLASSIFICATION_SOURCES,
  REDLINE_CATEGORIES,
  REVIEW_LIMITS,
  asClassification,
  type AdminReview,
  type AdminStop,
  type AdminUser,
  type Classification,
  type ClassificationSource,
  type RedlineCategory,
  type Role,
} from '@vibesandbox/contracts';
import { ApiError } from './api.ts';
import { errorMessage } from './client.ts';
import { validateEmail, type EmailValidation } from './share.ts';

export const ADMIN_TITLE = 'Kontrollrummet';

/** Länken i rubrikraden. Visas bara för den som bär rollen — men servern är den som avgör. */
export const ADMIN_LINK_LABEL = 'Kontrollrummet';

export const ADMIN_LEAD =
  'Här ser du alla appar i plattformen, också dem som andra har byggt, och bestämmer vilka som får logga in.';

/**
 * Den som saknar rollen möts av servern med 403. Det ska läsas som ett besked, inte som ett fel:
 * ingenting är trasigt, kontot har bara inte den behörigheten.
 */
export const ADMIN_FORBIDDEN =
  'Kontrollrummet är bara för dig som administrerar plattformen. Ditt konto har inte den behörigheten.';

export const ADMIN_LOADING = 'Hämtar plattformens appar och adresser…';

export const ADMIN_EMPTY = 'Inga appar ännu. Den första någon bygger dyker upp här.';

export const ADMIN_FIGURES_HEADING = 'Så ser plattformen ut just nu';

export const ADMIN_APPS_HEADING = 'Alla appar';

/** Sagt en gång, vid listan: vad länkarna är, och vad de inte är. */
export const ADMIN_ID_NOTE =
  'Varje app har två länkar: en till arbetsytan där den byggs, och en till appen som den körs. De är genvägar, inte nycklar — arbetsytan är bara ägarens, och appen öppnas bara av den som äger eller har fått den delad. Andras appar möts av samma besked som en app som inte finns, precis som förut.';

/** Länkarna i applistan. Två ord var: de står i en tabellcell, inte i en mening. */
export const ADMIN_APP_EDIT_LINK = 'Öppna arbetsytan';
export const ADMIN_APP_OPEN_LINK = 'Öppna appen';

/** Sagt om den app som ännu inte har något att öppna — i stället för en länk som inte leder någonstans. */
export const ADMIN_APP_NOTHING_TO_OPEN = 'Inget byggt ännu';

/** "Tokens" är modellens mått. Sagt en gång, i vanliga ord, så att siffrorna betyder något. */
export const ADMIN_TOKENS_NOTE = `Tokens är måttet på hur mycket text modellen läst och skrivit. Siffrorna för plattformen gäller de senaste ${ADMIN_TOKEN_WINDOW_DAYS} dygnen; siffrorna i listan gäller varje app sedan den skapades.`;

/**
 * Appen HAR en ägare — byggverktyget vet vem som skapade den. Det som saknas är adressen:
 * appar som fanns innan control hade en åtkomstlista fick sin ägarrad vid en omstart, och då
 * skickas `null` som adress eftersom byggverktyget aldrig sparar e-postadresser
 * (`packages/builder/src/atkomst.ts`). "Saknar ägare" vore alltså osant och oroande.
 */
export const ADMIN_OWNER_MISSING = 'Adressen är inte känd';

export interface AppStatus {
  readonly label: string;
  readonly published: boolean;
  /** En kort tilläggsupplysning, när läget behöver mer än en etikett. */
  readonly note: string | null;
}

/**
 * Appens läge i ett ord. En publicerad app som fått ett nyare utkast är fortfarande publicerad —
 * men det som syns för andra är inte det senaste, och det är värt att veta.
 */
export function statusOf(app: { readonly published: boolean; readonly hasDraft: boolean }): AppStatus {
  if (app.published) {
    return { label: 'Publicerad', published: true, note: app.hasDraft ? 'Ändrad sedan publiceringen' : null };
  }
  if (app.hasDraft) return { label: 'Utkast', published: false, note: null };
  return { label: 'Inte byggd än', published: false, note: null };
}

/** 403 här betyder en sak, och den ska sägas rakt ut. Övriga fel är redan klarspråk. */
export function adminErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return ADMIN_FORBIDDEN;
  return errorMessage(error);
}

// ── Vilka som får logga in ──────────────────────────────────────────────────────
//
// Kontraktets roller heter `admin`, `builder` och `viewer`. De orden säger ingenting för den som
// ska välja en roll åt en kollega, så vyn använder svenska namn — och en mening om vad var och en
// faktiskt får göra, eftersom skillnaden mellan dem inte är självklar.

/** Rollerna i ordning, den som får mest först. Samma ordning i listan, i menyerna och i siffrorna. */
export const ROLES: readonly Role[] = ['admin', 'builder', 'viewer'];

export interface RoleText {
  /** Rollens namn i gränssnittet. Ett svenskt ord, aldrig kontraktets engelska. */
  readonly label: string;
  /** Vad rollen får göra, i en mening. Står vid listan, inte i varje meny. */
  readonly explanation: string;
}

export const ROLE_TEXTS: Readonly<Record<Role, RoleText>> = {
  admin: {
    label: 'Förvaltare',
    explanation: 'Ser kontrollrummet och alla appar i plattformen, och bestämmer vilka som får logga in.',
  },
  builder: {
    label: 'Byggare',
    explanation: 'Bygger egna appar och delar dem med kollegor. Ser bara sina egna appar, inte andras.',
  },
  viewer: {
    label: 'Besökare',
    explanation: 'Loggar in och använder de appar någon annan har delat. Bygger inga egna appar.',
  },
};

export function roleLabel(role: Role): string {
  return ROLE_TEXTS[role].label;
}

export const ADMIN_USERS_HEADING = 'Vilka får logga in';

export const ADMIN_USERS_LEAD =
  'Bara adresserna i listan kan logga in i plattformen. Rollen avgör vad personen får göra när hen väl är inne.';

/** Kolumnrubrikerna i adresslistan. Adressen är radens rubrik, så att en cell hör ihop med en person. */
export const ADMIN_USERS_COLUMNS = {
  email: 'Adress',
  role: 'Roll',
  created: 'Inbjuden',
  change: 'Ändra roll',
} as const;

/**
 * Varför den egna raden saknar knapp. Servern nekar ändå (`invalid_request`), men en knapp som
 * bara kan misslyckas är ett löfte vyn inte kan hålla — och följden av att lyckas vore värre:
 * en förvaltare som sänker sig själv kommer inte in igen utan hjälp direkt vid servern.
 */
export const ADMIN_SELF_NOTE =
  'Det här är du. Din egen roll går inte att ändra härifrån — den som sänker sig själv stänger ute sig själv, och då krävs hjälp direkt vid servern för att komma in igen.';

export const ADMIN_INVITE_HEADING = 'Bjud in en adress';

export const ADMIN_INVITE_NOTE =
  'Den inbjudna kan logga in med en kod som kommer till mejlen. Finns adressen redan får den rollen du väljer här, men bara uppåt — en roll sänks i listan nedanför.';

export const ADMIN_INVITE_EMAIL_LABEL = 'E-postadress';
export const ADMIN_INVITE_ROLE_LABEL = 'Roll';
export const ADMIN_INVITE_BUTTON = 'Bjud in';
export const ADMIN_INVITE_SENDING = 'Skickar…';

/** Menyn i en rad. Etiketten är dold för ögat men finns för skärmläsaren — utan adressen i sig. */
export const ADMIN_ROLE_SELECT_LABEL = 'Ny roll för den här raden';
export const ADMIN_ROLE_BUTTON = 'Spara';
export const ADMIN_ROLE_SAVING = 'Sparar…';

export const ADMIN_EMPTY_EMAIL = 'Skriv adressen till den som ska få logga in.';
export const ADMIN_INVALID_EMAIL = 'Det ser inte ut som en e-postadress. Kontrollera den och försök igen.';

/** Behörigheten kan ha tagits bort mitt i sessionen. Då är inget trasigt — sidan är bara gammal. */
export const ADMIN_WRITE_FORBIDDEN =
  'Ditt konto får inte längre ändra vilka som kan logga in. Ladda om sidan så ser du vad du kommer åt.';

export const ADMIN_CONFLICT =
  'Någon annan ändrade samma adress samtidigt, så ändringen gjordes inte. Ladda om sidan så ser du hur det blev.';

export const ADMIN_RATE_LIMITED = 'Du har gjort många ändringar på kort tid. Vänta en stund och försök igen.';

/** Servern avvisar den egna raden. Vyn erbjuder det aldrig, men svaret ska ändå gå att läsa. */
export const ADMIN_SELF_REFUSED = 'Du kan inte ändra din egen roll.';

const ADMIN_WRITE_UNKNOWN = 'Det gick inte att spara ändringen. Försök igen om en stund.';

/**
 * Adressen skrivs bara ut på det som syns — i cellen och i beskedet. Aldrig i ett `aria-label`,
 * en `title` eller ett `id`: sådant följer med i en skärmläsares historik utan att någon bett om det.
 */
export function invitedMessage(user: AdminUser, existed: boolean): string {
  return existed
    ? `${user.email} har nu rollen ${roleLabel(user.role)}.`
    : `${user.email} är inbjuden som ${roleLabel(user.role)} och kan logga in.`;
}

export function roleChangedMessage(user: AdminUser): string {
  return `${user.email} har nu rollen ${roleLabel(user.role)}.`;
}

/** Fel som betyder samma sak vilken väg man än gick. `undefined` ⇒ vägen får säga det själv. */
function sharedWriteMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return ADMIN_WRITE_UNKNOWN;
  if (error.status === 403) return ADMIN_WRITE_FORBIDDEN;
  if (error.status === 409) return ADMIN_CONFLICT;
  if (error.status === 429) return ADMIN_RATE_LIMITED;
  if (error.status === 400) return undefined;
  return error.message;
}

/** 400 vid en inbjudan betyder att adressen inte dög — det är det enda fältet som skickades. */
export function inviteErrorMessage(error: unknown): string {
  return sharedWriteMessage(error) ?? ADMIN_INVALID_EMAIL;
}

/** 400 vid en rolländring betyder att raden var den egna. Adressen är serverns, inte något man skrev. */
export function roleErrorMessage(error: unknown): string {
  return sharedWriteMessage(error) ?? ADMIN_SELF_REFUSED;
}

/**
 * Adressen kontrolleras en gång till här, så att en uppenbar felskrivning möts på plats i stället
 * för av servern. Mönstret är delningens — samma regel ska gälla på båda ställena.
 */
export function validateInviteEmail(input: string): EmailValidation {
  if (input.trim() === '') return { ok: false, message: ADMIN_EMPTY_EMAIL };
  const checked = validateEmail(input);
  return checked.ok ? checked : { ok: false, message: ADMIN_INVALID_EMAIL };
}

/**
 * Serverns rad läggs in i listan: den ersätter raden med samma `userId` på dess plats, annars
 * läggs den sist. Ordningen är serverns och rörs aldrig av vyn.
 */
export function withUser(users: readonly AdminUser[], user: AdminUser): AdminUser[] {
  const index = users.findIndex((row) => row.userId === user.userId);
  if (index < 0) return [...users, user];
  const next = [...users];
  next[index] = user;
  return next;
}

/**
 * Siffrorna per roll, räknade ur listan. Efter en ändring stämmer panelen då fortfarande med
 * tabellen under den — två svar på samma fråga får inte säga olika saker på samma sida.
 */
export function countRoles(users: readonly AdminUser[]): { admin: number; builder: number; viewer: number } {
  const counts = { admin: 0, builder: 0, viewer: 0 };
  for (const user of users) counts[user.role] += 1;
  return counts;
}

// ── Röda linjer: önskemål som stoppats innan något byggdes ──────────────────────

export const ADMIN_STOPS_HEADING = 'Stoppade önskemål';

/**
 * Kontraktets kategorikoder är maskintext. En förvaltare ska förstå vad som stoppades utan att
 * kunna regelverket, så varje kod har en rubrik i vanliga ord och en mening som förklarar
 * användningen. En paragrafhänvisning förklarar ingenting och är därför förbjuden i testet.
 */
export interface RedlineText {
  readonly label: string;
  readonly explanation: string;
}

export const REDLINE_TEXTS: Readonly<Record<RedlineCategory, RedlineText>> = {
  'social-poangsattning': {
    label: 'Poängsättning av människor',
    explanation: 'Att ge människor poäng eller rangordna dem efter hur de beter sig eller vilka de är.',
  },
  kansloigenkanning: {
    label: 'Känsloigenkänning',
    explanation: 'Att läsa av hur människor känner sig, på en arbetsplats eller i en skola.',
  },
  biometri: {
    label: 'Biometrisk identifiering',
    explanation: 'Att känna igen vem någon är på kroppen — ansikte, fingeravtryck eller något liknande.',
  },
  'prediktiv-brottsbekampning': {
    label: 'Förutsägelser om brott',
    explanation: 'Att räkna ut att en viss person kommer att begå ett brott.',
  },
  'automatiskt-beslut-om-enskild': {
    label: 'Beslut utan människa',
    explanation: 'Att avgöra någons ärende eller bidrag utan att en människa prövar saken.',
  },
  manipulation: {
    label: 'Manipulation',
    explanation: 'Att påverka någon utan att hen märker det, eller utnyttja att någon är i underläge.',
  },
};

/** Sagt vid listan: varför det bara står en kategori och aldrig vad som skrevs. */
export const ADMIN_STOPS_PRIVACY_NOTE =
  'Här står bara vilken sorts användning som stoppades, aldrig vad någon skrev. Ett önskemål kan ' +
  'innehålla personuppgifter, och ett stopp ska inte bli stället där just sådant sparas.';

/** Listans egentliga syfte: den säger mer om reglerna än om dem som skrev. */
export const ADMIN_STOPS_PATTERN_NOTE =
  'Återkommer samma gräns ofta är det troligare att regeln är för bred än att många försöker ' +
  'samma sak. Läs listan som ett omdöme om regeln, inte om personerna.';

/** Tomt läge. Ingenting är trasigt och ingenting saknas — det här är den goda nyheten. */
export const ADMIN_STOPS_EMPTY = 'Ingen har bett om något som de röda linjerna stoppar.';

// ── Bygg som gick fel ──────────────────────────────────────────────────────────

export const ADMIN_FAILED_HEADING = 'Bygg som gick fel';

export const ADMIN_FAILED_LEAD =
  'När någon hör av sig om att appen inte gick att bygga står svaret här: vad kontrollen sa, i ' +
  'vilken fil och på vilken rad. Det är maskinens besked om koden — inte något ur appen, och ' +
  'inte vad personen bad om.';

export const ADMIN_FAILED_PRIVACY_NOTE =
  'Önskemålets text står inte här, och inte heller det byggverktyget självt skrev om det. Båda ' +
  'är formulerade ur det någon skrivit och kan bära vad som helst om en människa.';

export const ADMIN_FAILED_EMPTY = 'Inget bygge har gått fel den senaste månaden.';

/** Ett jobb som dog utan att någon kontroll hann köra. Raden finns, men har inget fel att visa. */
export const ADMIN_FAILED_NO_CHECK = 'Bygget avbröts innan kontrollen hann köra.';

export function failedProblemsText(problems: number): string {
  return problems === 1 ? '1 sak att rätta' : `${problems} saker att rätta`;
}

/** Var felet satt. Raden utelämnas när kontrollen inte angav någon. */
export function diagnosticWhere(file: string | undefined, line: number | undefined): string {
  if (file === undefined) return '';
  return line === undefined ? file : `${file}, rad ${line}`;
}

/** Vem som hittade felet, i klarspråk. */
export const DIAGNOSTIC_SOURCE_TEXTS: Readonly<Record<'policy' | 'typecheck' | 'build', string>> = {
  policy: 'Regel för vad appar får göra',
  typecheck: 'Kontroll av koden',
  build: 'Bygget',
};

/**
 * Hur ofta varje gräns träffats, den vanligaste först. Kategorier utan träffar tas inte med: en
 * rad med noll säger ingenting, och sex nollor döljer den enda siffra som betyder något.
 *
 * Lika många träffar ger kontraktets ordning, så att listan inte hoppar runt mellan två laddningar.
 */
export function countStops(stops: readonly AdminStop[]): readonly { category: RedlineCategory; count: number }[] {
  const counts = new Map<RedlineCategory, number>();
  for (const stop of stops) counts.set(stop.category, (counts.get(stop.category) ?? 0) + 1);
  return REDLINE_CATEGORIES.filter((category) => counts.has(category))
    .map((category) => ({ category, count: counts.get(category) ?? 0 }))
    .sort((a, b) => b.count - a.count || REDLINE_CATEGORIES.indexOf(a.category) - REDLINE_CATEGORIES.indexOf(b.category));
}

/**
 * När adressen lades in är okänt. Det inträffar bara om värdet inte gick att läsa ur databasen —
 * användaren visas ändå, eftersom den som inte syns i kontrollrummet inte heller går att ändra
 * rollen på. Ett tankstreck är ärligare än ett påhittat datum.
 */
export const ADMIN_DATE_UNKNOWN = '—';

// ── AI-registret: vilka appar finns, vem äger dem, hur känsliga är de ──────────
//
// Registret är kontrollrummets svar på det en tillsyn frågar. Kontraktets ord för nivå och källa
// är maskintext — `oppen`, `personuppgift`, `fail-closed` — och säger ingenting för den som
// förvaltar plattformen. Därför har varje värde ett läsbart namn OCH en mening om vad det
// innebär, på samma sätt som rollerna och de röda linjerna.
//
// Källan är det som gör nivån möjlig att bedöma. En nivå som satts av ett golv, eller för att
// bedömningen inte gick att göra alls, betyder inte samma sak som en nivå som faktiskt bedömts —
// och den skillnaden syns inte i själva nivån.

export const ADMIN_REGISTER_HEADING = 'AI-registret';

/** Vad registret ÄR, och varför det finns. Frågan är en tillsyns, inte en utvecklares. */
export const ADMIN_REGISTER_LEAD =
  'Registret svarar på det en tillsyn frågar: vilka appar som finns i plattformen, vem som äger ' +
  'dem, och hur känsliga uppgifter de hanterar. Nivån sätts åt den som bygger appen — hen väljer ' +
  'den aldrig själv — och den höjs men sänks aldrig.';

export const ADMIN_REGISTER_LEVELS_HEADING = 'Nivåerna, från minst till mest känslig';

export const ADMIN_REGISTER_SOURCES_HEADING = 'Så kan nivån ha satts';

/** Kolumnrubrikerna. Appens namn är radens rubrik, så att en cell hör ihop med rätt app. */
export const ADMIN_REGISTER_COLUMNS = {
  app: 'App',
  owner: 'Ägare',
  level: 'Nivå',
  source: 'Hur nivån sattes',
  classified: 'Nivån sattes',
  state: 'Läge',
} as const;

/** Tomt läge. Registret är tomt därför att plattformen är tom — ingenting är trasigt. */
export const ADMIN_REGISTER_EMPTY =
  'Inga appar ännu, så registret är tomt. Den första någon bygger står här med sin nivå.';

/** Vad som står i tidkolumnen för en app som aldrig klassats. Aldrig ett påhittat datum. */
export const ADMIN_REGISTER_NEVER_CLASSIFIED = 'Aldrig klassad';

/**
 * En app utan tidpunkt står ändå på den strängaste nivån, och utan den här meningen läses det som
 * ett fel i registret. Det är tvärtom: att det okända väger strängast är hela poängen.
 */
export const ADMIN_REGISTER_NEVER_CLASSIFIED_NOTE =
  'En app som ännu inte beskrivits har aldrig klassats. Den står ändå på den strängaste nivån, ' +
  'och det är avsiktligt: en app vars känslighet ingen känner ska aldrig se ofarligare ut än en ' +
  'som prövats. Någon tidpunkt visas inte, eftersom det inte finns någon. Det är alltså inte ett ' +
  'fel i registret.';

export const ADMIN_REGISTER_PUBLISHED = 'Publicerad';
export const ADMIN_REGISTER_UNPUBLISHED = 'Inte publicerad';

// ── Avvecklade appar i registret ──────────────────────────────────────────────
//
// En avvecklad app står KVAR i registret. Raden är då det enda som finns kvar av den, och den är
// inte ett skräprester efter en radering som gick halvvägs — den är själva svaret på frågan "har
// den här appen funnits, och vad gjorde ni med den?".
//
// Två saker måste därför synas. Att raden är avvecklad ska gå att se vid en blick, utan att läsa
// någon cell; och att posten står kvar MED FLIT ska stå i ord, annars läser den som granskar
// plattformen raden som ett bevis på att uppgifterna inte raderades.

/** Lägesordet för en avvecklad app. Ersätter "Publicerad"/"Inte publicerad" — hon är varken. */
export const ADMIN_REGISTER_DECOMMISSIONED = 'Avvecklad';

/** Står framför datumet i tidkolumnen, så att det syns vilken av radens två tidpunkter det är. */
export const ADMIN_REGISTER_DECOMMISSIONED_AT = 'Avvecklad';

/**
 * Varför en avvecklad rad står kvar. Utan den här meningen ser registret ut att bevara appar som
 * ägaren bett om att få bort — och det gör det inte: det som står kvar är att appen har funnits.
 */
export const ADMIN_REGISTER_DECOMMISSIONED_NOTE =
  'En avvecklad app står kvar i registret, och det är med flit. Uppgifterna som fanns i appen är ' +
  'raderade, liksom filerna och koden. Kvar står att appen har funnits, vem som ägde den, vilken ' +
  'nivå den hade och när den avvecklades — just det någon som granskar plattformen behöver kunna ' +
  'se. En avvecklad rad är alltså inte en app som lever vidare i det tysta.';

/**
 * Lägesordet visar aldrig "Publicerad" för en avvecklad app, hur raden än såg ut när den levde.
 * Appen är inte ute längre; adressen slutade svara i samma stund som den avvecklades, och en rad
 * som stod kvar som publicerad hade pekat på något som inte finns.
 */
export function registerStateLabel(entry: { readonly published: boolean; readonly decommissionedAt: string | null }): string {
  if (entry.decommissionedAt !== null) return ADMIN_REGISTER_DECOMMISSIONED;
  return entry.published ? ADMIN_REGISTER_PUBLISHED : ADMIN_REGISTER_UNPUBLISHED;
}

/** Ett läsbart namn och en mening om vad värdet innebär. Samma form för nivå som för källa. */
export interface ClassificationText {
  readonly label: string;
  readonly explanation: string;
}

export const CLASSIFICATION_TEXTS: Readonly<Record<Classification, ClassificationText>> = {
  oppen: {
    label: 'Öppen',
    explanation: 'Uppgifter som kan visas för vem som helst utan att någon tar skada av det.',
  },
  intern: {
    label: 'Intern',
    explanation:
      'Uppgifter som hör till verksamheten och inte ska spridas utanför den, men som inte pekar ut någon enskild.',
  },
  personuppgift: {
    label: 'Personuppgifter',
    explanation: 'Uppgifter som går att knyta till en enskild människa — namn, adress, eller vem som gjort vad och när.',
  },
  kanslig: {
    label: 'Känsliga uppgifter',
    explanation:
      'Uppgifter som kräver extra skydd: hälsa, etnicitet, religion, sexualliv, fackligt medlemskap eller brott.',
  },
};

/**
 * Källorna säger HUR nivån sattes, inte vad källan heter. "Ett ord satte en lägsta nivå" är en
 * upplysning; kontraktets `signalord` är ett ord man antingen känner eller inte.
 */
export const CLASSIFICATION_SOURCE_TEXTS: Readonly<Record<ClassificationSource, ClassificationText>> = {
  modell: {
    label: 'Plattformen läste beskrivningen',
    explanation: 'Nivån är en bedömning av det appen beskrevs som, gjord när den byggdes.',
  },
  signalord: {
    label: 'Ett ord satte en lägsta nivå',
    explanation:
      'Ett ord i det som skrevs satte ett golv som bedömningen inte fick underskrida. Nivån kan alltså vara ' +
      'högre än bedömningen kom fram till, aldrig lägre.',
  },
  'fail-closed': {
    label: 'Gick inte att avgöra',
    explanation:
      'Nivån kunde inte bedömas, och då gäller den strängaste. Appen kan alltså hantera mindre känsliga ' +
      'uppgifter än den ser ut att göra här, och ingen har prövat saken sedan dess.',
  },
};

/**
 * Nivåns text. Ett värde som inte är en känd nivå — en rad skriven av en annan version av vår egen
 * kod — läses som den strängaste, samma regel som `asClassification` i kontraktet. Vyn ritar då
 * något sant i stället för att falla på ett `undefined`.
 */
export function classificationText(value: unknown): ClassificationText {
  return CLASSIFICATION_TEXTS[asClassification(value)];
}

/** Källans text. En källa vi inte känner igen säger inget sant om hur nivån sattes — då vet vi inte. */
export function classificationSourceText(value: unknown): ClassificationText {
  const known = CLASSIFICATION_SOURCES.includes(value as ClassificationSource);
  return CLASSIFICATION_SOURCE_TEXTS[known ? (value as ClassificationSource) : 'fail-closed'];
}

// ── Granskning: en människa läser koden innan appen går ut ─────────────────────
//
// Kön är kontrollrummets enda del som ber om arbete av den som läser den. De andra delarna
// svarar på frågor — den här väntar på ett beslut, och tills det är fattat ligger appen stilla.
//
// Två saker skiljer den från resten. Nivån ur AI-registret står i kön, inte bara i registret:
// granskaren ska se om nivån är ett omdöme eller ett misslyckande INNAN hon läser koden, för en
// app vars känslighet ingen kunnat avgöra är inte samma sak att släppa ut som en prövad app. Och
// ett öppnat ärende visar appens KOD, vilket ingen annan del av kontrollrummet gör — se
// `ADMIN_REVIEW_CODE_NOTE`.

export const ADMIN_REVIEWS_HEADING = 'Väntar på granskning';

/** Vad kön är: den sista spärren, och den enda som är en människa. */
export const ADMIN_REVIEWS_LEAD =
  'Den som bygger en app publicerar den inte själv — hon begär att den ska publiceras, och någon ' +
  'läser koden innan den går ut. Tills du har avgjort ett ärende ligger appen stilla, och ägaren ' +
  'väntar. Äldsta ärendet står först.';

/** Tomt läge. Ingen kö betyder att ingen väntar — det är ett gott läge, inte ett fel. */
export const ADMIN_REVIEWS_EMPTY = 'Ingenting väntar på granskning just nu. Ingen står och väntar på besked.';

/** Kolumnrubrikerna. Appens namn är radens rubrik, så att en cell hör ihop med rätt app. */
export const ADMIN_REVIEWS_COLUMNS = {
  app: 'App',
  owner: 'Ägare',
  requested: 'Begärdes',
  level: 'Nivå',
  source: 'Hur nivån sattes',
  open: 'Läs koden',
} as const;

export const ADMIN_REVIEW_OPEN_BUTTON = 'Läs koden';
export const ADMIN_REVIEW_OPENING = 'Hämtar koden…';
export const ADMIN_REVIEW_CLOSE_BUTTON = 'Stäng utan att avgöra';

export const ADMIN_REVIEW_CODE_HEADING = 'Koden som ska granskas';

/**
 * Sagt vid koden: varför just den här ytan visar det kontrollrummet annars aldrig visar. Utan den
 * meningen ser undantaget ut som en glipa — det är tvärtom hela poängen med granskningen.
 */
export const ADMIN_REVIEW_CODE_NOTE =
  'Det här är enda stället i kontrollrummet där innehållet i någons app visas, och det är ' +
  'avsiktligt: granskningen ÄR att någon läser koden. Allt annat här svarar på att appar finns, ' +
  'aldrig på vad som står i dem. Koden är den version ägaren begärde — bygger hon om medan ' +
  'ärendet väntar dras det tillbaka, så du läser aldrig kod som redan är ersatt.';

/** Ett ärende utan filer finns inte: då har vyn inget att visa och ingenting att avgöra på. */
export const ADMIN_REVIEW_NO_FILES =
  'Det finns ingen kod att läsa i det här ärendet. Avgör det inte — be ägaren bygga om appen.';

export const ADMIN_REVIEW_APPROVE_BUTTON = 'Godkänn och publicera';
export const ADMIN_REVIEW_REJECT_BUTTON = 'Avvisa';
export const ADMIN_REVIEW_DECIDING = 'Skickar…';

export const ADMIN_REVIEW_REASON_LABEL = 'Varför kan appen inte publiceras?';

/**
 * Står FÖRE rutan, inte efter: den som skriver ska veta att texten går vidare ordagrant innan hon
 * skriver den, inte få veta det när den redan är skickad.
 */
export const ADMIN_REVIEW_REASON_NOTE =
  'Ägaren får det du skriver ordagrant, som ett meddelande i sin app. Skriv vad som behöver ' +
  'ändras, i vanliga ord — det är det hon har att gå på.';

/** Ett godkännande publicerar. Sagt innan, eftersom knappen inte går att ångra. */
export const ADMIN_REVIEW_APPROVE_NOTE =
  'Godkänner du publiceras appen direkt, i exakt den version du har läst.';

export const ADMIN_REVIEW_REASON_MISSING = 'Skriv varför appen inte kan publiceras. Ägaren får skälet ordagrant.';

export const ADMIN_REVIEW_REASON_TOO_LONG = `Skälet är för långt. Håll det till det som behöver åtgärdas — högst ${REVIEW_LIMITS.maxReasonChars} tecken.`;

/** Serverns nej när granskaren äger appen själv. Ett godkännande av sig själv är ingen granskning. */
export const ADMIN_REVIEW_OWN_APP =
  'Du kan inte granska din egen app. Be en annan förvaltare läsa den.';

/** Ärendet hann avgöras av någon annan, eller dras tillbaka av ägaren. Inget är trasigt. */
export const ADMIN_REVIEW_ALREADY_DECIDED =
  'Ärendet är inte längre öppet. Någon annan hann avgöra det, eller så byggde ägaren om appen. Ladda om sidan så ser du kön som den är nu.';

export const ADMIN_REVIEW_GONE = 'Ärendet finns inte längre. Ladda om sidan så ser du kön som den är nu.';

/** Behörigheten kan ha tagits bort mitt i sessionen. Då är inget trasigt — sidan är bara gammal. */
export const ADMIN_REVIEW_FORBIDDEN =
  'Ditt konto får inte längre granska appar. Ladda om sidan så ser du vad du kommer åt.';

/** Beskeden efter ett beslut. De säger vad som HÄNDE, inte att en knapp trycktes. */
export function reviewApprovedMessage(review: AdminReview): string {
  return `${review.name} är granskad och publicerad. Ägaren har fått besked.`;
}

export function reviewRejectedMessage(review: AdminReview): string {
  return `${review.name} publicerades inte. Ägaren har fått ditt skäl ordagrant.`;
}

export interface ReviewReasonCheck {
  readonly ok: boolean;
  readonly reason: string;
  readonly message: string;
}

/**
 * Skälet prövas här också, inte bara av servern: ett nej utan skäl lämnar ägaren med ett avslag
 * hon inte kan göra något åt, och det ska hon få veta innan anropet går iväg. Samma regel som i
 * byggverktyget (`readDecision` i `packages/builder/src/admin.ts`) — blanktecken räknas inte.
 */
export function validateReviewReason(input: string): ReviewReasonCheck {
  const reason = input.trim();
  if (reason.length === 0) return { ok: false, reason, message: ADMIN_REVIEW_REASON_MISSING };
  if (reason.length > REVIEW_LIMITS.maxReasonChars) {
    return { ok: false, reason, message: ADMIN_REVIEW_REASON_TOO_LONG };
  }
  return { ok: true, reason, message: '' };
}

/**
 * Serverns fel när ett beslut inte gick igenom. 400 betyder här en av två saker — ett skäl som
 * saknas, eller den egna appen — och servern säger vilket i klarspråk, så dess egen text vinner.
 */
export function reviewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error);
  if (error.status === 403) return ADMIN_REVIEW_FORBIDDEN;
  if (error.status === 404) return ADMIN_REVIEW_GONE;
  if (error.status === 409) return ADMIN_REVIEW_ALREADY_DECIDED;
  if (error.status === 429) return ADMIN_RATE_LIMITED;
  return error.message;
}
