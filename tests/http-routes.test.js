const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPrompterServer } = require('../server');
const { registerHttpRoutes } = require('../server/http-routes');

const root = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('composed http routes serve the page, keep the staff token on the library, and still publish without it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-http-routes-'));
  const resolved = path.resolve(dir);
  assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
  assert.equal(resolved.startsWith(`${path.resolve(root)}${path.sep}`), false);
  const scriptFile = path.join(dir, 'script.txt');
  const previousFile = path.join(dir, 'script.previous.txt');
  const libraryDir = path.join(dir, 'data', 'library');
  const journalDir = path.join(dir, 'data', 'live-journal');
  fs.writeFileSync(scriptFile, '# Opening\n[ADA]\nFIRST SPOKEN LINE\n');
  const created = createPrompterServer({
    scriptFile,
    previousFile,
    libraryDir,
    journalDir,
    staffToken: 'stage-staff',
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
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="script-library"/);

  const scriptFileResponse = await fetch(`${base}/public/text.js`);
  assert.equal(scriptFileResponse.status, 200);
  assert.match(scriptFileResponse.headers.get('content-type') || '', /javascript/);

  const live = await fetch(`${base}/script`);
  assert.equal(live.status, 200);
  assert.match(await live.text(), /FIRST SPOKEN LINE/);

  const missingPrevious = await fetch(`${base}/script/previous`);
  assert.equal(missingPrevious.status, 404);
  assert.equal((await missingPrevious.json()).error, 'No previous script');

  const denied = await fetch(`${base}/api/library`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/api/library`, {
    headers: { 'X-Staff-Token': 'stage-staff' },
  });
  assert.equal(allowed.status, 200);

  const createdScript = await fetch(`${base}/api/library`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': 'stage-staff',
    },
    body: JSON.stringify({
      title: 'Other',
      text: '# Blue Room\n[BLUE]\nBLUE ROOM LINE\n',
    }),
  });
  assert.equal(createdScript.status, 201);
  const createdBody = await createdScript.json();
  const stale = await fetch(`${base}/api/library/${createdBody.script.id}/live`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': 'stage-staff',
    },
    body: JSON.stringify({ expectedRevision: 'not-the-saved-revision' }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'conflict');
  assert.match(fs.readFileSync(scriptFile, 'utf8'), /FIRST SPOKEN LINE/);

  const published = await fetch(`${base}/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '# Opening\n[ADA]\nUPDATED LINE\n',
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).ok, true);
  assert.match(fs.readFileSync(scriptFile, 'utf8'), /UPDATED LINE/);
  const previous = await fetch(`${base}/script/previous`);
  assert.equal(previous.status, 200);
  assert.match(await previous.text(), /FIRST SPOKEN LINE/);

  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(root, 'server/http-routes.js'), 'utf8');
  assert.equal(typeof registerHttpRoutes, 'function');
  assert.equal(serverSource.includes('app.get('), false);
  assert.equal(serverSource.includes('registerLiveSocketHandlers('), true);
  assert.equal(serverSource.includes('wss.on('), false);
  assert.match(routeSource, /app\.post\('\/script'/);
  assert.match(routeSource, /writeLiveScript\(/);
  assert.equal(routeSource.includes('commitLiveFiles'), false);
});
