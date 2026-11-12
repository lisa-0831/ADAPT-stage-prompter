const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

test('exit confirmation is controller-only, and staying leaves the show usable', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, actor, audience];

  try {
    await expect(controller.page.locator('#btn-exit')).toBeVisible();
    await expect(controller.page.locator('#exit-guard')).toBeHidden();
    await expect(actor.page.locator('#btn-exit')).toBeHidden();
    await expect(actor.page.locator('#exit-guard')).toBeHidden();
    await expect(audience.page.locator('#btn-exit')).toBeHidden();
    await expect(audience.page.locator('#exit-guard')).toBeHidden();

    await actor.page.keyboard.press('Escape');
    await expect(actor.page.locator('#exit-guard')).toBeHidden();

    await controller.page.keyboard.press('Escape');
    await expect(controller.page.locator('#exit-guard')).toBeVisible();
    await expect(controller.page.locator('#exit-guard')).toContainText('Exit Prompter?');
    await expect(controller.page.locator('#btn-stay')).toHaveText('Stay on Stage');
    await expect(controller.page.locator('#btn-confirm-exit')).toHaveText('Confirm Exit');
    await controller.page.keyboard.press('Escape');
    await expect(controller.page.locator('#exit-guard')).toBeHidden();

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#btn-exit').click();
    await expect(controller.page.locator('#exit-guard')).toBeVisible();
    await controller.page.keyboard.press('ArrowRight');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#btn-stay').click();
    await expect(controller.page.locator('#exit-guard')).toBeHidden();
    await controller.page.locator('#progress').click();
    await controller.page.keyboard.press('ArrowRight');
    await expect(controller.page.locator('#slide-title')).toHaveText('Picture A');
    await expect(audience.page.locator('#slide-title')).toHaveText('Picture A');

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('escape closes a clean editor and does not open the exit guard', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');

    await controller.page.keyboard.press('Escape');
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await expect(controller.page.locator('#exit-guard')).toBeHidden();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('confirming exit leaves this page and leaves the audience on the live cue', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-exit').click();
    await controller.page.locator('#btn-confirm-exit').click();
    await expect(controller.page).toHaveURL('about:blank');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows([controller, audience]);
  }
});
