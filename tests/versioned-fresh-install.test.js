const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { freshInstallationBytes } = require('../server/storage-mode');
const { authorizeVersionedFixture, VersionedStartupError } = require('../server/versioned-runtime');
const { loadVersionedShow } = require('../server/versioned-show');

const REPO = path.resolve(__dirname, '..');
const INSTALLATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STALE = 'STALE MIRROR MUST NOT APPEAR\n';
const TEXT = '# Opening\n[ADA]\nFIRST CUE\n';
const SHARED = '# Opening\n@image: images/Title_Card.jpeg\n[ADA]\nSHARED\n';

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-fresh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function layout(root) {
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'live-journal');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  fs.writeFileSync(scriptFile, STALE);
  fs.writeFileSync(previousFile, '');
  fs.writeFileSync(`${previousFile}.meta.json`, '{}\n');
  fs.writeFileSync(path.join(libraryDir, 'migration.json'), freshInstallationBytes(INSTALLATION, false));
  return { root, libraryDir, journalDir, scriptFile, previousFile };
}

async function boot(t, paths, options) {
  const server = await createPrompterServer(Object.assign({
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
    staffToken: 'stage-staff',
    versionedFixture: authorizeVersionedFixture(paths),
    now: () => '2026-06-06T00:00:00.000Z',
    allowFaults: true,
  }, options || {}));
  t.after(async () => {
    if (server && server.close) await server.close();
  });
  await new Promise((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    base: `http://127.0.0.1:${server.server.address().port}`,
  };
}

function request(base, method, route, options) {
  const settings = options || {};
  return new Promise((resolve, reject) => {
    const url = new URL(route, base);
    const req = http.request(url, {
      method,
      headers: Object.assign({ 'X-Staff-Token': 'stage-staff' }, settings.headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch (err) { /* Text responses stay strings. */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (settings.body) req.write(settings.body);
    req.end();
  });
}

function marker(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'migration.json'), 'utf8'));
}

test('a fresh installation waits without inventing a show', async (t) => {
  const paths = layout(makeRoot(t));
  const shown = loadVersionedShow({ libraryDir: paths.libraryDir, scriptFile: paths.scriptFile });
  assert.equal(shown.status, 'awaiting-live');
  assert.equal(shown.text, null);
  assert.equal(shown.productionId, null);
  assert.equal(shown.previousActivation, null);
  const running = await boot(t, paths);
  assert.equal(running.server.getAwaitingLive(), true);
  assert.equal(running.server.getSlides().length, 0);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), STALE);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'productions')), false);
  assert.equal(marker(paths).liveInstalled, false);
  assert.equal(marker(paths).previousActivation, null);

  const listed = await request(running.base, 'GET', '/api/library');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.scripts, []);
  assert.equal(listed.body.liveId, null);
  assert.equal(listed.body.awaitingLive, true);
  const script = await request(running.base, 'GET', '/script');
  assert.equal(script.status, 404);
  assert.equal(script.body.code, 'no-live-show');
  const previous = await request(running.base, 'GET', '/script/previous');
  assert.equal(previous.status, 404);
  assert.equal(previous.body.code, 'no-previous-activation');
  const published = await request(running.base, 'POST', '/script', {
    headers: { 'Content-Type': 'text/plain' },
    body: TEXT,
  });
  assert.equal(published.status, 404);
  assert.equal(published.body.code, 'no-live-show');
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'productions')), false);

  const socket = new WebSocket(running.base.replace('http', 'ws'));
  const first = await new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  assert.equal(first.awaitingLive, true);
  assert.deepEqual(first.slides, []);
  assert.equal(first.liveScriptId, null);
  socket.close();
});

test('a saved production restarts still waiting', async (t) => {
  const paths = layout(makeRoot(t));
  const first = await boot(t, paths);
  const created = await request(first.base, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Opening Night', text: TEXT }),
  });
  assert.equal(created.status, 201);
  await first.server.close();
  const second = await boot(t, paths);
  assert.equal(second.server.getAwaitingLive(), true);
  assert.equal(second.server.getSlides().length, 0);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), STALE);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);
  assert.equal(marker(paths).liveInstalled, false);
  const listed = await request(second.base, 'GET', '/api/library');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.awaitingLive, true);
  assert.equal(listed.body.scripts.length, 1);
  assert.equal(listed.body.scripts[0].id, created.body.script.id);
  assert.equal(listed.body.liveId, null);
});

