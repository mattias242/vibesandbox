/**
 * Låst byggkonfiguration. Principen: BARA `src/` får påverka vad som byggs.
 *
 * Appens kod skrivs av en AI-modell och hamnar i `src/`. Allt annat i den här katalogen ägs av
 * mallen och skrivs över av plattformen före varje bygge. Varje inställning nedan stänger en
 * väg där en fil utanför `src/` annars hade kunnat köra kod vid byggtid eller smyga in innehåll
 * i den färdiga appen. `test/build.test.ts` prövar låsningen med fientliga filer.
 *
 * Ändra inget här utan att samtidigt lägga till ett test som visar varför.
 */
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const templateDir = import.meta.dirname;

export default defineConfig({
  root: templateDir,

  // Relativa sökvägar i index.html: appen fungerar oavsett under vilken adress den serveras.
  base: './',

  // Ingen public/-katalog. Den kopieras annars rakt in i bygget, förbi all granskning av src/.
  publicDir: false,

  // Inga .env-filer läses. De kan annars smuggla in värden i bunten — och på en byggserver
  // läcka hemligheter dit. `import.meta.env.DEV/PROD/MODE` finns kvar; de kommer inte från filer.
  envDir: false,

  plugins: [react()],

  css: {
    // En inline-konfiguration stänger av Vites sökning efter postcss.config.* / .postcssrc*.
    // Sådana filer är JavaScript som körs vid byggtid. Av samma skäl finns ingen Tailwind i
    // mallen (dess @plugin/@config laddar JavaScript). Vanlig CSS räcker.
    postcss: { plugins: [] },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,

    // Källkartor skulle publicera appens källkod och ge fler filer att granska.
    sourcemap: false,

    // Alla resurser blir egna filer i stället för data:-adresser. Plattformens CSP tillåter
    // t.ex. inte typsnitt som data: (font-src 'self'), så beteendet ska inte bero på filstorlek.
    assetsInlineLimit: 0,

    // Polyfillen behövs inte i de webbläsare plattformen stöder, och är kod vi slipper granska.
    modulePreload: { polyfill: false },

    rolldownOptions: {
      // Fast ingång: en index.html någon annanstans (t.ex. i src/) blir aldrig en egen sida.
      input: path.join(templateDir, 'index.html'),
    },
  },

  server: {
    // Utvecklingsservern lyssnar bara lokalt.
    host: '127.0.0.1',
  },
});
