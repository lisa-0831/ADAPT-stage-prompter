const { test, expect, openShow, assertQuiet, closeShows } = require('./support');
const { startVersionedFixture } = require('./versioned-fixture');

function lastOf(sockets, type) {
  return [...sockets].reverse().find((message) => message && message.type === type) || null;
}

function cueIndex(message) {
  if (!message) return undefined;
  if (message.state && typeof message.state.lineIndex === 'number') return message.state.lineIndex;
  return message.lineIndex;
}

async function reviseOpening(page, from, to) {
  await expect(page.locator('#script-editor')).toBeVisible();
  const dialogue = page.getByRole('textbox', { name: /Dialogue/ }).first();
  await expect(dialogue).toBeVisible();
  await dialogue.fill(to);
  void from;
}

test('versioned controller, actor, and audience stay on the live cue', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const actor = await openShow(browser, fixture.baseURL, 'actor');
  const browsing = await openShow(browser, fixture.baseURL, 'actor');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const phone = await openShow(browser, fixture.baseURL, 'audience', { width: 390, height: 844 });
  const pages = [controller, actor, browsing, audience, phone];

  try {
    for (const show of [controller, actor, audience, phone]) {
      await expect(show.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
      expect(lastOf(show.sockets, 'script').revision).toBeTruthy();
      expect(cueIndex(lastOf(show.sockets, 'state'))).toBe(0);
    }
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/3 · Line 1/1');
    await expect(phone.page.locator('#btn-next')).toBeHidden();

    await browsing.page.locator('#btn-actor-next').click();
    await browsing.page.locator('#btn-actor-next').click();
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('BROWSING');
    await expect(browsing.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    await expect(actor.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);

    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.direction);
    await expect(actor.page.locator('#lines-current .script-line')).toHaveText(fixture.direction);
    await expect(browsing.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    await expect(audience.page.locator('#lines-past .script-line')).toContainText(fixture.direction);
    const pastColor = await audience.page.locator('#lines-past .script-line').evaluate((node) => getComputedStyle(node).color);
    const currentColor = await audience.page.locator('#lines-current .script-line').evaluate((node) => getComputedStyle(node).color);
    expect(pastColor).not.toBe(currentColor);
    expect(cueIndex(lastOf(controller.sockets, 'state'))).toBe(1);
    expect(cueIndex(lastOf(audience.sockets, 'state'))).toBe(1);

    await browsing.page.locator('#btn-return-live').click();
    await expect(browsing.page.locator('#actor-mode-status')).toHaveText('FOLLOWING LIVE');
    await expect(browsing.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);

    await controller.page.locator('#btn-case').click();
    await expect(controller.page.locator('#lines-current .script-line')).toHaveText(
      fixture.middle.charAt(0) + fixture.middle.slice(1).toLowerCase(),
    );
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);

    const late = await openShow(browser, fixture.baseURL, 'audience');
    pages.push(late);
    await expect(late.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    expect(cueIndex(lastOf(late.sockets, 'state'))).toBe(1);

    assertQuiet(pages);
  } finally {
    await closeShows(pages);
    await fixture.close();
  }
});

test('versioned publish preserves the cue and switching productions resets it', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-next').click();
    await controller.page.locator('#btn-next').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);

    await controller.page.locator('#btn-edit-script').click();
    await reviseOpening(controller.page, fixture.spoken, 'REVISED OPENING');
    await controller.page.locator('#editor-publish').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.locator('#script-editor')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    expect(cueIndex(lastOf(audience.sockets, 'state'))).toBe(1);

    await controller.page.locator('#btn-edit-script').click();
    await controller.page.locator('#editor-restore').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.middle);
    await controller.page.locator('#editor-close').click();
    await controller.page.locator('#btn-prev').click();
    await controller.page.locator('#btn-prev').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);

    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Set as Live ${fixture.otherTitle}` }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.blue);
    await expect(controller.page.locator('#ctrl-status')).toHaveText('Slide 1/1 · Line 1/1');
    expect(lastOf(audience.sockets, 'script').liveScriptId).toBe(fixture.otherId);

    const baseURL = fixture.baseURL;
    await closeShows(pages);
    pages.length = 0;
    await fixture.restart();
    const after = await openShow(browser, fixture.baseURL, 'audience');
    pages.push(after);
    await expect(after.page.locator('#lines-current .script-line')).toHaveText(fixture.blue);
    expect(fixture.baseURL).not.toBe(baseURL);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
    await fixture.close();
  }
});

test('a committed publish whose screen update fails stays live after restart', async ({ browser }) => {
  const fixture = await startVersionedFixture({ failSynchronization: 'throw' });
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-edit-script').click();
    await reviseOpening(controller.page, fixture.spoken, 'REVISED CUE');
    await controller.page.locator('#editor-publish').click();
    await controller.page.locator('#editor-confirm-yes').click();
    await expect(controller.page.locator('#controller-notice')).toContainText('Connected screens have not been updated');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);

    await closeShows(pages);
    pages.length = 0;
    await fixture.restart();
    const after = await openShow(browser, fixture.baseURL, 'audience');
    pages.push(after);
    await expect(after.page.locator('#lines-current .script-line')).toHaveText('REVISED CUE');
  } finally {
    await closeShows(pages);
    await fixture.close();
  }
});
