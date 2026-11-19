const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { createPrompterServer } = require('../server');
const { runMigration } = require('../library-migration-cli');
const { installVersionedLive } = require('../server/versioned-live-install');
const { createVersionedLibraryService } = require('../server/versioned-library-service');
const { registerVersionedHttpRoutes } = require('../server/versioned-http-routes');
const { authorizeVersionedFixture } = require('../server/versioned-runtime');

const REPO = path.resolve(__dirname, '..');
const TOKEN = 'stage-staff';
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CREATED = '33333333-3333-4333-8333-333333333333';
const V1 = '33333333-3333-4333-8333-333333333334';
const V2 = '44444444-4444-4444-8444-444444444444';
const V3 = '55555555-5555-4555-8555-555555555555';
const V4 = '66666666-6666-4666-8666-666666666666';
const V5 = '77777777-7777-4777-8777-777777777777';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
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

function jpegBytes() {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(16, 9),
    Buffer.from([0xFF, 0xD9]),
  ]);
}

function idFactory(prefix) {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-restore-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function liveText() {
  return '# Scene\r\n@image: images/Title_Card.jpeg\r\n[ADA]\r\nHéllo\r\n[ADA]\r\nAgain\r\n';
}

function commitImageFixture(t) {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'data', 'library');
  const text = liveText();
  const saved = '# Other\n[BLUE]\nOTHER\n';
  fs.mkdirSync(path.join(libraryDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'Title_Card.jpeg'), jpegBytes());
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${LIVE}.txt`), text);
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${OTHER}.txt`), saved);
  fs.writeFileSync(path.join(root, 'script.txt'), text);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  writeJson(path.join(libraryDir, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [
      { id: LIVE, title: 'Live Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(text)) },
      { id: OTHER, title: 'Saved Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(saved)) },
    ],
  });
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
  const installed = installVersionedLive(Object.assign({ now: () => '2026-06-06T00:00:00.000Z' }, paths));
  assert.equal(installed.ok, true, installed.error);
  return paths;
}

function openService(paths) {
  return createVersionedLibraryService({
    root: paths.root,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    journalDir: paths.journalDir,
    now: () => '2026-06-06T00:00:10.000Z',
  });
}

async function listenApp(t, paths) {
  const service = openService(paths);
  assert.equal(service.ok, true, service.code);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerVersionedHttpRoutes({
    app,
    service,
    staffToken: TOKEN,
    now: () => '2026-11-16T15:00:00.000Z',
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return { service, base: `http://127.0.0.1:${server.address().port}` };
}

function metadata(paths, productionId) {
  return JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', productionId, 'metadata.json',
  ), 'utf8'));
}

function versionFile(paths, productionId, versionId, name) {
  return path.join(paths.libraryDir, 'productions', productionId, 'versions', versionId, name);
}

function versionBytes(paths, productionId, versionId) {
  return fs.readFileSync(versionFile(paths, productionId, versionId, 'script.txt'));
}

async function restore(service, productionId, sourceVersionId, expectedVersionId, newVersionId) {
  return service.restoreSavedVersion({
    productionId,
    sourceVersionId,
    expectedVersionId,
    newVersionId,
    createdAt: '2026-11-16T15:00:00.000Z',
  });
}

