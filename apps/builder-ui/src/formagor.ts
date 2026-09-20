/**
 * Innehållet i guiden "Vilka tjänster finns som appen kan använda?" — för den som INTE är
 * utvecklare. Den säger vad man kan be om i chatten, inte hur något byggs.
 *
 * Fakta kommer från tjänsternas beskrivningar för byggagenten (`packages/sdk/tjanster/*.md` och
 * `packages/sdk/README.md`). Ändras en gräns där ska texten här följa med. `test/formagor.test.ts`
 * låser det viktigaste: att bara påslagna tjänster visas, att varje tjänst har en text, att inga
 * tekniska ord smyger sig in och att löftena om personuppgifter, roller och mejl står kvar.
 *
 * Skriv klarspråk: korta meningar, du-tilltal, vardagliga ord. Säg "lista", "uppgifter", "rad".
 */
import { APP_SERVICE_NAMES, type AppServiceName } from '@vibesandbox/contracts';

export const GUIDE_TITLE = 'Vilka tjänster finns som appen kan använda?';

/**
 * Raden längst ned: vilken version som körs. Servern vet det bara när driftsättningen angett
 * den (`APP_VERSION`); utan den står det ingenting alls — en gissad version vore värre än tyst.
 */
export function versionText(version: string | undefined): string | null {
  return version === undefined || version === '' ? null : `Version ${version}`;
}
/** Där den fulla frågan inte får plats, till exempel i rubrikraden. */
export const GUIDE_LINK_SHORT = 'Tjänster för appar';

export const GUIDE_INTRO: readonly string[] = [
  'Här ser du vad du kan be om när du beskriver din app. Skriv med dina egna ord – exemplen är bara förslag.',
  'Tryck på Använd för att lägga ett exempel i chattrutan. Inget skickas förrän du själv trycker på Skicka.',
];

export const BASE_HEADING = 'Det här kan alla appar';
export const SERVICES_HEADING = 'Tjänster som är påslagna';
export const SERVICES_NONE =
  'Inga extra tjänster är påslagna just nu. Hör av dig till den som ansvarar för plattformen om din app behöver något mer.';
export const LIMITS_HEADING = 'Det här kan appar inte göra';
export const EXAMPLES_LABEL = 'Skriv till exempel:';
export const HOW_TO_LABEL = 'Så gör du:';
export const GOOD_TO_KNOW_LABEL = 'Bra att veta';
export const USE_LABEL = 'Använd';
export const CLOSE_LABEL = 'Stäng';

export interface Capability {
  /** Stabil nyckel för vyn. Visas aldrig. */
  readonly key: string;
  readonly title: string;
  /** En till tre meningar om vad det är. */
  readonly about: string;
  /** Meningar att skriva i chatten. Tomt ⇒ `howTo` säger var i byggverktyget man gör det. */
  readonly examples: readonly string[];
  readonly howTo?: string;
  readonly goodToKnow: readonly string[];
}

export interface ServiceCapability extends Capability {
  /** Tjänster som den här bygger på. Saknas någon av dem visas den inte. */
  readonly requires?: readonly AppServiceName[];
}