test('the first Set as Live uses generation 1 and leaves no previous activation', async (t) => {
  const paths = layout(makeRoot(t));
  const running = await boot(t, paths);
  const created = await request(running.base, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Opening Night', text: TEXT }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.activated, false);
  assert.equal(running.server.getAwaitingLive(), true);
  const blocked = await request(running.base, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Shared', text: SHARED }),
  });
  const refused = await request(running.base, 'POST', `/api/library/${blocked.body.script.id}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: blocked.body.script.revision }),
  });
  assert.equal(refused.status, 409);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);
  const restored = await request(
    running.base,
    'POST',
    `/api/library/${created.body.script.id}/versions/${created.body.script.versionId}/restore`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Version-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({ expectedVersionId: created.body.script.versionId }),
    },
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.unchanged, true);
  assert.notEqual(restored.body.activated, true);
  assert.equal(running.server.getAwaitingLive(), true);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);

  const activated = await request(running.base, 'POST', `/api/library/${created.body.script.id}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: created.body.script.revision }),
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.generation, 1);
  assert.equal(activated.body.activated, true);
  const live = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(live.generation, 1);
  assert.equal(live.previousActivation, null);
  assert.equal(live.versionId, created.body.script.versionId);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), TEXT);
  assert.equal(marker(paths).liveInstalled, true);
  assert.equal(marker(paths).installationId, INSTALLATION);
  assert.equal(running.server.getAwaitingLive(), false);
  assert.equal(running.server.getSlides()[0].lines[0].text, 'FIRST CUE');
  const again = await request(running.base, 'GET', '/script/previous');
  assert.equal(again.body.code, 'no-previous-activation');
  const next = '# Opening\n[ADA]\nSECOND CUE\n';
  const published = await request(running.base, 'POST', '/script', {
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': created.body.script.id,
      'X-Library-Revision': created.body.script.revision,
    },
    body: next,
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.libraryUpdated, true);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), next);
  const afterPublish = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(afterPublish.generation, 2);
  assert.equal(afterPublish.previousActivation.versionId, created.body.script.versionId);
});

test('a committed first activation resumes, and a damaged install does not become waiting', async (t) => {
  const paths = layout(makeRoot(t));
  const running = await boot(t, paths);
  const created = await request(running.base, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Opening Night', text: TEXT }),
  });
  const crashed = await request(running.base, 'POST', `/api/library/${created.body.script.id}/live`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Fail-At': 'after-live-state',
    },
    body: JSON.stringify({ expectedRevision: created.body.script.revision }),
  });
  assert.equal(crashed.status, 503);
  assert.equal(marker(paths).liveInstalled, false);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), STALE);
  assert.equal(fs.existsSync(path.join(paths.journalDir, 'versioned-live', 'committed')), true);
  await running.server.close();

  const recovered = await boot(t, paths);
  assert.equal(recovered.server.getAwaitingLive(), false);
  assert.equal(marker(paths).liveInstalled, true);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), TEXT);
  const live = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(live.generation, 1);
  assert.equal(live.previousActivation, null);
  assert.equal(fs.existsSync(path.join(paths.journalDir, 'versioned-live', 'committed')), false);

  fs.rmSync(path.join(paths.libraryDir, 'live-state.json'));
  await recovered.server.close();
  await assert.rejects(() => boot(t, paths), (err) => err instanceof VersionedStartupError && err.code === 'missing-live-state');
  assert.equal(marker(paths).liveInstalled, true);
});

test('a pending first activation and an unauthorized fresh marker stay closed', async (t) => {
  const paths = layout(makeRoot(t));
  const running = await boot(t, paths);
  const created = await request(running.base, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Opening Night', text: TEXT }),
  });
  const pending = await request(running.base, 'POST', `/api/library/${created.body.script.id}/live`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Fail-At': 'pending-written',
    },
    body: JSON.stringify({ expectedRevision: created.body.script.revision }),
  });
  assert.equal(pending.status, 503);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);
  await running.server.close();
  await assert.rejects(() => boot(t, paths), (err) => {
    assert.equal(err instanceof VersionedStartupError, true);
    assert.equal(err.code, 'pending-journal');
    return true;
  });

  const bare = layout(makeRoot(t));
  let refused = null;
  try {
    await createPrompterServer({
      scriptFile: bare.scriptFile,
      previousFile: bare.previousFile,
      libraryDir: bare.libraryDir,
      journalDir: bare.journalDir,
    });
  } catch (err) {
    refused = err;
  }
  assert.equal(refused instanceof StorageModeError, true);
  assert.equal(refused.code, 'unsupported-versioned-storage');
  assert.equal(fs.readFileSync(bare.scriptFile, 'utf8'), STALE);
  assert.throws(() => authorizeVersionedFixture({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    previousFile: path.join(REPO, 'script.previous.txt'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
  }));
});
