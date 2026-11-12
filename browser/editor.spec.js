const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

const REVISED = 'REVISED CUE';

test('editor preview and drafts stay local, and cancelling restore keeps the published line', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#script-editor')).toBeVisible();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.locator('#editor-close').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();

    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill(REVISED);
    await controller.page.locator('#editor-preview-btn').click();
    await expect(controller.page.locator('#editor-preview')).toContainText(REVISED);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#editor-save').click();
    await expect(controller.page.locator('#editor-status')).toHaveText(
      'Draft saved in this browser. The live show was not changed.',
    );
    const controllerDrafts = await controller.page.evaluate(() => (
      Object.keys(localStorage).filter((key) => key.startsWith('prompter-script-draft:'))
    ));
    expect(controllerDrafts).toHaveLength(1);
    const saved = await controller.page.evaluate((key) => localStorage.getItem(key), controllerDrafts[0]);
    expect(saved).toContain(REVISED);
    const audienceDrafts = await audience.page.evaluate(() => (
      Object.keys(localStorage).filter((key) => key.startsWith('prompter-script-draft:'))
    ));
    expect(audienceDrafts).toEqual([]);

    await controller.page.locator('#editor-close').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('Opened your saved draft');
    await expect(controller.page.getByLabel(/Dialogue/)).toHaveValue(REVISED);

    await controller.page.locator('#editor-publish').click();
    await expect(controller.page.locator('#editor-confirm-heading')).toHaveText('Publish this script?');
    await expect(controller.page.locator('#editor-confirm-yes')).toHaveText('Publish Now');
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(REVISED);

    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-restore')).toBeVisible();
    await controller.page.locator('#editor-restore').click();
    await expect(controller.page.locator('#editor-confirm-heading')).toHaveText('Restore the previous script?');
    await controller.page.locator('#editor-confirm-no').click();
    await expect(controller.page.locator('#editor-confirm')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(REVISED);
    await controller.page.locator('#editor-close').click();

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