test('restore copies an older committed version into a new head and leaves live state in place', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const original = '# Scene\r\n[ADA]\r\nHéllo\r\n';
  const created = await service.createProduction({
    productionId: CREATED,
    versionId: V1,
    title: 'Restored Room',
    text: original,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(created.ok, true, created.error);
  const second = await service.saveVersion({
    productionId: CREATED,
    expectedVersionId: V1,
    newVersionId: V2,
    text: '# Scene\n[ADA]\nSECOND\n',
    createdAt: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(second.ok, true, second.error);
  const third = await service.saveVersion({
    productionId: CREATED,
    expectedVersionId: V2,
    newVersionId: V3,
    text: '# Scene\n[ADA]\nTHIRD\n',
    createdAt: '2026-08-03T00:00:00.000Z',
  });
  assert.equal(third.ok, true, third.error);
  const live = await service.readLiveShow();
  const switched = await service.setLiveVersion({
    productionId: CREATED,
    versionId: V2,
    expectedGeneration: live.generation,
    expectedVersionId: live.versionId,
    expectedContentHash: live.contentHash,
  });
  assert.equal(switched.ok, true, switched.error);
  const marker = sha256(fs.readFileSync(path.join(paths.libraryDir, 'migration.json')));
  const liveFile = fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'));
  const mirror = fs.readFileSync(paths.scriptFile);
  const before = [V1, V2, V3].map((id) => sha256(versionBytes(paths, CREATED, id)));
  const restored = await restore(service, CREATED, V1, V3, V4);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.unchanged, false);
  assert.equal(restored.sourceVersionId, V1);
  assert.equal(restored.savedHeadVersionId, V4);
  assert.equal(restored.parentVersionId, V3);
  assert.equal(restored.version.parentVersionId, V3);
  assert.equal(restored.version.origin, 'edited');
  assert.equal(restored.version.role, 'edited');
  assert.equal(Object.prototype.hasOwnProperty.call(restored.version, 'sourceVersionId'), false);
  const stored = JSON.parse(fs.readFileSync(versionFile(paths, CREATED, V4, 'version.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'sourceVersionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'restoredFromVersionId'), false);
  assert.equal(versionBytes(paths, CREATED, V4).equals(versionBytes(paths, CREATED, V1)), true);
  assert.equal(versionBytes(paths, CREATED, V4).toString('utf8'), original);
  assert.deepEqual([V1, V2, V3].map((id) => sha256(versionBytes(paths, CREATED, id))), before);
  assert.equal(metadata(paths, CREATED).headVersionId, V4);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')).equals(liveFile), true);
  assert.equal(fs.readFileSync(paths.scriptFile).equals(mirror), true);
  assert.equal(sha256(fs.readFileSync(path.join(paths.libraryDir, 'migration.json'))), marker);
  assert.equal(restored.liveState.versionId, V2);
  assert.equal(restored.liveState.productionId, CREATED);

  const same = await restore(service, CREATED, V1, V4, V5);
  assert.equal(same.ok, true, same.error);
  assert.equal(same.unchanged, true);
  assert.equal(same.sourceVersionId, V1);
  assert.equal(same.savedHeadVersionId, V4);
  assert.equal(fs.existsSync(versionFile(paths, CREATED, V5, 'script.txt')), false);
  const stale = await restore(service, CREATED, V1, V3, '88888888-8888-4888-8888-888888888888');
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.currentVersionId, V4);
  assert.equal(metadata(paths, CREATED).headVersionId, V4);
});

test('a verified shared image restores as a new owned version and leaves the original alone', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const source = versionBytes(paths, LIVE, original.versionId);
  const migratedBytes = versionBytes(paths, LIVE, migrated.versionId);
  const liveFile = fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'));
  const mirror = fs.readFileSync(paths.scriptFile);
  const detail = await service.readProductionVersion({ productionId: LIVE, versionId: original.versionId });
  assert.equal(detail.images.sharedRestore.status, 'verified');
  assert.equal(detail.images.sharedRestore.basis, 'stored-copy');
  assert.equal(detail.images.sharedRestore.historicalProof, false);
  assert.match(detail.images.sharedRestore.description, /does not prove they are the images from the original save/);
  assert.doesNotMatch(detail.images.sharedRestore.description, /identical to the originals|historical original|proven historical/i);
  const edited = await service.saveVersion({
    productionId: LIVE,
    expectedVersionId: migrated.versionId,
    newVersionId: V3,
    text: '# Scene\r\n[ADA]\r\nEDITED\r\n',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(edited.ok, true, edited.error);
  const restored = await restore(service, LIVE, original.versionId, V3, V4);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.unchanged, false);
  assert.equal(restored.parentVersionId, V3);
  assert.equal(restored.imageIntegrity, 'verified');
  assert.equal(restored.imagesCopied, 0);
  const saved = versionBytes(paths, LIVE, V4).toString('utf8');
  assert.equal(saved.includes('library:'), true);
  assert.equal(saved.includes('images/'), false);
  assert.equal(versionBytes(paths, LIVE, original.versionId).equals(source), true);
  assert.equal(versionBytes(paths, LIVE, migrated.versionId).equals(migratedBytes), true);
  const document = JSON.parse(fs.readFileSync(versionFile(paths, LIVE, V4, 'version.json'), 'utf8'));
  assert.equal(document.parentVersionId, V3);
  assert.equal(document.imageRestoration.integrity, 'verified');
  assert.equal(document.imageRestoration.sourceVersionId, original.versionId);
  const manifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  assert.equal(manifest.productionId, LIVE);
  const assetHashes = new Map();
  document.assetIds.forEach((assetId) => {
    const entry = manifest.assets.find((asset) => (asset.assetId || asset.id) === assetId);
    assert.ok(entry, assetId);
    const filePath = path.join(paths.libraryDir, 'productions', LIVE, 'assets', entry.file);
    assert.equal(filePath.startsWith(path.join(paths.libraryDir, 'productions', LIVE, 'assets')), true);
    assert.equal(fs.existsSync(filePath), true);
    assetHashes.set(assetId, sha256(fs.readFileSync(filePath)));
  });
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')).equals(liveFile), true);
  assert.equal(fs.readFileSync(paths.scriptFile).equals(mirror), true);
  await service.close();
  const again = openService(paths);
  t.after(() => again.close());
  const reread = await again.readProductionVersion({ productionId: LIVE, versionId: V4 });
  assert.equal(reread.ok, true, reread.error);
  assert.equal(reread.version.text, saved);
  assert.equal(reread.version.imageRestoration.integrity, 'verified');
  assetHashes.forEach((hash, assetId) => {
    const entry = manifest.assets.find((asset) => (asset.assetId || asset.id) === assetId);
    const filePath = path.join(paths.libraryDir, 'productions', LIVE, 'assets', entry.file);
    assert.equal(sha256(fs.readFileSync(filePath)), hash);
  });
});

test('a late retry of the same restore id does not save a second version', async (t) => {
  const paths = commitImageFixture(t);
  const started = await listenApp(t, paths);
  const service = started.service;
  const created = await service.createProduction({
    productionId: CREATED,
    versionId: V1,
    title: 'Retry Room',
    text: '# Scene\n[ADA]\nFIRST\n',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(created.ok, true, created.error);
  const edited = await service.saveVersion({
    productionId: CREATED,
    expectedVersionId: V1,
    newVersionId: V2,
    text: '# Scene\n[ADA]\nSECOND\n',
    createdAt: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(edited.ok, true, edited.error);
  const liveBefore = fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'));
  const [first, second] = await Promise.all([
    restore(service, CREATED, V1, V2, V4),
    restore(service, CREATED, V1, V2, V4),
  ]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.ok && result.alreadyRestored !== true && result.unchanged !== true).length, 1);
  assert.equal(results.filter((result) => result.ok && result.alreadyRestored === true).length, 1);
  assert.equal(metadata(paths, CREATED).headVersionId, V4);
  assert.equal(fs.readdirSync(path.join(paths.libraryDir, 'productions', CREATED, 'versions')).filter((name) => !name.startsWith('.')).length, 3);
  const retry = await fetch(`${started.base}/api/library/${CREATED}/versions/${V1}/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': TOKEN,
      'X-Version-Id': V4,
    },
    body: JSON.stringify({ expectedVersionId: V2 }),
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.alreadyRestored, true);
  assert.equal(retryBody.restoredVersionId, V4);
  assert.equal(retryBody.savedHeadVersionId, V4);
  assert.equal(fs.readdirSync(path.join(paths.libraryDir, 'productions', CREATED, 'versions')).filter((name) => !name.startsWith('.')).length, 3);

  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const source = versionBytes(paths, LIVE, original.versionId);
  fs.writeFileSync(path.join(paths.root, 'images', 'Title_Card.jpeg'), Buffer.concat([
    jpegBytes().subarray(0, jpegBytes().length - 3),
    Buffer.from([7]),
    jpegBytes().subarray(jpegBytes().length - 2),
  ]));
  const copied = await service.restoreSavedVersion({
    productionId: LIVE,
    sourceVersionId: original.versionId,
    expectedVersionId: migrated.versionId,
    newVersionId: V5,
    createdAt: '2026-11-16T15:04:00.000Z',
    confirmCurrentImages: true,
  });
  assert.equal(copied.ok, true, copied.error);
  assert.equal(copied.imageIntegrity, 'current-shared');
  const manifestAfterCopy = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const copiedIds = manifestAfterCopy.assets.map((asset) => asset.assetId || asset.id);
  const late = await service.restoreSavedVersion({
    productionId: LIVE,
    sourceVersionId: original.versionId,
    expectedVersionId: migrated.versionId,
    newVersionId: V5,
    createdAt: '2026-11-16T15:05:00.000Z',
    confirmCurrentImages: true,
  });
  assert.equal(late.alreadyRestored, true);
  assert.equal(late.imagesCopied, 0);
  assert.equal(metadata(paths, LIVE).headVersionId, V5);
  const manifestAfterRetry = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  assert.deepEqual(manifestAfterRetry.assets.map((asset) => asset.assetId || asset.id), copiedIds);
  assert.equal(versionBytes(paths, LIVE, original.versionId).equals(source), true);
  const conflict = await restore(service, LIVE, original.versionId, migrated.versionId, '88888888-8888-4888-8888-888888888888');
  assert.equal(conflict.code, 'conflict');
  assert.equal(fs.existsSync(versionFile(paths, LIVE, '88888888-8888-4888-8888-888888888888', 'script.txt')), false);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')).equals(liveBefore), true);

  await service.close();
  const again = openService(paths);
  t.after(() => again.close());
  const plain = await again.readProductionVersion({ productionId: CREATED, versionId: V4 });
  const shared = await again.readProductionVersion({ productionId: LIVE, versionId: V5 });
  assert.equal(plain.ok, true, plain.error);
  assert.equal(plain.version.text.includes('FIRST'), true);
  assert.equal(shared.version.imageRestoration.integrity, 'current-shared');
  const reopenedManifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const owned = reopenedManifest.assets.find((asset) => asset.imageSource === 'current-shared-file');
  assert.equal(owned.legacyPath, 'images/Title_Card.jpeg');
  assert.equal(sha256(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', owned.file,
  ))), owned.contentHash);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')).equals(liveBefore), true);
});

test('an unverified shared image waits for confirmation and then copies the current file', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const source = versionBytes(paths, LIVE, original.versionId);
  const namesBefore = fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions'));
  const manifestBefore = fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json'));
  fs.writeFileSync(path.join(paths.root, 'images', 'Title_Card.jpeg'), Buffer.concat([
    jpegBytes().subarray(0, jpegBytes().length - 3),
    Buffer.from([4]),
    jpegBytes().subarray(jpegBytes().length - 2),
  ]));
  const held = await restore(service, LIVE, original.versionId, migrated.versionId, V4);
  assert.equal(held.code, 'confirmation-required');
  assert.equal(held.imageIntegrity, 'current-shared');
  assert.equal(versionBytes(paths, LIVE, original.versionId).equals(source), true);
  assert.deepEqual(fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions')), namesBefore);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json')).equals(manifestBefore), true);
  const restored = await service.restoreSavedVersion({
    productionId: LIVE,
    sourceVersionId: original.versionId,
    expectedVersionId: migrated.versionId,
    newVersionId: V4,
    createdAt: '2026-11-16T15:00:00.000Z',
    confirmCurrentImages: true,
  });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.imageIntegrity, 'current-shared');
  assert.equal(restored.imagesCopied, 1);
  assert.equal(restored.parentVersionId, migrated.versionId);
  assert.equal(versionBytes(paths, LIVE, original.versionId).equals(source), true);
  const document = JSON.parse(fs.readFileSync(versionFile(paths, LIVE, V4, 'version.json'), 'utf8'));
  assert.equal(document.imageRestoration.integrity, 'current-shared');
  const manifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const copied = manifest.assets.find((asset) => asset.imageSource === 'current-shared-file');
  assert.ok(copied);
  assert.equal(copied.legacyPath, 'images/Title_Card.jpeg');
  assert.equal(manifest.productionId, LIVE);
  const liveFile = fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'));
  await service.close();
  const again = openService(paths);
  t.after(() => again.close());
  const reread = await again.readProductionVersion({ productionId: LIVE, versionId: V4 });
  assert.equal(reread.version.imageRestoration.images[0].integrity, 'current-shared');
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')).equals(liveFile), true);
});

test('a missing or unsafe shared image is refused without a partial restore', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const source = versionBytes(paths, LIVE, original.versionId);
  const namesBefore = fs.readdirSync(path.join(paths.libraryDir, 'productions', LIVE, 'versions'));
  const manifestBefore = fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json'));
  fs.rmSync(path.join(paths.root, 'images', 'Title_Card.jpeg'));
  const missing = await restore(service, LIVE, original.versionId, migrated.versionId, V4);
  assert.equal(missing.code, 'missing-image');
  assert.equal(missing.sharedImages.some((image) => image.name === 'Title_Card.jpeg' && image.code === 'missing-image'), true);
  fs.writeFileSync(path.join(paths.root, 'images', 'Title_Card.jpeg'), jpegBytes());
  fs.symlinkSync(path.join(paths.root, 'images', 'Title_Card.jpeg'), path.join(paths.root, 'images', 'Linked.jpeg'));
  const unsafeText = '# Scene\r\n@image: images/Linked.jpeg\r\n[ADA]\r\nHéllo\r\n';
  const head = metadata(paths, LIVE);
  const unsafeId = V2;
  fs.mkdirSync(path.dirname(versionFile(paths, LIVE, unsafeId, 'script.txt')), { recursive: true });
  fs.writeFileSync(versionFile(paths, LIVE, unsafeId, 'script.txt'), unsafeText);
  writeJson(versionFile(paths, LIVE, unsafeId, 'version.json'), {
    schema: 1,
    id: unsafeId,
    productionId: LIVE,
    contentHash: sha256(Buffer.from(unsafeText)),
    parentVersionId: original.versionId,
    origin: 'original',
    role: 'v1',
    legacyImagePolicy: 'shared-images',
    assetIds: [],
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  head.versions.push({
    id: unsafeId,
    role: 'v1',
    origin: 'original',
    parentVersionId: original.versionId,
    contentHash: sha256(Buffer.from(unsafeText)),
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  writeJson(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), head);
  const linked = await restore(service, LIVE, unsafeId, migrated.versionId, V5);
  assert.equal(linked.code, 'unsafe-image');
  const traversalText = '# Scene\r\n@image: images/../Title_Card.jpeg\r\n[ADA]\r\nHéllo\r\n';
  fs.mkdirSync(path.dirname(versionFile(paths, LIVE, '99999999-9999-4999-8999-999999999991', 'script.txt')), { recursive: true });
  fs.writeFileSync(versionFile(paths, LIVE, '99999999-9999-4999-8999-999999999991', 'script.txt'), traversalText);
  writeJson(versionFile(paths, LIVE, '99999999-9999-4999-8999-999999999991', 'version.json'), {
    schema: 1,
    id: '99999999-9999-4999-8999-999999999991',
    productionId: LIVE,
    contentHash: sha256(Buffer.from(traversalText)),
    parentVersionId: original.versionId,
    origin: 'original',
    role: 'v1',
    legacyImagePolicy: 'shared-images',
    assetIds: [],
    createdAt: '2026-09-05T00:00:00.000Z',
  });
  const recorded = metadata(paths, LIVE);
  recorded.versions.push({
    id: '99999999-9999-4999-8999-999999999991',
    role: 'v1',
    origin: 'original',
    parentVersionId: original.versionId,
    contentHash: sha256(Buffer.from(traversalText)),
    createdAt: '2026-09-05T00:00:00.000Z',
  });
  writeJson(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), recorded);
  const traversal = await restore(service, LIVE, '99999999-9999-4999-8999-999999999991', migrated.versionId, '99999999-9999-4999-8999-999999999992');
  assert.equal(traversal.code, 'unsafe-image');
  assert.equal(versionBytes(paths, LIVE, original.versionId).equals(source), true);
  assert.equal(metadata(paths, LIVE).headVersionId, migrated.versionId);
  assert.equal(fs.existsSync(versionFile(paths, LIVE, V4, 'script.txt')), false);
  assert.equal(fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json')).equals(manifestBefore), true);
  assert.ok(namesBefore.includes(original.versionId));
});

test('a failed shared-image copy does not leave a new version or asset', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const manifestBefore = fs.readFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json'));
  fs.writeFileSync(path.join(paths.root, 'images', 'Title_Card.jpeg'), Buffer.concat([
    jpegBytes().subarray(0, jpegBytes().length - 3),
    Buffer.from([5]),
    jpegBytes().subarray(jpegBytes().length - 2),
  ]));
  const failed = await service.restoreSavedVersion({
    productionId: LIVE,
    sourceVersionId: original.versionId,
    expectedVersionId: migrated.versionId,
    newVersionId: V4,
    createdAt: '2026-11-16T15:00:00.000Z',
    confirmCurrentImages: true,
    failAt: 'after-assets',
  });
  assert.equal(failed.code, 'storage-failure');
  assert.equal(metadata(paths, LIVE).headVersionId, migrated.versionId);
  assert.equal(fs.existsSync(versionFile(paths, LIVE, V4, 'script.txt')), false);
  const manifestAfter = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const manifestOriginal = JSON.parse(manifestBefore.toString('utf8'));
  assert.deepEqual(
    manifestAfter.assets.map((asset) => asset.assetId || asset.id),
    manifestOriginal.assets.map((asset) => asset.assetId || asset.id),
  );
  assert.equal(manifestAfter.assets.some((asset) => asset.imageSource === 'current-shared-file'), false);
  const stale = await service.restoreSavedVersion({
    productionId: LIVE,
    sourceVersionId: original.versionId,
    expectedVersionId: V3,
    newVersionId: V5,
    createdAt: '2026-11-16T15:00:00.000Z',
    confirmCurrentImages: true,
  });
  assert.equal(stale.code, 'conflict');
  assert.equal(metadata(paths, LIVE).headVersionId, migrated.versionId);
});

test('owned historical assets are verified and left in place', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const edited = await service.saveVersion({
    productionId: LIVE,
    expectedVersionId: migrated.versionId,
    newVersionId: V3,
    text: '# Scene\n[ADA]\nEDITED\n',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(edited.ok, true, edited.error);
  const spare = await service.uploadAsset({
    productionId: LIVE,
    assetId: ASSET,
    name: 'spare.png',
    body: PNG,
  });
  assert.equal(spare.ok, true, spare.error);
  const manifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const owned = manifest.assets.find((asset) => (asset.assetId || asset.id) !== ASSET);
  const assetName = owned.file || `${owned.assetId || owned.id}.${owned.ext || 'jpeg'}`;
  const assetPath = path.join(paths.libraryDir, 'productions', LIVE, 'assets', assetName);
  const assetHash = sha256(fs.readFileSync(assetPath));
  const source = versionBytes(paths, LIVE, migrated.versionId);
  const restored = await restore(service, LIVE, migrated.versionId, V3, V4);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.parentVersionId, V3);
  assert.equal(versionBytes(paths, LIVE, V4).equals(source), true);
  assert.equal(versionBytes(paths, LIVE, V4).toString('utf8').includes('library:'), true);
  assert.equal(sha256(fs.readFileSync(assetPath)), assetHash);
  assert.equal(fs.readFileSync(paths.scriptFile).equals(source), true);

  const missingHead = metadata(paths, LIVE).headVersionId;
  fs.writeFileSync(assetPath, Buffer.from('not-an-image'));
  const corrupt = await restore(service, LIVE, migrated.versionId, missingHead, V5);
  assert.equal(corrupt.code, 'corrupt-asset');
  assert.equal(metadata(paths, LIVE).headVersionId, missingHead);
  assert.equal(fs.existsSync(versionFile(paths, LIVE, V5, 'script.txt')), false);
  assert.equal(versionBytes(paths, LIVE, migrated.versionId).equals(source), true);
});

test('a missing owned asset, a foreign asset, and a blank speaker do not become the head', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const manifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const owned = manifest.assets[0];
  const assetName = owned.file || `${owned.assetId || owned.id}.${owned.ext || 'jpeg'}`;
  fs.rmSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', assetName));
  const missing = await restore(service, LIVE, migrated.versionId, migrated.versionId, V4);
  assert.equal(missing.code, 'missing-asset');
  assert.equal(metadata(paths, LIVE).headVersionId, migrated.versionId);

  const foreignText = `# Scene\n@image: library:${OTHER}/${FOREIGN}\n[ADA]\nFOREIGN\n`;
  const foreignHash = sha256(Buffer.from(foreignText));
  fs.mkdirSync(path.dirname(versionFile(paths, LIVE, V2, 'script.txt')), { recursive: true });
  fs.writeFileSync(versionFile(paths, LIVE, V2, 'script.txt'), foreignText);
  writeJson(versionFile(paths, LIVE, V2, 'version.json'), {
    id: V2,
    productionId: LIVE,
    contentHash: foreignHash,
    parentVersionId: migrated.versionId,
    origin: 'edited',
    role: 'edited',
    legacyImagePolicy: 'production-assets',
    assetIds: [FOREIGN],
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  const meta = metadata(paths, LIVE);
  meta.versions.push({
    id: V2,
    role: 'edited',
    origin: 'edited',
    parentVersionId: migrated.versionId,
    contentHash: foreignHash,
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  writeJson(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), meta);
  const foreign = await restore(service, LIVE, V2, migrated.versionId, V4);
  assert.equal(foreign.code, 'foreign-asset');
  assert.equal(metadata(paths, LIVE).headVersionId, migrated.versionId);

  const blank = '# Scene\n[ ]\nBLANK\n';
  const blankHash = sha256(Buffer.from(blank));
  fs.mkdirSync(path.dirname(versionFile(paths, LIVE, V3, 'script.txt')), { recursive: true });
  fs.writeFileSync(versionFile(paths, LIVE, V3, 'script.txt'), blank);
  writeJson(versionFile(paths, LIVE, V3, 'version.json'), {
    id: V3,
    productionId: LIVE,
    contentHash: blankHash,
    parentVersionId: migrated.versionId,
    origin: 'edited',
    role: 'edited',
    legacyImagePolicy: 'none',
    assetIds: [],
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  const withBlank = metadata(paths, LIVE);
  withBlank.versions.push({
    id: V3,
    role: 'edited',
    origin: 'edited',
    parentVersionId: migrated.versionId,
    contentHash: blankHash,
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  writeJson(path.join(paths.libraryDir, 'productions', LIVE, 'metadata.json'), withBlank);
  const invalid = await restore(service, LIVE, V3, migrated.versionId, V5);
  assert.equal(invalid.code, 'invalid-script');
  assert.equal(fs.existsSync(versionFile(paths, LIVE, V5, 'script.txt')), false);
});

test('orphans, corrupt versions, and another production cannot be restored', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const head = metadata(paths, LIVE).headVersionId;
  const orphanText = '# Scene\n[ADA]\nORPHAN\n';
  const orphanDir = path.dirname(versionFile(paths, LIVE, V2, 'script.txt'));
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(versionFile(paths, LIVE, V2, 'script.txt'), orphanText);
  writeJson(versionFile(paths, LIVE, V2, 'version.json'), {
    id: V2,
    productionId: LIVE,
    contentHash: sha256(Buffer.from(orphanText)),
    parentVersionId: head,
    origin: 'edited',
    role: 'edited',
    legacyImagePolicy: 'none',
    assetIds: [],
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  const orphan = await restore(service, LIVE, V2, head, V4);
  assert.equal(orphan.code, 'orphan-version');
  assert.equal(metadata(paths, LIVE).headVersionId, head);
  const missing = await restore(service, LIVE, '99999999-9999-4999-8999-999999999999', head, V4);
  assert.equal(missing.code, 'missing-version');
  const otherHead = metadata(paths, OTHER).headVersionId;
  const foreign = await restore(service, LIVE, otherHead, head, V4);
  assert.equal(foreign.code, 'missing-version');
  const reused = await restore(service, LIVE, head, head, head);
  assert.equal(reused.code, 'invalid-id');

  const listed = await service.listProductionVersions(OTHER);
  const sourceId = listed.versions[0].versionId;
  fs.writeFileSync(versionFile(paths, OTHER, sourceId, 'version.json'), '{');
  const corrupt = await restore(service, OTHER, sourceId, sourceId, V4);
  assert.equal(corrupt.code, 'corrupt-version');
  const parked = `${path.dirname(versionFile(paths, OTHER, sourceId, 'script.txt'))}-parked`;
  fs.rmSync(path.dirname(versionFile(paths, OTHER, sourceId, 'script.txt')), { recursive: true, force: true });
  fs.mkdirSync(parked);
  fs.symlinkSync(parked, path.dirname(versionFile(paths, OTHER, sourceId, 'script.txt')));
  const linked = await restore(service, OTHER, sourceId, sourceId, V4);
  assert.equal(linked.code, 'unsafe-path');
  assert.equal(metadata(paths, OTHER).headVersionId, sourceId);
});

test('restore routes keep the staff token and a queued restore sees the new head', async (t) => {
  const paths = commitImageFixture(t);
  const { service, base } = await listenApp(t, paths);
  const listed = await service.listProductionVersions(OTHER);
  const source = listed.versions[0];
  const edited = await service.saveVersion({
    productionId: OTHER,
    expectedVersionId: source.versionId,
    newVersionId: V2,
    text: '# Other\n[BLUE]\nEDITED\n',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(edited.ok, true, edited.error);
  const missing = await fetch(`${base}/api/library/${OTHER}/versions/${source.versionId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersionId: V2 }),
  });
  assert.equal(missing.status, 401);
  const role = await fetch(`${base}/api/library/${OTHER}/versions/${source.versionId}/restore?role=controller`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Version-Id': V4 },
    body: JSON.stringify({ expectedVersionId: V2 }),
  });
  assert.equal(role.status, 401);
  const first = service.restoreSavedVersion({
    productionId: OTHER,
    sourceVersionId: source.versionId,
    expectedVersionId: V2,
    newVersionId: V4,
    createdAt: '2026-11-16T15:00:00.000Z',
  });
  const second = service.restoreSavedVersion({
    productionId: OTHER,
    sourceVersionId: source.versionId,
    expectedVersionId: V2,
    newVersionId: V5,
    createdAt: '2026-11-16T15:00:00.000Z',
  });
  const [winner, loser] = await Promise.all([first, second]);
  assert.equal(winner.ok, true, winner.error);
  assert.equal(winner.unchanged, false);
  assert.equal(winner.savedHeadVersionId, V4);
  assert.equal(winner.parentVersionId, V2);
  assert.equal(loser.code, 'conflict');
  assert.equal(loser.currentVersionId, V4);
  assert.equal(fs.existsSync(versionFile(paths, OTHER, V5, 'script.txt')), false);
  const accepted = await fetch(`${base}/api/library/${OTHER}/versions/${source.versionId}/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': TOKEN,
      'X-Version-Id': '88888888-8888-4888-8888-888888888888',
    },
    body: JSON.stringify({ expectedVersionId: V4 }),
  });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.unchanged, true);
  assert.equal(body.sourceVersionId, source.versionId);
  assert.equal(metadata(paths, OTHER).headVersionId, V4);
});

test('a restore on the running server does not move the cue or send a script update', async (t) => {
  const paths = commitImageFixture(t);
  const server = await createPrompterServer({
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
    staffToken: TOKEN,
    versionedFixture: authorizeVersionedFixture(paths),
  });
  const listed = await server.service.listProductionVersions(LIVE);
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  const edited = await server.service.saveVersion({
    productionId: LIVE,
    expectedVersionId: migrated.versionId,
    newVersionId: V3,
    text: '# Scene\n[ADA]\nEDITED\n',
    createdAt: '2026-10-02T00:00:00.000Z',
  });
  assert.equal(edited.ok, true, edited.error);
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => socket.once('open', resolve));
  for (let attempt = 0; attempt < 50 && !messages.some((message) => message.type === 'script'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const lineCount = server.getSlides()[0].lines.length;
  const target = lineCount - 1;
  assert.ok(target > 0);
  socket.send(JSON.stringify({ type: 'goto', lineIndex: target }));
  for (let attempt = 0; attempt < 50 && server.getState().lineIndex !== target; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(server.getState().lineIndex, target);
  const scripts = messages.filter((message) => message.type === 'script').length;
  const mirror = sha256(fs.readFileSync(paths.scriptFile));
  const liveFile = sha256(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')));
  const response = await fetch(`http://127.0.0.1:${port}/api/library/${LIVE}/versions/${migrated.versionId}/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Staff-Token': TOKEN,
      'X-Version-Id': V4,
    },
    body: JSON.stringify({ expectedVersionId: V3 }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.sourceVersionId, migrated.versionId);
  assert.equal(body.parentVersionId, V3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === 'script').length, scripts);
  assert.equal(server.getState().lineIndex, target);
  assert.equal(sha256(fs.readFileSync(paths.scriptFile)), mirror);
  assert.equal(sha256(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'))), liveFile);
  socket.close();
});

test('a legacy server has no restore route and the repository stays unchanged', async (t) => {
  const root = makeRoot(t);
  const scriptFile = path.join(root, 'script.txt');
  fs.writeFileSync(scriptFile, '# Legacy\n[ADA]\nLINE\n');
  const server = createPrompterServer({
    scriptFile,
    previousFile: path.join(root, 'script.previous.txt'),
    libraryDir: path.join(root, 'data', 'library'),
    journalDir: path.join(root, 'data', 'live-journal'),
  });
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}/api/library/${LIVE}/versions/${V1}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersionId: V1 }),
  });
  assert.equal(response.status, 404);
  Object.keys(REAL_FILES).forEach((relative) => {
    assert.equal(sha256(fs.readFileSync(path.join(REPO, relative))), REAL_FILES[relative], relative);
  });
  assertCheckoutSeedIntact(REPO);
});
