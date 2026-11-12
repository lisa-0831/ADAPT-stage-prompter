const { test, expect, openShow, assertQuiet, closeShows } = require('./support');

async function progressWidth(page) {
  return page.locator('#progress-fill').evaluate((element) => element.style.width);
}

test('title images, image-only scenes, and an empty scene keep the controller in sync', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');

  try {
    await expect(controller.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await expect(controller.page.locator('#stage-content')).toBeHidden();
    await expect.poll(() => controller.page.locator('#title-image').evaluate((image) => (
      image.complete && image.naturalWidth > 0
    ))).toBe(true);
    await expect(controller.page.locator('#slide-select')).toHaveValue('0');
    await expect(controller.page.locator('#slide-select option:checked')).toHaveText('1. Opening');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Title image');
    await expect.poll(() => progressWidth(controller.page)).toBe('0%');

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#title-image-overlay')).not.toHaveClass(/show/);
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.spoken);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/5 · Line 1/1');
    await expect.poll(() => progressWidth(controller.page)).toBe('20%');

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#slide-title')).toHaveText('Picture A');
    await expect(controller.page.locator('#slide-select option:checked')).toHaveText('2. Picture A');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 2/5 · Title image');
    await expect(controller.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await expect.poll(() => progressWidth(controller.page)).toBe('40%');

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#slide-title')).toHaveText('Picture B');
    await expect(controller.page.locator('#slide-select option:checked')).toHaveText('3. Picture B');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 3/5 · Title image');
    await expect.poll(() => progressWidth(controller.page)).toBe('60%');

    await controller.page.locator('#btn-prev').click();
    await expect(controller.page.locator('#slide-title')).toHaveText('Picture A');
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 2/5 · Title image');
    await expect(controller.page.locator('#title-image-overlay')).toHaveClass(/show/);
    await expect.poll(() => progressWidth(controller.page)).toBe('40%');

    await controller.page.locator('#btn-next').click();
    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#slide-title')).toHaveText('Gap');
    await expect(controller.page.locator('#slide-select option:checked')).toHaveText('4. Gap');
    await expect(controller.page.locator('#title-image-overlay')).not.toHaveClass(/show/);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 4/5 · Line 1/0');

    await controller.page.locator('#btn-next').click();
    await expect(controller.page.locator('#slide-title')).toHaveText('Tail');
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(prompter.tail);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 5/5 · Line 1/1');

    assertQuiet([controller]);
  } finally {
    await closeShows([controller]);
  }
});
