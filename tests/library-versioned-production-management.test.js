const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVersionStore } = require('../library-version-store');
const {
  CREATE_STAGES,
  ProductionError,
  createProductionManager,
} = require('../library-versioned-production-management');

const REPO = path.resolve(__dirname, '..');
const PROD = '11111111-1111-4111-8111-111111111111';
const PROD_B = '22222222-2222-4222-8222-222222222222';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const VERSION_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const VERSION_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_V = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SPARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const REQUEST_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const NOW = '2026-06-06T00:00:00.000Z';
const CREATED = '2026-06-06T01:00:00.000Z';
const TITLE = '  欢迎 — “Café”  ';
const SCRIPT = '# Created Show\nHello there\n';
const LEGACY = '# Created Show\n@image: images/Title_Card.jpeg\nPRIVATE-IMPORT\n';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-prod-mgmt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  fs.writeFileSync(scriptFile, 'LIVE-MIRROR\n');
  fs.writeFileSync(path.join(libraryDir, 'live-state.json'), '{"schema":1,"productionId":"existing"}\n');
  fs.writeFileSync(path.join(libraryDir, 'migration.json'), '{"schema":2,"mirrorInstalled":true}\n');
  const manager = createProductionManager({
    root,
    libraryDir,
    now: () => NOW,
  });
  return { root, libraryDir, scriptFile, manager };
}

function request(overrides) {
  return Object.assign({
    productionId: PROD,
    versionId: VERSION,
    title: TITLE,
    text: SCRIPT,
    createdAt: CREATED,
    requestId: REQUEST,
  }, overrides || {});
}

function productionDir(fixture, productionId) {
  return path.join(fixture.libraryDir, 'productions', productionId || PROD);
}

function versionFile(fixture, name, versionId) {
  return path.join(productionDir(fixture), 'versions', versionId || VERSION, name);
}

function snapshot(fixture) {
  return {
    live: fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')),
    marker: fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')),
    mirror: fs.readFileSync(fixture.scriptFile),
  };
}

test('creates one immutable production and does not make it live', async (t) => {
  const fixture = makeFixture(t);
  const before = snapshot(fixture);
  const created = await fixture.manager.createProduction(request());
  assert.equal(created.ok, true, created.error);
  assert.equal(created.unchanged, false);
  assert.equal(created.confirmed, true);
  assert.equal(created.productionId, PROD);
  assert.equal(created.versionId, VERSION);
  assert.equal(created.activated, false);
  assert.equal(created.activationReady, true);
  assert.equal(created.imageStatus, 'ready');
  assert.equal(created.generation, 1);
  assert.equal(created.title, TITLE);
  const scriptBytes = fs.readFileSync(versionFile(fixture, 'script.txt'));
  const version = JSON.parse(fs.readFileSync(versionFile(fixture, 'version.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'metadata.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'assets', 'manifest.json'), 'utf8'));
  assert.equal(scriptBytes.toString('utf8'), SCRIPT);
  assert.equal(hashBuffer(scriptBytes), created.contentHash);
  assert.equal(version.contentHash, created.contentHash);
  assert.equal(version.origin, 'original');
  assert.equal(version.role, 'v1');
  assert.equal(version.parentVersionId, null);
  assert.equal(version.legacyImagePolicy, 'none');
  assert.equal(metadata.title, TITLE);
  assert.equal(metadata.headVersionId, VERSION);
  assert.equal(metadata.currentVersionId, VERSION);
  assert.equal(metadata.generation, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'isLive'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'liveId'), false);
  assert.equal(manifest.productionId, PROD);
  assert.deepEqual(manifest.assets, []);
  assert.deepEqual(snapshot(fixture), before);
  assert.equal(fs.existsSync(path.join(fixture.root, 'data', 'live-journal')), false);

  const again = await fixture.manager.createProduction(request());
  assert.equal(again.ok, true, again.error);
  assert.equal(again.unchanged, true);
  assert.equal(fs.readdirSync(path.join(productionDir(fixture), 'versions')).length, 1);
  const different = await fixture.manager.createProduction(request({ text: '# Created Show\nDifferent\n' }));
  assert.equal(different.code, 'conflict');
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt')).equals(scriptBytes), true);
  const otherRequest = await fixture.manager.createProduction(request({
    productionId: PROD_B,
    versionId: VERSION_B,
    requestId: REQUEST,
    title: 'Second',
  }));
  assert.equal(otherRequest.code, 'conflict');
  assert.equal(fs.existsSync(productionDir(fixture, PROD_B)), false);

  const missingTitle = await fixture.manager.createProduction(request({ title: '   ' }));
  const missingScript = await fixture.manager.createProduction(request({ text: '   \n' }));
  assert.equal(missingTitle.code, 'missing-title');
  assert.equal(missingScript.code, 'invalid-script');
  const viewed = await fixture.manager.readProduction(PROD);
  assert.equal(viewed.ok, true, viewed.error);
  assert.equal(viewed.production.title, TITLE);
  assert.equal(viewed.production.headVersionId, VERSION);
  assert.equal(JSON.stringify(viewed).includes('PRIVATE'), false);
  const readyManifest = JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'assets', 'manifest.json'), 'utf8'));
  readyManifest.assets.push({ assetId: SPARE, file: `${SPARE}.png`, ext: 'png' });
  writeJson(path.join(productionDir(fixture), 'assets', 'manifest.json'), readyManifest);
  const withSpare = await fixture.manager.readProduction(PROD);
  assert.equal(withSpare.activationReady, true);
  assert.equal(withSpare.imageStatus, 'ready');
  assert.equal(withSpare.unassignedAssets.length, 1);
  assert.equal(withSpare.unassignedAssets[0].referenced, false);
});

