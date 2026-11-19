const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { runMigration } = require('../library-migration-cli');
const { createVersionedLibraryService } = require('../server/versioned-library-service');
const { createVersionedLiveOperations } = require('../server/versioned-live-operations');
const { createVersionStore } = require('../library-version-store');
const { installVersionedLive } = require('../server/versioned-live-install');
const {
  VersionedStartupError,
  authorizeVersionedFixture,
  createLiveGenerationGuard,
} = require('../server/versioned-runtime');

const REPO = path.resolve(__dirname, '..');
const TOKEN = 'stage-staff';
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const LIVE_TEXT = '# Live Show\nOne\nTwo\nThree\n';
const OTHER_TEXT = '# Saved Show\nSaved one\nSaved two\nSaved three\n';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const REAL_FILES = {
  'script.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
  'script.previous.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
  'script.previous.txt.meta.json': 'f3c9f57f43645b30dcaa81eb419ba80819b6927423622ac307d8ceb886024230',
  'data/library/index.json': '6c71ace24d5e026e9848983a28b2b57fc116ecd687e889f64998ee2d1b16e449',
  'data/library/scripts/2d0f0937-fc36-4d27-a31e-d047c2fd5623.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
  'images/Title_Card.jpeg': 'da924c3aaf284c9e5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e',
  'images/Cap_Back2.jpeg': 'ecf446be1bdc76be16dea4c24ba5188fa42c360c626927d247175820818bec1b',
  'images/Cap_Back3.jpeg': '11a6309fd758a094d8e5b4c82af9001163d8253ab2b173b5cad907068a8a41f5',
  'images/Cap_Back4.jpeg': '6d786f25b3ee1e49f5cb8a40625f4c152e58e416645059eef5578a4b21419410',
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function idFactory(prefix) {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
}

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-versioned-server-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clock() {
  let tick = 0;
  return () => {
    const value = new Date(Date.UTC(2026, 5, 6, 0, 0, tick)).toISOString();
    tick += 1;
    return value;
  };
}

function writeLegacy(root, liveText, otherText) {
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(library, 'scripts', `${LIVE}.txt`), liveText);
  fs.writeFileSync(path.join(library, 'scripts', `${OTHER}.txt`), otherText);
  fs.writeFileSync(path.join(root, 'script.txt'), liveText);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), {
    liveId: null,
    textHash: 'ab'.repeat(32),
  });
  writeJson(path.join(library, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [
      {
        id: LIVE,
        title: 'Live Show',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: sha256(Buffer.from(liveText)),
      },
      {
        id: OTHER,
        title: 'Saved Show',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: sha256(Buffer.from(otherText)),
      },
    ],
  });
  return library;
}

function commitFixture(t, liveText, otherText) {
  const root = makeRoot(t);
  const libraryDir = writeLegacy(root, liveText || LIVE_TEXT, otherText || OTHER_TEXT);
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: idFactory('cccccccc'),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({
    command: 'commit',
    root,
    createId: () => { throw new Error('unexpected id'); },
  });
  assert.equal(committed.ok, true, committed.error);
  const paths = {
    root,
    libraryDir,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    journalDir: path.join(root, 'data', 'live-journal'),
  };
  paths.metaFile = `${paths.previousFile}.meta.json`;
  return paths;
}

function authorize(paths) {
  return authorizeVersionedFixture(paths);
}

async function boot(t, paths, options) {
  const settings = options || {};
  const now = settings.now || clock();
  const server = await createPrompterServer({
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
    staffToken: TOKEN,
    versionedFixture: settings.authorization || authorize(paths),
    now,
    createId: settings.createId || idFactory('dddddddd'),
    failSynchronization: settings.failSynchronization,
    deferSynchronization: settings.deferSynchronization === true,
  });
  assert.equal(server.server.listening, false);
  let finished = false;
  const originalClose = server.close.bind(server);
  server.close = async () => {
    if (finished) return;
    finished = true;
    await originalClose();
  };
  t.after(() => server.close());
  return server;
}

async function listen(server) {
  if (server.server.listening) return server.server.address().port;
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  return server.server.address().port;
}

async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('The expected server state did not arrive.');
}

function openClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

async function send(port, method, routePath, options) {
  const settings = options || {};
  const headers = Object.assign(
    {},
    settings.staff === false ? {} : { 'X-Staff-Token': TOKEN },
    settings.headers || {},
  );
  const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
    method,
    headers,
    body: settings.body,
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: payload, type };
}

function liveState(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'), 'utf8'));
}

function marker(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'migration.json'), 'utf8'));
}

