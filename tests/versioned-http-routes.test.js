const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { createVersionedLibraryService } = require('../server/versioned-library-service');
const { registerVersionedHttpRoutes } = require('../server/versioned-http-routes');

const REPO_ROOT = path.resolve(__dirname, '..');
const NOW = '2026-06-06T00:00:00.000Z';
const TOKEN = 'stage-staff';
const TITLE = '  欢迎 — “Café”  ';
const TEXT = '# Created Show\nHello\n';
const TEXT_B = '# Created Show\nHello again\n';
const TEXT_C = '# Created Show\nHello finally\n';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tinyJpeg() {
  const bytes = Buffer.alloc(22);
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  bytes[2] = 0xFF;
  bytes[3] = 0xE0;
  bytes[20] = 0xFF;
  bytes[21] = 0xD9;
  return bytes;
}

function tinyWebp() {
  const bytes = Buffer.alloc(12);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(4, 4);
  bytes.write('WEBP', 8);
  return bytes;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-versioned-http-')));
  const repo = fs.realpathSync(REPO_ROOT);
  const tmp = fs.realpathSync(os.tmpdir());
  assert.equal(root === tmp, false);
  assert.equal(root.startsWith(`${tmp}${path.sep}`), true);
  assert.equal(root.startsWith(`${repo}${path.sep}`), false);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function productionDir(fixture, productionId) {
  return path.join(fixture.libraryDir, 'productions', productionId);
}

function metadataOf(fixture, productionId) {
  return JSON.parse(fs.readFileSync(path.join(productionDir(fixture, productionId), 'metadata.json'), 'utf8'));
}

function versionFile(fixture, productionId, versionId, name) {
  return path.join(productionDir(fixture, productionId), 'versions', versionId, name);
}

function installLive(fixture, productionId, versionId, generation, previousActivation) {
  const version = JSON.parse(fs.readFileSync(versionFile(fixture, productionId, versionId, 'version.json'), 'utf8'));
  const text = fs.readFileSync(versionFile(fixture, productionId, versionId, 'script.txt'));
  writeJson(path.join(fixture.libraryDir, 'migration.json'), {
    schema: 2,
    state: 'committed',
    migrationId: MIGRATION,
    productionId,
    versionId,
    sourceScriptHash: version.contentHash,
    contentHash: version.contentHash,
    mirrorInstalled: true,
    previousActivation: null,
  });
  writeJson(path.join(fixture.libraryDir, 'live-state.json'), {
    schema: 1,
    productionId,
    versionId,
    contentHash: version.contentHash,
    previousActivation: previousActivation || null,
    updatedAt: NOW,
    generation: generation || 1,
  });
  fs.writeFileSync(fixture.scriptFile, text);
  return version.contentHash;
}

async function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function start(t, options) {
  const settings = options || {};
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'journal');
  const scriptFile = path.join(root, 'script.txt');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(scriptFile, TEXT);
  const service = createVersionedLibraryService({
    root,
    libraryDir,
    scriptFile,
    journalDir,
    now: () => NOW,
    maxImageBytes: settings.maxImageBytes,
  });
  assert.equal(service.ok, true);
  const app = express();
  app.use(express.text({ type: 'text/plain', limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));
  registerVersionedHttpRoutes({
    app,
    service,
    staffToken: TOKEN,
    imageMaxBytes: settings.maxImageBytes,
    now: () => NOW,
    allowFaults: true,
  });
  const server = http.createServer(app);
  t.after(async () => {
    await service.close();
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });
  const port = await listen(server);
  return {
    root,
    libraryDir,
    journalDir,
    scriptFile,
    service,
    base: `http://127.0.0.1:${port}`,
    headers: { 'X-Staff-Token': TOKEN },
  };
}

async function send(fixture, method, routePath, options) {
  const settings = options || {};
  const headers = Object.assign({}, settings.staff === false ? {} : fixture.headers, settings.headers || {});
  const response = await fetch(`${fixture.base}${routePath}`, {
    method,
    headers,
    body: settings.body,
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: payload, type };
}

function liveState(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
}

test('listing uses versioned metadata and verified live state', async (t) => {
  const fixture = await start(t);
  const created = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE, text: TEXT, trackIfCurrent: false }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.activated, false);
  assert.equal(created.body.script.live, false);
  assert.equal(created.body.script.title, TITLE);
  const productionId = created.body.script.id;
  const versionId = created.body.script.versionId;
  const other = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Second', text: TEXT_B }),
  });
  assert.equal(other.status, 201);
  installLive(fixture, productionId, versionId, 1);
  const decoy = '55555555-5555-4555-8555-555555555555';
  const indexPath = path.join(fixture.libraryDir, 'index.json');
  writeJson(indexPath, { version: 1, liveId: decoy, scripts: [] });
  const indexBytes = fs.readFileSync(indexPath);
  fs.mkdirSync(path.join(fixture.libraryDir, 'productions', '.creating-secret'));
  fs.writeFileSync(path.join(fixture.libraryDir, 'productions', '.creating-secret', 'metadata.json'), '{"title":"SECRET"}');
  fs.mkdirSync(path.join(fixture.libraryDir, 'productions', 'migration-work'));
  const corruptId = '44444444-4444-4444-8444-444444444444';
  fs.mkdirSync(path.join(fixture.libraryDir, 'productions', corruptId));
  fs.writeFileSync(path.join(fixture.libraryDir, 'productions', corruptId, 'metadata.json'), '{');
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'metadata.json'), JSON.stringify({ title: 'SECRET-LINK' }));
  const linkId = '66666666-6666-4666-8666-666666666666';
  fs.symlinkSync(outside, path.join(fixture.libraryDir, 'productions', linkId));

  const listed = await send(fixture, 'GET', '/api/library');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.liveId, productionId);
  assert.equal(listed.body.order, 'production-id');
  assert.deepEqual(listed.body.scripts.map((entry) => entry.id), [productionId, other.body.script.id].sort());
  const live = listed.body.scripts.find((entry) => entry.id === productionId);
  assert.equal(live.title, TITLE);
  assert.equal(live.revision, created.body.script.revision);
  assert.equal(live.versionId, versionId);
  assert.equal(live.live, true);
  assert.equal(live.generation, 1);
  assert.equal(listed.body.scripts.some((entry) => entry.title === 'SECRET' || entry.title === 'SECRET-LINK'), false);
  assert.equal(listed.body.invalid.some((entry) => entry.name === corruptId && entry.code === 'corrupt-metadata'), true);
  assert.equal(listed.body.invalid.some((entry) => entry.name === linkId && entry.code === 'unsafe-path'), true);
  assert.equal(JSON.stringify(listed.body).includes('SECRET-LINK'), false);
  assert.equal(fs.readFileSync(indexPath).equals(indexBytes), true);
  assert.equal(metadataOf(fixture, productionId).title, TITLE);
});

