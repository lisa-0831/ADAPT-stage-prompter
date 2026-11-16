const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVersionStore } = require('../library-version-store');
const { createProductionManager } = require('../library-versioned-production-management');
const { createPrompterServer } = require('../server');
const { StorageModeError, detectStorageMode } = require('../server/storage-mode');
const {
  UPLOAD_STAGES,
  DELETE_STAGES,
  AssetError,
  createVersionedAssetManager,
} = require('../library-versioned-assets');

const REPO = path.resolve(__dirname, '..');
const PROD = '11111111-1111-4111-8111-111111111111';
const PROD_B = '22222222-2222-4222-8222-222222222222';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const VERSION_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const VERSION_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const ORPHAN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9';
const BROKEN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee8';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SPARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const EXTRA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const REQUEST_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const NOW = '2026-06-06T00:00:00.000Z';
const CREATED = '2026-06-06T01:00:00.000Z';
const UPLOADED = '2026-06-06T02:00:00.000Z';
const TITLE = '  欢迎 — “Café”  ';
const SCRIPT = '# Created Show\nHello there\nPRIVATE-CUE\n';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);
const WEBP = Buffer.alloc(12);
WEBP.write('RIFF', 0);
WEBP.writeUInt32LE(4, 4);
WEBP.write('WEBP', 8);
const REAL_FILES = {
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

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(file) {
  return hashBuffer(fs.readFileSync(file));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  fs.writeFileSync(scriptFile, 'LIVE-MIRROR\n');
  const manager = createProductionManager({ root, libraryDir, now: () => NOW });
  const assets = createVersionedAssetManager({
    root,
    libraryDir,
    scriptFile,
    now: () => UPLOADED,
  });
  return { root, libraryDir, scriptFile, manager, assets };
}

function request(overrides) {
  return Object.assign({
    productionId: PROD,
    versionId: VERSION,
    title: TITLE,
    text: SCRIPT,
    createdAt: CREATED,
  }, overrides || {});
}

function productionDir(fixture, productionId) {
  return path.join(fixture.libraryDir, 'productions', productionId || PROD);
}

function versionPath(fixture, versionId, name, productionId) {
  return path.join(productionDir(fixture, productionId), 'versions', versionId, name);
}

function assetPath(fixture, assetId, ext, productionId) {
  return path.join(productionDir(fixture, productionId), 'assets', `${assetId}.${ext}`);
}

function manifestPath(fixture, productionId) {
  return path.join(productionDir(fixture, productionId), 'assets', 'manifest.json');
}

function readManifest(fixture, productionId) {
  return JSON.parse(fs.readFileSync(manifestPath(fixture, productionId), 'utf8'));
}

function versionMeta(fixture, versionId, productionId) {
  return JSON.parse(fs.readFileSync(versionPath(fixture, versionId, 'version.json', productionId), 'utf8'));
}

function metadata(fixture, productionId) {
  return JSON.parse(fs.readFileSync(path.join(productionDir(fixture, productionId), 'metadata.json'), 'utf8'));
}

function imageLine(productionId, assetId) {
  return `# Created Show\n@image: library:${productionId}/${assetId}\nAssigned\n`;
}

function upload(assets, overrides) {
  return assets.uploadAsset(Object.assign({
    productionId: PROD,
    assetId: ASSET,
    name: '../Title_Card.jpeg',
    body: JPEG,
  }, overrides || {}));
}

function visible(result) {
  const copy = JSON.parse(JSON.stringify(result, (key, value) => (key === 'bytes' ? undefined : value)));
  return JSON.stringify(copy);
}

function marker(productionId, versionId, contentHash) {
  return {
    schema: 2,
    state: 'committed',
    migrationId: MIGRATION,
    productionId,
    versionId,
    sourceScriptHash: contentHash,
    contentHash,
    mirrorInstalled: true,
    previousActivation: null,
  };
}

function liveDocument(productionId, versionId, contentHash, previousActivation) {
  return {
    schema: 1,
    productionId,
    versionId,
    contentHash,
    previousActivation: previousActivation || null,
    updatedAt: NOW,
    generation: 2,
  };
}

function installLive(fixture, productionId, versionId, previousActivation) {
  const contentHash = versionMeta(fixture, versionId, productionId).contentHash;
  const text = fs.readFileSync(versionPath(fixture, versionId, 'script.txt', productionId));
  writeJson(path.join(fixture.libraryDir, 'migration.json'), marker(productionId, versionId, contentHash));
  writeJson(
    path.join(fixture.libraryDir, 'live-state.json'),
    liveDocument(productionId, versionId, contentHash, previousActivation),
  );
  fs.writeFileSync(fixture.scriptFile, text);
  return { contentHash, text };
}

function versionHashes(fixture, productionId) {
  const dir = path.join(productionDir(fixture, productionId), 'versions');
  const hashes = {};
  fs.readdirSync(dir).filter((name) => !name.startsWith('.')).forEach((versionId) => {
    const script = path.join(dir, versionId, 'script.txt');
    const meta = path.join(dir, versionId, 'version.json');
    if (fs.existsSync(script)) hashes[`${versionId}/script.txt`] = hashFile(script);
    if (fs.existsSync(meta)) hashes[`${versionId}/version.json`] = hashFile(meta);
  });
  return hashes;
}

test('uploads immutable images without assigning them or changing live state', async (t) => {
  const fixture = makeFixture(t);
  const created = await fixture.manager.createProduction(request());
  assert.equal(created.ok, true, created.error);
  const other = await fixture.manager.createProduction(request({
    productionId: PROD_B,
    versionId: VERSION_B,
    title: 'Second',
    text: '# Second Show\nHello\n',
  }));
  assert.equal(other.ok, true, other.error);
  const hash = versionMeta(fixture, VERSION).contentHash;
  installLive(fixture, PROD, VERSION);
  const before = {
    live: fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')),
    marker: fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')),
    mirror: fs.readFileSync(fixture.scriptFile),
    script: fs.readFileSync(versionPath(fixture, VERSION, 'script.txt')),
    head: metadata(fixture).headVersionId,
  };
  assert.equal(hash, hashBuffer(before.script));

  const jpeg = await upload(fixture.assets, { requestId: REQUEST });
  assert.equal(jpeg.ok, true, jpeg.error);
  assert.equal(jpeg.unchanged, false);
  assert.equal(jpeg.confirmed, true);
  assert.equal(jpeg.asset.assetId, ASSET);
  assert.equal(jpeg.asset.name, 'Title_Card.jpeg');
  assert.equal(jpeg.asset.ext, 'jpg');
  assert.equal(jpeg.asset.mime, 'image/jpeg');
  assert.equal(jpeg.asset.byteLength, JPEG.length);
  assert.equal(jpeg.asset.contentHash, hashBuffer(JPEG));
  assert.equal(jpeg.asset.createdAt, UPLOADED);
  assert.equal(jpeg.asset.referenced, false);
  assert.equal(jpeg.asset.unassigned, true);
  assert.equal(jpeg.asset.file, `${ASSET}.jpg`);
  assert.equal(fs.readFileSync(assetPath(fixture, ASSET, 'jpg')).equals(JPEG), true);
  assert.equal(hashFile(assetPath(fixture, ASSET, 'jpg')), jpeg.asset.contentHash);
  assert.equal(visible(jpeg).includes(fixture.root), false);
  assert.equal(visible(jpeg).includes('PRIVATE-CUE'), false);

  const png = await upload(fixture.assets, {
    assetId: SPARE,
    name: 'Title_Card.jpeg',
    body: PNG,
    requestId: REQUEST_B,
  });
  assert.equal(png.ok, true, png.error);
  assert.equal(png.asset.file, `${SPARE}.png`);
  assert.equal(png.asset.name, 'Title_Card.jpeg');
  assert.equal(hashFile(assetPath(fixture, SPARE, 'png')), hashBuffer(PNG));
  assert.equal(fs.readFileSync(assetPath(fixture, ASSET, 'jpg')).equals(JPEG), true);

  const webp = await upload(fixture.assets, {
    productionId: PROD_B,
    assetId: EXTRA,
    name: 'Title_Card.jpeg',
    body: WEBP,
  });
  assert.equal(webp.ok, true, webp.error);
  assert.equal(webp.asset.ext, 'webp');
  assert.equal(webp.asset.mime, 'image/webp');
  assert.equal(hashFile(assetPath(fixture, EXTRA, 'webp', PROD_B)), hashBuffer(WEBP));
  assert.notEqual(path.dirname(assetPath(fixture, EXTRA, 'webp', PROD_B)), path.dirname(assetPath(fixture, ASSET, 'jpg')));

  const listed = await fixture.assets.listAssets(PROD);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.assets.length, 2);
  assert.deepEqual(listed.assets.map((asset) => asset.assetId).sort(), [ASSET, SPARE].sort());
  listed.assets.forEach((asset) => {
    assert.equal(asset.name, 'Title_Card.jpeg');
    assert.equal(asset.unassigned, true);
    assert.equal(asset.referenced, false);
    assert.equal(asset.file.includes('/'), false);
  });
  const otherListed = await fixture.assets.listAssets(PROD_B);
  assert.equal(otherListed.assets.length, 1);
  assert.equal(otherListed.assets[0].assetId, EXTRA);
  assert.equal(otherListed.assets[0].contentHash, hashBuffer(WEBP));

  const read = await fixture.assets.readAsset(PROD, ASSET);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.mime, 'image/jpeg');
  assert.equal(read.byteLength, JPEG.length);
  assert.equal(read.contentHash, hashBuffer(JPEG));
  assert.equal(read.bytes.equals(JPEG), true);
  assert.equal(Object.prototype.hasOwnProperty.call(read, 'filePath'), false);
  assert.equal(visible(read).includes(fixture.root), false);

  const foreign = await fixture.assets.readAsset(PROD_B, ASSET);
  assert.equal(foreign.code, 'missing-asset');
  const missing = await fixture.assets.readAsset(PROD, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4');
  assert.equal(missing.code, 'missing-asset');
  const absent = await fixture.assets.readAsset('33333333-3333-4333-8333-333333333333', ASSET);
  assert.equal(absent.code, 'missing-production');

  const ready = await fixture.assets.assessProduction(PROD);
  assert.equal(ready.activationReady, true);
  assert.equal(ready.imageStatus, 'ready');
  assert.equal(ready.unassignedAssets.length, 2);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION, 'script.txt')).equals(before.script), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(before.live), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(before.marker), true);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(before.mirror), true);
  assert.equal(metadata(fixture).headVersionId, before.head);
  assert.equal(versionMeta(fixture, VERSION).contentHash, hash);

  const invalid = await upload(fixture.assets, { assetId: EXTRA, body: Buffer.alloc(16, 1) });
  const incomplete = await upload(fixture.assets, {
    assetId: EXTRA,
    body: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(20, 1)]),
  });
  const oversized = await createVersionedAssetManager({
    root: fixture.root,
    libraryDir: fixture.libraryDir,
    maxImageBytes: 20,
    now: () => UPLOADED,
  }).uploadAsset({ productionId: PROD, assetId: EXTRA, name: 'Big.jpg', body: JPEG });
  assert.equal(invalid.code, 'invalid-image');
  assert.equal(incomplete.code, 'incomplete-image');
  assert.equal(oversized.code, 'too-large');
  assert.equal(fs.existsSync(assetPath(fixture, EXTRA, 'jpg')), false);
  assert.equal(readManifest(fixture).assets.some((entry) => entry.assetId === EXTRA), false);
});