test('an imported legacy image stays unresolved and is not activated', async (t) => {
  const fixture = makeFixture(t);
  const before = snapshot(fixture);
  const created = await fixture.manager.createProduction(request({ text: LEGACY }));
  assert.equal(created.ok, true, created.error);
  assert.equal(created.activationReady, false);
  assert.equal(created.imageStatus, 'unresolved-shared-images');
  assert.equal(created.legacyImagePolicy, 'shared-images');
  assert.equal(created.historicalImages[0].byteSnapshot, false);
  assert.equal(created.historicalImages[0].dependency, 'shared-images');
  assert.equal(created.historicalImages[0].legacyPath, 'images/Title_Card.jpeg');
  const scriptBytes = fs.readFileSync(versionFile(fixture, 'script.txt'));
  assert.equal(scriptBytes.toString('utf8').includes('@image: images/Title_Card.jpeg'), true);
  assert.equal(scriptBytes.toString('utf8').includes('library:'), false);
  const store = createVersionStore({ root: fixture.libraryDir });
  const rejected = await store.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_C,
    text: LEGACY.replace('PRIVATE-IMPORT', 'Edited'),
    createdAt: CREATED,
  });
  assert.equal(rejected.code, 'legacy-image');
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt')).equals(scriptBytes), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'metadata.json'), 'utf8')).headVersionId, VERSION);
  assert.deepEqual(snapshot(fixture), before);

  const unresolved = await fixture.manager.createProduction(request({
    productionId: PROD_B,
    versionId: VERSION_B,
    requestId: REQUEST_B,
    text: `# Created Show\n@image: library:${PROD_B}/${ASSET}\nScene\n`,
  }));
  assert.equal(unresolved.ok, true, unresolved.error);
  assert.equal(unresolved.activationReady, false);
  assert.equal(unresolved.imageStatus, 'unresolved-library-images');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(productionDir(fixture, PROD_B), 'assets', 'manifest.json'), 'utf8')).assets, []);
  const foreign = await fixture.manager.createProduction(request({
    productionId: OTHER,
    versionId: OTHER_V,
    requestId: null,
    text: `# Created Show\n@image: library:${PROD}/${ASSET}\nScene\n`,
  }));
  assert.equal(foreign.code, 'foreign-asset');
  assert.equal(fs.existsSync(productionDir(fixture, OTHER)), false);

  const spareManifest = path.join(productionDir(fixture), 'assets', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(spareManifest, 'utf8'));
  manifest.assets.push({
    assetId: SPARE,
    file: `${SPARE}.png`,
    ext: 'png',
    referenced: false,
  });
  writeJson(spareManifest, manifest);
  const inspected = await fixture.manager.readProduction(PROD);
  assert.equal(inspected.activationReady, false);
  assert.equal(inspected.unassignedAssets.length, 1);
  assert.equal(inspected.unassignedAssets[0].assetId, SPARE);
});

