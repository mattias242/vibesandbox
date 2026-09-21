/**
 * Kontrollrummets texter och de små beslut som går att pröva utan webbläsare.
 *
 * Vyn är ren läsning. Den ger plattformens administratör insyn i ATT appar finns — aldrig en väg
 * in i dem. Därför står det ingenstans här en app-adress, och ingen text lovar något som
 * plattformen inte gör.
 */
import { ADMIN_TOKEN_WINDOW_DAYS } from '@vibesandbox/contracts';
import { ApiError } from './api.ts';
import { errorMessage } from './client.ts';

export const ADMIN_TITLE = 'Kontrollrummet';

/** Länken i rubrikraden. Visas bara för den som bär rollen — men servern är den som avgör. */
export const ADMIN_LINK_LABEL = 'Kontrollrummet';

export const ADMIN_LEAD =
  'Här ser du alla appar i plattformen, också dem som andra har byggt. Sidan visar bara — den ändrar ingenting.';

/**
 * Den som saknar rollen möts av servern med 403. Det ska läsas som ett besked, inte som ett fel:
 * ingenting är trasigt, kontot har bara inte den behörigheten.
 */
export const ADMIN_FORBIDDEN =
  'Kontrollrummet är bara för dig som administrerar plattformen. Ditt konto har inte den behörigheten.';

export const ADMIN_LOADING = 'Hämtar plattformens appar…';

export const ADMIN_EMPTY = 'Inga appar ännu. Den första någon bygger dyker upp här.';

export const ADMIN_FIGURES_HEADING = 'Så ser plattformen ut just nu';

export const ADMIN_APPS_HEADING = 'Alla appar';

/**
 * Antalet inloggningsadresser per roll finns i kontraktet men räknas inte ännu. Nollor hade sett
 * ut som ett svar; den här meningen säger i stället som det är.
 */
export const ADMIN_USERS_UNKNOWN =
  'Hur många adresser som får logga in räknas inte i den här versionen, så den siffran visas inte.';

/** Sagt en gång, vid listan: varför appens namn inte går att klicka på. */
export const ADMIN_ID_NOTE =
  'Av varje app visas bara början av dess adress, och det finns ingen väg härifrån in i appen. Hela adressen är nyckeln till appen, och den har bara de som äger eller delar den.';

/** "Tokens" är modellens mått. Sagt en gång, i vanliga ord, så att siffrorna betyder något. */
export const ADMIN_TOKENS_NOTE = `Tokens är måttet på hur mycket text modellen läst och skrivit. Siffrorna för plattformen gäller de senaste ${ADMIN_TOKEN_WINDOW_DAYS} dygnen; siffrorna i listan gäller varje app sedan den skapades.`;

export const ADMIN_OWNER_MISSING = 'Saknar ägare';

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
