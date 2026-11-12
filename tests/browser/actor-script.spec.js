const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

const REVISED = 'REVISED CUE';

test('a published script returns a browsing actor to the live cue', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const pages = [controller, audience, actor];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await actor.page.locator('#btn-actor-next').click();
    await expect(actor.page.locator('#actor-mode-status')).toHaveText('BROWSING');
    await expect(actor.page.locator('#slide-title')).toHaveText('Picture A');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill(REVISED);
    await controller.page.locator('#editor-publish').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();

    await expect(actor.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(REVISED);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(REVISED);
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(REVISED);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
