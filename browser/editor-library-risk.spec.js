const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('closing with unsaved edits asks before discarding, and the audience stays on the live line', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill('UNSAVED LINE');
    await controller.page.locator('#editor-close').click();
    await expect(controller.page.locator('#editor-confirm-heading')).toHaveText('Discard unsaved edits?');
    await controller.page.locator('#editor-confirm-no').click();
    await expect(controller.page.locator('#script-editor')).toBeVisible();
    await expect(controller.page.getByLabel(/Dialogue/)).toHaveValue('UNSAVED LINE');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#editor-close').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('confirming Restore returns the previous live line and keeps both saved productions', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill('TEMPORARY LINE');
    await controller.page.locator('#editor-publish').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('TEMPORARY LINE');
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-restore')).toBeVisible();
    await controller.page.locator('#editor-restore').click();
    await expect(controller.page.locator('#editor-confirm-heading')).toHaveText('Restore the previous script?');
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#editor-close').click();
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.getByRole('heading', { name: prompter.liveTitle })).toBeVisible();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await controller.page.getByRole('button', { name: `Preview ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-preview-body')).toContainText(prompter.blue);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('saving an edited library script leaves the live show on its current cue', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Edit ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    await controller.page.getByLabel(/Dialogue/).fill('LIBRARY ONLY');
    await controller.page.locator('#editor-save-library').click();
    await expect(controller.page.locator('#editor-status')).toHaveText('Saved to the library. The live show was not changed.');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#editor-close').click();
    await controller.page.getByRole('button', { name: `Preview ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-preview-body')).toContainText('LIBRARY ONLY');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('a library save reports a stale revision and does not replace the newer copy or the live cue', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Edit ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    const listed = await controller.page.request.get(`${prompter.baseURL}/api/library`);
    const body = await listed.json();
    const saved = body.scripts.find((entry) => entry.title === prompter.otherTitle);
    const newer = await controller.page.request.put(`${prompter.baseURL}/api/library/${saved.id}`, {
      data: {
        text: `# ${prompter.otherTitle}\n[BLUE]\nNEWER LIBRARY LINE\n`,
        expectedRevision: saved.revision,
      },
    });
    expect(newer.ok()).toBeTruthy();
    await controller.page.getByLabel(/Dialogue/).fill('STALE EDIT');
    await controller.page.locator('#editor-save-library').click();
    await expect(controller.page.locator('#editor-status')).toContainText('changed after you opened it');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await controller.page.locator('#editor-close').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await controller.page.getByRole('button', { name: `Preview ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-preview-body')).toContainText('NEWER LIBRARY LINE');
    await expect(controller.page.locator('#library-preview-body')).not.toContainText('STALE EDIT');
    expect(controller.errors.filter((error) => !error.includes('409'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
  }
});

test('uploading an image and assigning it to a saved scene does not change the live show', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Manage Images ${prompter.otherTitle}` }).click();
    await controller.page.locator('#library-image-file').setInputFiles({
      name: 'prop.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(controller.page.locator('#library-images-status')).toContainText('Uploaded “prop.png”');
    await controller.page.locator('#library-images-back').click();
    await controller.page.getByRole('button', { name: `Edit ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    await controller.page.getByRole('button', { name: 'Choose image' }).click();
    await controller.page.getByRole('button', { name: 'prop.png' }).click();
    await expect(controller.page.locator('#editor-scene-image-label')).toHaveText('Scene image: prop.png');
    await controller.page.locator('#editor-save-library').click();
    await expect(controller.page.locator('#editor-status')).toHaveText('Saved to the library. The live show was not changed.');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('an open editor shows a conflict when another controller publishes, and closing does not overwrite that publish', async ({ browser, prompter }) => {
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const first = await openShow(browser, prompter.baseURL, 'controller');
  const second = await openShow(browser, prompter.baseURL, 'controller');
  const pages = [audience, first, second];

  try {
    await first.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await first.page.locator('#btn-edit-script').click();
    await expect(first.page.locator('#editor-status')).toContainText('does not change until you publish');
    await second.page.locator('#btn-edit-script').click();
    await expect(second.page.locator('#editor-status')).toContainText('does not change until you publish');
    await second.page.getByLabel(/Dialogue/).fill('OTHER PUBLISH');
    await second.page.locator('#editor-publish').click();
    await second.page.locator('#editor-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('OTHER PUBLISH');
    await expect(first.page.locator('#editor-conflict')).toContainText('changed while this editor was open');
    await first.page.locator('#editor-close').click();
    await expect(first.page.locator('#script-editor')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('OTHER PUBLISH');
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('cancelling publish keeps the edit on this controller and leaves the audience unchanged', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill('UNPUBLISHED LINE');
    await controller.page.locator('#editor-publish').click();
    await expect(controller.page.locator('#editor-confirm-heading')).toHaveText('Publish this script?');
    await controller.page.locator('#editor-confirm-no').click();
    await expect(controller.page.locator('#editor-confirm')).toBeHidden();
    await expect(controller.page.locator('#script-editor')).toBeVisible();
    await expect(controller.page.getByLabel(/Dialogue/)).toHaveValue('UNPUBLISHED LINE');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('publishing the live script sends the linked library revision and updates the audience', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    const listed = await controller.page.request.get(`${prompter.baseURL}/api/library`);
    const saved = (await listed.json()).scripts.find((entry) => entry.title === prompter.liveTitle);
    let posted = null;
    await controller.page.route(/\/script$/, async (route) => {
      if (route.request().method() === 'POST') {
        posted = {
          headers: route.request().headers(),
          body: route.request().postData(),
        };
      }
      await route.continue();
    });
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-edit-script').click();
    await expect(controller.page.locator('#editor-status')).toContainText('does not change until you publish');
    await controller.page.getByLabel(/Dialogue/).fill('LINKED PUBLISH');
    await controller.page.locator('#editor-publish').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('LINKED PUBLISH');
    expect(posted.body).toContain('LINKED PUBLISH');
    expect(posted.headers['content-type']).toContain('text/plain');
    expect(posted.headers['x-library-id']).toBe(saved.id);
    expect(posted.headers['x-library-revision']).toBe(saved.revision);
    expect(posted.headers['x-restore-previous']).toBeUndefined();
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