test('retries the same upload identity and keeps a second filename as a new asset', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  const first = await upload(fixture.assets, { name: 'Title_Card.jpeg', requestId: REQUEST });
  assert.equal(first.ok, true, first.error);
  const again = await upload(fixture.assets, { name: 'Replacement.jpeg', body: JPEG, requestId: REQUEST });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.unchanged, true);
  assert.equal(again.asset.name, 'Title_Card.jpeg');
  assert.equal(again.asset.contentHash, hashBuffer(JPEG));
  assert.equal(readManifest(fixture).assets.length, 1);
  const conflict = await upload(fixture.assets, { body: PNG, name: 'Title_Card.jpeg' });
  assert.equal(conflict.code, 'conflict');
  assert.equal(fs.readFileSync(assetPath(fixture, ASSET, 'jpg')).equals(JPEG), true);
  const reused = await upload(fixture.assets, { assetId: SPARE, requestId: REQUEST, body: PNG });
  assert.equal(reused.code, 'conflict');
  assert.equal(fs.existsSync(assetPath(fixture, SPARE, 'png')), false);
  const namedAgain = await upload(fixture.assets, {
    assetId: SPARE,
    name: 'Title_Card.jpeg',
    body: PNG,
    requestId: REQUEST_B,
  });
  assert.equal(namedAgain.ok, true, namedAgain.error);
  assert.equal(readManifest(fixture).assets.length, 2);
  assert.equal(fs.readFileSync(assetPath(fixture, ASSET, 'jpg')).equals(JPEG), true);
  assert.equal(fs.readFileSync(assetPath(fixture, SPARE, 'png')).equals(PNG), true);
});