export const BASE_CAPABILITIES: readonly Capability[] = [
  {
    key: 'shared',
    title: 'Spara och visa uppgifter',
    about:
      'Appen kan spara uppgifter i listor, till exempel bokningar, ärenden eller svar på en enkät. Alla som får öppna appen ser samma uppgifter och kan ändra dem.',
    examples: [
      'Gör en lista där vi kan lägga till, ändra och ta bort bokningar av mötesrum.',
      'Varje ärende ska ha rubrik, beskrivning, datum och status.',
      'Sortera listan så att det senaste kommer först.',
    ],
    goodToKnow: [
      'Uppgifterna finns bara i den här appen. Andra appar kommer inte åt dem.',
      'En lista visar högst 1 000 rader åt gången. Be om sökning eller filter om listan blir lång.',
      'Mycket långa texter får inte plats på en enda rad i en lista.',
      'Skriv inte in känsliga personuppgifter om det inte behövs.',
    ],
  },
  {
    key: 'personal',
    title: 'Uppgifter som bara du ser',
    about:
      'En lista kan också vara personlig. Då ser var och en bara sina egna uppgifter, till exempel egna anteckningar eller egna svar.',
    examples: [
      'Varje person ska ha sina egna anteckningar som ingen annan kan se.',
      'Svaren på enkäten ska bara synas för den som svarade.',
    ],
    goodToKnow: [
      'Bestäm från början om en lista ska vara gemensam eller personlig. Det går inte att ändra senare.',
      'Inte ens du som äger appen ser någon annans personliga uppgifter. Ska du kunna se alla svar, välj en gemensam lista.',
      'En personlig lista är det som skyddar uppgifter från andra i appen.',
    ],
  },
  {
    key: 'who',
    title: 'Veta vem som är inloggad',
    about: 'Alla som använder appen är inloggade. Appen kan visa vem du är och vem som har lagt till något.',
    examples: [
      'Hälsa på den som är inloggad med namn.',
      'Spara vem som lade till varje bokning och visa det i listan.',
    ],
    goodToKnow: [
      'Appen visar namnet som står före @ i e-postadressen. Den får aldrig se hela e-postadressen.',
      'Den som inte är inloggad kommer inte in i appen alls.',
    ],
  },
  {
    key: 'share',
    title: 'Dela appen med kollegor',
    about:
      'När appen är publicerad kan du dela den med kollegor. De får ett mejl med en länk och loggar in för att använda appen.',
    examples: [],
    howTo: 'Publicera appen först. Skriv sedan kollegans e-postadress under Dela appen, bredvid förhandsvisningen.',
    goodToKnow: [
      'Du kan ta bort någons åtkomst i listan över personer som har appen. Det gäller direkt.',
      'Bara de du delar appen med kommer in. Appen är inte öppen för alla.',
      'Den du delar appen med kan använda den, men inte ändra hur den är byggd.',
    ],
  },
  {
    key: 'preview',
    title: 'Förhandsvisa och publicera',
    about:
      'Medan du bygger ser du appen i förhandsvisningen, och bara du ser den. När du är nöjd publicerar du appen.',
    examples: [],
    howTo: 'Prova appen i förhandsvisningen. Tryck sedan på Publicera.',
    goodToKnow: [
      'Förhandsvisningen har egna uppgifter. Det du provar där syns aldrig i den publicerade appen.',
      'Ändringar syns för andra först när du publicerar igen.',
      'Du kan fortsätta ändra appen efter att den är publicerad.',
    ],
  },
];

const BERGET = 'Berget, en svensk leverantör som är plattformens godkända personuppgiftsbiträde';
const MASKED = 'Personnummer, telefonnummer, e-postadresser, kortnummer och IBAN tas bort innan texten skickas.';