function versionDirs(paths, productionId) {
  return fs.readdirSync(path.join(paths.libraryDir, 'productions', productionId, 'versions'));
}

function assertRealBytes() {
  Object.keys(REAL_FILES).forEach((relative) => {
    assert.equal(sha256(fs.readFileSync(path.join(REPO, relative))), REAL_FILES[relative], relative);
  });
  assertCheckoutSeedIntact(REPO);
}

test('an older live generation cannot replace a newer one', () => {
  const guard = createLiveGenerationGuard();
  assert.equal(guard.accept(2), true);
  assert.equal(guard.accept(3), true);
  assert.equal(guard.accept(2), false);
  assert.equal(guard.current(), 3);
  assert.equal(guard.accept(3), true);
});

test('versioned startup requires fixture authorization and refuses the repository', async (t) => {
  assertRealBytes();
  const paths = commitFixture(t);
  const indexBefore = fs.readFileSync(path.join(paths.libraryDir, 'index.json'));
  assert.throws(
    () => createPrompterServer({
      scriptFile: paths.scriptFile,
      previousFile: paths.previousFile,
      libraryDir: paths.libraryDir,
      journalDir: paths.journalDir,
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'index.json')).equals(indexBefore), true);
  assert.throws(
    () => authorizeVersionedFixture({
      root: REPO,
      libraryDir: path.join(REPO, 'data', 'library'),
      scriptFile: path.join(REPO, 'script.txt'),
      previousFile: path.join(REPO, 'script.previous.txt'),
      journalDir: path.join(REPO, 'data', 'live-journal'),
    }),
    (err) => err instanceof VersionedStartupError && err.code === 'unsafe-root',
  );
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-versioned-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(
    () => authorizeVersionedFixture({
      root: paths.root,
      libraryDir: paths.libraryDir,
      scriptFile: paths.scriptFile,
      previousFile: paths.previousFile,
      journalDir: path.resolve(paths.root, '..', path.basename(outside)),
    }),
    (err) => err instanceof VersionedStartupError && err.code === 'unsafe-path',
  );
  const linked = path.join(paths.root, 'linked-library');
  fs.symlinkSync(paths.libraryDir, linked);
  assert.throws(
    () => authorizeVersionedFixture(Object.assign({}, paths, { libraryDir: linked })),
    (err) => err instanceof VersionedStartupError && err.code === 'unsafe-path',
  );
});

test('an authorized fixture installs live state before listen and does not adopt the legacy library', async (t) => {
  const paths = commitFixture(t);
  const indexBefore = fs.readFileSync(path.join(paths.libraryDir, 'index.json'));
  const scriptsBefore = fs.readdirSync(path.join(paths.libraryDir, 'scripts')).sort();
  const markerBefore = marker(paths);
  assert.equal(markerBefore.mirrorInstalled, false);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'live-state.json')), false);
  const started = await boot(t, paths);
  assert.equal(started.mode, 'versioned');
  assert.equal(started.library, undefined);
  const state = liveState(paths);
  assert.equal(state.productionId, LIVE);
  assert.equal(state.versionId, markerBefore.versionId);
  assert.equal(state.generation, 1);
  assert.equal(marker(paths).mirrorInstalled, true);
  assert.equal(marker(paths).versionId, markerBefore.versionId);
  const versionText = fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'versions', state.versionId, 'script.txt',
  ));
  assert.equal(fs.readFileSync(paths.scriptFile).equals(versionText), true);
  assert.equal(started.getLiveRaw(), versionText.toString('utf8'));
  assert.equal(started.getScriptRevision(), state.contentHash);
  assert.equal(started.getState().slideIndex, 0);
  assert.equal(started.getState().lineIndex, 0);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'index.json')).equals(indexBefore), true);
  assert.deepEqual(fs.readdirSync(path.join(paths.libraryDir, 'scripts')).sort(), scriptsBefore);
  const port = await listen(started);
  const script = await send(port, 'GET', '/script', { staff: false });
  assert.equal(script.status, 200);
  assert.equal(script.body.toString('utf8'), LIVE_TEXT);
  const listed = await send(port, 'GET', '/api/library');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.scripts.map((entry) => entry.id).sort(), [LIVE, OTHER].sort());
  fs.writeFileSync(path.join(paths.libraryDir, 'scripts', 'not-a-production.txt'), 'nope');
  const again = await send(port, 'GET', '/api/library');
  assert.equal(again.body.scripts.some((entry) => entry.id === 'not-a-production'), false);
  const hidden = await send(port, 'GET', '/data/library/productions', { staff: false });
  assert.equal(hidden.status, 404);
  const query = await send(port, 'POST', '/api/library?role=controller', {
    staff: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Nope', text: '# Nope\nNo\n' }),
  });
  assert.equal(query.status, 401);
});

