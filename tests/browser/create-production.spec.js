const { test, expect, openShow, assertQuiet, closeShows } = require('./support');
const { startFixture } = require('./fixture-server');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SCRIPT = '# New Room\n@image: images/Title_Card.jpeg\n[ADA]\nCREATED LINE\n';

function trackPosts(page) {
  const posts = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/library' || pathname.endsWith('/assets') || pathname === '/script') posts.push(pathname);
  });
  return posts;
}

async function openCreate(page) {
  await page.locator('#btn-script-library').click();
  await expect(page.getByRole('heading', { name: 'Script Library' })).toBeVisible();
  await page.locator('#library-create-open').click();
  await expect(page.locator('#library-create-name')).toBeFocused();
}

test('choosing create-production files sends nothing until submit, and cancel clears them', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await openCreate(controller.page);
    const posts = trackPosts(controller.page);
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'hamlet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(SCRIPT),
    });
    await controller.page.locator('#library-create-card').setInputFiles({
      name: 'Title_Card.jpeg',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await controller.page.locator('#library-create-scenes').setInputFiles([
      { name: 'scene-a.png', mimeType: 'image/png', buffer: PNG },
      { name: 'scene-b.png', mimeType: 'image/png', buffer: PNG },
    ]);
    await expect(controller.page.locator('#library-create-review')).toContainText('hamlet.txt');
    await expect(controller.page.locator('#library-create-review')).toContainText('Title_Card.jpeg');
    await expect(controller.page.locator('#library-create-review')).toContainText('scene-a.png');
    await expect(controller.page.locator('#library-create-card-preview')).toHaveAttribute('alt', 'Preview of Title_Card.jpeg');
    await expect(controller.page.locator('#library-create-status')).toContainText('not been uploaded');
    expect(posts).toEqual([]);

    await controller.page.getByRole('button', { name: 'Remove scene-b.png' }).click();
    await expect(controller.page.locator('#library-create-review')).not.toContainText('scene-b.png');
    await controller.page.locator('#library-create-cancel').click();
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#library-status')).toContainText('Nothing was added');
    expect(posts).toEqual([]);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('create production asks for a title and a script before it sends a request', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const pages = [controller];

  try {
    await openCreate(controller.page);
    const posts = trackPosts(controller.page);
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('Enter a production title.');
    await controller.page.locator('#library-create-name').fill('Hamlet');
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('Choose a .txt script file');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('   '),
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('The script is empty');
    expect(posts).toEqual([]);
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('text-only create adds a library production and leaves the live show alone', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await openCreate(controller.page);
    const posts = trackPosts(controller.page);
    await controller.page.locator('#library-create-name').fill('Hamlet');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'hamlet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(SCRIPT),
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('not the live show');
    await expect(controller.page.locator('#library-create-status')).toContainText('No pictures were added');
    await expect(controller.page.locator('#library-create-status')).toContainText('images/Title_Card.jpeg');
    expect(posts).toEqual(['/api/library']);

    await controller.page.locator('#library-create-edit').click();
    await expect(controller.page.locator('#editor-status')).toContainText('saved script');
    await expect(controller.page.locator('#editor-scene-image-label')).toContainText('Title_Card.jpeg');
    await controller.page.locator('#editor-close').click();
    await expect(controller.page.getByRole('heading', { name: 'Hamlet' })).toBeVisible();
    await expect(controller.page.getByRole('button', { name: `Already live: ${prompter.liveTitle}` })).toBeDisabled();
    await controller.page.getByRole('button', { name: `Set as Live ${prompter.otherTitle}` }).click();
    await expect(controller.page.locator('#library-confirm-heading')).toHaveText('Set this script as Live?');
    await controller.page.locator('#library-confirm-no').click();
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');

    const listed = await controller.page.request.get(`${prompter.baseURL}/api/library`);
    const body = await listed.json();
    const created = body.scripts.find((entry) => entry.title === 'Hamlet');
    const saved = await controller.page.request.get(`${prompter.baseURL}/api/library/${created.id}`);
    const savedBody = await saved.json();
    expect(savedBody.script.text).toBe(SCRIPT);
    expect(created.live).toBeFalsy();
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('a second create click does not create another production', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await openCreate(controller.page);
    await controller.page.locator('#library-create-name').fill('Hamlet');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'hamlet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# Scene\nHello\n'),
    });
    let createPosts = 0;
    await controller.page.route('**/api/library', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST' && pathname === '/api/library') {
        createPosts += 1;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.continue();
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-submit')).toBeDisabled();
    await controller.page.locator('#library-create-submit').click({ force: true, timeout: 1000 }).catch(() => {});
    await expect(controller.page.locator('#library-create-status')).toContainText('not the live show');
    expect(createPosts).toBe(1);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    assertQuiet(pages);
  } finally {
    await closeShows(pages);
  }
});

test('optional images stay on the new production and a failed one can be retried', async ({ browser, prompter }) => {
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await openCreate(controller.page);
    const posts = trackPosts(controller.page);
    await controller.page.locator('#library-create-name').fill('Hamlet');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'hamlet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(SCRIPT),
    });
    await controller.page.locator('#library-create-card').setInputFiles({
      name: 'Title_Card.jpeg',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await controller.page.locator('#library-create-scenes').setInputFiles([
      { name: 'good.png', mimeType: 'image/png', buffer: PNG },
      { name: 'bad.png', mimeType: 'image/png', buffer: PNG },
    ]);
    let failed = false;
    await controller.page.route('**/api/library/**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && request.url().includes('/assets')) {
        const name = decodeURIComponent(request.headers()['x-asset-name'] || '');
        if (name === 'bad.png' && !failed) {
          failed = true;
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'That file is not a JPEG, PNG, or WebP image.' }),
          });
          return;
        }
      }
      await route.continue();
    });
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('Not uploaded: bad.png');
    await expect(controller.page.locator('#library-create-status')).toContainText('not an all-or-nothing save');
    await expect(controller.page.locator('#library-create-status')).toContainText('images/Title_Card.jpeg');
    expect(posts.filter((pathname) => pathname === '/api/library')).toEqual(['/api/library']);

    await controller.page.locator('#library-create-retry').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('Uploaded to this production only');
    await expect(controller.page.locator('#library-create-status')).not.toContainText('Not uploaded');
    expect(posts.filter((pathname) => pathname === '/api/library')).toEqual(['/api/library']);

    const listed = await controller.page.request.get(`${prompter.baseURL}/api/library`);
    const body = await listed.json();
    const created = body.scripts.find((entry) => entry.title === 'Hamlet');
    const live = body.scripts.find((entry) => entry.live);
    const assets = await controller.page.request.get(`${prompter.baseURL}/api/library/${created.id}/assets`);
    const assetBody = await assets.json();
    const names = assetBody.assets.map((asset) => asset.name).sort();
    expect(names).toEqual(['Title_Card.jpeg', 'bad.png', 'good.png']);
    const foreign = await controller.page.request.get(`${prompter.baseURL}/api/library/${live.id}/assets/${assetBody.assets[0].id}`);
    expect(foreign.status()).toBe(404);
    const saved = await controller.page.request.get(`${prompter.baseURL}/api/library/${created.id}`);
    const savedBody = await saved.json();
    expect(savedBody.script.text).toBe(SCRIPT);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    await expect(audience.page.locator('#title-image-overlay')).toHaveClass(/show/);
    expect(controller.errors.filter((error) => !error.includes('400'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
  }
});