export const SERVICE_CAPABILITIES: Readonly<Record<AppServiceName, ServiceCapability>> = {
  files: {
    key: 'files',
    title: 'Bifoga filer och bilder',
    about:
      'Den som använder appen kan ladda upp filer och bilder, och sedan visa eller ladda ned dem igen. En fil kan höra ihop med något i appen, till exempel ett ärende.',
    examples: [
      'Låt användarna bifoga en bild till varje felanmälan.',
      'Lägg till en plats där vi kan ladda upp protokoll som PDF och ladda ned dem igen.',
      'Varje person ska kunna ladda upp filer som bara hen själv ser.',
    ],
    goodToKnow: [
      'Det går att ladda upp bilder, PDF, Word, Excel, textfiler och ljudfiler. Webbsidor och Excel-filer med makron går inte.',
      'En fil får vara högst 20 MB. Appen har ett begränsat utrymme för filer.',
      'Den som laddade upp en fil kan ta bort den. Det kan också du som äger appen.',
      'Filerna i förhandsvisningen är skilda från filerna i den publicerade appen.',
    ],
  },
  notify: {
    key: 'notify',
    title: 'Skicka mejl till dem som använder appen',
    about:
      'Appen kan skicka mejl till dem som har tillgång till den, till exempel när något nytt har hänt. Mejlet kan gå till alla, till dig som äger appen eller till utvalda personer.',
    examples: [
      'Skicka ett mejl till mig när någon gör en ny anmälan.',
      'Lägg till en knapp som mejlar alla i appen att schemat är ändrat.',
      'Låt mig välja vilka i appen som ska få mejlet.',
    ],
    goodToKnow: [
      'Mejl går bara till dem som appen är delad med. Appen kan inte mejla några andra adresser.',
      'I förhandsvisningen går mejlet bara till dig själv.',
      'Mejlet får inte innehålla webbadresser. Det har alltid en länk till appen.',
      'Det finns en gräns för hur många mejl appen får skicka per timme och per dygn.',
      'Appen får en knapp där var och en kan stänga av mejlen från appen.',
    ],
  },
  roles: {
    key: 'roles',
    title: 'Olika behörigheter i appen',
    about:
      'Appen kan ha roller, till exempel handläggare och administratör. Du som äger appen bestämmer vem som har vilken roll.',
    examples: [
      'Bara de som har rollen administratör ska se inställningarna.',
      'Lägg till rollen handläggare och låt mig välja handläggare för varje ärende.',
      'Gör en sida där jag kan ge personerna i appen olika roller.',
    ],
    goodToKnow: [
      'Roller styr vad appen visar, men de skyddar inte uppgifter. Den som har tillgång till appen kan ändå komma åt alla gemensamma uppgifter.',
      'Lägg därför aldrig något i en gemensam lista som bara vissa roller får se.',
      'Alla i appen kan se vilka som är med och vilka roller de har.',
      'Du som äger appen har inte automatiskt alla roller.',
      'Appen kan ha högst 20 roller. Förhandsvisningen har egna roller.',
    ],
  },
  llm: {
    key: 'llm',
    title: 'Låta AI sammanfatta text',
    about:
      'Appen kan be en AI om hjälp med text. Den kan till exempel sammanfatta, skriva om i klarspråk eller föreslå en kategori.',
    examples: [
      'Lägg till en knapp som sammanfattar ärendet i tre meningar.',
      'Låt AI föreslå en kategori för varje felanmälan, som jag sedan kan ändra.',
      'Lägg till en knapp som skriver om texten i klarspråk.',
    ],
    goodToKnow: [
      'Text från AI kan vara fel. Den visas som ett förslag som du granskar och kan ändra innan det sparas.',
      'Appen visar tydligt att texten kommer från AI. Låt aldrig AI fatta beslut.',
      `${MASKED} Namn och adresser tas inte bort.`,
      'Det kan ta upp till en minut att få svar. Det finns en gräns för hur mycket appen får fråga per timme och per dygn.',
    ],
  },
  ocr: {
    key: 'ocr',
    title: 'Läsa text i bilder och kvitton',
    about:
      'Appen kan läsa texten i en uppladdad bild eller PDF, till exempel ett kvitto, en blankett eller en skylt. Texten kan sedan sparas i appen.',
    examples: [
      'Låt mig fota ett kvitto och spara texten från det.',
      'Läs texten i en uppladdad PDF och visa den under filen.',
      'Lägg till en knapp som läser av texten på en bild.',
    ],
    goodToKnow: [
      'Det fungerar med foton, skärmbilder och PDF. Går en PDF inte att läsa kan du ladda upp sidorna som bilder.',
      'Texten kan läsas på svenska eller engelska. Läs igenom den, eftersom den kan bli fel om bilden är otydlig.',
      `Bilden skickas som den är till ${BERGET}. Uppgifter i bilden kan inte tas bort först.`,
      'Läs inte in papper med känsliga personuppgifter i onödan, till exempel om hälsa eller ekonomi.',
      'Det finns en gräns för hur många sidor appen får läsa per dygn.',
    ],
    requires: ['files'],
  },
  history: {
    key: 'history',
    title: 'Se vem som ändrat vad',
    about:
      'Appen sparar automatiskt vem som lade till, ändrade eller tog bort något, och när. Appen kan visa historiken och ångra ändringar.',
    examples: [
      'Visa vem som ändrade ärendet senast och när.',
      'Lägg till en knapp som ångrar den senaste ändringen.',
      'Visa allt som har ändrats den senaste veckan.',
    ],
    goodToKnow: [
      'Borttagna uppgifter går att ta tillbaka.',
      'Historiken visar namnet före @ i e-postadressen, aldrig hela adressen.',
      'I personliga listor ser var och en bara historiken för sina egna uppgifter.',
      'Historiken sparas normalt i ett år. Blir utrymmet fullt tas den äldsta historiken bort först.',
    ],
  },
  schedule: {
    key: 'schedule',
    title: 'Skicka påminnelser via mejl',
    about:
      'Appen kan skicka en påminnelse via mejl vid en viss tid, en gång eller varje dag, vecka eller månad. Påminnelsen skickas även när ingen har appen öppen.',
    examples: [
      'Påminn alla i appen varje fredag klockan 9 om veckomötet.',
      'Skicka en påminnelse till mig dagen innan en bokning.',
      'Låt var och en ställa in en egen påminnelse om sina uppgifter.',
    ],
    goodToKnow: [
      'Påminnelser går bara till dem som appen är delad med.',
      'I förhandsvisningen går påminnelserna bara till dig själv.',
      'En påminnelse kan ligga högst ett år fram i tiden. Klockslaget gäller svensk tid, även vid sommartid.',
      'Det finns en gräns för hur många påminnelser som kan vara aktiva samtidigt.',
      'Har den som skapade en påminnelse inte längre tillgång till appen tas påminnelsen bort.',
    ],
    requires: ['notify'],
  },
  transcribe: {
    key: 'transcribe',
    title: 'Göra om tal till text',
    about:
      'Appen kan göra om en inspelning till text, till exempel från ett möte eller en intervju. Du kan ladda upp en ljudfil eller spela in direkt i appen.',
    examples: [
      'Lägg till en knapp för att spela in mötet och gör om det till text.',
      'Låt mig ladda upp en ljudfil från en intervju och spara texten i appen.',
      'Visa texten med tider, så att jag ser när något sades.',
    ],
    goodToKnow: [
      'Berätta för alla som hörs i inspelningen att den spelas in och görs om till text. Gör det innan inspelningen börjar.',
      `Ljudet skickas till ${BERGET}. Uppgifter i ljudet kan inte tas bort först.`,
      'Det tar ungefär en minut per 15–25 minuter ljud. Ibland får du vänta i kö.',
      'En ljudfil får vara högst 100 MB. Appen kan göra om ett visst antal minuter ljud per dygn.',
      'Bara den som beställde texten och du som äger appen kan läsa den. Den försvinner efter några dagar om appen inte sparar den.',
    ],
    requires: ['files'],
  },
  search: {
    key: 'search',
    title: 'Smart sökning',
    about:
      'Appen kan söka efter vad något handlar om, inte bara efter exakta ord. En sökning på ”stulen cykel” hittar till exempel ”Cykeln försvann från stället”.',
    examples: [
      'Lägg till en sökruta som hittar ärenden som handlar om samma sak.',
      'Visa liknande ärenden under varje ärende.',
      'Gör en kunskapsbank där man kan ställa en fråga och få de mest passande artiklarna.',
    ],
    goodToKnow: [
      'Sökningen hittar bara det som den som söker ändå får se.',
      'Sökningen läser ungefär en halv sida text från varje rad. Datum och tal söks inte, men appen kan sortera och filtrera på dem.',
      'En lista kan ha högst 5 000 rader för att gå att söka i. Det finns en gräns för hur många sökningar som görs per minut och per dygn.',
      `Texten skickas till ${BERGET}. ${MASKED} Namn tas inte bort.`,
    ],
  },
};