test('recovers an upload that fails around the manifest commit', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  const manifestBefore = fs.readFileSync(manifestPath(fixture));
  await assert.rejects(
    () => upload(fixture.assets, { failAt: 'file-written' }),
    (err) => err instanceof AssetError && err.stage === 'file-written',
  );
  assert.equal(fs.readFileSync(manifestPath(fixture)).equals(manifestBefore), true);
  assert.equal(readManifest(fixture).assets.length, 0);
  const completed = await upload(fixture.assets);
  assert.equal(completed.ok, true, completed.error);
  assert.equal(completed.unchanged, false);
  assert.equal(hashFile(assetPath(fixture, ASSET, 'jpg')), hashBuffer(JPEG));
  assert.equal(readManifest(fixture).assets.length, 1);

  const orphanId = SPARE;
  const orphanFile = assetPath(fixture, orphanId, 'png');
  fs.writeFileSync(orphanFile, PNG);
  const ignored = await fixture.assets.listAssets(PROD);
  assert.equal(ignored.assets.some((asset) => asset.assetId === orphanId), false);
  const adopted = await upload(fixture.assets, { assetId: orphanId, body: PNG, name: 'Kept.png' });
  assert.equal(adopted.ok, true, adopted.error);
  assert.equal(readManifest(fixture).assets.some((entry) => entry.assetId === orphanId), true);
  assert.equal(hashFile(orphanFile), hashBuffer(PNG));
  const blocked = assetPath(fixture, EXTRA, 'png');
  fs.writeFileSync(blocked, JPEG);
  const refused = await upload(fixture.assets, { assetId: EXTRA, body: PNG, name: 'Card.png' });
  assert.equal(refused.code, 'conflict');
  assert.equal(fs.readFileSync(blocked).equals(JPEG), true);
  assert.equal(readManifest(fixture).assets.some((entry) => entry.assetId === EXTRA), false);
  fs.unlinkSync(blocked);

  await assert.rejects(
    () => upload(fixture.assets, { assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', body: WEBP, failAt: 'before-manifest' }),
    (err) => err instanceof AssetError && err.stage === 'before-manifest',
  );
  assert.equal(readManifest(fixture).assets.some((entry) => entry.assetId === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'), false);

  const recovered = await upload(fixture.assets, { assetId: EXTRA, body: WEBP, failAt: 'after-manifest' });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.confirmed, true);
  assert.equal(hashFile(assetPath(fixture, EXTRA, 'webp')), hashBuffer(WEBP));
  const retry = await upload(fixture.assets, { assetId: EXTRA, body: WEBP, name: 'Other.webp' });
  assert.equal(retry.unchanged, true);
  assert.equal(readManifest(fixture).assets.filter((entry) => entry.assetId === EXTRA).length, 1);
});

test('rejects symlink and corrupted asset bytes', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  assert.equal((await upload(fixture.assets, { body: PNG, name: 'Card.png' })).ok, true);
  const stored = assetPath(fixture, ASSET, 'png');
  const outside = path.join(fixture.root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.rmSync(stored);
  fs.symlinkSync(outside, stored);
  const linked = await fixture.assets.readAsset(PROD, ASSET);
  assert.equal(linked.code, 'unsafe-path');
  assert.equal(fs.readFileSync(outside).equals(PNG), true);
  const linkedDelete = await fixture.assets.deleteAsset({ productionId: PROD, assetId: ASSET });
  assert.equal(linkedDelete.ok, false);
  assert.equal(fs.lstatSync(stored).isSymbolicLink(), true);
  fs.rmSync(stored);
  fs.writeFileSync(stored, PNG);

  const manifest = readManifest(fixture);
  manifest.assets[0].contentHash = 'ab'.repeat(32);
  writeJson(manifestPath(fixture), manifest);
  const wrong = await fixture.assets.readAsset(PROD, ASSET);
  assert.equal(wrong.code, 'corrupt-asset');
  manifest.assets[0].contentHash = hashBuffer(PNG);
  writeJson(manifestPath(fixture), manifest);
  fs.writeFileSync(stored, JPEG);
  const changed = await fixture.assets.readAsset(PROD, ASSET);
  assert.equal(changed.code, 'corrupt-asset');
  const removed = await fixture.assets.deleteAsset({ productionId: PROD, assetId: ASSET });
  assert.equal(removed.code, 'corrupt-asset');
  assert.equal(fs.existsSync(stored), true);
  assert.equal(readManifest(fixture).assets.length, 1);
});

test('refuses deletion while any retained version or activation needs the asset', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  const store = createVersionStore({ root: fixture.libraryDir });
  assert.equal((await upload(fixture.assets, { body: PNG, name: 'Card.png' })).ok, true);
  const saved = await store.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_B,
    text: imageLine(PROD, ASSET),
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await upload(fixture.assets, { assetId: SPARE, body: JPEG, name: 'Scene.jpeg' })).ok, true);
  const newer = await store.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION_B,
    newVersionId: VERSION_C,
    text: imageLine(PROD, SPARE),
    createdAt: CREATED,
  });
  assert.equal(newer.ok, true, newer.error);
  assert.equal((await upload(fixture.assets, { assetId: EXTRA, body: WEBP, name: 'Spare.webp' })).ok, true);
  const originalScript = hashFile(versionPath(fixture, VERSION, 'script.txt'));
  const olderScript = hashFile(versionPath(fixture, VERSION_B, 'script.txt'));
  const headScript = hashFile(versionPath(fixture, VERSION_C, 'script.txt'));
  const previous = {
    productionId: PROD,
    versionId: VERSION_B,
    contentHash: versionMeta(fixture, VERSION_B).contentHash,
  };
  installLive(fixture, PROD, VERSION_C, previous);
  const liveBefore = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const mirrorBefore = fs.readFileSync(fixture.scriptFile);
  const markerBefore = fs.readFileSync(path.join(fixture.libraryDir, 'migration.json'));

  const listed = await fixture.assets.listAssets(PROD);
  const byId = Object.fromEntries(listed.assets.map((asset) => [asset.assetId, asset]));
  assert.equal(byId[ASSET].referenced, true);
  assert.equal(byId[SPARE].referenced, true);
  assert.equal(byId[EXTRA].referenced, false);
  assert.equal(byId[EXTRA].unassigned, true);
  assert.equal(readManifest(fixture).assets.every((entry) => entry.referenced === false), true);

  const headDelete = await fixture.assets.deleteAsset({ productionId: PROD, assetId: SPARE });
  assert.equal(headDelete.code, 'in-use');
  assert.equal(headDelete.versions.includes(VERSION_C), true);
  const olderDelete = await fixture.assets.deleteAsset({ productionId: PROD, assetId: ASSET });
  assert.equal(olderDelete.code, 'in-use');
  assert.equal(olderDelete.versions.includes(VERSION_B), true);
  assert.equal(fs.readFileSync(assetPath(fixture, ASSET, 'png')).equals(PNG), true);
  assert.equal(fs.readFileSync(assetPath(fixture, SPARE, 'jpg')).equals(JPEG), true);

  const liveFile = path.join(fixture.libraryDir, 'live-state.json');
  const brokenLive = JSON.parse(liveBefore.toString('utf8'));
  brokenLive.previousActivation.contentHash = 'cd'.repeat(32);
  writeJson(liveFile, brokenLive);
  const uncertain = await fixture.assets.deleteAsset({ productionId: PROD, assetId: EXTRA });
  assert.equal(uncertain.code, 'incomplete-inventory');
  assert.equal(fs.existsSync(assetPath(fixture, EXTRA, 'webp')), true);
  fs.writeFileSync(liveFile, liveBefore);

  const orphanDir = path.join(productionDir(fixture), 'versions', ORPHAN);
  fs.mkdirSync(orphanDir);
  const orphanText = imageLine(PROD, EXTRA);
  fs.writeFileSync(path.join(orphanDir, 'script.txt'), orphanText);
  const orphanMeta = versionMeta(fixture, VERSION);
  orphanMeta.id = ORPHAN;
  orphanMeta.parentVersionId = VERSION;
  orphanMeta.origin = 'edited';
  orphanMeta.role = 'edited';
  orphanMeta.assetIds = [EXTRA];
  orphanMeta.contentHash = hashBuffer(Buffer.from(orphanText));
  writeJson(path.join(orphanDir, 'version.json'), orphanMeta);
  assert.equal(metadata(fixture).versions.some((entry) => entry.id === ORPHAN), false);
  const orphanDelete = await fixture.assets.deleteAsset({ productionId: PROD, assetId: EXTRA });
  assert.equal(orphanDelete.code, 'in-use');
  assert.equal(orphanDelete.versions.includes(ORPHAN), true);
  fs.rmSync(orphanDir, { recursive: true });

  fs.mkdirSync(path.join(productionDir(fixture), 'versions', BROKEN));
  fs.writeFileSync(path.join(productionDir(fixture), 'versions', BROKEN, 'script.txt'), 'partial');
  const blocked = await fixture.assets.deleteAsset({ productionId: PROD, assetId: EXTRA });
  assert.equal(blocked.code, 'incomplete-inventory');
  assert.equal(hashFile(assetPath(fixture, EXTRA, 'webp')), hashBuffer(WEBP));
  fs.rmSync(path.join(productionDir(fixture), 'versions', BROKEN), { recursive: true });
  fs.writeFileSync(path.join(productionDir(fixture), 'versions', '.scratch.tmp'), 'ignore');

  const hashes = versionHashes(fixture, PROD);
  const removed = await fixture.assets.deleteAsset({ productionId: PROD, assetId: EXTRA, failAt: 'after-manifest' });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.deleted, true);
  assert.equal(removed.recovered, true);
  assert.equal(fs.existsSync(assetPath(fixture, EXTRA, 'webp')), false);
  assert.equal(readManifest(fixture).assets.some((entry) => entry.assetId === EXTRA), false);
  assert.equal(hashFile(versionPath(fixture, VERSION, 'script.txt')), originalScript);
  assert.equal(hashFile(versionPath(fixture, VERSION_B, 'script.txt')), olderScript);
  assert.equal(hashFile(versionPath(fixture, VERSION_C, 'script.txt')), headScript);
  assert.deepEqual(versionHashes(fixture, PROD), hashes);
  assert.equal(metadata(fixture).headVersionId, VERSION_C);
  assert.equal(fs.readFileSync(liveFile).equals(liveBefore), true);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(mirrorBefore), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(markerBefore), true);
  assert.equal(fs.existsSync(assetPath(fixture, ASSET, 'png')), true);
  assert.equal(fs.existsSync(assetPath(fixture, SPARE, 'jpg')), true);
});

