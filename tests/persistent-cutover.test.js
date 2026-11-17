'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const { runPersistentMigration } = require('../library-migration-cli');
const { bindAddress, startPersistentRuntime, PersistentRuntimeError } = require('../server/persistent-runtime');
const { createStorageBackup, verifyStorageBackup, restoreStorageBackup } = require('../server/storage-backup');
const { acquireStorageWriter } = require('../server/storage-writer-lock');
const { detectStorageMode } = require('../server/storage-mode');

const REPO = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'support', 'storage-writer-child.js');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const LIVE_TEXT = '# Live Show\n@image: images/Card.png\nPRIVATE-LIVE-CUE\n';
const OTHER_TEXT = '# Saved Show\nPRIVATE-SAVED-CUE\n';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: mode || 0o644 });
  if (mode) fs.chmodSync(file, mode);
}

function makeParent(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.adapt-m9c2-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}

function writeLegacy(root) {
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(library, 'scripts', `${LIVE}.txt`), LIVE_TEXT);
  fs.writeFileSync(path.join(library, 'scripts', `${OTHER}.txt`), OTHER_TEXT);
  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  fs.writeFileSync(path.join(root, 'images', 'Card.png'), PNG);
  writeJson(path.join(library, 'index.json'), {
    version: 1,
    liveId: OTHER,
    scripts: [
      { id: LIVE, title: 'Live Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(LIVE_TEXT)) },
      { id: OTHER, title: 'Saved Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(OTHER_TEXT)) },
    ],
  });
  return library;
}

function sourceManifest(root) {
  const files = [
    'script.txt',
    'script.previous.txt',
    'script.previous.txt.meta.json',
    'data/library/index.json',
    `data/library/scripts/${LIVE}.txt`,
    `data/library/scripts/${OTHER}.txt`,
    'images/Card.png',
  ];
  const manifest = {};
  files.forEach((relative) => {
    manifest[relative] = sha256(fs.readFileSync(path.join(root, ...relative.split('/'))));
  });
  return manifest;
}

function migrationConfig(parent, root, manifest, liveId) {
  const file = path.join(parent, 'migration-auth.json');
  writeJson(file, {
    schema: 1,
    purpose: 'adapt-persistent-migration',
    root,
    libraryDir: path.join(root, 'data', 'library'),
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    journalDir: path.join(root, 'data', 'live-journal'),
    expectedLiveProductionId: liveId || LIVE,
    sourceManifest: manifest || sourceManifest(root),
  }, 0o600);
  return file;
}

function runtimeConfig(parent, root, marker) {
  const file = path.join(parent, 'runtime-auth.json');
  writeJson(file, {
    schema: 1,
    purpose: 'adapt-persistent-runtime',
    root,
    libraryDir: path.join(root, 'data', 'library'),
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    journalDir: path.join(root, 'data', 'live-journal'),
    installation: {
      schema: 2,
      state: 'committed',
      migrationId: marker.migrationId,
      productionId: marker.productionId,
      versionId: marker.versionId,
      contentHash: marker.contentHash,
    },
  }, 0o600);
  return file;
}

function ids() {
  let count = 0;
  return () => {
    count += 1;
    return `cccccccc-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
}

function spawnChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const line = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child timed out: ${output}`)), 8000);
    child.stdout.on('data', () => {
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(output.slice(0, newline).trim());
    });
  });
  return { child, line };
}