test('create, read, rename, and save keep the saved head distinct from live', async (t) => {
  const fixture = await start(t);
  const requestId = crypto.randomUUID();
  const created = await send(fixture, 'POST', '/api/library', {
    headers: {
      'Content-Type': 'application/json',
      'X-Creation-Request-Id': requestId,
    },
    body: JSON.stringify({ title: 'Original', text: TEXT, trackIfCurrent: false }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.activated, false);
  assert.equal(created.body.trackIfCurrent, 'not-requested');
  assert.equal(created.body.liveId, null);
  const productionId = created.body.script.id;
  const versionId = created.body.script.versionId;
  const repeated = await send(fixture, 'POST', '/api/library', {
    headers: {
      'Content-Type': 'application/json',
      'X-Creation-Request-Id': requestId,
    },
    body: JSON.stringify({ title: 'Original', text: TEXT }),
  });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.unchanged, true);
  assert.equal(repeated.body.script.id, productionId);
  assert.equal(fs.readdirSync(path.join(fixture.libraryDir, 'productions')).filter((name) => !name.startsWith('.')).length, 1);

  const saved = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: TEXT_B, expectedRevision: created.body.script.revision }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.script.revision, sha256(TEXT_B));
  assert.notEqual(saved.body.script.versionId, versionId);
  assert.equal(sha256(fs.readFileSync(versionFile(fixture, productionId, versionId, 'script.txt'))), sha256(TEXT));
  installLive(fixture, productionId, versionId, 1);
  const detail = await send(fixture, 'GET', `/api/library/${productionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.script.text, TEXT_B);
  assert.equal(detail.body.script.versionId, saved.body.script.versionId);
  const mirror = await send(fixture, 'GET', '/script', { staff: false });
  assert.equal(mirror.status, 200);
  assert.equal(mirror.body.toString('utf8'), TEXT);

  const renamed = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated', expectedRevision: saved.body.script.revision }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.script.title, 'Updated');
  assert.equal(renamed.body.script.revision, saved.body.script.revision);
  const staleGeneration = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Stale',
      expectedRevision: saved.body.script.revision,
      expectedGeneration: 1,
    }),
  });
  assert.equal(staleGeneration.status, 409);
  assert.equal(staleGeneration.body.code, 'conflict');
  assert.equal(staleGeneration.body.field, 'title');
  assert.equal(metadataOf(fixture, productionId).title, 'Updated');

  const staleVersion = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: TEXT_C,
      expectedRevision: saved.body.script.revision,
      expectedVersionId: versionId,
    }),
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.body.code, 'conflict');
  assert.equal(metadataOf(fixture, productionId).headVersionId, saved.body.script.versionId);

  const combined = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Combined',
      text: TEXT_C,
      expectedRevision: saved.body.script.revision,
    }),
  });
  assert.equal(combined.status, 200);
  assert.equal(combined.body.script.title, 'Combined');
  assert.equal(combined.body.script.revision, sha256(TEXT_C));
  assert.equal(metadataOf(fixture, productionId).title, 'Combined');
  assert.equal(metadataOf(fixture, productionId).headVersionId, combined.body.script.versionId);

  const partial = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Kept Title',
      text: '# Created Show\n@image: images/Title_Card.jpeg\nAssigned\n',
      expectedRevision: combined.body.script.revision,
    }),
  });
  assert.equal(partial.status, 409);
  assert.equal(partial.body.partial, true);
  assert.equal(partial.body.saved.title, true);
  assert.equal(partial.body.saved.text, false);
  assert.equal(partial.body.conflict.code, 'legacy-image');
  assert.equal(metadataOf(fixture, productionId).title, 'Kept Title');
  assert.equal(metadataOf(fixture, productionId).headVersionId, combined.body.script.versionId);
  const staleRevision = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '# Created Show\nNope\n', expectedRevision: sha256(TEXT) }),
  });
  assert.equal(staleRevision.status, 409);
  assert.equal(staleRevision.body.code, 'conflict');
  assert.equal(metadataOf(fixture, productionId).headVersionId, combined.body.script.versionId);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'index.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'scripts')), false);
});

test('asset upload, preview, deletion, and public live reads stay on the service', async (t) => {
  const fixture = await start(t);
  const created = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Images', text: TEXT }),
  });
  const productionId = created.body.script.id;
  const metadataBytes = fs.readFileSync(path.join(productionDir(fixture, productionId), 'metadata.json'));
  const failed = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Asset-Name': 'notes.txt' },
    body: Buffer.from('this is not an image'),
  });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.code, 'invalid-image');
  assert.equal(fs.readFileSync(path.join(productionDir(fixture, productionId), 'metadata.json')).equals(metadataBytes), true);

  const assetId = crypto.randomUUID();
  const png = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: {
      'Content-Type': 'image/png',
      'X-Asset-Name': encodeURIComponent('Card.png'),
      'X-Asset-Id': assetId,
    },
    body: TINY_PNG,
  });
  assert.equal(png.status, 201);
  assert.equal(png.body.asset.id, assetId);
  assert.equal(png.body.asset.name, 'Card.png');
  assert.equal(JSON.stringify(png.body).includes(fixture.root), false);
  const retry = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: { 'Content-Type': 'image/png', 'X-Asset-Id': assetId },
    body: TINY_PNG,
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.unchanged, true);
  const clash = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: { 'Content-Type': 'image/jpeg', 'X-Asset-Id': assetId },
    body: tinyJpeg(),
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'conflict');
  const jpeg = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: { 'Content-Type': 'image/jpeg', 'X-Asset-Name': 'Still.jpg' },
    body: tinyJpeg(),
  });
  const webp = await send(fixture, 'POST', `/api/library/${productionId}/assets`, {
    headers: { 'Content-Type': 'image/webp', 'X-Asset-Name': 'Mark.webp' },
    body: tinyWebp(),
  });
  assert.equal(jpeg.status, 201);
  assert.equal(webp.status, 201);
  const listed = await send(fixture, 'GET', `/api/library/${productionId}/assets`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.assets.map((asset) => asset.id).sort(), [assetId, jpeg.body.asset.id, webp.body.asset.id].sort());
  assert.equal(JSON.stringify(listed.body).includes(fixture.root), false);

  const denied = await send(fixture, 'GET', `/api/library/${productionId}/assets/${assetId}`, { staff: false });
  assert.equal(denied.status, 401);
  const preview = await send(fixture, 'GET', `/api/library/${productionId}/assets/${assetId}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.type.includes('image/png'), true);
  assert.equal(sha256(preview.body), sha256(TINY_PNG));

  const other = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Other', text: TEXT_B }),
  });
  const referenced = await send(fixture, 'PUT', `/api/library/${productionId}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `# Created Show\n@image: library:${productionId}/${assetId}\nAssigned\n`,
      expectedRevision: created.body.script.revision,
    }),
  });
  assert.equal(referenced.status, 200);
  installLive(fixture, productionId, referenced.body.script.versionId, 1);
  const liveImage = await send(fixture, 'GET', `/api/live/assets/${productionId}/${assetId}`, { staff: false });
  assert.equal(liveImage.status, 200);
  assert.equal(sha256(liveImage.body), sha256(TINY_PNG));
  const unreferenced = await send(fixture, 'GET', `/api/live/assets/${productionId}/${jpeg.body.asset.id}`, { staff: false });
  assert.equal(unreferenced.status, 404);
  const crossed = await send(fixture, 'GET', `/api/live/assets/${other.body.script.id}/${assetId}`, { staff: false });
  assert.equal(crossed.status, 404);
  const removed = await send(fixture, 'DELETE', `/api/library/${productionId}/assets/${assetId}`);
  assert.equal(removed.status, 409);
  assert.equal(removed.body.code, 'in-use');
  const stored = fs.readFileSync(path.join(productionDir(fixture, productionId), 'assets', `${assetId}.png`));
  assert.equal(sha256(stored), sha256(TINY_PNG));
  const spare = await send(fixture, 'DELETE', `/api/library/${productionId}/assets/${webp.body.asset.id}`);
  assert.equal(spare.status, 200);
  const gone = await send(fixture, 'GET', `/api/library/${productionId}/assets/${webp.body.asset.id}`);
  assert.equal(gone.status, 404);

  const small = await start(t, { maxImageBytes: 16 });
  const smallCreated = await send(small, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Small', text: TEXT }),
  });
  const oversized = await send(small, 'POST', `/api/library/${smallCreated.body.script.id}/assets`, {
    headers: { 'Content-Type': 'image/png' },
    body: TINY_PNG,
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'too-large');
});