test('keeps a dangling historical reference unresolved until a new version names an uploaded asset', async (t) => {
  const fixture = makeFixture(t);
  const dangling = `# Created Show\n@image: library:${PROD}/${ASSET}\nUnresolved\n`;
  const created = await fixture.manager.createProduction(request({ text: dangling }));
  assert.equal(created.ok, true, created.error);
  assert.equal(created.activationReady, false);
  assert.equal(created.imageStatus, 'unresolved-library-images');
  const original = fs.readFileSync(versionPath(fixture, VERSION, 'script.txt'));
  const originalHash = hashBuffer(original);
  const uploaded = await upload(fixture.assets, { assetId: SPARE, body: PNG, name: 'Title_Card.jpeg' });
  assert.equal(uploaded.ok, true, uploaded.error);
  assert.equal(uploaded.asset.unassigned, true);
  const filled = await upload(fixture.assets, { assetId: ASSET, body: PNG, name: 'Title_Card.jpeg' });
  assert.equal(filled.code, 'dangling-reference');
  assert.equal(fs.existsSync(assetPath(fixture, ASSET, 'png')), false);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION, 'script.txt')).equals(original), true);
  const still = await fixture.assets.assessProduction(PROD);
  assert.equal(still.activationReady, false);
  assert.equal(still.imageStatus, 'unresolved-library-images');
  assert.equal(still.unresolvedAssets[0].assetId, ASSET);
  assert.equal(still.unassignedAssets[0].assetId, SPARE);

  installLive(fixture, PROD, VERSION);
  const hidden = await fixture.assets.readLiveAsset(PROD, SPARE);
  assert.equal(hidden.ok, false);
  const missingLive = await fixture.assets.readLiveAsset(PROD, ASSET);
  assert.equal(missingLive.ok, false);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION, 'script.txt')).equals(original), true);

  const store = createVersionStore({ root: fixture.libraryDir });
  const saved = await store.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_B,
    text: imageLine(PROD, SPARE),
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.version.assetIds.includes(SPARE), true);
  assert.equal(hashFile(versionPath(fixture, VERSION, 'script.txt')), originalHash);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION, 'script.txt'), 'utf8').includes(`library:${PROD}/${ASSET}`), true);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION_B, 'script.txt'), 'utf8').includes(`library:${PROD}/${SPARE}`), true);
  const ready = await fixture.assets.assessProduction(PROD);
  assert.equal(ready.activationReady, true);
  assert.equal(ready.imageStatus, 'ready');
  assert.equal(ready.versionId, VERSION_B);

  const legacy = await fixture.manager.createProduction(request({
    productionId: PROD_B,
    versionId: VERSION_C,
    title: 'Legacy',
    text: '# Legacy Show\n@image: images/Title_Card.jpeg\n',
  }));
  assert.equal(legacy.ok, true, legacy.error);
  fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'images', 'Title_Card.jpeg'), JPEG);
  const shared = await fixture.assets.assessProduction(PROD_B);
  assert.equal(shared.activationReady, false);
  assert.equal(shared.imageStatus, 'unresolved-shared-images');
  assert.equal((await upload(fixture.assets, {
    productionId: PROD_B,
    assetId: EXTRA,
    body: JPEG,
    name: 'Title_Card.jpeg',
  })).ok, true);
  const sharedAfter = await fixture.assets.assessProduction(PROD_B);
  assert.equal(sharedAfter.activationReady, false);
  assert.equal(sharedAfter.unassignedAssets[0].assetId, EXTRA);

  installLive(fixture, PROD, VERSION_B);
  const live = await fixture.assets.readLiveAsset(PROD, SPARE);
  assert.equal(live.ok, true, live.error);
  assert.equal(live.mime, 'image/png');
  assert.equal(live.contentHash, hashBuffer(PNG));
  assert.equal(live.bytes.equals(PNG), true);
  assert.equal(visible(live).includes(fixture.root), false);
  const unreferenced = await fixture.assets.readLiveAsset(PROD, EXTRA);
  assert.equal(unreferenced.code, 'not-live');
  const otherProduction = await fixture.assets.readLiveAsset(PROD_B, EXTRA);
  assert.equal(otherProduction.code, 'not-live');
  const noScript = createVersionedAssetManager({
    root: fixture.root,
    libraryDir: fixture.libraryDir,
    now: () => UPLOADED,
  });
  assert.equal((await noScript.readLiveAsset(PROD, SPARE)).code, 'script-required');
});

