const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

test('browsing stays on one actor until Return to Live', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const following = await openShow(browser, prompter.baseURL, 'actor');
  const browsing = await openShow(browser, prompter.baseURL, 'actor');
  const pages = [controller, audience, following, browsing];

  try {
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await expect(following.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');

    await browsing.page.locator('#btn-actor-next').click();
    await browsing.page.locator('#btn-actor-next').click();
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('BROWSING');
    await expect(browsing.page.locator('#slide-title')).toHaveText('Picture A');
    await expect(browsing.page.locator('#title-image-overlay')).toHaveClass(/show/);

    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await expect(following.page.locator('#slide-title')).toHaveText('Opening');
    await expect(following.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(following.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(following.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(browsing.page.locator('#slide-title')).toHaveText('Picture A');

    await browsing.page.locator('#btn-return-live').click();
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(browsing.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
