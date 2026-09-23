/**
 * Felet som en sida, för den som klickat på en länk.
 *
 * Varför: `toFailure` ger ett API-svar, och det är rätt för appens kod. Men en människa som fått
 * en adress av en kollega och klickar på den möts då av `{"error":{"code":"not_found",...}}` i
 * webbläsarfönstret — ett svar hon varken kan läsa eller göra något åt. Inloggningsvägen tog
 * redan det här beslutet åt sitt håll (inloggningssida.ts: "i stället för ett 401 som en
 * människa inte kan göra något med"); felvägen fick det aldrig. Här får den det.
 *
 * REGELN SOM INTE FÅR BRYTAS: sidan byggs UTESLUTANDE ur `Failure` och ur byggverktygets origin,
 * som är samma för varje besökare och varje app. Ingenting ur förfrågan — inget app-id, ingen
 * sökväg, ingen identitet — når hit. Det är det som gör att `hyresgast.ts` regel överlever
 * formatbytet: "appen finns inte", "appen saknar den här versionen" och "du har inte åtkomst"
 * ger redan IDENTISKA `Failure`, och identiska `Failure` ger därmed identiska sidor, byte för
 * byte. Den som vill kartlägga vilka app-id som finns får lika lite som förut.
 *
 * Därför står här inte heller något om VARFÖR det nekades. Texten räknar upp de vanliga
 * orsakerna utan att välja någon — samma text i alla lägen är hela poängen, inte en otydlighet
 * att städa bort. Den som frestas skriva "du saknar behörighet till den här appen" är på väg att
 * bygga just den kartläggning regeln finns för att stoppa.
 */
import type { Failure } from './fel.ts';

/** Samma färger som byggverktygets gränssnitt (`apps/builder-ui/src/styles.css`). */
const NAVY = '#0b2e59';
const BLUE = '#1a5ba6';
const INK = '#1b2533';
const MUTED = '#4a5668';

/**
 * Meddelandena är gatewayns egna (`fel.ts`) och innehåller inga specialtecken i dag. Kodningen
 * sker ändå: en text som en gång hamnar i ett HTML-dokument ska aldrig vara beroende av att
 * ingen senare lägger till ett citattecken i en felsträng.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const FAILURE_PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * `builderOrigin` är byggverktygets adress när gatewayn har ett byggverktyg — en publik,
 * oföränderlig sträng ur konfigurationen. Saknas den utelämnas länken, och sidan är fortfarande
 * densamma för alla.
 */
export function renderFailurePage(failure: Failure, builderOrigin: string | undefined): string {
  const message = escapeHtml(failure.body.error.message);
  const backLink =
    builderOrigin === undefined
      ? ''
      : `\n<p class="tillbaka"><a href="${escapeHtml(builderOrigin)}/">Till byggverktyget</a></p>`;

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${message}</title>
<style>
body { margin: 0; background: #fff; color: ${INK};
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 4rem 1.25rem; }
h1 { margin: 0 0 1rem; color: ${NAVY}; font-size: 1.5rem; line-height: 1.25; }
p { margin: 0 0 1rem; color: ${MUTED}; }
.tillbaka { margin-top: 2rem; }
a { color: ${BLUE}; }
a:focus-visible { outline: 3px solid #f2b600; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>${message}</h1>
<p>Adressen leder inte till någonting här. En apps adress är samtidigt dess nyckel, så en länk
som hunnit bli gammal, som bara kopierats till hälften eller som aldrig var menad för dig
slutar fungera.</p>
<p>Stämmer adressen? Be den som skickade den att dela appen på nytt.</p>${backLink}
</main>
</body>
</html>
`;
}