test('set live, publish, and restore use live state and report partial activation', async (t) => {
  const fixture = await start(t);
  const first = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'First', text: TEXT }),
  });
  const second = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Second', text: TEXT_B }),
  });
  const legacy = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Legacy',
      text: '# Created Show\n@image: images/Title_Card.jpeg\nAssigned\n',
    }),
  });
  assert.equal(legacy.body.script.activationReady, false);
  assert.equal(legacy.body.script.imageStatus, 'unresolved-shared-images');
  const firstId = first.body.script.id;
  const secondId = second.body.script.id;
  installLive(fixture, firstId, first.body.script.versionId, 1);
  fs.mkdirSync(path.join(fixture.root, 'images'));
  fs.writeFileSync(path.join(fixture.root, 'images', 'Title_Card.jpeg'), tinyJpeg());
  const previousMissing = await send(fixture, 'GET', '/script/previous', { staff: false });
  assert.equal(previousMissing.status, 404);
  assert.equal(previousMissing.body.error, 'No previous script');
  const restoreMissing = await send(fixture, 'POST', '/script', {
    staff: false,
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: TEXT,
  });
  assert.equal(restoreMissing.status, 404);
  assert.equal(restoreMissing.body.code, 'no-previous-activation');
  assert.equal(liveState(fixture).versionId, first.body.script.versionId);

  const stale = await send(fixture, 'POST', `/api/library/${secondId}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: second.body.script.revision,
      expectedLiveGeneration: 99,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale-live');
  assert.equal(liveState(fixture).versionId, first.body.script.versionId);

  const blocked = await send(fixture, 'POST', `/api/library/${legacy.body.script.id}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: legacy.body.script.revision }),
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'activation-not-ready');
  assert.equal(blocked.body.sharedLegacyImages, true);
  assert.equal(liveState(fixture).productionId, firstId);

  const activated = await send(fixture, 'POST', `/api/library/${secondId}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: second.body.script.revision }),
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.liveId, secondId);
  assert.equal(activated.body.versionId, second.body.script.versionId);
  assert.equal(activated.body.resetPosition, true);
  assert.equal(activated.body.cue.action, 'reset');
  assert.equal(activated.body.synchronized, false);
  assert.equal(liveState(fixture).versionId, second.body.script.versionId);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), TEXT_B);

  const published = await send(fixture, 'POST', '/script', {
    staff: false,
    headers: {
      'Content-Type': 'text/plain',
      'X-Library-Id': secondId,
      'X-Library-Revision': second.body.script.revision,
      'X-Reset-Position': '1',
    },
    body: TEXT_C,
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.liveScriptId, secondId);
  assert.equal(published.body.revision, sha256(TEXT_C));
  assert.equal(published.body.libraryUpdated, true);
  assert.equal(published.body.resetPosition, true);
  assert.equal(published.body.synchronized, false);
  assert.equal(metadataOf(fixture, secondId).headVersionId, published.body.versionId);
  assert.equal(liveState(fixture).versionId, published.body.versionId);
  assert.equal(sha256(fs.readFileSync(versionFile(fixture, secondId, second.body.script.versionId, 'script.txt'))), sha256(TEXT_B));

  const previous = await send(fixture, 'GET', '/script/previous', { staff: false });
  assert.equal(previous.status, 200);
  assert.equal(previous.body.toString('utf8'), TEXT_B);
  const headBeforeRestore = metadataOf(fixture, secondId).headVersionId;
  const restored = await send(fixture, 'POST', '/script', {
    staff: false,
    headers: { 'Content-Type': 'text/plain', 'X-Restore-Previous': '1' },
    body: TEXT_B,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.libraryUpdated, false);
  assert.equal(restored.body.versionId, second.body.script.versionId);
  assert.equal(metadataOf(fixture, secondId).headVersionId, headBeforeRestore);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), TEXT_B);
  assert.equal(fs.existsSync(path.join(fixture.root, 'script.previous.txt')), false);

  const mirrorBefore = sha256(fs.readFileSync(fixture.scriptFile));
  const stopped = await send(fixture, 'POST', '/script', {
    staff: false,
    headers: { 'Content-Type': 'text/plain', 'X-Test-Fail-At': 'after-save' },
    body: '# Created Show\nSaved only\n',
  });
  assert.equal(stopped.status, 409);
  assert.equal(stopped.body.code, 'saved-not-live');
  assert.equal(stopped.body.saved, true);
  assert.equal(stopped.body.activated, false);
  assert.equal(stopped.body.rolledBack, false);
  assert.notEqual(metadataOf(fixture, secondId).headVersionId, headBeforeRestore);
  assert.equal(liveState(fixture).versionId, second.body.script.versionId);
  assert.equal(sha256(fs.readFileSync(fixture.scriptFile)), mirrorBefore);
  assert.equal(JSON.stringify(stopped.body).toLowerCase().includes('rolled back'), false);
});

test('a committed journal is recovered and a pending journal is not overwritten', async (t) => {
  const fixture = await start(t);
  const first = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'First', text: TEXT }),
  });
  const second = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Second', text: TEXT_B }),
  });
  installLive(fixture, first.body.script.id, first.body.script.versionId, 1);
  const crashed = await send(fixture, 'POST', `/api/library/${second.body.script.id}/live`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Fail-At': 'journal-committed',
    },
    body: JSON.stringify({ expectedRevision: second.body.script.revision }),
  });
  assert.equal(crashed.status, 503);
  assert.equal(crashed.body.code, 'storage-failure');
  const committed = path.join(fixture.journalDir, 'versioned-live', 'committed', 'plan.json');
  const planBytes = fs.readFileSync(committed);
  assert.equal(liveState(fixture).versionId, first.body.script.versionId);
  const retried = await send(fixture, 'POST', `/api/library/${second.body.script.id}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: second.body.script.revision }),
  });
  assert.equal(retried.status, 409);
  assert.equal(retried.body.code, 'stale-live');
  assert.equal(liveState(fixture).versionId, second.body.script.versionId);
  assert.equal(fs.existsSync(committed), false);

  const third = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Third', text: TEXT_C }),
  });
  const pendingCrash = await send(fixture, 'POST', `/api/library/${third.body.script.id}/live`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Fail-At': 'pending-written',
    },
    body: JSON.stringify({ expectedRevision: third.body.script.revision }),
  });
  assert.equal(pendingCrash.status, 503);
  const pendingPlan = path.join(fixture.journalDir, 'versioned-live', 'pending', 'plan.json');
  const pendingBytes = fs.readFileSync(pendingPlan);
  const conflicted = await send(fixture, 'POST', `/api/library/${first.body.script.id}/live`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: first.body.script.revision }),
  });
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.body.code, 'journal-conflict');
  assert.equal(fs.readFileSync(pendingPlan).equals(pendingBytes), true);
  assert.equal(liveState(fixture).versionId, second.body.script.versionId);
  assert.equal(planBytes.length > 0, true);
});