test('rename changes only metadata and keeps the saved head', async (t) => {
  const fixture = makeFixture(t);
  const before = snapshot(fixture);
  const created = await fixture.manager.createProduction(request());
  assert.equal(created.ok, true, created.error);
  const second = await fixture.manager.createProduction(request({
    productionId: PROD_B,
    versionId: VERSION_B,
    requestId: REQUEST_B,
    title: 'Other show',
    text: '# Other Show\nLine\n',
  }));
  assert.equal(second.ok, true, second.error);
  const versionBytes = fs.readFileSync(versionFile(fixture, 'script.txt'));
  const versionMeta = fs.readFileSync(versionFile(fixture, 'version.json'));
  const otherMeta = fs.readFileSync(path.join(productionDir(fixture, PROD_B), 'metadata.json'));
  const same = await fixture.manager.renameProduction({
    productionId: PROD,
    title: TITLE,
    expectedGeneration: 1,
  });
  assert.equal(same.unchanged, true);
  assert.equal(same.generation, 1);
  const renamed = await fixture.manager.renameProduction({
    productionId: PROD,
    title: 'Renamed 欢迎',
    expectedGeneration: 1,
  });
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.unchanged, false);
  assert.equal(renamed.generation, 2);
  assert.equal(renamed.headVersionId, VERSION);
  assert.equal(renamed.activated, false);
  const metadata = JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'metadata.json'), 'utf8'));
  assert.equal(metadata.title, 'Renamed 欢迎');
  assert.equal(metadata.generation, 2);
  assert.equal(metadata.headVersionId, VERSION);
  assert.equal(metadata.versions.length, 1);
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt')).equals(versionBytes), true);
  assert.equal(fs.readFileSync(versionFile(fixture, 'version.json')).equals(versionMeta), true);
  assert.equal(fs.readFileSync(path.join(productionDir(fixture, PROD_B), 'metadata.json')).equals(otherMeta), true);
  assert.deepEqual(snapshot(fixture), before);
  const stale = await fixture.manager.renameProduction({
    productionId: PROD,
    title: 'Too late',
    expectedGeneration: 1,
  });
  assert.equal(stale.code, 'conflict');
  assert.equal(JSON.parse(fs.readFileSync(path.join(productionDir(fixture), 'metadata.json'), 'utf8')).title, 'Renamed 欢迎');
});

test('one factory serializes creation and rename', async (t) => {
  const fixture = makeFixture(t);
  const [first, second] = await Promise.all([
    fixture.manager.createProduction(request({ text: '# Created Show\nFirst\n' })),
    fixture.manager.createProduction(request({ text: '# Created Show\nSecond\n' })),
  ]);
  const results = [first, second].sort((left, right) => Number(right.ok) - Number(left.ok));
  assert.equal(results[0].ok, true);
  assert.equal(results[1].code, 'conflict');
  assert.equal(fs.readdirSync(path.join(productionDir(fixture), 'versions')).length, 1);
  const [sameA, sameB] = await Promise.all([
    fixture.manager.createProduction(request({
      productionId: PROD_B,
      versionId: VERSION_B,
      requestId: REQUEST_B,
      title: 'Shared',
      text: '# Shared Show\nSame\n',
    })),
    fixture.manager.createProduction(request({
      productionId: PROD_B,
      versionId: VERSION_B,
      requestId: REQUEST_B,
      title: 'Shared',
      text: '# Shared Show\nSame\n',
    })),
  ]);
  assert.equal(sameA.ok, true);
  assert.equal(sameB.ok, true);
  assert.equal([sameA.unchanged, sameB.unchanged].filter(Boolean).length, 1);
  const [renameA, renameB] = await Promise.all([
    fixture.manager.renameProduction({ productionId: PROD_B, title: 'Alpha', expectedGeneration: 1 }),
    fixture.manager.renameProduction({ productionId: PROD_B, title: 'Beta', expectedGeneration: 1 }),
  ]);
  const renames = [renameA, renameB].sort((left, right) => Number(right.ok) - Number(left.ok));
  assert.equal(renames[0].ok, true);
  assert.equal(renames[1].code, 'conflict');
  assert.equal(JSON.parse(fs.readFileSync(path.join(productionDir(fixture, PROD_B), 'metadata.json'), 'utf8')).generation, 2);
});

test('a crash before publication leaves no production, and a crash after confirms it', async (t) => {
  const early = ['before-directory', 'version-script', 'metadata', 'manifest', 'verify', 'before-rename'];
  for (let index = 0; index < early.length; index += 1) {
    const stage = early[index];
    const fixture = makeFixture(t);
    const before = snapshot(fixture);
    fs.mkdirSync(path.join(fixture.libraryDir, 'productions', '.creating-manual'), { recursive: true });
    fs.writeFileSync(path.join(fixture.libraryDir, 'productions', '.creating-manual', 'keep.txt'), 'keep');
    let error = null;
    try {
      await fixture.manager.createProduction(request({ failAt: stage }));
    } catch (err) {
      error = err;
    }
    assert.equal(error instanceof ProductionError, true, stage);
    assert.equal(error.stage, stage);
    assert.equal(fs.existsSync(productionDir(fixture)), false, stage);
    assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'productions', '.creating-manual', 'keep.txt'), 'utf8'), 'keep');
    const names = fs.readdirSync(path.join(fixture.libraryDir, 'productions'));
    assert.equal(names.some((name) => name.startsWith('.creating-') && name !== '.creating-manual'), false, stage);
    assert.deepEqual(snapshot(fixture), before);
  }
  for (const stage of ['after-rename', 'before-response']) {
    const fixture = makeFixture(t);
    const created = await fixture.manager.createProduction(request({ failAt: stage }));
    assert.equal(created.ok, true, created.error);
    assert.equal(created.recovered, true);
    assert.equal(created.confirmed, true);
    assert.equal(hashBuffer(fs.readFileSync(versionFile(fixture, 'script.txt'))), created.contentHash);
    assert.equal(fs.readdirSync(path.join(productionDir(fixture), 'versions')).length, 1);
  }
});

