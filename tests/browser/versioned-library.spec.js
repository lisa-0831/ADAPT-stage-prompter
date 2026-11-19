const fs = require('fs');
const path = require('path');

const { test, expect, openShow, closeShows } = require('./support');
const { startVersionedFixture } = require('./versioned-fixture');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function jpegBytes() {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(16, 1),
    Buffer.from([0xFF, 0xD9]),
  ]);
}

function webpBytes() {
  const payload = Buffer.from('VP8XXXXXXXXX');
  const buf = Buffer.alloc(12 + payload.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8);
  payload.copy(buf, 12);
  return buf;
}

function trackPosts(page) {
  const posts = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/library' || pathname.endsWith('/assets') || pathname === '/script') {
      posts.push({ pathname, headers: request.headers() });
    }
  });
  return posts;
}

test('versioned create waits for submit, stays offstage, and retries one creation', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const posts = trackPosts(controller.page);

  try {
    const before = fs.readdirSync(path.join(fixture.libraryDir, 'productions'));
    await controller.page.locator('#btn-script-library').click();
    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'new-room.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# New Room\n[ADA]\nCREATED LINE\n'),
    });
    await expect.poll(() => posts.length).toBe(0);
    expect(fs.readdirSync(path.join(fixture.libraryDir, 'productions'))).toEqual(before);

    await controller.page.locator('#library-create-name').fill('New Room');
    await Promise.all([
      controller.page.locator('#library-create-submit').click(),
      controller.page.locator('#library-create-submit').click(),
    ]);
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#library-status')).toContainText('not the live show');
    await expect(controller.page.getByRole('heading', { name: 'New Room' })).toBeVisible();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    expect(posts.filter((post) => post.pathname === '/api/library')).toHaveLength(1);
    const createdId = posts[0].headers['x-creation-request-id'];
    expect(createdId).toBeTruthy();
    expect(fs.readdirSync(path.join(fixture.libraryDir, 'productions'))).toHaveLength(before.length + 1);

    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-name').fill('Second Room');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'second.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# Second Room\n[ADA]\nSECOND LINE\n'),
    });
    let dropped = false;
    await controller.page.route('**/api/library', async (route) => {
      if (!dropped && route.request().method() === 'POST') {
        dropped = true;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('was not created');
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#library-status')).toContainText('not the live show');
    await expect(controller.page.getByRole('heading', { name: 'Second Room' })).toBeVisible();
    const creates = posts.filter((post) => post.pathname === '/api/library');
    expect(creates).toHaveLength(3);
    expect(creates[2].headers['x-creation-request-id']).toBe(creates[1].headers['x-creation-request-id']);
    expect(fs.readdirSync(path.join(fixture.libraryDir, 'productions'))).toHaveLength(before.length + 2);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('versioned images upload separately, save a new version, and go live only when set live', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Manage Images ${fixture.otherTitle}` }).click();
    const assets = path.join(fixture.libraryDir, 'productions', fixture.otherId, 'assets');
    const beforeAssets = fs.existsSync(assets) ? fs.readdirSync(assets).length : 0;
    const images = [
      { name: 'scene.png', mimeType: 'image/png', buffer: PNG },
      { name: 'scene.jpg', mimeType: 'image/jpeg', buffer: jpegBytes() },
      { name: 'scene.webp', mimeType: 'image/webp', buffer: webpBytes() },
    ];
    for (const image of images) {
      await controller.page.locator('#library-image-file').setInputFiles(image);
      await expect(controller.page.locator('#library-images-status')).toContainText(`Uploaded “${image.name}”`);
    }
    const stored = fs.readdirSync(assets);
    expect(stored).toHaveLength(beforeAssets + 3);
    await controller.page.locator('#library-images-back').click();

    const metadataFile = path.join(fixture.libraryDir, 'productions', fixture.otherId, 'metadata.json');
    const before = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    const original = fs.readFileSync(path.join(
      fixture.libraryDir, 'productions', fixture.otherId, 'versions', before.headVersionId, 'script.txt',
    ));
    await controller.page.getByRole('button', { name: `Edit ${fixture.otherTitle}` }).click();
    await controller.page.getByRole('button', { name: 'Choose image' }).click();
    await controller.page.getByRole('button', { name: 'scene.png' }).click();
    await expect(controller.page.locator('#editor-scene-image-label')).toHaveText('Scene image: scene.png');
    await controller.page.locator('#editor-save-library').click();
    await expect(controller.page.locator('#editor-status')).toHaveText('Saved to the library. The live show was not changed.');
    await controller.page.locator('#editor-close').click();
    const after = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    expect(after.headVersionId).not.toBe(before.headVersionId);
    const originalAfter = fs.readFileSync(path.join(
      fixture.libraryDir, 'productions', fixture.otherId, 'versions', before.headVersionId, 'script.txt',
    ));
    expect(originalAfter.equals(original)).toBe(true);
    const savedText = fs.readFileSync(path.join(
      fixture.libraryDir, 'productions', fixture.otherId, 'versions', after.headVersionId, 'script.txt',
    ), 'utf8');
    expect(savedText).toContain(`library:${fixture.otherId}/`);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    await expect(audience.page.locator('#title-image-overlay')).not.toHaveClass(/show/);

    await controller.page.getByRole('button', { name: `Set as Live ${fixture.otherTitle}` }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.blue);
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    const image = audience.page.locator('#title-image-overlay img');
    await expect(image).toBeVisible();
    const src = await image.getAttribute('src');
    const allowed = await audience.page.request.get(new URL(src, fixture.baseURL).href);
    expect(allowed.status()).toBe(200);
    const assetId = src.split('/').pop();
    const foreign = await audience.page.request.get(`${fixture.baseURL}/api/live/assets/${fixture.liveId}/${assetId}`);
    expect(foreign.status()).toBe(404);
    const raw = await audience.page.request.get(`${fixture.baseURL}/data/library/productions/${fixture.otherId}/assets/${assetId}`);
    expect(raw.status()).toBe(404);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('a newer saved head of the live production can be set live without changing the audience first', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.getByRole('button', { name: `Edit ${fixture.liveTitle}` }).click();
    const dialogue = controller.page.getByRole('textbox', { name: /Dialogue/ }).first();
    await expect(dialogue).toBeVisible();
    await dialogue.fill('SAVED HEAD LINE');
    await controller.page.locator('#editor-save-library').click();
    await expect(controller.page.locator('#editor-status')).toHaveText('Saved to the library. The live show was not changed.');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
    await controller.page.locator('#editor-close').click();
    const liveButton = controller.page.getByRole('button', { name: `Set as Live ${fixture.liveTitle}` });
    await expect(liveButton).toBeEnabled();
    await liveButton.click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText('SAVED HEAD LINE');
    const otherHead = JSON.parse(fs.readFileSync(path.join(
      fixture.libraryDir, 'productions', fixture.otherId, 'metadata.json',
    ), 'utf8')).headVersionId;
    expect(otherHead).toBeTruthy();
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('an unresolved shared image cannot be set live, and a failed upload retries the same production', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');
  const posts = trackPosts(controller.page);

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-name').fill('Shared Picture');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'shared.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# Shared\n@image: images/Title_Card.jpeg\n[ADA]\nSHARED LINE\n'),
    });
    await controller.page.locator('#library-create-scenes').setInputFiles({
      name: 'bad.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    let failed = false;
    await controller.page.route('**/api/library/**', async (route) => {
      if (!failed && route.request().method() === 'POST' && route.request().url().includes('/assets')) {
        failed = true;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'The image was rejected.' }),
        });
        return;
      }
      await route.continue();
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('Not uploaded: bad.png');
    const first = posts.find((post) => post.pathname.endsWith('/assets'));
    await controller.page.locator('#library-create-retry').click();
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#library-status')).toContainText('Uploaded to this production only');
    const retries = posts.filter((post) => post.pathname.endsWith('/assets'));
    expect(retries).toHaveLength(2);
    expect(retries[1].pathname).toBe(first.pathname);
    expect(retries[1].headers['x-asset-id']).toBe(first.headers['x-asset-id']);

    fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', '..', 'images', 'Title_Card.jpeg'),
      path.join(fixture.root, 'images', 'Title_Card.jpeg'),
    );
    await controller.page.getByRole('button', { name: 'Set as Live Shared Picture' }).click();
    await controller.page.locator('#library-confirm-yes').click();
    await expect(controller.page.locator('#library-confirm-status')).toContainText('cannot become live until its image references are resolved');
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});

test('staff storage stays closed without the token, including a controller page', async ({ browser }) => {
  const fixture = await startVersionedFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, fixture.baseURL, 'controller');

  try {
    const missing = await controller.page.request.get(`${fixture.baseURL}/api/library`);
    expect(missing.status()).toBe(401);
    const wrong = await controller.page.request.get(`${fixture.baseURL}/api/library`, {
      headers: { 'X-Staff-Token': 'nope' },
    });
    expect(wrong.status()).toBe(401);
    const accepted = await controller.page.request.get(`${fixture.baseURL}/api/library`, {
      headers: { 'X-Staff-Token': 'stage-staff' },
    });
    expect(accepted.status()).toBe(200);
    await controller.page.locator('#btn-script-library').click();
    await expect(controller.page.locator('#library-access')).toBeVisible();
    await controller.page.locator('#library-token').fill('nope');
    await controller.page.locator('#library-token-continue').click();
    await expect(controller.page.locator('#library-status')).toContainText('was not accepted');
    await controller.page.locator('#library-token').fill('stage-staff');
    await controller.page.locator('#library-token-continue').click();
    await expect(controller.page.getByRole('heading', { name: fixture.liveTitle })).toBeVisible();
  } finally {
    await closeShows([controller]);
    await fixture.close();
  }
});

test('replacing the live script with a shared image is refused before a version is written', async ({ browser }) => {
  const fixture = await startVersionedFixture();
  const controller = await openShow(browser, fixture.baseURL, 'controller');
  const audience = await openShow(browser, fixture.baseURL, 'audience');

  try {
    const versions = path.join(fixture.libraryDir, 'productions', fixture.liveId, 'versions');
    const before = fs.readdirSync(versions);
    await controller.page.locator('#btn-upload-toggle').click();
    await expect(controller.page.locator('#script-textarea')).toHaveValue(new RegExp(fixture.spoken));
    await controller.page.locator('#script-textarea').fill('# Opening\n@image: images/Title_Card.jpeg\n[ADA]\nBLOCKED LINE\n');
    const dialog = controller.page.waitForEvent('dialog');
    await controller.page.locator('#btn-upload-submit').click();
    const alert = await dialog;
    expect(alert.message()).toContain('shared images/');
    await alert.accept();
    expect(fs.readdirSync(versions)).toEqual(before);
    await expect(audience.page.locator('#lines-current .script-line')).toHaveText(fixture.spoken);
  } finally {
    await closeShows([controller, audience]);
    await fixture.close();
  }
});
