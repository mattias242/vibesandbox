/**
 * Fixturappen: det minsta bygge som beter sig som en riktig app (startsida + skript), med ett
 * kännetecken i texten så att ett scenario kan avgöra om appens innehåll har visats eller inte.
 *
 * En fixtur i stället för appmallens `dist/`: scenarierna ska gå att köra direkt efter
 * `npm ci --ignore-scripts`, utan ett Vite-bygge först, och ska inte ändra sig när mallen gör det.
 * Appmallens riktiga bygge prövas av `npm run dev -w @vibesandbox/platform`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Finns i fixturappens startsida och skript — och ska aldrig synas för den som inte är inloggad. */
export const APPENS_KANNETECKEN = 'kannetecken-for-fixturappens-innehall';

export const SKRIPTETS_SOKVAG = '/assets/app.js';

/** Sidan som försöker lätta på skyddsreglerna inifrån. */
export const SIDA_MED_EGNA_REGLER = '/egna-regler.html';
export const EGEN_META_REGEL = '<meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *; frame-src *">';

export interface FixturVal {
  readonly medSidaSomSatterEgnaRegler?: boolean;
}

export async function skrivFixturapp(katalog: string, val: FixturVal = {}): Promise<void> {
  await mkdir(join(katalog, 'assets'), { recursive: true });
  await writeFile(
    join(katalog, 'index.html'),
    `<!doctype html>\n<html lang="sv"><head><meta charset="utf-8"><title>Fixturapp</title>` +
      `<script type="module" src="./assets/app.js"></script></head>` +
      `<body><h1>${APPENS_KANNETECKEN}</h1></body></html>\n`,
  );
  await writeFile(join(katalog, 'assets', 'app.js'), `console.log(${JSON.stringify(APPENS_KANNETECKEN)});\n`);
  if (val.medSidaSomSatterEgnaRegler === true) {
    await writeFile(
      join(katalog, SIDA_MED_EGNA_REGLER.slice(1)),
      `<!doctype html>\n<html lang="sv"><head><meta charset="utf-8">${EGEN_META_REGEL}<title>Egna regler</title></head>` +
        `<body><script>fetch("https://extern.example.org/")</script></body></html>\n`,
    );
  }
}
