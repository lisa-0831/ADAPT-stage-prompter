const test = require('node:test');
const assert = require('node:assert/strict');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
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
const CREATED_V1 = '33333333-3333-4333-8333-333333333334';
const EDITED = '44444444-4444-4444-8444-444444444444';
const LATER = '55555555-5555-4555-8555-555555555555';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-history-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function liveText() {
  return '# Scene\r\n@image: images/Title_Card.jpeg\r\n[ADA]\r\nHéllo\r\n';
}

function otherText() {
  return '# Other\n[BLUE]\nOTHER\n';
}

function commitImageFixture(t) {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'data', 'library');
  const text = liveText();
  const saved = otherText();
  fs.mkdirSync(path.join(libraryDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'Title_Card.jpeg'), jpegBytes());
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${LIVE}.txt`), text);
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${OTHER}.txt`), saved);
  fs.writeFileSync(path.join(root, 'script.txt'), text);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), {
    liveId: null,
    textHash: 'ab'.repeat(32),
  });
  writeJson(path.join(libraryDir, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [
      {
        id: LIVE,
        title: 'Live Show',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: sha256(Buffer.from(text)),
      },
      {
        id: OTHER,
        title: 'Saved Show',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: sha256(Buffer.from(saved)),
      },
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
    now: () => '2026-06-06T00:00:10.000Z',
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return { service, base: `http://127.0.0.1:${server.address().port}` };
}

async function send(base, routePath, headers) {
  const response = await fetch(`${base}${routePath}`, { headers });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body };
}

function metadata(paths, productionId) {
  return JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', productionId, 'metadata.json',
  ), 'utf8'));
}

function versionScript(paths, productionId, versionId) {
  return fs.readFileSync(path.join(
    paths.libraryDir, 'productions', productionId, 'versions', versionId, 'script.txt',
  ));
}

test('migrated history keeps original and migrated versions distinct from the saved head and live version', async (t) => {
  const paths = commitImageFixture(t);
  const { service, base } = await listenApp(t, paths);
  const head = metadata(paths, LIVE);
  const listed = await service.listProductionVersions(LIVE);
  assert.equal(listed.ok, true, listed.code);
  assert.equal(listed.order, 'createdAt,versionId');
  assert.equal(listed.savedHeadVersionId, head.headVersionId);
  assert.equal(listed.versions.length, 2);
  const original = listed.versions.find((version) => version.origin === 'original');
  const migrated = listed.versions.find((version) => version.origin === 'migrated');
  assert.ok(original);
  assert.ok(migrated);
  assert.equal(original.parentVersionId, null);
  assert.equal(migrated.parentVersionId, original.versionId);
  assert.equal(original.savedHead, false);
  assert.equal(migrated.savedHead, true);
  assert.equal(migrated.live, true);
  assert.equal(original.live, false);
  assert.equal(original.previousLive, false);
  assert.equal(migrated.previousLive, false);
  assert.equal(original.createdAt, null);
  assert.equal(migrated.createdAt, null);
  assert.equal(Object.prototype.hasOwnProperty.call(original, 'description'), false);
  assert.equal(original.legacyImagePolicy, 'shared-images');
  assert.equal(original.imageBytesImmutable, false);
  assert.equal(migrated.imageBytesImmutable, true);
  assert.deepEqual(
    listed.versions.map((version) => version.versionId),
    [original, migrated].map((version) => version.versionId).sort(),
  );

  const detail = await service.readProductionVersion({
    productionId: LIVE,
    versionId: original.versionId,
  });
  assert.equal(detail.ok, true, detail.code);
  assert.equal(detail.version.text, liveText());
  assert.equal(detail.version.contentHash, sha256(Buffer.from(detail.version.text)));
  assert.equal(detail.version.savedHead, false);
  assert.equal(detail.version.live, false);
  assert.equal(detail.images.replay, 'not-guaranteed');
  assert.deepEqual(detail.images.sharedImages, [{
    reference: 'images/Title_Card.jpeg',
    shared: true,
    immutable: false,
  }]);
  assert.equal(detail.savedHeadVersionId, migrated.versionId);
  assert.equal(JSON.stringify(detail).includes(paths.root), false);

  const migratedDetail = await send(
    base,
    `/api/library/${LIVE}/versions/${migrated.versionId}`,
    { 'X-Staff-Token': TOKEN },
  );
  assert.equal(migratedDetail.status, 200);
  assert.equal(migratedDetail.body.version.versionId, migrated.versionId);
  assert.equal(migratedDetail.body.version.text.includes('library:'), true);
  assert.equal(migratedDetail.body.images.imageBytesImmutable, true);
  assert.equal(migratedDetail.body.images.replay, 'stored-bytes');
});

