const { test, expect, openShow, assertQuiet, closeShows } = require('./support');
const { startFixture } = require('./fixture-server');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a stale Set as Live revision is refused and the live show stays put', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();

    const listed = await controller.page.request.get(`${prompter.baseURL}/api/library`);
    const body = await listed.json();
    const saved = body.scripts.find((entry) => entry.title === prompter.otherTitle);
    const newer = await controller.page.request.put(`${prompter.baseURL}/api/library/${saved.id}`, {
      data: {
        text: `# ${prompter.otherTitle}\n[BLUE]\nREVISED BLUE ROOM\n`,
        expectedRevision: saved.revision,
      },
    });
    expect(newer.ok()).toBeTruthy();

    await controller.page.getByRole('button', { name: `Set as Live ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText('Set this script as Live?');
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-confirm-status')).toContainText('changed after you reviewed it');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Review latest');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-preview-body')).toContainText('REVISED BLUE ROOM');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    expect(controller.errors.filter((error) => !error.includes('409'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
  }
});

test('a staff code is required before the library lists productions', async ({ browser }) => {
  const prompter = await startFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.locator('#library-access')).toBeVisible();
    await expect(controller.page.locator('#library-status')).toContainText('staff access code');
    await expect(controller.page.getByRole('heading', { name: prompter.liveTitle })).toHaveCount(0);

    await controller.page.locator('#library-token').fill('wrong-code');
    await controller.page.locator('#library-token-continue').click();
    await expect(controller.page.locator('#library-status')).toContainText('not accepted');
    await expect(controller.page.locator('#library-access')).toBeVisible();

    await controller.page.locator('#library-token').fill('stage-staff');
    await controller.page.locator('#library-token-continue').click();
    await expect.poll(() => controller.page.evaluate(
      () => sessionStorage.getItem('prompter-staff-token'),
    )).toBe('stage-staff');
    await controller.page.locator('#library-close').click();
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.locator('#library-access')).toBeHidden();
    await expect(controller.page.getByRole('heading', { name: prompter.liveTitle })).toBeVisible();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);

    expect(controller.errors.filter((error) => !error.includes('401'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
    await prompter.close();
  }
});

test('an uploaded image stays with the production it was added to', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Manage Images ${prompter.liveTitle}` }).click();
    await expect(controller.page.locator('#library-images-list')).toContainText('card.png');
    await expect(controller.page.locator('#library-images-list')).not.toContainText('prop.png');
    await controller.page.locator('#library-images-back').click();

    await controller.page.getByRole('button', { name: `Manage Images ${prompter.otherTitle}` }).click();
    await controller.page.locator('#library-image-file').setInputFiles({
      name: 'prop.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(controller.page.locator('#library-images-status')).toContainText('Uploaded “prop.png”');
    await expect(controller.page.locator('#library-images-list')).toContainText('prop.png');
    await expect(controller.page.locator('#library-images-list')).not.toContainText('card.png');
    await controller.page.locator('#library-images-back').click();

    await controller.page.getByRole('button', { name: `Manage Images ${prompter.liveTitle}` }).click();
    await expect(controller.page.locator('#library-images-list')).toContainText('card.png');
    await expect(controller.page.locator('#library-images-list')).not.toContainText('prop.png');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('closing a saved-script edit returns to the library and leaves the live cue', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Edit ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    await expect(controller.page.locator('#script-library')).toBeHidden();
    await controller.page.locator('#editor-close').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await expect(controller.page.getByRole('heading', { name: 'Script Library' })).toBeVisible();
    await expect(controller.page.getByRole('heading', { name: prompter.otherTitle })).toBeVisible();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('library preview and editor preview each show the saved image, then the next preview replaces it', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Preview ${prompter.liveTitle}` }).click();
    const libraryImages = controller.page.locator('#library-preview-body img');
    await expect(libraryImages).toHaveCount(3);
    await expect.poll(() => libraryImages.first().evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(controller.page.locator('#library-preview-body')).toContainText(prompter.spoken);

    await controller.page.locator('#library-preview-back').click();
    await expect(controller.page.locator('#library-preview-body img')).toHaveCount(0);

    await controller.page.getByRole('button', { name: `Edit ${prompter.liveTitle}` }).click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    await controller.page.locator('#editor-preview-btn').click();
    const editorImages = controller.page.locator('#editor-preview img');
    await expect(editorImages).toHaveCount(1);
    await expect.poll(() => editorImages.first().evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(controller.page.locator('#editor-preview')).toContainText(prompter.spoken);

    await controller.page.locator('#editor-close').click();
    await expect(controller.page.getByRole('heading', { name: 'Script Library' })).toBeVisible();
    await controller.page.getByRole('button', { name: `Preview ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-preview-body')).toContainText(prompter.blue);
    await expect(controller.page.locator('#library-preview-body img')).toHaveCount(0);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
