/**
 * Låst byggkonfiguration för byggverktygets gränssnitt, efter samma princip som appmallen:
 * inget utanför `src/` och `index.html` ska kunna påverka vad som byggs. Gränssnittet serveras
 * under byggverktygets CSP (`builderContentSecurityPolicy`): inga inline-skript, ingen eval,
 * inga externa resurser. `test/build.test.ts` granskar det byggda.
 */
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { builderApiMock } from './dev/mock.ts';

const uiDir = import.meta.dirname;

export default defineConfig({
  root: uiDir,

  // Gränssnittet ligger alltid i roten på byggverktygets värd.
  base: '/',

  // Ingen public/-katalog: allt som hamnar i bygget ska ha passerat src/.
  publicDir: false,

  // Inga .env-filer: inga värden eller hemligheter ska kunna smyga in i bunten.
  envDir: false,

  // Låtsas-API:t finns bara i utvecklingsservern (`apply: 'serve'`) och följer aldrig med i bygget.
  plugins: [react(), builderApiMock()],

  css: {
    // Inline-konfiguration ⇒ ingen sökning efter postcss.config.* (JavaScript som körs vid byggtid).
    postcss: { plugins: [] },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Egna filer i stället för data:-adresser, så att beteendet inte beror på filstorlek.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: path.join(uiDir, 'index.html'),
    },
  },

  server: {
    host: '127.0.0.1',
  },
});