test('escape closes the create form without a request, and a bad staff code does not create twice', async ({ browser }) => {
  const prompter = await startFixture({ staffToken: 'stage-staff' });
  const controller = await openShow(browser, prompter.baseURL, 'controller');
  const audience = await openShow(browser, prompter.baseURL, 'audience');
  const pages = [controller, audience];

  try {
    await controller.page.locator('#btn-script-library').click();
    await controller.page.locator('#library-token').fill('stage-staff');
    await controller.page.locator('#library-token-continue').click();
    await expect(controller.page.locator('#library-create-open')).toBeVisible();
    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-name').fill('Temp');
    const posts = trackPosts(controller.page);
    await controller.page.locator('#library-create-name').press('Escape');
    await expect(controller.page.locator('#library-create')).toBeHidden();
    await expect(controller.page.locator('#script-library')).toBeVisible();
    expect(posts).toEqual([]);

    await controller.page.locator('#library-create-open').click();
    await controller.page.locator('#library-create-name').fill('Hamlet');
    await controller.page.locator('#library-create-script').setInputFiles({
      name: 'hamlet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('# Scene\nHello\n'),
    });
    await controller.page.evaluate(() => sessionStorage.removeItem('prompter-staff-token'));
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-status')).toContainText('not accepted');
    await expect(controller.page.locator('#library-access')).toBeVisible();
    const before = await controller.page.request.get(`${prompter.baseURL}/api/library`, {
      headers: { 'X-Staff-Token': 'stage-staff' },
    });
    const beforeBody = await before.json();
    expect(beforeBody.scripts.some((entry) => entry.title === 'Hamlet')).toBeFalsy();

    await controller.page.locator('#library-token').fill('stage-staff');
    await controller.page.locator('#library-token-continue').click();
    await expect(controller.page.locator('#library-create')).toBeVisible();
    await controller.page.locator('#library-create-submit').click();
    await expect(controller.page.locator('#library-create-status')).toContainText('not the live show');
    await controller.page.locator('#library-create-submit').click({ force: true }).catch(() => {});
    const after = await controller.page.request.get(`${prompter.baseURL}/api/library`, {
      headers: { 'X-Staff-Token': 'stage-staff' },
    });
    const afterBody = await after.json();
    expect(afterBody.scripts.filter((entry) => entry.title === 'Hamlet')).toHaveLength(1);
    await expect(audience.page.locator('#slide-title')).toHaveText('Opening');
    expect(controller.errors.filter((error) => !error.includes('401'))).toEqual([]);
    expect(audience.errors).toEqual([]);
  } finally {
    await closeShows(pages);
    await prompter.close();
  }
});
