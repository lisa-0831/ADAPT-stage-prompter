const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { test, expect, openShow, closeShows } = require('./support');
const { startVersionedFixture } = require('./versioned-fixture');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('create production is a separate form and cancel adds nothing', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const posts = [];
  controller.page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/library') posts.push(request.url());
  });
  const before = fs.readdirSync(path.join(fixture.libraryDir, 'productions')).sort();

  try {
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.locator('#library-new-title')).toHaveCount(0);
    await expect(controller.page.locator('#library-save-live')).toHaveCount(0);
    await expect(controller.page.locator('#library-add')).toHaveCount(0);
    await expect(controller.page.locator('#library-create-open')).toBeVisible();
    await expect(controller.page.locator('#library-create')).toBeHidden();

    await controller.page.locator('#library-create-open').click();
    await expect(controller.page.locator('#library-create')).toBeVisible();
    await expect(controller.page.locator('#library-list')).toBeHidden();
    await controller.page.locator('#library-create-name').fill('Unused Room');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'unused.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# Unused\n[ADA]\nNOT SAVED\n'),
    });
    await controller.page.locator('#library-create-cancel').click();
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#library-list')).toBeVisible();
    await expect(controller.page.locator('#library-status')).toContainText('Nothing was added');
    expect(posts).toEqual([]);
    expect(fs.readdirSync(path.join(fixture.libraryDir, 'productions')).sort()).toEqual(before);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('delete asks first, removes one production, and stays gone after restart', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const deletes = [];
  controller.page.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/library/')) {
      deletes.push(new URL(request.url()).pathname);
    }
  });
  const otherDir = path.join(fixture.libraryDir, 'productions', fixture.otherId);
  const liveDir = path.join(fixture.libraryDir, 'productions', fixture.liveId);
  const liveHash = sha256(path.join(liveDir, 'metadata.json'));
  const otherVersions = fs.readdirSync(path.join(otherDir, 'versions'));
  expect(otherVersions.length).toBeGreaterThan(0);

  try {
    await controller.page.locator('#btn-script-library').click();
    const liveDelete = controller.page.getByRole('button', {
      name: `Delete unavailable while ${fixture.liveTitle} is live. Set another production as Live first.`,
    });
    const otherDelete = controller.page.getByRole('button', { name: `Delete ${fixture.otherTitle}` });
    await expect(liveDelete).toBeDisabled();
    await expect(otherDelete).toBeEnabled();

    await otherDelete.click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText(`Permanently delete '${fixture.otherTitle}'?`);
    await expect(controller.page.locator('#library-confirm-body')).toContainText('all saved versions');
    await expect(controller.page.locator('#library-confirm-body')).toContainText('cannot be undone in the app');
    await controller.page.locator('#library-confirm-no').click();
    await expect(controller.page.locator('#library-confirm')).toBeHidden();
    expect(deletes).toEqual([]);
    expect(fs.existsSync(path.join(otherDir, 'metadata.json'))).toBe(true);
    expect(fs.readdirSync(path.join(otherDir, 'versions')).sort()).toEqual(otherVersions.sort());

    await otherDelete.click();
    await Promise.all([
      controller.page.locator('#library-confirm-yes').click(),
      controller.page.locator('#library-confirm-yes').click(),
    ]);
    await expect(controller.page.locator('#library-status')).toContainText(`Permanently deleted “${fixture.otherTitle}”`);
    await expect(controller.page.locator('#library-status')).toContainText('cannot be undone in the app');
    await expect(controller.page.locator('#library-confirm')).toBeHidden();
    await expect(controller.page.getByRole('heading', { name: fixture.otherTitle })).toHaveCount(0);
    await expect(controller.page.getByRole('heading', { name: fixture.liveTitle })).toBeVisible();
    expect(deletes).toEqual([`/api/library/${fixture.otherId}`]);
    expect(fs.existsSync(otherDir)).toBe(false);
    expect(sha256(path.join(liveDir, 'metadata.json'))).toBe(liveHash);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);

    const refused = await controller.page.request.delete(`${fixture.baseURL}/api/library/${fixture.liveId}`, {
      data: { expectedGeneration: 1 },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe('live-production');
    expect(fs.existsSync(path.join(liveDir, 'metadata.json'))).toBe(true);

    const restarted = await fixture.restart();
    const again = await openShow(browser, restarted, 'controller');
    try {
      await again.page.locator('#btn-script-library').click();
      await expect(again.page.getByRole('heading', { name: fixture.otherTitle })).toHaveCount(0);
      await expect(again.page.getByRole('heading', { name: fixture.liveTitle })).toBeVisible();
      expect(fs.existsSync(otherDir)).toBe(false);
      expect(sha256(path.join(liveDir, 'metadata.json'))).toBe(liveHash);
    } finally {
      await closeShows([again]);
    }
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});