test('a marker-free fixture keeps the legacy server', async (t) => {
  const root = makeRoot(t);
  const scriptFile = path.join(root, 'script.txt');
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(scriptFile, LIVE_TEXT);
  const legacy = createPrompterServer({
    scriptFile,
    previousFile: path.join(root, 'script.previous.txt'),
    libraryDir,
    journalDir: path.join(root, 'data', 'live-journal'),
    staffToken: '',
  });
  assert.equal(typeof legacy.then, 'undefined');
  assert.equal(legacy.server.listening, false);
  assert.equal(fs.existsSync(path.join(libraryDir, 'migration.json')), false);
  t.after(() => new Promise((resolve) => {
    legacy.wss.close(() => legacy.server.close(() => resolve()));
  }));
  const port = await new Promise((resolve) => {
    legacy.server.listen(0, '127.0.0.1', () => resolve(legacy.server.address().port));
  });
  const body = await fetch(`http://127.0.0.1:${port}/script`);
  assert.equal(await body.text(), LIVE_TEXT);
  const client = await openClient(port);
  await until(() => client.messages.some((message) => message.type === 'state'));
  client.socket.send(JSON.stringify({ type: 'navigate', direction: 'next' }));
  await until(() => client.messages.some((message) => message.type === 'state' && message.state.lineIndex === 1));
  client.socket.close();
});

test('startup refuses corrupt marker, live state, version, mirror, and image evidence without deleting it', async (t) => {
  const corruptMarker = commitFixture(t);
  const markerPath = path.join(corruptMarker.libraryDir, 'migration.json');
  const markerBytes = fs.readFileSync(markerPath);
  const parsed = JSON.parse(markerBytes.toString('utf8'));
  parsed.schema = 99;
  fs.writeFileSync(markerPath, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.throws(
    () => createPrompterServer({
      scriptFile: corruptMarker.scriptFile,
      previousFile: corruptMarker.previousFile,
      libraryDir: corruptMarker.libraryDir,
      journalDir: corruptMarker.journalDir,
      versionedFixture: authorize(corruptMarker),
    }),
    (err) => err instanceof StorageModeError,
  );
  assert.equal(fs.readFileSync(markerPath).toString('utf8').includes('"schema": 99'), true);

  async function refuse(prepare, code) {
    const paths = commitFixture(t);
    const started = await boot(t, paths);
    await started.close();
    const evidence = prepare(paths);
    await assert.rejects(
      () => boot(t, paths),
      (err) => err instanceof VersionedStartupError && (!code || err.code === code),
    );
    if (evidence) evidence();
    const reopened = createVersionedLibraryService({
      root: paths.root,
      libraryDir: paths.libraryDir,
      scriptFile: paths.scriptFile,
      journalDir: paths.journalDir,
    });
    assert.equal(reopened.ok, true, reopened.code);
    await reopened.close();
  }

  await refuse((paths) => {
    const file = path.join(paths.libraryDir, 'live-state.json');
    fs.writeFileSync(file, '{');
    return () => assert.equal(fs.readFileSync(file, 'utf8'), '{');
  }, 'invalid-live-state');

  await refuse((paths) => {
    const state = liveState(paths);
    const dir = path.join(paths.libraryDir, 'productions', state.productionId, 'versions', state.versionId);
    fs.rmSync(dir, { recursive: true, force: true });
    return () => assert.equal(fs.existsSync(dir), false);
  });

  await refuse((paths) => {
    const state = liveState(paths);
    const file = path.join(paths.libraryDir, 'productions', state.productionId, 'versions', state.versionId, 'script.txt');
    const flipped = Buffer.from(fs.readFileSync(file));
    flipped[0] = flipped[0] === 35 ? 36 : 35;
    fs.writeFileSync(file, flipped);
    return () => assert.equal(fs.readFileSync(file).equals(flipped), true);
  }, 'hash-mismatch');

  await refuse((paths) => {
    fs.writeFileSync(paths.scriptFile, '# Tampered\nNope\n');
    return () => assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), '# Tampered\nNope\n');
  }, 'mirror-recovery-required');
});

