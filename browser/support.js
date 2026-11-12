const { test: base, expect } = require('@playwright/test');

const { startFixture } = require('./fixture-server');

const test = base.extend({
  prompter: async ({}, use) => {
    const started = await startFixture();
    try {
      await use(started);
    } finally {
      await started.close();
    }
  },
});

async function openShow(browser, baseURL, role, viewport) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: viewport || { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location().url || '';
    // Chrome asks for /favicon.ico on its own. The page does not reference one.
    if (text.includes('favicon') || url.includes('favicon.ico')) return;
    errors.push(url ? `${text} (${url})` : text);
  });
  const suffix = role == null ? '/' : `/?role=${encodeURIComponent(role)}`;
  await page.goto(`${baseURL}${suffix}`);
  if (role === 'nope') await page.waitForURL(/role=viewer/);
  await expect(page.locator('#connecting')).toBeHidden();
  return { context, page, errors };
}

function assertQuiet(pages) {
  for (const entry of pages) {
    expect(entry.errors, entry.errors.join('\n')).toEqual([]);
  }
}

async function closeShows(pages) {
  await Promise.all(pages.map((entry) => entry.context.close()));
}

module.exports = {
  test,
  expect,
  openShow,
  assertQuiet,
  closeShows,
};
