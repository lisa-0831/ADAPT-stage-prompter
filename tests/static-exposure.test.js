const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createPrompterServer } = require('../server');

const root = path.join(__dirname, '..');

const PUBLIC_URLS = [
  '/styles.css',
  '/background.jpg',
  '/role-model.js',
  '/navigation-model.js',
  '/actor-mode-model.js',
  '/actor-input-model.js',
  '/subtitle-layout.js',
  '/caption-case.js',
  '/script-format.js',
  '/script-editor-model.js',
  '/script-library-model.js',
  '/public/text.js',
  '/public/live-show.js',
  '/public/stage.js',
  '/public/actor-view.js',
  '/public/connection.js',
  '/public/controller-view.js',
  '/public/replace-script.js',
  '/public/exit-confirmation.js',
  '/public/editor-view.js',
  '/public/library-view.js',
  '/fonts/Engravers-Gothic-Regular.otf',
  '/fonts/Netto-Regular.otf',
  '/fonts/Netto-Regular-Italic.otf',
  '/fonts/TTRoundsCondensed-Black.ttf',
  '/images/Title_Card.jpeg',
  '/images/Cap_Back2.jpeg',
  '/images/Cap_Back3.jpeg',
  '/images/Cap_Back4.jpeg',
];

const PRIVATE_URLS = [
  '/script.txt',
  '/script.previous.txt',
  '/script.previous.txt.meta.json',
  '/server.js',
  '/server/http-routes.js',
  '/server/live-socket.js',
  '/package.json',
  '/package-lock.json',
  '/client.html',
  '/README.md',
  '/playwright.config.js',
  '/script-library.js',
  '/live-script-store.js',
  '/tests/http-routes.test.js',
  '/tests/browser/roles.spec.js',
  '/tests/static-exposure.test.js',
  '/public/not-a-module.js',
  '/public/',
  '/fonts/',
  '/images/',
  '/images/notes.txt',
];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function rawRequest(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          type: res.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the browser allowlist serves the page assets and leaves the script API in place', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-static-public-'));
  const resolved = path.resolve(dir);
  assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
  assert.equal(resolved.startsWith(`${path.resolve(root)}${path.sep}`), false);
  const scriptFile = path.join(dir, 'script.txt');
  fs.writeFileSync(scriptFile, '# Opening\n[ADA]\nFIRST SPOKEN LINE\n');
  const created = createPrompterServer({
    scriptFile,
    previousFile: path.join(dir, 'script.previous.txt'),
    libraryDir: path.join(dir, 'data', 'library'),
    journalDir: path.join(dir, 'data', 'live-journal'),
  });
  t.after(async () => {
    for (const client of created.wss.clients) client.terminate();
    await new Promise((resolve) => created.wss.close(() => resolve()));
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(() => resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await listen(created.server);

  const page = await rawRequest(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="script-library"/);
  assert.equal(page.body.includes('createPrompterServer'), false);

  for (const urlPath of PUBLIC_URLS) {
    for (const method of ['GET', 'HEAD']) {
      const response = await rawRequest(port, method, urlPath);
      assert.equal(response.status, 200, `${method} ${urlPath}`);
      if (method === 'HEAD') assert.equal(response.body, '', urlPath);
      else assert.equal(response.body.length > 0, true, urlPath);
    }
  }
  const stylesheet = await rawRequest(port, 'GET', '/styles.css');
  assert.match(stylesheet.type, /css/);
  const model = await rawRequest(port, 'GET', '/navigation-model.js');
  assert.match(model.type, /javascript/);
  const image = await rawRequest(port, 'GET', '/images/Title_Card.jpeg');
  assert.match(image.type, /image/);

  const live = await rawRequest(port, 'GET', '/script');
  assert.equal(live.status, 200);
  assert.match(live.body, /FIRST SPOKEN LINE/);
  const liveHead = await rawRequest(port, 'HEAD', '/script');
  assert.equal(liveHead.status, 200);
  assert.equal(liveHead.body, '');

  const routeSource = fs.readFileSync(path.join(root, 'server/http-routes.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.equal(routeSource.includes('express.static'), false);
  assert.equal(serverSource.includes('express.static'), false);
});

test('private files, encoded paths, and the library journal are not served', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-static-private-'));
  const resolved = path.resolve(dir);
  assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
  assert.equal(resolved.startsWith(`${path.resolve(root)}${path.sep}`), false);
  const libraryDir = path.join(root, 'data', `s1-library-${process.pid}-${Date.now()}`);
  const journalDir = path.join(root, 'data', `s1-journal-${process.pid}-${Date.now()}`);
  const scriptFile = path.join(dir, 'script.txt');
  fs.writeFileSync(scriptFile, '# Opening\n[ADA]\nFIRST SPOKEN LINE\n');
  const created = createPrompterServer({
    scriptFile,
    previousFile: path.join(dir, 'script.previous.txt'),
    libraryDir,
    journalDir,
  });
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(path.join(journalDir, 'committed'), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'private-marker.txt'), 'STATIC_LIBRARY_MARKER');
  fs.writeFileSync(path.join(journalDir, 'committed', 'live.txt'), 'STATIC_JOURNAL_MARKER');
  t.after(async () => {
    for (const client of created.wss.clients) client.terminate();
    await new Promise((resolve) => created.wss.close(() => resolve()));
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(() => resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(libraryDir, { recursive: true, force: true });
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  const port = await listen(created.server);
  const libraryUrl = `/${path.relative(root, libraryDir).split(path.sep).join('/')}/private-marker.txt`;
  const journalUrl = `/${path.relative(root, journalDir).split(path.sep).join('/')}/committed/live.txt`;

  async function expectHidden(urlPath) {
    for (const method of ['GET', 'HEAD']) {
      const response = await rawRequest(port, method, urlPath);
      assert.equal(response.status, 404, `${method} ${urlPath}`);
      assert.equal(response.body.includes('createPrompterServer'), false, urlPath);
      assert.equal(response.body.includes('STATIC_LIBRARY_MARKER'), false, urlPath);
      assert.equal(response.body.includes('STATIC_JOURNAL_MARKER'), false, urlPath);
      assert.equal(response.body.includes('FIRST SPOKEN LINE'), false, urlPath);
      if (method === 'GET') assert.equal(response.body, 'Not found', urlPath);
    }
  }

  for (const urlPath of PRIVATE_URLS) await expectHidden(urlPath);
  await expectHidden(libraryUrl);
  await expectHidden(journalUrl);
  await expectHidden(`/${path.relative(root, journalDir).split(path.sep).join('/')}/pending/live.txt`);

  const traversals = [
    '/images/../server.js',
    '/public/../server.js',
    '/fonts/../package.json',
    '/images/%2e%2e/server.js',
    '/public/%2e%2e%2fserver.js',
    '/fonts/%2e%2e/%2e%2e/script.txt',
    '/%2e%2e/server.js',
    '/images/..%2Fserver.js',
    '/public/text.js/../../server.js',
    '/server/%2e%2e/server.js',
    '/tests/%2e%2e/package.json',
    libraryUrl.replace('/private-marker.txt', '/../') + path.basename(libraryDir) + '/private-marker.txt',
  ];
  for (const urlPath of traversals) await expectHidden(urlPath);
});
