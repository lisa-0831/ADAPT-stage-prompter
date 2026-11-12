const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

test('each role shows only its own controls', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const missing = await openShow(browser, prompter.baseURL, null);
  const invalid = await openShow(browser, prompter.baseURL, 'nope');
  const pages = [controller, actor, audience, missing, invalid];

  try {
    await expect(controller.page.locator('html')).toHaveAttribute('data-role', 'controller');
    await expect(controller.page.locator('#controller')).toBeVisible();
    await expect(controller.page.locator('#btn-next')).toBeVisible();
    await expect(controller.page.locator('#btn-prev')).toBeVisible();
    await expect(controller.page.locator('#btn-edit-script')).toBeVisible();
    await expect(controller.page.locator('#btn-script-library')).toBeVisible();
    await expect(controller.page.locator('#actor-controls')).toBeHidden();

    await expect(actor.page.locator('html')).toHaveAttribute('data-role', 'actor');
    await expect(actor.page.locator('#actor-controls')).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Previous script cue' })).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Next script cue' })).toBeVisible();
    await expect(actor.page.getByRole('button', { name: 'Return to the live Controller position' })).toBeVisible();
    await expect(actor.page.locator('#controller')).toBeHidden();

    for (const entry of [audience, missing, invalid]) {
      await expect(entry.page.locator('html')).toHaveAttribute('data-role', 'audience');
      await expect(entry.page.locator('#role-label')).toHaveText('AUDIENCE');
      await expect(entry.page.locator('#controller')).toBeHidden();
      await expect(entry.page.locator('#actor-controls')).toBeHidden();
      await expect(entry.page.locator('#btn-next')).toBeHidden();
      await expect(entry.page.locator('#btn-actor-next')).toBeHidden();
    }

    const stylesheet = await controller.page.request.get(`${prompter.baseURL}/styles.css`);
    expect(stylesheet.status()).toBe(200);
    expect(stylesheet.headers()['content-type'] || '').toMatch(/css/);
    const css = await stylesheet.text();
    const assetUrls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]);
    expect(assetUrls.length).toBeGreaterThan(0);
    for (const assetUrl of assetUrls) {
      const resolved = new URL(assetUrl, `${prompter.baseURL}/styles.css`);
      const asset = await controller.page.request.get(resolved.toString());
      expect(asset.status(), assetUrl).toBe(200);
    }

    for (const entry of [controller, actor, audience]) {
      await expect(entry.page.locator('link[rel="stylesheet"]')).toHaveAttribute('href', '/styles.css');
      await expect(entry.page.locator('style')).toHaveCount(0);
      const applied = await entry.page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        const stage = getComputedStyle(document.getElementById('stage'));
        return {
          caption: root.getPropertyValue('--caption-size').trim(),
          background: body.backgroundColor,
          stageImage: stage.backgroundImage,
        };
      });
      expect(applied.caption).toContain('clamp');
      expect(applied.background).toBe('rgb(10, 10, 10)');
      expect(applied.stageImage).toContain('background.jpg');
    }

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