test('committed journals recover and pending or corrupt journals stay in place', async (t) => {
  const pendingPaths = commitFixture(t);
  assert.throws(
    () => installVersionedLive(Object.assign({ failAt: 'pending-written', now: () => '2026-06-06T00:00:00.000Z' }, pendingPaths)),
    (err) => err && err.code === 'injected-failure',
  );
  const pendingDir = path.join(pendingPaths.journalDir, 'versioned-live', 'pending');
  assert.equal(fs.existsSync(path.join(pendingDir, 'plan.json')), true);
  await assert.rejects(
    () => boot(t, pendingPaths),
    (err) => err instanceof VersionedStartupError && err.code === 'pending-journal',
  );
  assert.equal(fs.existsSync(path.join(pendingDir, 'plan.json')), true);

  const installPaths = commitFixture(t);
  assert.throws(
    () => installVersionedLive(Object.assign({ failAt: 'journal-committed', now: () => '2026-06-06T00:00:00.000Z' }, installPaths)),
    (err) => err && err.code === 'injected-failure',
  );
  const committedDir = path.join(installPaths.journalDir, 'versioned-live', 'committed');
  assert.equal(fs.existsSync(path.join(committedDir, 'plan.json')), true);
  const recovered = await boot(t, installPaths);
  assert.equal(liveState(installPaths).productionId, LIVE);
  assert.equal(fs.existsSync(committedDir), false);
  await recovered.close();

  const corruptPaths = commitFixture(t);
  const corruptDir = path.join(corruptPaths.journalDir, 'versioned-live', 'committed');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'plan.json'), '{');
  await assert.rejects(
    () => boot(t, corruptPaths),
    (err) => err instanceof VersionedStartupError && err.code === 'corrupt-journal',
  );
  assert.equal(fs.readFileSync(path.join(corruptDir, 'plan.json'), 'utf8'), '{');

  const livePaths = commitFixture(t);
  const first = await boot(t, livePaths);
  const original = liveState(livePaths);
  await first.close();
  const operations = createVersionedLiveOperations({
    root: livePaths.root,
    libraryDir: livePaths.libraryDir,
    scriptFile: livePaths.scriptFile,
    journalDir: livePaths.journalDir,
    now: () => '2026-06-06T00:00:01.000Z',
  });
  assert.equal(operations.ok, true, operations.code);
  const metadata = JSON.parse(fs.readFileSync(path.join(livePaths.libraryDir, 'productions', OTHER, 'metadata.json'), 'utf8'));
  await assert.rejects(
    () => operations.setLiveVersion({
      productionId: OTHER,
      versionId: metadata.headVersionId,
      expectedGeneration: original.generation,
      expectedVersionId: original.versionId,
      expectedContentHash: original.contentHash,
      failAt: 'journal-committed',
    }),
    (err) => err && err.code === 'injected-failure',
  );
  assert.equal(fs.existsSync(path.join(livePaths.journalDir, 'versioned-live', 'committed', 'plan.json')), true);
  const restarted = await boot(t, livePaths);
  assert.equal(liveState(livePaths).productionId, OTHER);
  assert.equal(liveState(livePaths).versionId, metadata.headVersionId);
  assert.notEqual(liveState(livePaths).versionId, marker(livePaths).versionId);
  assert.equal(restarted.getLiveRaw(), OTHER_TEXT);
  assert.equal(fs.existsSync(path.join(livePaths.journalDir, 'versioned-live', 'committed')), false);
});