/** "Det här kan appar inte göra" — beror på om påminnelser finns. */
function limitsFor(enabled: ReadonlySet<AppServiceName>): readonly string[] {
  const reminders = enabled.has('schedule') && enabled.has('notify');
  const mail = enabled.has('notify');
  return [
    'Appen kan inte hämta eller skicka uppgifter till andra webbplatser eller tjänster på internet, till exempel kartor, väder eller andra system.',
    mail
      ? 'Appen kan inte skicka mejl till vilka adresser som helst. Mejl går bara till dem som appen är delad med.'
      : 'Appen kan inte skicka mejl till vilka adresser som helst.',
    reminders
      ? 'Appen kan inte göra något när ingen har appen öppen. Undantaget är påminnelser, som skickas vid rätt tid.'
      : 'Appen kan inte göra något när ingen har appen öppen.',
    'Appen kan inte hämta uppgifter från andra appar. Varje app har sina egna uppgifter.',
    'Appen kan inte vara öppen för alla. Den som använder appen måste logga in.',
  ];
}

export interface Guide {
  readonly base: readonly Capability[];
  readonly services: readonly ServiceCapability[];
  readonly limits: readonly string[];
}

/**
 * Det guiden visar för de påslagna tjänsterna. Namn som guiden inte känner till (en nyare server)
 * hoppas över; en tjänst visas bara om det den bygger på också är påslaget.
 */
export function guideFor(services: readonly string[]): Guide {
  const enabled = new Set(APP_SERVICE_NAMES.filter((name) => services.includes(name)));
  const shown = APP_SERVICE_NAMES.filter((name) => {
    if (!enabled.has(name)) return false;
    return (SERVICE_CAPABILITIES[name].requires ?? []).every((required) => enabled.has(required));
  }).map((name) => SERVICE_CAPABILITIES[name]);
  return { base: BASE_CAPABILITIES, services: shown, limits: limitsFor(enabled) };
}

/** Varje text guiden kan visa, för testerna av klarspråk. */
export function allGuideTexts(): string[] {
  const capabilities: Capability[] = [...BASE_CAPABILITIES, ...APP_SERVICE_NAMES.map((name) => SERVICE_CAPABILITIES[name])];
  return [
    GUIDE_TITLE,
    GUIDE_LINK_SHORT,
    ...GUIDE_INTRO,
    BASE_HEADING,
    SERVICES_HEADING,
    SERVICES_NONE,
    LIMITS_HEADING,
    EXAMPLES_LABEL,
    HOW_TO_LABEL,
    GOOD_TO_KNOW_LABEL,
    USE_LABEL,
    CLOSE_LABEL,
    ...capabilities.flatMap((capability) => [
      capability.title,
      capability.about,
      ...capability.examples,
      ...(capability.howTo === undefined ? [] : [capability.howTo]),
      ...capability.goodToKnow,
    ]),
    ...new Set([...guideFor([]).limits, ...guideFor(APP_SERVICE_NAMES).limits]),
  ];
}
