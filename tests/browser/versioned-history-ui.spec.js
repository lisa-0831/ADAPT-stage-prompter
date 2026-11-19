const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { test, expect, openShow, closeShows } = require('./support');
const { startFixture } = require('./fixture-server');
const { startVersionedFixture } = require('./versioned-fixture');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function versionDir(fixture, productionId) {
  return path.join(fixture.libraryDir, 'productions', productionId, 'versions');
}

async function saveEditedHead(page, baseURL, productionId, versionId, text, revision) {
  const saved = await page.request.put(`${baseURL}/api/library/${productionId}`, {
    headers: { 'X-Version-Id': versionId },
    data: { text, expectedRevision: revision },
  });
  expect(saved.status()).toBe(200);
  return saved.json();
}

test('version history can be previewed and restored without moving the live show', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const editedId = '55555555-5555-4555-8555-555555555555';
  const restoredId = '66666666-6666-4666-8666-666666666666';

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    const history = await listed.json();
    const original = history.versions.find((version) => version.savedHead);
    const sourceBytes = fs.readFileSync(path.join(versionDir(fixture, fixture.liveId), original.versionId, 'script.txt'));
    const mirror = sha256(path.join(fixture.root, 'script.txt'));
    const liveState = sha256(path.join(fixture.libraryDir, 'live-state.json'));
    await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.liveId,
      editedId,
      '# Opening\n[ADA]\nEDITED HEAD\n',
      original.contentHash,
    );

    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await expect(controller.page.locator('#library-history')).toBeVisible();
    await expect(controller.page.locator('#library-history-list')).toContainText('Latest Saved');
    await expect(controller.page.locator('#library-history-list')).toContainText('Live Now');
    await expect(controller.page.locator('#library-history-list')).toContainText('Version 1');
    await expect(controller.page.locator('#library-history-list')).toContainText('Original save time unavailable');
    await expect(controller.page.locator('.history-version h4').first()).toHaveText('Version 2');
    await expect(controller.page.getByText('EDITED HEAD', { exact: false })).toHaveCount(0);

    const scriptFrames = () => audience.sockets.filter((message) => message.type === 'script').length;
    const beforeFrames = scriptFrames();
    const liveCard = controller.page.locator('.history-version', { hasText: 'Live Now' });
    await liveCard.getByRole('button', { name: /Preview Version/ }).click();
    await expect(controller.page.locator('#library-history-preview-text')).toContainText(fixture.spoken);
    await expect(controller.page.locator('#library-history-preview')).toContainText('Read only');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(scriptFrames()).toBe(beforeFrames);
    expect(sha256(path.join(fixture.root, 'script.txt'))).toBe(mirror);
    expect(sha256(path.join(fixture.libraryDir, 'live-state.json'))).toBe(liveState);

    await controller.page.locator('#library-history-restore').click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText('Restore this saved version?');
    await expect(controller.page.locator('#library-confirm-body')).toContainText('will not switch');
    await controller.page.locator('#library-confirm-no').click();
    expect(fs.existsSync(path.join(versionDir(fixture, fixture.liveId), restoredId))).toBe(false);

    const restores = [];
    controller.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/restore')) restores.push(request.url());
    });
    let releaseRestore;
    const held = new Promise((resolve) => { releaseRestore = resolve; });
    await controller.page.route('**/restore', async (route) => {
      await held;
      await route.continue();
    });
    await controller.page.locator('#library-history-restore').click();
    const yes = controller.page.locator('#library-confirm-yes');
    const clicked = yes.click();
    await expect(yes).toBeDisabled();
    releaseRestore();
    await clicked;
    await expect(controller.page.locator('#library-history-status')).toContainText('not live');
    expect(restores).toHaveLength(1);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(fs.readFileSync(path.join(versionDir(fixture, fixture.liveId), original.versionId, 'script.txt')).equals(sourceBytes)).toBe(true);
    expect(sha256(path.join(fixture.root, 'script.txt'))).toBe(mirror);
    expect(sha256(path.join(fixture.libraryDir, 'live-state.json'))).toBe(liveState);
    await controller.page.locator('#library-history-back').click();
    await expect(controller.page.getByRole('heading', { name: fixture.liveTitle, exact: true })).toBeVisible();

    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await controller.page.locator('.history-version', { hasText: 'Latest Saved' }).getByRole('button', { name: /as a new saved version/ }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-history-status')).toContainText('Another version was not created');

    const other = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.otherId}`);
    const otherBody = await other.json();
    const switched = await controller.page.request.post(`${fixture.baseURL}/api/library/${fixture.otherId}/live`, {
      data: { expectedRevision: otherBody.script.revision },
    });
    expect(switched.ok()).toBeTruthy();
    await controller.page.locator('#library-history-back').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await expect(controller.page.locator('#library-history-list')).toContainText('Previous live');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.blue);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('a stale saved head is shown and is not restored again automatically', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    const history = await listed.json();
    const original = history.versions.find((version) => version.savedHead);
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await controller.page.getByRole('button', { name: /as a new saved version/ }).click();
    await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.liveId,
      '55555555-5555-4555-8555-555555555555',
      '# Opening\n[ADA]\nNEWER HEAD\n',
      original.contentHash,
    );
    const restores = [];
    controller.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/restore')) restores.push(1);
    });
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-confirm-status')).toContainText('was not repeated');
    expect(restores).toHaveLength(1);
    await expect(controller.page.locator('#library-history-list')).toContainText('Latest Saved');
    await controller.page.locator('#library-confirm-no').click();
    expect(restores).toHaveLength(1);
  } finally {
    await closeShows([controller]);
    await fixture.close();
  }
});

test('shared and missing historical images are explained, and orphans stay out of the list', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const created = await controller.page.request.post(`${fixture.baseURL}/api/library`, {
      data: {
        title: 'Shared Picture',
        text: '# Card\n@image: images/Title_Card.jpeg\n[ADA]\nSHARED LINE\n',
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: 'Version History Shared Picture' }).click();
    await expect(controller.page.locator('#library-history-list')).toContainText('Historical replay is not guaranteed');
    await controller.page.getByRole('button', { name: /as a new saved version/ }).click();
    await expect(controller.page.locator('#library-confirm-status')).toContainText('Title_Card.jpeg is missing');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Not restored');
    await expect(controller.page.locator('#library-confirm-yes')).toBeDisabled();
    await expect(controller.page.locator('#library-confirm-no')).toBeEnabled();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    await controller.page.locator('#library-confirm-no').click();
    await controller.page.locator('#library-history-back').click();

    const orphanId = '77777777-7777-4777-8777-777777777777';
    fs.mkdirSync(path.join(versionDir(fixture, fixture.liveId), orphanId));
    fs.writeFileSync(path.join(versionDir(fixture, fixture.liveId), orphanId, 'script.txt'), '# Opening\n[ADA]\nORPHAN\n');
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await expect(controller.page.locator('#library-history-warning')).toContainText('excluded from history');
    await expect(controller.page.locator('#library-history-list')).not.toContainText(orphanId);
    await controller.page.locator('#library-history-back').click();

    const asset = await controller.page.request.post(`${fixture.baseURL}/api/library/${fixture.otherId}/assets`, {
      headers: { 'Content-Type': 'image/png', 'X-Asset-Name': 'spare.png' },
      data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    });
    expect(asset.status()).toBe(201);
    const assetBody = await asset.json();
    const other = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.otherId}`);
    const otherBody = await other.json();
    const referenced = await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.otherId,
      '88888888-8888-4888-8888-888888888888',
      `# Blue Room\n@image: library:${fixture.otherId}/${assetBody.asset.id}\n[BLUE]\nWITH PICTURE\n`,
      otherBody.script.revision,
    );
    const assetFile = fs.readdirSync(path.join(fixture.libraryDir, 'productions', fixture.otherId, 'assets'))
      .find((name) => name.startsWith(assetBody.asset.id));
    const imageRequests = [];
    controller.page.on('request', (request) => {
      if (request.url().includes('/assets/')) imageRequests.push(request.url());
    });
    await controller.page.getByRole('button', { name: `Version History ${fixture.otherTitle}` }).click();
    await controller.page.locator('.history-version').first().getByRole('button', { name: /Preview Version/ }).click();
    await expect(controller.page.locator('#library-history-preview-images img')).toBeVisible();
    expect(imageRequests.some((url) => url.includes(`/api/library/${fixture.otherId}/assets/`))).toBe(true);
    expect(imageRequests.some((url) => url.includes('/api/live/assets/'))).toBe(false);
    expect(imageRequests.some((url) => /token=/i.test(url))).toBe(false);
    await controller.page.locator('#library-history-preview-back').click();
    fs.rmSync(path.join(fixture.libraryDir, 'productions', fixture.otherId, 'assets', assetFile));
    await controller.page.locator('.history-version').first().getByRole('button', { name: /Preview Version/ }).click();
    await expect(controller.page.locator('#library-history-preview-meta')).toContainText('missing or damaged');
    expect(referenced.script.versionId).toBeTruthy();
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('an available shared image asks before it is copied, and cancel writes nothing', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'images', 'Card.png'), image);

  try {
    const created = await controller.page.request.post(`${fixture.baseURL}/api/library`, {
      data: {
        title: 'Current Picture',
        text: '# Card\n@image: images/Card.png\n[ADA]\nCURRENT LINE\n',
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    const productionId = createdBody.script.id;
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: 'Version History Current Picture' }).click();
    const restores = [];
    controller.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/restore')) restores.push(request.url());
    });
    await controller.page.getByRole('button', { name: /as a new saved version/ }).click();
    await expect(controller.page.locator('#library-confirm-body')).toContainText('cannot verify that they are identical');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Restore Using Current Images');
    await controller.page.locator('#library-confirm-no').click();
    expect(restores).toHaveLength(0);
    expect(fs.readdirSync(versionDir(fixture, productionId))).toHaveLength(1);

    await controller.page.getByRole('button', { name: /as a new saved version/ }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-history-status')).toContainText('not live');
    await expect(controller.page.locator('#library-confirm-yes')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(fs.readdirSync(versionDir(fixture, productionId))).toHaveLength(2);

    await fixture.restart();
    const reopened = await openShow(browser, fixture.baseURL, 'controller');
    await reopened.page.locator('#btn-script-library').click();
    await reopened.page.getByRole('button', { name: 'Version History Current Picture' }).click();
    await expect(reopened.page.locator('#library-history-list')).toContainText('Version 2');
    await expect(reopened.page.locator('#library-history-list')).toContainText('Latest Saved');
    await closeShows([reopened]);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('an unsaved editor draft survives a historical restore', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    const history = await listed.json();
    const original = history.versions.find((version) => version.savedHead);
    await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.liveId,
      '55555555-5555-4555-8555-555555555555',
      '# Opening\n[ADA]\nEDITED HEAD\n',
      original.contentHash,
    );
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Edit ${fixture.liveTitle}` }).click();
    const dialogue = controller.page.getByRole('textbox', { name: 'Line 3: Dialogue' });
    await dialogue.fill('DRAFT LINE');
    await controller.page.locator('#editor-version-history').click();
    await controller.page.locator('.history-version', { hasText: 'Live Now' }).getByRole('button', { name: /Preview Version/ }).click();
    await controller.page.locator('#library-history-restore').click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-history-status')).toContainText('not live');
    await expect(dialogue).toHaveValue('DRAFT LINE');
    await expect(controller.page.locator('#editor-conflict')).toContainText('saved version changed');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('version history stays behind the staff code and fits a narrow screen', async ({ browser }) => {
  const fixture = await startVersionedFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, fixture.baseURL, 'controller');

  try {
    const missing = await controller.page.request.get(
      `${fixture.baseURL}/api/library/${fixture.liveId}/versions?role=controller`,
    );
    expect(missing.status()).toBe(401);
    await controller.page.setViewportSize({ width: 390, height: 800 });
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.locator('#library-access')).toBeVisible();
    await controller.page.locator('#library-token').fill('stage-staff');
    await controller.page.locator('#library-token-continue').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    const history = controller.page.locator('#library-history');
    await expect(history).toBeVisible();
    const box = await history.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    await expect(controller.page.getByRole('button', { name: /as a new saved version/ })).toBeVisible();
  } finally {
    await closeShows([controller]);
    await fixture.close();
  }
});

test('a stored image copy is not described as the historical original', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'images', 'Card.png'), image);

  try {
    const created = await controller.page.request.post(`${fixture.baseURL}/api/library`, {
      data: {
        title: 'Stored Copy',
        text: '# Card\n@image: images/Card.png\n[ADA]\nSTORED LINE\n',
      },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    const productionId = createdBody.script.id;
    const uploaded = await controller.page.request.post(`${fixture.baseURL}/api/library/${productionId}/assets`, {
      headers: { 'Content-Type': 'image/png', 'X-Asset-Name': 'Card.png' },
      data: image,
    });
    expect(uploaded.status()).toBe(201);
    const manifestPath = path.join(fixture.libraryDir, 'productions', productionId, 'assets', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.assets).toHaveLength(1);
    manifest.assets[0].legacyPath = 'images/Card.png';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const assetFile = path.join(fixture.libraryDir, 'productions', productionId, 'assets', manifest.assets[0].file);

    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: 'Version History Stored Copy' }).click();
    await controller.page.getByRole('button', { name: /as a new saved version/ }).click();
    await expect(controller.page.locator('#library-confirm-body')).toContainText('does not prove they are the images from the original save');
    await expect(controller.page.locator('#library-confirm-body')).not.toContainText('identical to the originals');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Restore as New Saved Version');
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-history-status')).toContainText('not live');
    await expect(controller.page.locator('#library-confirm-yes')).toBeHidden();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(fs.readdirSync(versionDir(fixture, productionId)).filter((name) => !name.startsWith('.'))).toHaveLength(2);
    const restoredScript = fs.readdirSync(versionDir(fixture, productionId))
      .filter((name) => name !== createdBody.script.versionId)
      .map((name) => fs.readFileSync(path.join(versionDir(fixture, productionId), name, 'script.txt'), 'utf8'))
      .join('\n');
    expect(restoredScript).toContain(`library:${productionId}/`);
    expect(restoredScript).not.toContain('images/');

    await fixture.restart();
    const reopened = await openShow(browser, fixture.baseURL, 'controller');
    await reopened.page.locator('#btn-script-library').click();
    await reopened.page.getByRole('button', { name: 'Version History Stored Copy' }).click();
    await expect(reopened.page.locator('#library-history-list')).toContainText('Version 2');
    expect(fs.existsSync(assetFile)).toBe(true);
    expect(sha256(assetFile)).toBe(sha256(path.join(fixture.root, 'images', 'Card.png')));
    await closeShows([reopened]);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('a timed-out restore retries the same version id and does not save twice', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    const history = await listed.json();
    const head = history.versions.find((version) => version.savedHead);
    await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.liveId,
      '44444444-4444-4444-8444-444444444444',
      '# Opening\n[ADA]\nEDITED HEAD\n',
      head.contentHash,
    );
    const before = fs.readdirSync(versionDir(fixture, fixture.liveId)).filter((name) => !name.startsWith('.')).length;
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await controller.page.locator('.history-version').nth(1).getByRole('button', { name: /as a new saved version/ }).click();
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const ids = [];
    await controller.page.route(/\/restore$/, async (route) => {
      ids.push(route.request().headers()['x-version-id']);
      if (ids.length === 1) await gate;
      await route.continue();
    });
    await controller.page.clock.install();
    await controller.page.locator('#library-confirm-yes').click();
    await controller.page.clock.fastForward(31000);
    await expect(controller.page.locator('#library-confirm-status')).toContainText('The restore took too long and was not confirmed');
    await expect(controller.page.locator('#library-confirm-status')).toContainText('same new version id will be kept');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Not restored');
    await expect(controller.page.locator('#library-confirm-yes')).toBeDisabled();
    await expect(controller.page.locator('#library-confirm-no')).toBeEnabled();
    const pending = await controller.page.evaluate(() => Object.keys(sessionStorage)
      .filter((key) => key.startsWith('prompter-restore-attempt:')));
    expect(pending).toHaveLength(1);
    release();
    await expect.poll(() => fs.readdirSync(versionDir(fixture, fixture.liveId)).filter((name) => !name.startsWith('.')).length).toBe(before + 1);
    await controller.page.locator('#library-confirm-no').click();
    await controller.page.locator('.history-version').nth(1).getByRole('button', { name: /as a new saved version/ }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-history-status')).toContainText('already saved');
    await expect(controller.page.locator('#library-confirm-yes')).toBeHidden();
    expect(fs.readdirSync(versionDir(fixture, fixture.liveId)).filter((name) => !name.startsWith('.'))).toHaveLength(before + 1);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids[1]).toBe(ids[0]);
    const remaining = await controller.page.evaluate(() => Object.keys(sessionStorage)
      .filter((key) => key.startsWith('prompter-restore-attempt:')));
    expect(remaining).toHaveLength(0);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('a restore conflict explains the refusal and leaves the loading state', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const listed = await controller.page.request.get(`${fixture.baseURL}/api/library/${fixture.liveId}/versions`);
    const history = await listed.json();
    const head = history.versions.find((version) => version.savedHead);
    const before = fs.readdirSync(versionDir(fixture, fixture.liveId)).filter((name) => !name.startsWith('.')).length;
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Version History ${fixture.liveTitle}` }).click();
    await controller.page.locator('.history-version').first().getByRole('button', { name: /as a new saved version/ }).click();
    await saveEditedHead(
      controller.page,
      fixture.baseURL,
      fixture.liveId,
      '55555555-5555-4555-8555-555555555551',
      '# Opening\n[ADA]\nCHANGED UNDER THE DIALOG\n',
      head.contentHash,
    );
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-confirm-status')).toContainText('This restore was not repeated');
    await expect(controller.page.locator('#library-confirm-yes')).toHaveText('Not restored');
    await expect(controller.page.locator('#library-confirm-yes')).toBeDisabled();
    await expect(controller.page.locator('#library-confirm-no')).toBeEnabled();
    expect(fs.readdirSync(versionDir(fixture, fixture.liveId)).filter((name) => !name.startsWith('.'))).toHaveLength(before + 1);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('legacy library history says it is unavailable and leaves the show in place', async ({ browser }) => {
  const prompter = await startFixture();
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Version History ${prompter.liveTitle}` }).click();
    await expect(controller.page.locator('#library-history-status')).toContainText('not available on this library');
    await expect(controller.page.locator('#library-history-status')).not.toContainText('corrupt');
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await controller.page.locator('#library-history-back').click();
    await expect(controller.page.getByRole('button', { name: `Set as Live ${prompter.otherTitle}` })).toBeVisible();
  } finally {
    await closeShows([controller, audience]);
    await prompter.close();
  }
});
