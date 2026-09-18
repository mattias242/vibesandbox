'use strict';
const { defineConfig, devices } = require('@playwright/test');

// Kör allt i EN worker: en enda delad server, deterministisk matris.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: [['list']],
  timeout: 30000,
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    ignoreHTTPSErrors: true, // självsignerat cert
  },
  webServer: {
    command: 'node server.js',
    url: 'https://127.0.0.1:8443/_health',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