test('reads an M6 asset manifest without requiring newer fields', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  assert.equal((await upload(fixture.assets, { body: PNG, name: 'Title_Card.jpeg' })).ok, true);
  writeJson(manifestPath(fixture), {
    productionId: PROD,
    assets: [{
      assetId: ASSET,
      file: `${ASSET}.png`,
      originalName: 'Title_Card.jpeg',
      legacyPath: 'images/Title_Card.jpeg',
      contentHash: hashBuffer(PNG),
      ext: 'png',
      mime: 'image/png',
      byteLength: PNG.length,
      referenced: false,
    }, {
      id: SPARE,
      file: `${SPARE}.jpg`,
      name: 'Scene.jpeg',
      sha256: hashBuffer(JPEG),
      ext: 'jpg',
      byteLength: JPEG.length,
    }],
  });
  fs.writeFileSync(assetPath(fixture, SPARE, 'jpg'), JPEG);
  const listed = await fixture.assets.listAssets(PROD);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.assets.length, 2);
  const first = listed.assets.find((asset) => asset.assetId === ASSET);
  const second = listed.assets.find((asset) => asset.assetId === SPARE);
  assert.equal(first.name, 'Title_Card.jpeg');
  assert.equal(first.createdAt, null);
  assert.equal(first.contentHash, hashBuffer(PNG));
  assert.equal(first.unassigned, true);
  assert.equal(second.name, 'Scene.jpeg');
  assert.equal(second.contentHash, hashBuffer(JPEG));
  const read = await fixture.assets.readAsset(PROD, SPARE);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.bytes.equals(JPEG), true);
  assert.equal(read.mime, 'image/jpeg');
});