test('an unreadable published directory is not overwritten', async (t) => {
  const fixture = makeFixture(t);
  const created = await fixture.manager.createProduction(request());
  assert.equal(created.ok, true, created.error);
  fs.writeFileSync(path.join(productionDir(fixture), 'metadata.json'), '{');
  const retried = await fixture.manager.createProduction(request({ text: '# Created Show\nReplacement\n' }));
  assert.equal(retried.status, 'indeterminate');
  assert.equal(fs.readFileSync(path.join(productionDir(fixture), 'metadata.json'), 'utf8'), '{');
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt'), 'utf8'), SCRIPT);
});

test('an M6-shaped production stays readable and new edits keep the original bytes', async (t) => {
  const fixture = makeFixture(t);
  const text = '# Archived\nHello\n';
  const bytes = Buffer.from(text, 'utf8');
  const contentHash = hashBuffer(bytes);
  const dir = productionDir(fixture, OTHER);
  fs.mkdirSync(path.join(dir, 'versions', OTHER_V), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'versions', OTHER_V, 'script.txt'), bytes);
  writeJson(path.join(dir, 'versions', OTHER_V, 'version.json'), {
    id: OTHER_V,
    productionId: OTHER,
    role: 'v1',
    parentVersionId: null,
    origin: 'original',
    legacyImagePolicy: 'none',
    contentHash,
    assetIds: [],
  });
  writeJson(path.join(dir, 'metadata.json'), {
    id: OTHER,
    originalProductionId: OTHER,
    title: TITLE,
    headVersionId: OTHER_V,
    versions: [{
      id: OTHER_V,
      role: 'v1',
      origin: 'original',
      parentVersionId: null,
      contentHash,
    }],
    historicalImages: [],
    historicalPreview: { usesAssetSnapshots: false, note: 'v1 keeps its original lines.' },
  });
  writeJson(path.join(dir, 'assets', 'manifest.json'), { productionId: OTHER, assets: [] });
  const metadataBytes = fs.readFileSync(path.join(dir, 'metadata.json'));
  const viewed = await fixture.manager.readProduction(OTHER);
  assert.equal(viewed.ok, true, viewed.error);
  assert.equal(viewed.production.title, TITLE);
  assert.equal(viewed.production.generation, 1);
  assert.equal(viewed.production.headVersionId, OTHER_V);
  assert.equal(viewed.activationReady, true);
  assert.equal(fs.readFileSync(path.join(dir, 'metadata.json')).equals(metadataBytes), true);

  const created = await fixture.manager.createProduction(request());
  assert.equal(created.ok, true, created.error);
  const original = fs.readFileSync(versionFile(fixture, 'script.txt'));
  const store = createVersionStore({ root: fixture.libraryDir });
  const saved = await store.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_C,
    text: '# Created Show\nEdited line\n',
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.currentVersionId, VERSION_C);
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt')).equals(original), true);
  assert.equal(fs.readFileSync(versionFile(fixture, 'script.txt', VERSION_C), 'utf8'), '# Created Show\nEdited line\n');
});

test('unsafe roots and symlinks are rejected and the repository stays unchanged', async (t) => {
  const relative = createProductionManager({
    root: 'library',
    libraryDir: path.join(REPO, 'data', 'library'),
  });
  assert.equal((await relative.createProduction(request())).code, 'root-required');
  const repository = createProductionManager({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
  });
  assert.equal((await repository.renameProduction({ productionId: PROD, title: 'Nope', expectedGeneration: 1 })).code, 'unsafe-root');
  const fixture = makeFixture(t);
  const linked = path.join(fixture.root, 'linked-library');
  fs.symlinkSync(fixture.libraryDir, linked);
  const symlink = createProductionManager({ root: fixture.root, libraryDir: linked });
  assert.equal((await symlink.createProduction(request())).code, 'unsafe-path');
  const outside = path.join(os.tmpdir(), `prompter-outside-${process.pid}`);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const escaped = createProductionManager({ root: fixture.root, libraryDir: outside });
  assert.equal((await escaped.createProduction(request())).code, 'unsafe-path');
  Object.keys(REAL_FILES).forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), REAL_FILES[file]);
  });
  assertCheckoutSeedIntact(REPO);
  assert.equal(CREATE_STAGES.includes('before-rename'), true);
  assert.equal(CREATE_STAGES.includes('after-rename'), true);
});
