/**
 * Plattformstjänster i scenarierna. Ett scenario (eller en egenskap) slår på en tjänst med
 * taggen `@tjanst-<namn>`. Varje tjänsts stegfil (features/steg/tjanster/<namn>.ts) registrerar
 * här hur tjänsten förbereds — miljövariabler och fejkar för Berget och mejl — så att ingen
 * tjänst behöver ändra världen eller krokarna.
 */
import type { AppMailer, AppServiceName } from '@vibesandbox/contracts';
import { APP_SERVICE_NAMES } from '@vibesandbox/contracts';

export interface TjanstForberedelse {
  /** Miljövariabler till tjänsten (`SVC_<NAMN>_…`). */
  readonly miljo?: Readonly<Record<string, string>>;
  /** En fejkad Berget (t.ex. en lokal HTTP-server som tjänsten får adressen till). */
  readonly berget?: { readonly baseUrl: string; readonly apiKey: string };
  readonly mailer?: AppMailer;
  /** Körs efter scenariot (stänger fejkservrar m.m.). */
  readonly stada?: () => Promise<void>;
}

type Forberedare = () => Promise<TjanstForberedelse>;

const FORBEREDARE = new Map<AppServiceName, Forberedare>();

/** Anropas från tjänstens stegfil, på modulnivå. */
export function forberedTjanst(namn: AppServiceName, forbered: Forberedare): void {
  if (FORBEREDARE.has(namn)) throw new Error(`Tjänsten ${namn} förbereds redan av en annan stegfil.`);
  FORBEREDARE.set(namn, forbered);
}

/** Tjänsterna ett scenario taggat, i plattformens ordning. */
export function tjansterIScenariot(taggar: readonly string[]): AppServiceName[] {
  const namn = new Set(taggar.filter((t) => t.startsWith('@tjanst-')).map((t) => t.slice('@tjanst-'.length)));
  for (const n of namn) {
    if (!(APP_SERVICE_NAMES as readonly string[]).includes(n)) throw new Error(`Okänd tjänst i taggen @tjanst-${n}.`);
  }
  return APP_SERVICE_NAMES.filter((n) => namn.has(n));
}

export async function forbered(tjanster: readonly AppServiceName[]): Promise<TjanstForberedelse[]> {
  const resultat: TjanstForberedelse[] = [];
  for (const namn of tjanster) {
    const forberedare = FORBEREDARE.get(namn);
    resultat.push(forberedare === undefined ? {} : await forberedare());
  }
  return resultat;
}