test('serializes uploads and deletions in one manager', async (t) => {
  const fixture = makeFixture(t);
  assert.equal((await fixture.manager.createProduction(request())).ok, true);
  const [sameA, sameB] = await Promise.all([
    upload(fixture.assets, { name: 'First.jpeg', body: JPEG }),
    upload(fixture.assets, { name: 'Second.jpeg', body: JPEG }),
  ]);
  assert.equal(sameA.ok && sameB.ok, true);
  assert.equal([sameA.unchanged, sameB.unchanged].filter(Boolean).length, 1);
  assert.equal(readManifest(fixture).assets.length, 1);
  assert.equal(hashFile(assetPath(fixture, ASSET, 'jpg')), hashBuffer(JPEG));

  const [kept, rejected] = await Promise.all([
    upload(fixture.assets, { assetId: SPARE, body: PNG, name: 'A.png' }),
    upload(fixture.assets, { assetId: SPARE, body: JPEG, name: 'B.jpg' }),
  ]);
  const results = [kept, rejected];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'conflict').length, 1);
  const winner = results.find((result) => result.ok);
  assert.equal(hashFile(assetPath(fixture, SPARE, winner.asset.ext)), winner.asset.contentHash);
  assert.equal(readManifest(fixture).assets.filter((entry) => entry.assetId === SPARE).length, 1);

  const [left, right] = await Promise.all([
    upload(fixture.assets, { assetId: EXTRA, body: WEBP, name: 'Left.webp' }),
    upload(fixture.assets, { assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', body: PNG, name: 'Right.png' }),
  ]);
  assert.equal(left.ok, true, left.error);
  assert.equal(right.ok, true, right.error);
  assert.equal(readManifest(fixture).assets.length, 4);
});

