import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Varje testfil får egna temporära datakataloger; inget delat tillstånd mellan filer.
    isolate: true,
  },
});