test('a newer saved head stays distinct from the live version and previous activation', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const before = await service.listProductionVersions(LIVE);
  const liveVersion = before.versions.find((version) => version.live);
  const saved = await service.saveVersion({
    productionId: LIVE,
    expectedVersionId: before.savedHeadVersionId,
    newVersionId: EDITED,
    text: '# Scene\n[ADA]\nEDITED\n',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(saved.ok, true, saved.code);
  const otherHead = metadata(paths, OTHER).headVersionId;
  const live = await service.readLiveShow();
  const switched = await service.setLiveVersion({
    productionId: OTHER,
    versionId: otherHead,
    expectedGeneration: live.generation,
    expectedVersionId: live.versionId,
    expectedContentHash: live.contentHash,
  });
  assert.equal(switched.ok, true, switched.code);
  const listed = await service.listProductionVersions(LIVE);
  const edited = listed.versions.find((version) => version.versionId === EDITED);
  const stillLive = listed.versions.find((version) => version.versionId === liveVersion.versionId);
  assert.equal(edited.savedHead, true);
  assert.equal(edited.live, false);
  assert.equal(edited.origin, 'edited');
  assert.equal(edited.createdAt, '2026-07-01T00:00:00.000Z');
  assert.equal(stillLive.savedHead, false);
  assert.equal(stillLive.live, false);
  assert.equal(stillLive.previousLive, true);
  assert.equal(listed.versions[0].versionId, EDITED);
  assert.equal(versionScript(paths, LIVE, liveVersion.versionId).equals(versionScript(paths, LIVE, liveVersion.versionId)), true);
});

test('a created production lists only its own committed versions', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const created = await service.createProduction({
    productionId: CREATED,
    versionId: CREATED_V1,
    title: 'Created Room',
    text: '# Created\n[ADA]\nCREATED\n',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(created.ok, true, created.code);
  const second = await service.saveVersion({
    productionId: CREATED,
    expectedVersionId: CREATED_V1,
    newVersionId: LATER,
    text: '# Created\n[ADA]\nLATER\n',
    createdAt: '2026-08-01T00:00:01.000Z',
  });
  assert.equal(second.ok, true, second.code);
  const file = path.join(paths.libraryDir, 'productions', CREATED, 'metadata.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.versions.reverse();
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  const listed = await service.listProductionVersions(CREATED);
  assert.deepEqual(listed.versions.map((version) => version.versionId), [CREATED_V1, LATER]);
  assert.equal(listed.versions.filter((version) => version.savedHead).length, 1);
  assert.equal(listed.versions.every((version) => version.live === false), true);
  const detail = await service.readProductionVersion({ productionId: CREATED, versionId: CREATED_V1 });
  assert.equal(detail.version.text, '# Created\n[ADA]\nCREATED\n');
  assert.equal(detail.version.origin, 'original');
  assert.equal(detail.version.role, 'v1');
});

test('corrupt, orphan, foreign, and symlink versions stay out of committed history', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const listed = await service.listProductionVersions(LIVE);
  const original = listed.versions.find((version) => version.origin === 'original');
  const versionDir = path.join(paths.libraryDir, 'productions', LIVE, 'versions', original.versionId);
  const scriptFile = path.join(versionDir, 'script.txt');
  const originalBytes = fs.readFileSync(scriptFile);
  const flipped = Buffer.from(originalBytes);
  flipped[0] = flipped[0] === 35 ? 36 : 35;
  fs.writeFileSync(scriptFile, flipped);
  const mismatched = await service.readProductionVersion({ productionId: LIVE, versionId: original.versionId });
  assert.equal(mismatched.code, 'corrupt-version');
  const afterMismatch = await service.listProductionVersions(LIVE);
  assert.equal(afterMismatch.versions.some((version) => version.versionId === original.versionId), false);
  assert.equal(afterMismatch.diagnostics.some((item) => item.versionId === original.versionId), true);
  fs.writeFileSync(scriptFile, originalBytes);

  fs.writeFileSync(path.join(versionDir, 'version.json'), '{');
  const corrupt = await service.readProductionVersion({ productionId: LIVE, versionId: original.versionId });
  assert.equal(corrupt.code, 'corrupt-version');
  const parked = `${versionDir}-parked`;
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(parked);
  fs.symlinkSync(parked, versionDir);
  const linked = await service.readProductionVersion({ productionId: LIVE, versionId: original.versionId });
  assert.equal(linked.code, 'unsafe-path');
  fs.unlinkSync(versionDir);
  fs.renameSync(parked, versionDir);
  fs.writeFileSync(scriptFile, originalBytes);

  const partial = path.join(paths.libraryDir, 'productions', LIVE, 'versions', EDITED);
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, 'script.txt'), '# Scene\n[ADA]\nPARTIAL\n');
  const completeId = LATER;
  const completeDir = path.join(paths.libraryDir, 'productions', LIVE, 'versions', completeId);
  fs.mkdirSync(completeDir);
  const completeText = '# Scene\n[ADA]\nORPHAN\n';
  fs.writeFileSync(path.join(completeDir, 'script.txt'), completeText);
  writeJson(path.join(completeDir, 'version.json'), {
    id: completeId,
    productionId: LIVE,
    contentHash: sha256(Buffer.from(completeText)),
    parentVersionId: original.versionId,
    origin: 'edited',
    role: 'edited',
    legacyImagePolicy: 'none',
    assetIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  const history = await service.listProductionVersions(LIVE);
  assert.equal(history.versions.some((version) => version.versionId === EDITED || version.versionId === completeId), false);
  assert.deepEqual(
    history.orphans.filter((orphan) => orphan.versionId === EDITED || orphan.versionId === completeId),
    [
      { versionId: EDITED, complete: false, committed: false },
      { versionId: completeId, complete: true, committed: false },
    ],
  );
  const orphan = await service.readProductionVersion({ productionId: LIVE, versionId: completeId });
  assert.equal(orphan.code, 'orphan-version');
  assert.equal(orphan.complete, true);
  assert.equal(Object.prototype.hasOwnProperty.call(orphan, 'text'), false);
  assert.equal(fs.existsSync(completeDir), true);
  const missing = await service.readProductionVersion({
    productionId: LIVE,
    versionId: '99999999-9999-4999-8999-999999999999',
  });
  assert.equal(missing.code, 'missing-version');
  const otherHead = metadata(paths, OTHER).headVersionId;
  const foreign = await service.readProductionVersion({ productionId: LIVE, versionId: otherHead });
  assert.equal(foreign.code, 'missing-version');
  assert.equal(metadata(paths, LIVE).headVersionId, history.savedHeadVersionId);
});

test('history routes require the staff token and do not publish historical bytes', async (t) => {
  const paths = commitImageFixture(t);
  const { base } = await listenApp(t, paths);
  const missing = await send(base, `/api/library/${LIVE}/versions`);
  assert.equal(missing.status, 401);
  const role = await send(base, `/api/library/${LIVE}/versions?role=controller`);
  assert.equal(role.status, 401);
  const accepted = await send(base, `/api/library/${LIVE}/versions`, { 'X-Staff-Token': TOKEN });
  assert.equal(accepted.status, 200);
  const migrated = accepted.body.versions.find((version) => version.origin === 'migrated');
  const manifest = JSON.parse(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'assets', 'manifest.json',
  ), 'utf8'));
  const owned = manifest.assets[0];
  const assetName = owned.file || `${owned.assetId || owned.id}.${owned.ext || 'jpeg'}`;
  fs.writeFileSync(path.join(paths.libraryDir, 'productions', LIVE, 'assets', assetName), Buffer.from('not-an-image'));
  const detail = await send(
    base,
    `/api/library/${LIVE}/versions/${migrated.versionId}`,
    { 'X-Staff-Token': TOKEN },
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.images.imageBytesImmutable, false);
  assert.equal(detail.body.images.replay, 'not-guaranteed');
  assert.equal(detail.body.images.ownedImages.some((image) => image.available === false), true);
  const before = fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'versions', migrated.versionId, 'script.txt',
  ));
  assert.equal(fs.readFileSync(path.join(
    paths.libraryDir, 'productions', LIVE, 'versions', migrated.versionId, 'script.txt',
  )).equals(before), true);
  const uploaded = await fetch(`${base}/api/library/${OTHER}/assets`, {
    method: 'POST',
    headers: {
      'X-Staff-Token': TOKEN,
      'Content-Type': 'image/png',
      'X-Asset-Id': ASSET,
      'X-Asset-Name': 'spare.png',
    },
    body: PNG,
  });
  assert.equal(uploaded.status, 201);
  const otherHead = metadata(paths, OTHER).headVersionId;
  const spare = await send(
    base,
    `/api/library/${OTHER}/versions/${otherHead}`,
    { 'X-Staff-Token': TOKEN },
  );
  assert.equal(spare.status, 200);
  assert.deepEqual(spare.body.images.unassignedAssets, [{ assetId: ASSET, referenced: false }]);
  const hidden = await send(base, `/api/live/assets/${OTHER}/${ASSET}`);
  assert.equal(hidden.status, 404);
  const staffPreview = await send(base, `/api/library/${OTHER}/assets/${ASSET}`, { 'X-Staff-Token': TOKEN });
  assert.equal(staffPreview.status, 200);
  const raw = await send(base, `/data/library/productions/${LIVE}/versions`);
  assert.equal(raw.status, 404);
});