test('rejects unsafe roots and leaves the repository storage unchanged', async () => {
  const relative = createVersionedAssetManager({ root: 'tmp', libraryDir: path.join(REPO, 'data', 'library') });
  assert.equal(relative.ok, false);
  assert.equal((await relative.uploadAsset({ productionId: PROD, body: PNG })).code, 'root-required');
  const repository = createVersionedAssetManager({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
  });
  assert.equal(repository.ok, false);
  assert.equal((await repository.listAssets(PROD)).code, 'unsafe-root');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-assets-root-'));
  try {
    const outside = createVersionedAssetManager({
      root: temp,
      libraryDir: path.join(REPO, 'data', 'library'),
    });
    assert.equal(outside.ok, false);
    assert.equal((await outside.readAsset(PROD, ASSET)).code, 'unsafe-path');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  assert.deepEqual(UPLOAD_STAGES.includes('before-manifest'), true);
  assert.deepEqual(DELETE_STAGES.includes('after-manifest'), true);
});

test('the running server stays in legacy mode and real project files stay unchanged', async (t) => {
  assert.equal(detectStorageMode({ libraryDir: path.join(REPO, 'data', 'library') }).mode, 'legacy');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-assets-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyDir = path.join(root, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const created = createPrompterServer({
    scriptFile: path.join(legacyDir, 'script.txt'),
    libraryDir: path.join(legacyDir, 'library'),
    journalDir: path.join(legacyDir, 'journal'),
    staffToken: 'test-token',
  });
  assert.equal(created.server.listening, false);
  created.wss.close();
  created.server.close();

  const versionedDir = path.join(root, 'versioned');
  fs.mkdirSync(versionedDir, { recursive: true });
  writeJson(path.join(versionedDir, 'migration.json'), marker(PROD, VERSION, 'ab'.repeat(32)));
  assert.throws(
    () => createPrompterServer({
      scriptFile: path.join(root, 'script.txt'),
      libraryDir: versionedDir,
      journalDir: path.join(root, 'journal'),
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );
  assert.equal(fs.existsSync(path.join(root, 'script.txt')), false);

  Object.keys(REAL_FILES).forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), REAL_FILES[file], file);
  });
  ['data/library/migration.json', 'data/library/live-state.json', 'data/library/productions', 'data/live-journal'].forEach((file) => {
    assert.equal(fs.existsSync(path.join(REPO, file)), false, file);
  });
});
