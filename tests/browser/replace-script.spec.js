const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

const REPLACEMENT = [
  '# Replaced Scene',
  '[ADA]',
  'REPLACED CUE',
].join('\n');

async function openReplace(page) {
  await page.locator('#btn-upload-toggle').click();
  await expect(page.locator('#upload-area')).toBeVisible();
  await expect(page.locator('#script-textarea')).toHaveValue(/FIRST SPOKEN LINE/);
}

test('only the controller can open Replace Script, and cancel leaves the show', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const actor = await openShow(browser, prompter.baseURL, 'actor');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, actor, audience];

  try {
    await expect(controller.page.locator('#btn-upload-toggle')).toBeVisible();
    await expect(controller.page.locator('#upload-area')).toBeHidden();
    await expect(actor.page.locator('#btn-upload-toggle')).toBeHidden();
    await expect(audience.page.locator('#btn-upload-toggle')).toBeHidden();

    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await openReplace(controller.page);
    await controller.page.locator('#script-textarea').fill(REPLACEMENT);
    await controller.page.locator('#btn-upload-cancel').click();

    await expect(controller.page.locator('#upload-area')).toBeHidden();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('blank replacement text is not submitted', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const pages = [controller];
  let posts = 0;

  try {
    await controller.page.route(/\/script$/, async (route) => {
      if (route.request().method() === 'POST') posts += 1;
      await route.continue();
    });
    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await openReplace(controller.page);
    await controller.page.locator('#script-textarea').fill(' \n ');
    await controller.page.locator('#btn-upload-submit').click();

    await expect(controller.page.locator('#upload-area')).toBeVisible();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    expect(posts).toBe(0);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('a failed replacement reports the existing alert and leaves the show', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.route(/\/script$/, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'no' });
        return;
      }
      await route.continue();
    });
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await openReplace(controller.page);
    await controller.page.locator('#script-textarea').fill(REPLACEMENT);

    const dialog = controller.page.waitForEvent('dialog');
    await controller.page.locator('#btn-upload-submit').click();
    const alert = await dialog;
    expect(alert.message()).toBe('Upload failed — check server.');
    await alert.accept();

    await expect(controller.page.locator('#upload-area')).toBeVisible();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    expect(controller.errors.filter((error) => !error.includes('500'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
  }
});

test('replacing the script updates every screen and returns a browsing actor', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const following = await openShow(browser, prompter.baseURL, 'actor');
  const browsing = await openShow(browser, prompter.baseURL, 'actor');
  const pages = [controller, audience, following, browsing];

  try {
    await controller.page.locator('#btn-next').click();
    await expect(following.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await browsing.page.locator('#btn-actor-next').click();
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('BROWSING');
    await expect(browsing.page.locator('#slide-title')).toHaveText('Picture A');

    await openReplace(controller.page);
    await controller.page.locator('#script-textarea').fill(REPLACEMENT);
    await controller.page.locator('#btn-upload-submit').click();

    await expect(controller.page.locator('#upload-area')).toBeHidden();
    await expect(controller.page.locator('#slide-title')).toHaveText('Replaced Scene');
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText('REPLACED CUE');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/1 · Line 1/1');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('REPLACED CUE');
    await expect(following.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(following.page.locator('#lines-current .script-line')).toHaveText('REPLACED CUE');
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(browsing.page.locator('#lines-current .script-line')).toHaveText('REPLACED CUE');

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});
