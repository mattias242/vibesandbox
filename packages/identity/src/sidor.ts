/**
 * Inloggningssidorna. Rena funktioner som ger HTML.
 *
 * - Fungerar helt UTAN JavaScript: appvärdarnas CSP tillåter bara skript från den egna värden och
 *   inga inline-skript. Stilen ligger i ett `<style>`-block (`style-src 'unsafe-inline'`).
 * - Hämtar ingenting utifrån: inga typsnitt, bilder eller adresser till andra värdar.
 * - Allt som kommer ur förfrågan (bara `next`) eskapas. Adressen ekas ALDRIG — sidan efter
 *   "skicka kod" ska se exakt likadan ut för en inbjuden och en ej inbjuden adress.
 */
import { AUTH_PREFIX } from '@vibesandbox/contracts';

export const LOGIN_PATH = `${AUTH_PREFIX}/login`;
export const VERIFY_PATH = `${AUTH_PREFIX}/verify`;
export const LOGOUT_PATH = `${AUTH_PREFIX}/logout`;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #5c5c57; --card: #fff;
          --line: #d5d5cf; --accent: #1f5f8b; --accent-fg: #fff; --warn: #8a2a0a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ececea; --muted: #a6a6a0; --card: #222220; --line: #3a3a37;
            --accent: #7fb7de; --accent-fg: #0d1a24; --warn: #f0a488; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--fg);
         font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 26rem; background: var(--card); border: 1px solid var(--line);
         border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: .35rem; }
  input { width: 100%; font: inherit; padding: .65rem .75rem; border: 1px solid var(--line);
          border-radius: 8px; background: transparent; color: inherit; }
  input.kod { letter-spacing: .35em; font-size: 1.4rem; text-align: center; }
  button { margin-top: 1rem; width: 100%; font: inherit; font-weight: 600; padding: .7rem;
           border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .fel { color: var(--warn); font-weight: 600; }
  a { color: var(--accent); }
  .liten { font-size: .9rem; margin-top: 1rem; }
`;

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${content}
</main>
</body>
</html>
`;
}

function errorLine(message: string | undefined): string {
  return message === undefined ? '' : `<p class="fel" role="alert">${escapeHtml(message)}</p>\n`;
}

/** Steg 1: e-postadressen. `next` är redan kontrollerad (nasta.ts) men eskapas ändå. */
export function loginPage(next: string, error?: string): string {
  return page(
    'Logga in',
    `<h1>Logga in</h1>
<p>Skriv din e-postadress, så skickar vi en engångskod till den.</p>
${errorLine(error)}<form method="post" action="${LOGIN_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="email">E-postadress</label>
<input id="email" name="email" type="email" autocomplete="email" required maxlength="254" autofocus>
<button type="submit">Skicka kod</button>
</form>`,
  );
}

/**
 * Steg 2: koden. Samma sida oavsett om adressen är inbjuden — därför "om adressen har tillgång".
 */
export function codePage(error?: string): string {
  return page(
    'Skriv in koden',
    `<h1>Skriv in koden</h1>
<p>Om adressen har tillgång har vi skickat en kod med sex siffror till den. Koden gäller i tio minuter.</p>
${errorLine(error)}<form method="post" action="${VERIFY_PATH}">
<label for="code">Kod</label>
<input id="code" class="kod" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<button type="submit">Logga in</button>
</form>
<p class="liten">Ingen kod? Kontrollera skräpposten, eller <a href="${LOGIN_PATH}">börja om</a>.</p>`,
  );
}

/** Utmaningen finns inte längre: förbrukad, utgången, ersatt, eller från en annan webbläsare. */
export function expiredPage(): string {
  return page(
    'Koden gäller inte',
    `<h1>Koden gäller inte längre</h1>
<p>Koden har gått ut, redan använts eller ersatts av en nyare. Den fungerar också bara i den webbläsare där du begärde den.</p>
<p><a href="${LOGIN_PATH}">Begär en ny kod</a></p>`,
  );
}

export function rateLimitedPage(): string {
  return page(
    'Vänta en stund',
    `<h1>För många försök</h1>
<p>Det har gjorts för många inloggningsförsök på kort tid. Vänta en stund och försök sedan igen.</p>
<p><a href="${LOGIN_PATH}">Tillbaka till inloggningen</a></p>`,
  );
}

export function forbiddenPage(): string {
  return page(
    'Nekad',
    `<h1>Förfrågan nekades</h1>
<p>Formuläret skickades inte från den här sidan. Öppna inloggningen igen och försök på nytt.</p>
<p><a href="${LOGIN_PATH}">Till inloggningen</a></p>`,
  );
}

export function badRequestPage(): string {
  return page(
    'Något blev fel',
    `<h1>Något blev fel</h1>
<p>Formuläret kunde inte läsas. Öppna inloggningen igen och försök på nytt.</p>
<p><a href="${LOGIN_PATH}">Till inloggningen</a></p>`,
  );
}

export function methodNotAllowedPage(): string {
  return page(
    'Fel metod',
    `<h1>Adressen kan inte öppnas direkt</h1>
<p><a href="${LOGIN_PATH}">Till inloggningen</a></p>`,
  );
}
