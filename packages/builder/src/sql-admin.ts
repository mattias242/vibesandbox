/**
 * SQL för kontrollrummet (adminvyn) — och BARA för den.
 *
 * Varför en egen fil: satserna här saknar med flit ägarfiltret `owner_user_id = :owner` som varje
 * sats i sql.ts bär. De är hela undantaget från byggverktygets regel att man bara ser sitt eget,
 * och en granskare ska kunna läsa undantaget på ett enda ställe i stället för att leta efter en
 * sats i sql.ts som råkar ha tappat sitt filter. En sats i sql.ts ändras aldrig så att den tappar
 * sitt ägarfilter — behövs en vy över alla appar läggs den här.
 *
 * Den enda vägen hit går genom `requireAdmin` i api.ts: plattformsrollen `admin`, inte `builder`.
 * Satserna lämnar heller aldrig ut något som ger åtkomst till en app — de ger antal, namn och
 * tidpunkter. Hela app-id:t ÄR appens hemliga adress och kapas av anroparen innan det når svaret
 * (`ADMIN_APP_ID_PREFIX_LENGTH`); ägarens adress finns inte ens i den här databasen utan hämtas
 * ur control.
 */

/**
 * Sammanräkningen för `AdminOverview`, i en rad.
 *
 * `drafts` räknar appar som har ett bygge bakom sig men ännu aldrig publicerats — "byggd men inte
 * ute". En app som publicerats och sedan byggts om räknas alltså inte: det som saknas för den är
 * en ny publicering, inte ett första steg. Räkningen blir då också exakt lika med antalet rader i
 * applistan med `hasDraft && !published`, så att översikten och listan aldrig kan säga emot varandra.
 *
 * `count(*)` ger 0 för en tom tabell, men `sum(...)` ger NULL — därav `coalesce`.
 */
export const COUNT_ALL_APPS = `
  SELECT
    count(*) AS apps,
    coalesce(sum(CASE WHEN a.published_version IS NOT NULL THEN 1 ELSE 0 END), 0) AS published,
    coalesce(sum(
      CASE
        WHEN a.published_version IS NULL AND EXISTS (SELECT 1 FROM revisions r WHERE r.app_id = a.app_id)
        THEN 1 ELSE 0
      END
    ), 0) AS drafts
  FROM apps a
`;

/**
 * Tokens och antal jobb inom fönstret, oavsett app och ägare. Jobb räknas på `created_at`: ett jobb
 * som ännu inte hunnit bli klart har inga tokens och bidrar med noll, men ska ändå synas som ett
 * jobb i fönstret. `input_tokens`/`output_tokens` är NULL tills jobbet avslutats.
 */
export const SUM_JOB_TOKENS_SINCE = `
  SELECT
    coalesce(sum(input_tokens), 0) AS input_tokens,
    coalesce(sum(output_tokens), 0) AS output_tokens,
    count(*) AS jobs
  FROM jobs
  WHERE created_at > :since
`;

/** Byggverktygets egen felbild: jobb inom samma fönster som slutade som misslyckade. */
/**
 * Misslyckade BYGGEN. Ett stoppat önskemål är `failed` i tabellen men hör inte hit: det var ett
 * beslut, inte en krasch, och ska inte blandas in i felbilden som någon ska felsöka.
 */
export const COUNT_FAILED_JOBS_SINCE = `
  SELECT count(*) AS failed FROM jobs
  WHERE created_at > :since AND status = 'failed' AND stop_reason IS NULL
`;

/**
 * Stoppade önskemål, senast först. Önskemålets TEXT finns inte här och ska inte finnas: den kan
 * bära personuppgifter, och ett stopp får inte bli vägen som arkiverar just det någon inte borde
 * ha skrivit. App-id:t förkortas av anroparen — hela id:t är appens hemliga adress.
 */
export const LIST_STOPS = `
  SELECT app_id, stop_reason, created_at FROM jobs
  WHERE stop_reason IS NOT NULL
  ORDER BY created_at DESC, rowid DESC
  LIMIT :limit
`;

/**
 * Alla appar, senast ändrad först. Inget ägarfilter — det är hela poängen med den här filen.
 *
 * `name_is_default` följer med för att anroparen ska kunna se om namnet är ÄGARENS eller
 * plattformens: ett standardnamn är de första tecknen ur det första önskemålet, alltså samma text
 * som varken stopplistan eller registret får visa. Se admin.ts.
 *
 * `owner_user_id` följer med för att anroparen ska kunna hämta ägarens adress ur control;
 * adressen finns inte i byggverktygets databas. Tokens summeras över appens alla jobb sedan den
 * skapades, utan fönster: raden ska visa vad appen har kostat totalt.
 */
export const LIST_ALL_APPS = `
  SELECT
    a.app_id AS app_id,
    a.owner_user_id AS owner_user_id,
    a.name AS name,
    a.name_is_default AS name_is_default,
    a.updated_at AS updated_at,
    a.published_version AS published_version,
    EXISTS (SELECT 1 FROM revisions r WHERE r.app_id = a.app_id) AS has_draft,
    (SELECT coalesce(sum(j.input_tokens), 0) FROM jobs j WHERE j.app_id = a.app_id) AS input_tokens,
    (SELECT coalesce(sum(j.output_tokens), 0) FROM jobs j WHERE j.app_id = a.app_id) AS output_tokens
  FROM apps a
  ORDER BY a.updated_at DESC, a.rowid DESC
`;

/**
 * AI-registret: alla appar med sin klass, senast ändrad först. Inget ägarfilter — samma undantag
 * som resten av filen.
 *
 * Klasskolumnerna lämnas RÅA härifrån och prövas mot kontraktet av den som läser. Skälet är att en
 * rad skriven av en äldre version av vår egen kod ska falla åt det stränga hållet i ETT ställe
 * (admin.ts) i stället för att satsen här tyst översätter den. Önskemålets text finns inte i
 * satsen och ska inte finnas: registret svarar på att appen finns, aldrig på vad som står i den.
 */
export const LIST_REGISTER = `
  SELECT
    a.app_id AS app_id,
    a.owner_user_id AS owner_user_id,
    a.name AS name,
    a.name_is_default AS name_is_default,
    a.classification AS classification,
    a.classification_source AS classification_source,
    a.classified_at AS classified_at,
    a.published_version AS published_version
  FROM apps a
  ORDER BY a.updated_at DESC, a.rowid DESC
`;