test('save current live script returns the existing production and does not activate', async (t) => {
  const fixture = await start(t);
  const missing = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stage copy', text: TEXT, trackIfCurrent: true }),
  });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, 'not-installed');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions')), false);

  const created = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Original', text: TEXT, trackIfCurrent: false }),
  });
  assert.equal(created.status, 201);
  installLive(fixture, created.body.script.id, created.body.script.versionId, 1);
  const liveBytes = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const tracked = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stage copy', text: TEXT, trackIfCurrent: true }),
  });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.tracked, true);
  assert.equal(tracked.body.activated, false);
  assert.equal(tracked.body.unchanged, true);
  assert.equal(tracked.body.script.id, created.body.script.id);
  assert.equal(fs.readdirSync(path.join(fixture.libraryDir, 'productions')).length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(liveBytes), true);

  const saved = await send(fixture, 'PUT', `/api/library/${created.body.script.id}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: TEXT_B, expectedRevision: created.body.script.revision }),
  });
  assert.equal(saved.status, 200);
  const drifted = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Stage copy', text: TEXT, trackIfCurrent: true }),
  });
  assert.equal(drifted.status, 409);
  assert.equal(drifted.body.code, 'saved-head-differs');
  assert.equal(fs.readdirSync(path.join(fixture.libraryDir, 'productions')).length, 1);
  assert.equal(liveState(fixture).versionId, created.body.script.versionId);
  assert.equal(metadataOf(fixture, created.body.script.id).headVersionId, saved.body.script.versionId);

  const mismatch = await send(fixture, 'POST', '/api/library', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Other', text: TEXT_C, trackIfCurrent: true }),
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'live-mismatch');
  assert.equal(fs.readdirSync(path.join(fixture.libraryDir, 'productions')).length, 1);
});

test('staff authorization, startup refusal, and repository bytes stay in place', async (t) => {
  const fixture = await start(t);
  const denied = await send(fixture, 'GET', '/api/library', { staff: false });
  assert.equal(denied.status, 401);
  const query = await send(fixture, 'POST', '/api/library?role=controller', {
    staff: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Nope', text: TEXT }),
  });
  assert.equal(query.status, 401);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'productions')), false);
  const access = await send(fixture, 'GET', '/api/library/access', { staff: false });
  assert.equal(access.status, 200);
  assert.equal(access.body.required, true);

  const adapter = fs.readFileSync(path.join(REPO_ROOT, 'server', 'versioned-http-routes.js'), 'utf8');
  assert.equal(adapter.includes('library-version-store'), false);
  assert.equal(adapter.includes('createProductionManager'), false);
  assert.equal(adapter.includes('createVersionedAssetManager'), false);
  assert.equal(adapter.includes('createVersionedLiveOperations'), false);
  assert.equal(adapter.includes('broadcast'), false);
  assert.equal(adapter.includes("require('ws')"), false);
  const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.equal(serverSource.includes('versioned-http-routes'), false);
  const routeSource = fs.readFileSync(path.join(REPO_ROOT, 'server', 'http-routes.js'), 'utf8');
  assert.equal(routeSource.includes('versioned-http-routes'), false);

  const legacyRoot = makeRoot(t);
  const legacyScript = path.join(legacyRoot, 'script.txt');
  const legacyLibrary = path.join(legacyRoot, 'data', 'library');
  const legacyJournal = path.join(legacyRoot, 'data', 'live-journal');
  fs.mkdirSync(legacyLibrary, { recursive: true });
  fs.writeFileSync(legacyScript, TEXT);
  const legacy = createPrompterServer({
    scriptFile: legacyScript,
    previousFile: path.join(legacyRoot, 'script.previous.txt'),
    libraryDir: legacyLibrary,
    journalDir: legacyJournal,
    staffToken: TOKEN,
  });
  assert.equal(legacy.server.listening, false);
  await new Promise((resolve) => legacy.wss.close(() => resolve()));
  await new Promise((resolve) => legacy.server.close(() => resolve()));
  writeJson(path.join(legacyLibrary, 'migration.json'), {
    schema: 2,
    state: 'committed',
    migrationId: MIGRATION,
    productionId: '11111111-1111-4111-8111-111111111111',
    versionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    sourceScriptHash: sha256(TEXT),
    contentHash: sha256(TEXT),
    mirrorInstalled: true,
    previousActivation: null,
  });
  assert.throws(
    () => createPrompterServer({
      scriptFile: legacyScript,
      previousFile: path.join(legacyRoot, 'script.previous.txt'),
      libraryDir: legacyLibrary,
      journalDir: legacyJournal,
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );

  const files = {
    'script.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
    'script.previous.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
    'script.previous.txt.meta.json': 'f3c9f57f43645b30dcaa81eb419ba80819b6927423622ac307d8ceb886024230',
    'data/library/index.json': 'ee9d8f81ff66b174d6806bc5a43250449aae8dc21b6799e0d9d95dcf633762f7',
    'data/library/scripts/2d0f0937-fc36-4d27-a31e-d047c2fd5623.txt': 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0',
    'data/library/scripts/ee04e849-90d4-4eeb-b2a6-562b06067a32.txt': '44f27efa4ff652dfe0be20d967cd385a149a8ee0f13e16b250caa5dc9d09ca47',
    'images/Title_Card.jpeg': 'da924c3aaf284c9e5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e',
    'images/Cap_Back2.jpeg': 'ecf446be1bdc76be16dea4c24ba5188fa42c360c626927d247175820818bec1b',
    'images/Cap_Back3.jpeg': '11a6309fd758a094d8e5b4c82af9001163d8253ab2b173b5cad907068a8a41f5',
    'images/Cap_Back4.jpeg': '6d786f25b3ee1e49f5cb8a40625f4c152e58e416645059eef5578a4b21419410',
  };
  Object.keys(files).forEach((relative) => {
    assert.equal(sha256(fs.readFileSync(path.join(REPO_ROOT, relative))), files[relative]);
  });
  ['data/library/migration.json', 'data/library/live-state.json', 'data/library/productions', 'data/live-journal'].forEach((relative) => {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, relative)), false);
  });
});