test('live changes update memory once, preserve cue rules, and report synchronization', async (t) => {
  const paths = commitFixture(t);
  const started = await boot(t, paths);
  const port = await listen(started);
  const audience = await openClient(port);
  const controller = await openClient(port);
  const actor = await openClient(port);
  await until(() => [audience, controller, actor].every((client) => client.messages.some((message) => message.type === 'state')));
  controller.socket.send(JSON.stringify({ type: 'goto', lineIndex: 2 }));
  await until(() => started.getState().lineIndex === 2);
  const markerVersion = marker(paths).versionId;
  const beforeCreate = liveState(paths).versionId;
  const created = await send(port, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json', 'X-Creation-Request-Id': 'abababab-abab-4aba-8aba-abababababab' },
    body: JSON.stringify({ title: 'Extra', text: '# Extra\nAway\n', trackIfCurrent: false }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.activated, false);
  assert.equal(liveState(paths).versionId, beforeCreate);
  assert.equal(audience.messages.filter((message) => message.type === 'script').length, 1);

  const savedHead = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), 'utf8')).headVersionId;
  const saved = await send(port, 'PUT', `/api/library/${LIVE}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '# Live Show\nOne\nTwo\nThree saved\n',
      expectedRevision: sha256(Buffer.from(LIVE_TEXT)),
    }),
  });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.body.script.versionId, savedHead);
  assert.equal(liveState(paths).versionId, beforeCreate);
  assert.equal(started.getScriptRevision(), sha256(Buffer.from(LIVE_TEXT)));

  const activated = await send(port, 'POST', `/api/library/${LIVE}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: saved.body.script.revision }),
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.ok, true);
  assert.equal(activated.body.activated, true);
  assert.equal(activated.body.synchronized, true);
  assert.equal(activated.body.resetPosition, false);
  await until(() => started.getScriptRevision() === saved.body.script.revision);
  assert.equal(started.getState().lineIndex, 2);
  assert.equal(liveState(paths).versionId, saved.body.script.versionId);
  assert.equal(marker(paths).versionId, markerVersion);
  await until(() => audience.messages.some((message) => message.type === 'script' && message.revision === saved.body.script.revision));
  assert.equal(controller.messages.some((message) => message.type === 'state' && message.state.lineIndex === 2), true);

  const same = await send(port, 'POST', `/api/library/${LIVE}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: saved.body.script.revision }),
  });
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.synchronized, true);
  assert.equal(started.getState().lineIndex, 2);

  const otherMeta = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'productions', OTHER, 'metadata.json'), 'utf8'));
  const switched = await send(port, 'POST', `/api/library/${OTHER}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: otherMeta.headRevision || sha256(Buffer.from(OTHER_TEXT)) }),
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.resetPosition, true);
  assert.equal(switched.body.synchronized, true);
  await until(() => started.getLiveRaw() === OTHER_TEXT);
  assert.equal(started.getState().lineIndex, 0);
  assert.equal(started.getState().slideIndex, 0);

  const versionsBefore = versionDirs(paths, OTHER).length;
  const publishedText = '# Saved Show\nSaved one\nSaved two\nSaved three published\n';
  controller.socket.send(JSON.stringify({ type: 'goto', lineIndex: 2 }));
  await until(() => started.getState().lineIndex === 2);
  const published = await send(port, 'POST', '/script', {
    staff: false,
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': OTHER,
      'X-Library-Revision': sha256(Buffer.from(OTHER_TEXT)),
      'X-Version-Id': 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    },
    body: publishedText,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.activated, true);
  assert.equal(published.body.synchronized, true);
  assert.equal(published.body.resetPosition, false);
  assert.equal(published.body.versionId, 'ffffffff-ffff-4fff-8fff-fffffffffff1');
  await until(() => started.getLiveRaw() === publishedText);
  assert.equal(started.getState().lineIndex, 2);
  assert.equal(versionDirs(paths, OTHER).includes('ffffffff-ffff-4fff-8fff-fffffffffff1'), true);

  const previous = await send(port, 'GET', '/script/previous', { staff: false });
  assert.equal(previous.body.toString('utf8'), OTHER_TEXT);
  const restored = await send(port, 'POST', '/script', {
    staff: false,
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: OTHER_TEXT,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.activated, true);
  assert.equal(restored.body.synchronized, true);
  assert.equal(restored.body.libraryUpdated, false);
  await until(() => started.getLiveRaw() === OTHER_TEXT);
  assert.equal(started.getState().lineIndex, 2);
  assert.equal(versionDirs(paths, OTHER).length, versionsBefore + 1);

  const stale = await send(port, 'POST', `/api/library/${LIVE}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: saved.body.script.revision,
      expectedLiveGeneration: 1,
      expectedLiveVersionId: beforeCreate,
      expectedLiveContentHash: sha256(Buffer.from(LIVE_TEXT)),
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale-live');
  assert.equal(started.getLiveRaw(), OTHER_TEXT);
  assert.equal(actor.messages.filter((message) => message.type === 'state').every((message) => message.state), true);

  const joined = await openClient(port);
  await until(() => joined.messages.some((message) => message.type === 'state'));
  assert.equal(joined.messages.find((message) => message.type === 'script').revision, started.getScriptRevision());
  assert.equal(joined.messages.find((message) => message.type === 'state').state.lineIndex, 2);
  actor.socket.send(JSON.stringify({ type: 'navigate', direction: 'prev' }));
  await until(() => {
    const controllerState = controller.messages.filter((message) => message.type === 'state').at(-1);
    const audienceState = audience.messages.filter((message) => message.type === 'state').at(-1);
    return controllerState && audienceState
      && controllerState.state.lineIndex === 1
      && audienceState.state.lineIndex === 1
      && started.getState().lineIndex === 1;
  });
  joined.socket.close();
  actor.socket.close();
  controller.socket.close();
  audience.socket.close();
});

test('concurrent live changes and a synchronization failure stay with the committed generation', async (t) => {
  const paths = commitFixture(t);
  const deferred = await boot(t, paths, { deferSynchronization: true });
  const port = await listen(deferred);
  const client = await openClient(port);
  await until(() => client.messages.some((message) => message.type === 'state'));
  const created = await send(port, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Third', text: '# Third\nAlpha\nBeta\nGamma\n', trackIfCurrent: false }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const thirdId = created.body.script.id;
  const initialRevision = deferred.getScriptRevision();
  const [left, right] = await Promise.all([
    send(port, 'POST', `/api/library/${OTHER}/live`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: sha256(Buffer.from(OTHER_TEXT)) }),
    }),
    send(port, 'POST', `/api/library/${thirdId}/live`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: created.body.script.revision }),
    }),
  ]);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(left.body.synchronized, false);
  assert.equal(right.body.synchronized, false);
  assert.equal(deferred.getScriptRevision(), initialRevision);
  const later = [left.body, right.body].sort((a, b) => b.generation - a.generation)[0];
  const outcomes = deferred.applyDeferredSynchronizations([1, 0]);
  assert.equal(outcomes[0].synchronized, true);
  assert.equal(outcomes[1].synchronized, false);
  assert.equal(deferred.getScriptRevision(), later.revision);
  assert.equal(deferred.getLiveScriptId(), later.liveId);
  await until(() => client.messages.filter((message) => message.type === 'script' && message.revision !== initialRevision).length === 1);
  const scriptMessages = client.messages.filter((message) => message.type === 'script' && message.revision !== initialRevision);
  assert.equal(scriptMessages.length, 1);
  assert.equal(scriptMessages[0].revision, later.revision);
  client.socket.close();
  await deferred.close();

  const faultPaths = commitFixture(t);
  const faulted = await boot(t, faultPaths, { failSynchronization: 'throw' });
  const faultPort = await listen(faulted);
  const before = faulted.getScriptRevision();
  const published = await send(faultPort, 'POST', '/script', {
    staff: false,
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': LIVE,
      'X-Library-Revision': sha256(Buffer.from(LIVE_TEXT)),
      'X-Version-Id': 'ffffffff-ffff-4fff-8fff-fffffffffff2',
    },
    body: '# Live Show\nOne\nTwo\nThree changed\n',
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.ok, true);
  assert.equal(published.body.activated, true);
  assert.equal(published.body.synchronized, false);
  assert.equal(published.body.versionId, 'ffffffff-ffff-4fff-8fff-fffffffffff2');
  assert.notEqual(published.body.rolledBack, true);
  assert.equal(JSON.stringify(published.body).toLowerCase().includes('rolled back'), false);
  assert.equal(faulted.getScriptRevision(), before);
  assert.equal(liveState(faultPaths).versionId, published.body.versionId);
  await faulted.close();
  const reconciled = await boot(t, faultPaths);
  assert.equal(reconciled.getScriptRevision(), published.body.revision);
  assert.equal(reconciled.getLiveRaw(), '# Live Show\nOne\nTwo\nThree changed\n');
});

test('a websocket reload does not adopt a drifted mirror', async (t) => {
  const paths = commitFixture(t);
  const started = await boot(t, paths);
  const port = await listen(started);
  const client = await openClient(port);
  await until(() => client.messages.length >= 2);
  const before = fs.readFileSync(paths.scriptFile);
  fs.writeFileSync(paths.scriptFile, '# Drifted\nAway\n');
  const versionsBefore = versionDirs(paths, LIVE).slice();
  client.socket.send(JSON.stringify({ type: 'reloadScript' }));
  await until(() => client.messages.some((message) => message.type === 'error'));
  const error = client.messages.find((message) => message.type === 'error');
  assert.equal(error.code, 'mirror-recovery-required');
  assert.equal(started.getLiveRaw(), LIVE_TEXT);
  assert.deepEqual(versionDirs(paths, LIVE), versionsBefore);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), '# Drifted\nAway\n');
  assert.notEqual(sha256(fs.readFileSync(paths.scriptFile)), sha256(before));
  client.socket.close();
});

test('image routes stay production-owned and the public live image follows the active script', async (t) => {
  const paths = commitFixture(t);
  const started = await boot(t, paths);
  const port = await listen(started);
  const uploaded = await send(port, 'POST', `/api/library/${LIVE}/assets`, {
    headers: {
      'Content-Type': 'image/png',
      'X-Asset-Id': ASSET,
      'X-Asset-Name': 'Dot.png',
    },
    body: PNG,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const stored = path.join(paths.libraryDir, 'productions', LIVE, 'assets', `${ASSET}.png`);
  assert.equal(fs.readFileSync(stored).equals(PNG), true);
  const hidden = await send(port, 'GET', `/api/live/assets/${LIVE}/${ASSET}`, { staff: false });
  assert.equal(hidden.status, 404);
  const denied = await send(port, 'GET', `/api/library/${LIVE}/assets/${ASSET}`, { staff: false });
  assert.equal(denied.status, 401);
  const preview = await send(port, 'GET', `/api/library/${LIVE}/assets/${ASSET}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.equals(PNG), true);
  const referenced = `# Live Show\n@image: library:${LIVE}/${ASSET}\nOne\nTwo\nThree\n`;
  const published = await send(port, 'POST', '/script', {
    staff: false,
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': LIVE,
      'X-Library-Revision': sha256(Buffer.from(LIVE_TEXT)),
    },
    body: referenced,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.synchronized, true);
  const visible = await send(port, 'GET', `/api/live/assets/${LIVE}/${ASSET}`, { staff: false });
  assert.equal(visible.status, 200);
  assert.equal(visible.body.equals(PNG), true);
  await started.close();
  fs.writeFileSync(stored, Buffer.from('not-an-image'));
  await assert.rejects(
    () => boot(t, paths),
    (err) => err instanceof VersionedStartupError && err.code === 'corrupt-asset',
  );
  assert.equal(fs.readFileSync(stored).equals(Buffer.from('not-an-image')), true);
});

