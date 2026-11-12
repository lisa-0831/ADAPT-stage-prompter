const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

test('library preview and a cancelled Set as Live leave the audience on the current show', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.getByRole('heading', { name: 'Script Library' })).toBeVisible();
    await expect(controller.page.getByRole('heading', { name: prompter.liveTitle })).toBeVisible();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await expect(controller.page.getByRole('button', { name: `Already live: ${prompter.liveTitle}` })).toBeDisabled();

    await controller.page.getByRole('button', { name: `Preview ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-preview-body')).toContainText(prompter.blue);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);

    await controller.page.locator('#library-preview-back').click();
    await controller.page.getByRole('button', { name: `Set as Live ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText('Set this script as Live?');
    await expect(controller.page.locator('#library-confirm-body')).toContainText(`Current live script: ${prompter.liveTitle}`);
    await expect(controller.page.locator('#library-confirm-body')).toContainText(`New live script: ${prompter.otherTitle}`);
    await controller.page.locator('#library-confirm-no').click();
    await expect(controller.page.locator('#library-confirm')).toBeHidden();
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('confirming Set as Live switches every connected screen to that production', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await controller.page.getByRole('button', { name: `Set as Live ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText('Set this script as Live?');
    await controller.page.locator('#library-confirm-yes').click();

    await expect(audience.page.locator('#slide-title')).toHaveText('Blue Room');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.blue);
    await expect(audience.page.locator('#title-image-overlay')).not.toHaveClass(/show/);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/1 · Line 1/1');
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.blue);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
