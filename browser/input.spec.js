const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

async function insideViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('keyboard navigation respects focus, and actor edge taps stay local', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const pages = [controller, actor];

  try {
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');
    await controller.page.keyboard.press('ArrowRight');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');

    await controller.page.locator('#btn-prev').focus();
    await controller.page.keyboard.press('ArrowLeft');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');

    await controller.page.locator('#progress').click();
    await controller.page.keyboard.press('ArrowLeft');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');

    await actor.page.locator('#zone-next').click();
    await expect(actor.page.locator('#actor-mode-status')).toHaveText('BROWSING');
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('sentence case stays on the controller, and captions fit two viewports', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#btn-case').click();
    await expect(controller.page.locator('#btn-case')).toHaveAttribute('aria-pressed', 'true');
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText('First spoken line');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await controller.page.setViewportSize(viewport);
      await expect(controller.page.locator('#lines-current .script-line')).toBeVisible();
      await expect(controller.page.locator('#btn-next')).toBeVisible();
      await insideViewport(controller.page, '#lines-current .script-line');
      await insideViewport(controller.page, '#btn-next');
      const fontSize = await controller.page.locator('#lines-current .script-line').evaluate((element) => (
        Number.parseFloat(getComputedStyle(element).fontSize)
      ));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
