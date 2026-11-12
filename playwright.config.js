const { defineConfig } = require('@playwright/test');

// Browser smoke tests launch their own temporary server. Do not point this
// config at `npm start`; that serves the repository's real script and library.
//
// This config uses the machine's installed Google Chrome (`channel: 'chrome'`).
// A future machine without Chrome should install Playwright's browser and
// then delete the `channel` line so the downloaded Chromium is used:
//
//   npx playwright install chromium

module.exports = defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    channel: 'chrome',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
});