function getText(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('perl flock helper is available on this development host', () => {
  const result = spawn(process.execPath, ['-e', 'process.stdout.write(process.version)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let version = '';
  result.stdout.on('data', (chunk) => { version += chunk; });
  const perl = spawn('perl', ['-e', 'print "perl-ok\\n"'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let perlOut = '';
  perl.stdout.on('data', (chunk) => { perlOut += chunk; });
  return Promise.all([
    new Promise((resolve) => result.on('exit', resolve)),
    new Promise((resolve) => perl.on('exit', resolve)),
  ]).then((codes) => {
    assert.equal(codes[0], 0);
    assert.match(version, /^v\d+\.\d+\.\d+/);
    assert.equal(codes[1], 0);
    assert.equal(perlOut, 'perl-ok\n');
  });
});

test('persistent migration prepares, verifies, and commits only the approved plan', async (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  writeLegacy(root);
  const config = migrationConfig(parent, root);
  const preflight = runPersistentMigration({ command: 'preflight', configPath: config });
  assert.equal(preflight.ok, true, preflight.error);
  assert.equal(preflight.liveProductionId, LIVE);
  assert.equal(preflight.libraryLiveId, OTHER);
  assert.equal(preflight.warnings.some((warning) => warning.code === 'live-id-drift'), true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);

  const unprepared = runPersistentMigration({
    command: 'commit',
    configPath: config,
    planHash: 'ab'.repeat(32),
  });
  assert.equal(unprepared.code, 'not-ready');
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);

  const prepared = runPersistentMigration({
    command: 'prepare',
    configPath: config,
    createId: ids(),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.liveProductionId, LIVE);
  assert.match(prepared.planHash, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);

  const wrongPlan = runPersistentMigration({
    command: 'commit',
    configPath: config,
    planHash: 'ab'.repeat(32),
  });
  assert.equal(wrongPlan.code, 'plan-mismatch');
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);

  const committed = runPersistentMigration({
    command: 'commit',
    configPath: config,
    planHash: prepared.planHash,
  });
  assert.equal(committed.ok, true, committed.error);
  assert.equal(committed.marker.schema, 2);
  assert.equal(committed.marker.state, 'committed');
  assert.equal(committed.marker.productionId, LIVE);
  assert.equal(committed.marker.previousActivation, null);
  const savedCopy = fs.readFileSync(path.join(
    root,
    'data',
    'library',
    'productions',
    OTHER,
    'versions',
    fs.readdirSync(path.join(root, 'data', 'library', 'productions', OTHER, 'versions'))[0],
    'script.txt',
  ), 'utf8');
  assert.equal(savedCopy, OTHER_TEXT);
  const again = runPersistentMigration({ command: 'prepare', configPath: config });
  assert.equal(again.code, 'already-committed');
});

test('a stale live id, a changed manifest, and the checkout are refused', (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  writeLegacy(root);
  const stale = runPersistentMigration({
    command: 'preflight',
    configPath: migrationConfig(parent, root, sourceManifest(root), OTHER),
  });
  assert.equal(stale.code, 'live-mismatch');
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-work')), false);

  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  const savedManifest = sourceManifest(root);
  fs.writeFileSync(path.join(root, 'script.txt'), `${LIVE_TEXT}changed\n`);
  const changed = runPersistentMigration({
    command: 'preflight',
    configPath: migrationConfig(path.join(parent, 'changed'), root, savedManifest),
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'manifest-mismatch');

  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'images', 'Extra.png'), PNG);
  const extra = runPersistentMigration({
    command: 'preflight',
    configPath: migrationConfig(path.join(parent, 'extra'), root, savedManifest),
  });
  assert.equal(extra.code, 'unexpected-file');

  const checkoutConfig = path.join(parent, 'checkout-auth.json');
  writeJson(checkoutConfig, {
    schema: 1,
    purpose: 'adapt-persistent-migration',
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    previousFile: path.join(REPO, 'script.previous.txt'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
    expectedLiveProductionId: LIVE,
    sourceManifest: { 'script.txt': 'ab'.repeat(32) },
  }, 0o600);
  const checkout = runPersistentMigration({ command: 'preflight', configPath: checkoutConfig });
  assert.equal(checkout.code, 'repository-root');
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', '.writer.lock')), false);
  assert.equal(detectStorageMode({ libraryDir: path.join(REPO, 'data', 'library') }).mode, 'legacy');
});

test('a symlink lock and a running server block migration before it writes', async (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  writeLegacy(root);
  const lock = path.join(root, 'data', 'library', '.writer.lock');
  fs.writeFileSync(path.join(parent, 'lock-target'), '');
  fs.symlinkSync(path.join(parent, 'lock-target'), lock);
  const blocked = runPersistentMigration({
    command: 'prepare',
    configPath: migrationConfig(parent, root),
    createId: ids(),
  });
  assert.equal(blocked.code, 'unsafe-lock');
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-work')), false);
  fs.unlinkSync(lock);

  const config = migrationConfig(path.join(parent, 'server'), root);
  const prepared = runPersistentMigration({
    command: 'prepare',
    configPath: config,
    createId: ids(),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runPersistentMigration({ command: 'commit', configPath: config, planHash: prepared.planHash });
  assert.equal(committed.ok, true, committed.error);
  const runtime = runtimeConfig(parent, root, committed.marker);
  fs.writeFileSync(path.join(parent, 'boot.json'), JSON.stringify({
    mode: 'persistent',
    configPath: runtime,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    libraryDir: path.join(root, 'data', 'library'),
    journalDir: path.join(root, 'data', 'live-journal'),
  }));
  const child = spawnChild(['boot', path.join(parent, 'boot.json')]);
  const listening = await child.line;
  t.after(() => {
    child.child.kill('SIGKILL');
  });
  assert.match(listening, /^LISTENING /);
  const raced = runPersistentMigration({ command: 'prepare', configPath: config });
  assert.equal(raced.code, 'writer-locked');
  child.child.stdin.end();
});

test('the persistent runtime loads the committed show and refuses the wrong capability', async (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  writeLegacy(root);
  const config = migrationConfig(parent, root);
  const prepared = runPersistentMigration({
    command: 'prepare',
    configPath: config,
    createId: ids(),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  const committed = runPersistentMigration({ command: 'commit', configPath: config, planHash: prepared.planHash });
  assert.equal(committed.ok, true, committed.error);
  const runtime = runtimeConfig(parent, root, committed.marker);
  assert.throws(() => bindAddress('0.0.0.0'), (err) => err instanceof PersistentRuntimeError && err.code === 'public-bind');
  const migrationBoot = await startPersistentRuntime({ configPath: config, port: 0 }).then(() => null, (err) => err);
  assert.equal(migrationBoot.code, 'malformed-authorization');
  const started = await startPersistentRuntime({ configPath: runtime, port: 0, bindAddress: '127.0.0.1' });
  t.after(() => started.close());
  const port = started.server.address().port;
  assert.equal(started.host, '127.0.0.1');
  const script = await getText(port, '/script');
  assert.equal(script.status, 200);
  assert.match(script.body, /PRIVATE-LIVE-CUE/);
  assert.match(script.body, /library:/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const message = await new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
  socket.close();
  assert.equal(message.type, 'script');
  const previous = await getText(port, '/script/previous');
  assert.equal(previous.status, 404);
  await started.close();

  const restarted = await startPersistentRuntime({ configPath: runtime, port: 0 });
  t.after(() => restarted.close());
  const again = await getText(restarted.server.address().port, '/script');
  assert.equal(again.body, script.body);
  const wrong = runtimeConfig(path.join(parent, 'wrong'), root, Object.assign({}, committed.marker, {
    migrationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  }));
  const refused = await startPersistentRuntime({ configPath: wrong, port: 0 }).then(() => null, (err) => err);
  assert.equal(refused.code, 'installation-mismatch');
  const migrateWithRuntime = runPersistentMigration({ command: 'prepare', configPath: runtime });
  assert.equal(migrateWithRuntime.code, 'malformed-authorization');
});

test('a held writer lock keeps a second runtime from listening', async (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  fs.mkdirSync(root);
  writeLegacy(root);
  const config = migrationConfig(parent, root);
  const prepared = runPersistentMigration({
    command: 'prepare',
    configPath: config,
    createId: ids(),
    now: () => '2026-06-06T00:00:00.000Z',
  });
  const committed = runPersistentMigration({ command: 'commit', configPath: config, planHash: prepared.planHash });
  const runtime = runtimeConfig(parent, root, committed.marker);
  const child = spawnChild(['hold', path.join(root, 'data', 'library')]);
  const ready = await child.line;
  t.after(() => child.child.kill('SIGKILL'));
  assert.match(ready, /^READY /);
  const refused = await startPersistentRuntime({ configPath: runtime, port: 0 }).then(() => null, (err) => err);
  assert.equal(refused.code, 'writer-locked');
  child.child.stdin.end();
});

test('backup verifies a stopped copy and restores it somewhere else', async (t) => {
  const parent = makeParent(t);
  const root = path.join(parent, 'source');
  const backup = path.join(parent, 'backup');
  const restored = path.join(parent, 'restored');
  fs.mkdirSync(root);
  fs.mkdirSync(backup);
  fs.mkdirSync(restored);
  writeLegacy(root);
  const copied = createStorageBackup({ sourceRoot: root, backupDir: backup });
  assert.equal(copied.ok, true, copied.error);
  assert.equal(verifyStorageBackup({ backupDir: backup }).ok, true);
  fs.appendFileSync(path.join(backup, 'script.txt'), 'tamper');
  assert.equal(verifyStorageBackup({ backupDir: backup }).code, 'manifest-mismatch');
  fs.writeFileSync(path.join(backup, 'script.txt'), LIVE_TEXT);
  const result = restoreStorageBackup({ backupDir: backup, destinationRoot: restored });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(restored, 'script.txt'), 'utf8'), LIVE_TEXT);
  assert.equal(sha256(fs.readFileSync(path.join(restored, 'images', 'Card.png'))), sha256(PNG));
  const hold = acquireStorageWriter(path.join(root, 'data', 'library'), { exclusiveClaim: true });
  const second = path.join(parent, 'second-backup');
  fs.mkdirSync(second);
  const locked = createStorageBackup({ sourceRoot: root, backupDir: second });
  assert.equal(locked.code, 'writer-locked');
  hold.release();
  const checkout = createStorageBackup({ sourceRoot: REPO, backupDir: path.join(parent, 'nope') });
  assert.equal(checkout.code, 'repository-root');
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', '.writer.lock')), false);
});
