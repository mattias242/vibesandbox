/**
 * Kontrollrummets texter och de små beslut som går att pröva utan webbläsare.
 *
 * Applistan är ren läsning. Den ger plattformens administratör insyn i ATT appar finns — aldrig
 * en väg in i dem. Därför står det ingenstans här en app-adress, och ingen text lovar något som
 * plattformen inte gör.
 *
 * Adresslistan är vyns enda del som ändrar något. Den ändrar först när servern svarat: varje
 * funktion här tar emot SERVERNS rad och bygger besked eller ny lista av den, aldrig av det
 * någon hann klicka på.
 */
import { ADMIN_TOKEN_WINDOW_DAYS, type AdminUser, type Role } from '@vibesandbox/contracts';
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

/** Sagt en gång, vid listan: varför appens namn inte går att klicka på. */
export const ADMIN_ID_NOTE =
  'Av varje app visas bara början av dess adress, och det finns ingen väg härifrån in i appen. Hela adressen är nyckeln till appen, och den har bara de som äger eller delar den.';

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