test('a history read does not change the head, live state, mirror, or connected cue', async (t) => {
  const paths = commitImageFixture(t);
  const server = await createPrompterServer({
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
    staffToken: TOKEN,
    versionedFixture: authorizeVersionedFixture(paths),
  });
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of server.wss.clients) client.terminate();
    await server.close();
  });
  const port = server.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => socket.once('open', resolve));
  for (let attempt = 0; attempt < 50 && !messages.some((message) => message.type === 'script'); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const beforeMessages = messages.filter((message) => message.type === 'script').length;
  assert.equal(beforeMessages, 1);
  const mirror = sha256(fs.readFileSync(paths.scriptFile));
  const liveFile = sha256(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json')));
  const head = metadata(paths, LIVE).headVersionId;
  const headBytes = sha256(versionScript(paths, LIVE, head));
  const cue = server.getState().lineIndex;
  const response = await fetch(`http://127.0.0.1:${port}/api/library/${LIVE}/versions/${head}`, {
    headers: { 'X-Staff-Token': TOKEN },
  });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === 'script').length, beforeMessages);
  assert.equal(server.getState().lineIndex, cue);
  assert.equal(sha256(fs.readFileSync(paths.scriptFile)), mirror);
  assert.equal(sha256(fs.readFileSync(path.join(paths.libraryDir, 'live-state.json'))), liveFile);
  assert.equal(metadata(paths, LIVE).headVersionId, head);
  assert.equal(sha256(versionScript(paths, LIVE, head)), headBytes);
  socket.close();
});

