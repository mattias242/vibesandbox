/**
 * Översättning av fel till det enda feltyp som får lämna paketet: `DataApiError`.
 *
 * Varför en egen fil: regeln "inga interna detaljer läcker" ska gå att granska på ett ställe.
 * Ett SQLite-fel innehåller filsökvägar och SQL-text; inget av det får nå en app eller en
 * användare. Originalfelet följer med som `cause` så att gatewayn kan logga det.
 */
import { DataApiError, type ApiErrorCode } from '@vibesandbox/contracts';

/** SQLite:s primära felkod för "databasen eller disken är full". */
const SQLITE_FULL = 13;

/**
 * Skapar ett DataApiError med originalfelet som `cause`.
 *
 * `cause` sätts som icke-uppräkningsbar egenskap — precis som den inbyggda `Error`-konstruktorn
 * gör — så att den inte följer med om någon råkar serialisera felet till ett svar.
 */
export function dataApiError(code: ApiErrorCode, message: string, cause?: unknown): DataApiError {
  const fel = new DataApiError(code, message);
  if (cause !== undefined) {
    Object.defineProperty(fel, 'cause', {
      value: cause,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return fel;
}

/** Är detta SQLite:s "fullt"-fel? Utökade felkoder bär den primära koden i de låga åtta bitarna. */
export function isDatabaseFull(fel: unknown): boolean {
  if (typeof fel !== 'object' || fel === null) return false;
  const errcode = (fel as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_FULL;
}

/** Gör om vilket fel som helst till ett DataApiError som är tryggt att visa. */
export function translateError(fel: unknown): DataApiError {
  if (fel instanceof DataApiError) return fel;
  if (isDatabaseFull(fel)) {
    return dataApiError(
      'quota_exceeded',
      'Appens lagringsutrymme är fullt. Ta bort något innan du sparar mer.',
      fel,
    );
  }
  return dataApiError('internal', 'Något gick fel när appens data skulle hanteras.', fel);
}