test('shutdown releases the writer and the same fixture can start again', async (t) => {
  const paths = commitFixture(t);
  const first = await boot(t, paths);
  const blocked = createVersionedLibraryService({
    root: paths.root,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    journalDir: paths.journalDir,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'writer-active');
  await first.close();
  const second = await boot(t, paths);
  assert.equal(second.getLiveRaw(), LIVE_TEXT);
  assert.equal(second.getState().lineIndex, 0);
  await second.close();
  const reopened = createVersionedLibraryService({
    root: paths.root,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    journalDir: paths.journalDir,
  });
  assert.equal(reopened.ok, true, reopened.code);
  await reopened.close();
});

test('the repository scripts, library, images, and journals stay unchanged', () => {
  assertRealBytes();
  const adapter = fs.readFileSync(path.join(REPO, 'server', 'versioned-http-routes.js'), 'utf8');
  assert.equal(adapter.includes('broadcast'), false);
  const routes = fs.readFileSync(path.join(REPO, 'server', 'http-routes.js'), 'utf8');
  assert.equal(routes.includes('versioned-http-routes'), false);
});

test('install journals recover after the live state or mirror is written', async (t) => {
  for (const stage of ['after-live-state', 'before-cleanup']) {
    const paths = commitFixture(t);
    assert.throws(
      () => installVersionedLive(Object.assign({ failAt: stage, now: () => '2026-06-06T00:00:00.000Z' }, paths)),
      (err) => err && err.code === 'injected-failure',
    );
    assert.equal(fs.existsSync(path.join(paths.journalDir, 'versioned-live', 'committed', 'plan.json')), true);
    const started = await boot(t, paths);
    assert.equal(started.getLiveRaw(), LIVE_TEXT);
    assert.equal(liveState(paths).productionId, LIVE);
    assert.equal(fs.existsSync(path.join(paths.journalDir, 'versioned-live', 'committed')), false);
    await started.close();
  }
});

test('committed publish and restore journals select their recorded version', async (t) => {
  const publishPaths = commitFixture(t);
  const installed = await boot(t, publishPaths);
  const original = liveState(publishPaths);
  await installed.close();
  const publishing = createVersionedLiveOperations({
    root: publishPaths.root,
    libraryDir: publishPaths.libraryDir,
    scriptFile: publishPaths.scriptFile,
    journalDir: publishPaths.journalDir,
    now: () => '2026-06-06T00:00:02.000Z',
  });
  const head = JSON.parse(fs.readFileSync(path.join(publishPaths.libraryDir, 'productions', LIVE, 'metadata.json'), 'utf8')).headVersionId;
  const published = '# Live Show\nOne\nTwo\nPublished\n';
  const publishedId = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(
    () => publishing.publishLiveVersion({
      productionId: LIVE,
      expectedHeadVersionId: head,
      newVersionId: publishedId,
      text: published,
      createdAt: '2026-06-06T00:00:02.000Z',
      expectedGeneration: original.generation,
      expectedVersionId: original.versionId,
      expectedContentHash: original.contentHash,
      failAt: 'journal-committed',
    }),
    (err) => err && err.code === 'injected-failure',
  );
  const recoveredPublish = await boot(t, publishPaths);
  assert.equal(liveState(publishPaths).versionId, publishedId);
  assert.equal(recoveredPublish.getLiveRaw(), published);
  await recoveredPublish.close();

  const restorePaths = commitFixture(t);
  const first = await boot(t, restorePaths);
  const initial = liveState(restorePaths);
  await first.close();
  const restoring = createVersionedLiveOperations({
    root: restorePaths.root,
    libraryDir: restorePaths.libraryDir,
    scriptFile: restorePaths.scriptFile,
    journalDir: restorePaths.journalDir,
    now: () => '2026-06-06T00:00:03.000Z',
  });
  const otherHead = JSON.parse(fs.readFileSync(path.join(restorePaths.libraryDir, 'productions', OTHER, 'metadata.json'), 'utf8')).headVersionId;
  const switched = await restoring.setLiveVersion({
    productionId: OTHER,
    versionId: otherHead,
    expectedGeneration: initial.generation,
    expectedVersionId: initial.versionId,
    expectedContentHash: initial.contentHash,
  });
  assert.equal(switched.ok, true, switched.code);
  const switchedState = liveState(restorePaths);
  await assert.rejects(
    () => restoring.restorePreviousLive({
      expectedGeneration: switchedState.generation,
      expectedVersionId: switchedState.versionId,
      expectedContentHash: switchedState.contentHash,
      failAt: 'journal-committed',
    }),
    (err) => err && err.code === 'injected-failure',
  );
  const recoveredRestore = await boot(t, restorePaths);
  assert.equal(liveState(restorePaths).productionId, LIVE);
  assert.equal(liveState(restorePaths).versionId, initial.versionId);
  assert.equal(recoveredRestore.getLiveRaw(), LIVE_TEXT);
  await recoveredRestore.close();
});

test('an interrupted version finishes from its stored timestamp and is not rewritten', async (t) => {
  const paths = commitFixture(t);
  const versionId = '44444444-4444-4444-8444-444444444444';
  const text = '# Live Show\nOne\nTwo\nInterrupted\n';
  const head = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), 'utf8')).headVersionId;
  const interrupted = createVersionStore({ root: paths.libraryDir, failAt: 'before-metadata' });
  const first = await interrupted.saveVersion({
    productionId: LIVE,
    expectedVersionId: head,
    newVersionId: versionId,
    text,
    createdAt: '2026-06-06T00:00:04.000Z',
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'incomplete');
  const versionFile = path.join(paths.libraryDir, 'productions', LIVE, 'versions', versionId, 'version.json');
  const stored = fs.readFileSync(versionFile);
  const versionsBefore = fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions'));
  const retry = createVersionStore({ root: paths.libraryDir });
  const second = await retry.saveVersion({
    productionId: LIVE,
    expectedVersionId: head,
    newVersionId: versionId,
    text,
    createdAt: '2026-06-06T00:00:05.000Z',
  });
  assert.equal(second.ok, true, second.code);
  assert.equal(second.currentVersionId, versionId);
  assert.equal(fs.readFileSync(versionFile).equals(stored), true);
  assert.equal(JSON.parse(stored.toString('utf8')).createdAt, '2026-06-06T00:00:04.000Z');
  assert.deepEqual(fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions')), versionsBefore);
  const metadata = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), 'utf8'));
  assert.equal(metadata.headVersionId, versionId);

  const otherId = '55555555-5555-4555-8555-555555555555';
  const parkedFile = path.join(paths.libraryDir, 'productions', LIVE, 'versions', otherId, 'version.json');
  const parked = createVersionStore({ root: paths.libraryDir, failAt: 'before-metadata' });
  const parkedResult = await parked.saveVersion({
    productionId: LIVE,
    expectedVersionId: versionId,
    newVersionId: otherId,
    text: '# Live Show\nParked\n',
    createdAt: '2026-06-06T00:00:06.000Z',
  });
  assert.equal(parkedResult.code, 'incomplete');
  const parkedBytes = fs.readFileSync(parkedFile);
  const mismatch = await createVersionStore({ root: paths.libraryDir }).saveVersion({
    productionId: LIVE,
    expectedVersionId: versionId,
    newVersionId: otherId,
    text: '# Live Show\nDifferent\n',
    createdAt: '2026-06-06T00:00:06.000Z',
  });
  assert.equal(mismatch.code, 'version-exists');
  assert.equal(fs.readFileSync(parkedFile).equals(parkedBytes), true);
  assert.equal(fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions')).includes(otherId), true);
});