test('a history list queued ahead of a save does not observe that save', async (t) => {
  const paths = commitImageFixture(t);
  const service = openService(paths);
  t.after(() => service.close());
  const before = await service.listProductionVersions(LIVE);
  const listed = service.listProductionVersions(LIVE);
  const saved = service.saveVersion({
    productionId: LIVE,
    expectedVersionId: before.savedHeadVersionId,
    newVersionId: EDITED,
    text: '# Scene\n[ADA]\nQUEUED\n',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  const [first, wrote] = await Promise.all([listed, saved]);
  assert.equal(wrote.ok, true, wrote.code);
  assert.equal(first.savedHeadVersionId, before.savedHeadVersionId);
  assert.equal(first.versions.some((version) => version.versionId === EDITED), false);
  assert.equal(first.versions.filter((version) => version.savedHead).length, 1);
  const after = await service.listProductionVersions(LIVE);
  assert.equal(after.savedHeadVersionId, EDITED);
  assert.equal(after.versions.filter((version) => version.savedHead).map((version) => version.versionId).join(','), EDITED);
  after.versions.forEach((version) => {
    assert.equal(sha256(versionScript(paths, LIVE, version.versionId)), version.contentHash);
  });
});

test('a legacy server has no version history route and the repository stays unchanged', async (t) => {
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
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}/api/library/${LIVE}/versions`);
  assert.equal(response.status, 404);
  Object.keys(REAL_FILES).forEach((relative) => {
    assert.equal(sha256(fs.readFileSync(path.join(REPO, relative))), REAL_FILES[relative], relative);
  });
  assertCheckoutSeedIntact(REPO);
});
