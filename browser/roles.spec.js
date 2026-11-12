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

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
