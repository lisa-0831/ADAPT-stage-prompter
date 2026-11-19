const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMigration } = require('../library-migration-plan');
const { hashText } = require('../script-library');
const {
  HISTORICAL_PREVIEW_NOTE,
  stageMigration,
  verifyStaging,
} = require('../library-migration-staging');

const REPO = path.resolve(__dirname, '..');
const WELCOME = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';
const TEST_SHOW = 'ee04e849-90d4-4eeb-b2a6-562b06067a32';
const WELCOME_V1 = '11111111-1111-4111-8111-111111111111';
const WELCOME_V2 = '11111111-1111-4111-8111-111111111112';
const TEST_V1 = '22222222-2222-4222-8222-222222222221';
const TEST_V2 = '22222222-2222-4222-8222-222222222222';
const CARD_WELCOME = '33333333-3333-4333-8333-333333333331';
const CARD_TEST = '33333333-3333-4333-8333-333333333332';
const PLAIN = '55555555-5555-4555-8555-555555555551';
const PLAIN_V1 = '55555555-5555-4555-8555-555555555552';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const REAL_FILES = [
  'script.txt',
  'script.previous.txt',
  'script.previous.txt.meta.json',
  'data/library/index.json',
  'data/library/scripts/2d0f0937-fc36-4d27-a31e-d047c2fd5623.txt',
  'images/Title_Card.jpeg',
  'images/Cap_Back2.jpeg',
  'images/Cap_Back3.jpeg',
  'images/Cap_Back4.jpeg',
];

const ACTIVATION = [
  'data/library/migration.json',
  'data/library/live-state.json',
  'data/library/productions',
  'data/live-journal',
];

function jpegBytes(fill) {
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(16, fill),
    Buffer.from([0xFF, 0xD9]),
  ]);
}

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(file) {
  return hashBuffer(fs.readFileSync(file));
}

function welcomeText() {
  return '# WELCOME\n{AN IMMERSIVE}\n@image: images/Title_Card.jpeg\n---\n# Later\n@image: images/Title_Card.jpeg\nSee images/Title_Card.jpeg in the dialogue.\n';
}

function testShowText() {
  return welcomeText().replace('{AN IMMERSIVE}', '{AN IMMERSIVe}');
}

function makeRoot(t, prefix = 'prompter-stage-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function workOf(root) {
  return path.join(root, 'data', 'library', 'migration-work');
}

function writeFixture(root, welcome, other) {
  fs.writeFileSync(path.join(root, 'script.txt'), welcome);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), welcome);
  const scripts = path.join(root, 'data', 'library', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'library', 'index.json'),
    `${JSON.stringify({ version: 1, liveId: TEST_SHOW })}\n`,
  );
  fs.writeFileSync(path.join(scripts, `${WELCOME}.txt`), welcome);
  fs.writeFileSync(path.join(scripts, `${TEST_SHOW}.txt`), other);
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images', 'Title_Card.jpeg'), jpegBytes(9));
}

function fixtureFiles(root) {
  return [
    'script.txt',
    'script.previous.txt',
    'data/library/index.json',
    `data/library/scripts/${WELCOME}.txt`,
    `data/library/scripts/${TEST_SHOW}.txt`,
    'images/Title_Card.jpeg',
  ].map((relative) => path.join(root, relative));
}

function fingerprint(files) {
  const found = {};
  files.forEach((file) => {
    found[file] = hashFile(file);
  });
  return found;
}

function realFingerprint() {
  return fingerprint(REAL_FILES.map((relative) => path.join(REPO, relative)));
}

function production(id, text, v1, v2, assetId) {
  return {
    id,
    text,
    versions: { v1, v2 },
    assets: { 'Title_Card.jpeg': assetId },
  };
}

function twoShowPlan(welcome, other) {
  return planMigration({
    liveScript: welcome,
    liveId: TEST_SHOW,
    productions: [
      production(WELCOME, welcome, WELCOME_V1, WELCOME_V2, CARD_WELCOME),
      production(TEST_SHOW, other, TEST_V1, TEST_V2, CARD_TEST),
    ],
  });
}

function writeSource(root, productionId, assetId, bytes) {
  const dir = path.join(root, 'sources');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${productionId}-${assetId}.img`);
  fs.writeFileSync(filePath, bytes);
  return { productionId, assetId, path: filePath, bytes };
}

function stageFixture(t) {
  const root = makeRoot(t);
  const welcome = welcomeText();
  const other = testShowText();
  writeFixture(root, welcome, other);
  const plan = twoShowPlan(welcome, other);
  assert.equal(plan.ok, true);
  const welcomeSource = writeSource(root, WELCOME, CARD_WELCOME, TINY_PNG);
  const testSource = writeSource(root, TEST_SHOW, CARD_TEST, jpegBytes(4));
  return {
    root,
    welcome,
    other,
    plan,
    planJson: JSON.stringify(plan),
    welcomeSource,
    testSource,
    before: fingerprint(fixtureFiles(root)),
  };
}

function sourceList(built) {
  return [
    { productionId: WELCOME, assetId: CARD_WELCOME, path: built.welcomeSource.path },
    { productionId: TEST_SHOW, assetId: CARD_TEST, path: built.testSource.path },
  ];
}

function stageBuilt(built, extra = {}) {
  return stageMigration({
    root: built.root,
    plan: built.plan,
    sources: sourceList(built),
    ...extra,
  });
}

function assertFixtureUntouched(built) {
  assert.deepEqual(fingerprint(fixtureFiles(built.root)), built.before);
  assert.equal(JSON.stringify(built.plan), built.planJson);
}

function versionScript(root, productionId, versionId) {
  return path.join(workOf(root), 'productions', productionId, 'versions', versionId, 'script.txt');
}

function saved(plan, id) {
  return plan.productions.find((production) => production.id === id);
}

function stopAt(stage) {
  return (name) => {
    if (name !== stage) return;
    const err = new Error('injected-stop');
    err.code = 'injected-stop';
    throw err;
  };
}

function assertDormant(root) {
  if (path.resolve(root) === REPO) {
    assertCheckoutSeedIntact(REPO);
    return;
  }
  ACTIVATION.forEach((relative) => {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  });
}

test('stages two synthetic productions into an isolated temporary root', (t) => {
  const built = stageFixture(t);
  const writer = fs.readFileSync(path.join(REPO, 'library-migration-staging.js'), 'utf8');
  assert.equal(writer.includes('planMigration'), false);
  assert.equal(writer.includes('library-migration-plan'), false);
  const result = stageBuilt(built);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.ready, true);
  assert.equal(result.resumed, false);
  assert.equal(result.priorStatus, 'absent');
  assert.equal(result.verification.ready, true);
  assert.deepEqual(result.verification.problems, []);
  assert.deepEqual(result.verification.activationFiles, []);

  const disk = verifyStaging(built.root);
  assert.equal(disk.ok, true);
  assert.equal(disk.ready, true);
  assert.equal(disk.state, 'ready');
  assert.deepEqual(disk.productions.map((production) => production.id), [WELCOME, TEST_SHOW]);
  disk.productions.forEach((production) => {
    assert.equal(path.basename(production.directory), production.id);
    assert.equal(fs.statSync(production.directory).isDirectory(), true);
  });
  const ready = JSON.parse(fs.readFileSync(path.join(workOf(built.root), 'READY'), 'utf8'));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.commit, false);
  assert.equal(ready.planHash, disk.planHash);
  const planFile = JSON.parse(fs.readFileSync(path.join(workOf(built.root), 'PLAN.json'), 'utf8'));
  assert.equal(planFile.state, 'ready');
  assert.equal(planFile.activation.commit, false);
  assert.equal(fs.existsSync(path.join(built.root, 'data', 'library', 'productions')), false);
  assertFixtureUntouched(built);
  assertDormant(built.root);
});

test('preserves exact v1 bytes', (t) => {
  const built = stageFixture(t);
  const result = stageBuilt(built);
  assert.equal(result.ok, true);
  [WELCOME, TEST_SHOW].forEach((id) => {
    const version = saved(built.plan, id).versions.v1;
    const file = versionScript(built.root, id, version.id);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.equals(Buffer.from(version.text, 'utf8')), true);
    assert.equal(hashBuffer(bytes), version.contentHash);
    assert.equal(hashText(bytes.toString('utf8')), version.contentHash);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'version.json'), 'utf8'));
    assert.equal(meta.origin, 'original');
    assert.equal(meta.parentVersionId, null);
    assert.equal(meta.contentHash, version.contentHash);
    assert.equal(meta.productionId, id);
  });
  const welcomeBytes = fs.readFileSync(versionScript(built.root, WELCOME, WELCOME_V1));
  assert.equal(welcomeBytes.toString('utf8'), built.welcome);
  assert.equal(welcomeBytes.toString('utf8').includes('{AN IMMERSIVE}'), true);
  assert.equal(welcomeBytes.toString('utf8').includes('@image: images/Title_Card.jpeg'), true);
});

test('writes v2 content and its content hash', (t) => {
  const built = stageFixture(t);
  assert.equal(stageBuilt(built).ok, true);
  const version = saved(built.plan, WELCOME).versions.v2;
  const file = versionScript(built.root, WELCOME, WELCOME_V2);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('utf8'), version.text);
  assert.equal(hashBuffer(bytes), version.contentHash);
  assert.notEqual(version.contentHash, saved(built.plan, WELCOME).versions.v1.contentHash);
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'version.json'), 'utf8'));
  assert.equal(meta.origin, 'migrated');
  assert.equal(meta.parentVersionId, WELCOME_V1);
  assert.equal(meta.legacyImagePolicy, 'production-assets');
  assert.equal(meta.contentHash, hashBuffer(bytes));
  const reference = `library:${WELCOME}/${CARD_WELCOME}`;
  assert.equal(bytes.toString('utf8').includes(`@image: ${reference}`), true);
  assert.equal(bytes.toString('utf8').includes('@image: images/'), false);
  const disk = verifyStaging(built.root);
  const recorded = disk.productions[0].versions.find((item) => item.role === 'v2');
  assert.equal(recorded.byteHash, version.contentHash);
  assert.equal(recorded.parentVersionId, WELCOME_V1);
});

test('gives each production an independent asset copy', (t) => {
  const built = stageFixture(t);
  assert.equal(stageBuilt(built).ok, true);
  const welcomeAsset = path.join(workOf(built.root), 'productions', WELCOME, 'assets', `${CARD_WELCOME}.png`);
  const testAsset = path.join(workOf(built.root), 'productions', TEST_SHOW, 'assets', `${CARD_TEST}.jpg`);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', WELCOME, 'assets', `${CARD_TEST}.jpg`)), false);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', TEST_SHOW, 'assets', `${CARD_WELCOME}.png`)), false);
  const welcomeBytes = fs.readFileSync(welcomeAsset);
  const testBytes = fs.readFileSync(testAsset);
  assert.equal(welcomeBytes.equals(TINY_PNG), true);
  assert.equal(testBytes.equals(jpegBytes(4)), true);
  assert.equal(hashBuffer(welcomeBytes), hashBuffer(TINY_PNG));
  const welcomeStat = fs.statSync(welcomeAsset);
  const testStat = fs.statSync(testAsset);
  assert.equal(welcomeStat.nlink, 1);
  assert.equal(testStat.nlink, 1);
  assert.notEqual(`${welcomeStat.dev}:${welcomeStat.ino}`, `${testStat.dev}:${testStat.ino}`);
  const welcomeReal = fs.realpathSync(welcomeAsset);
  const testReal = fs.realpathSync(testAsset);
  assert.equal(welcomeReal.startsWith(`${fs.realpathSync(path.join(workOf(built.root), 'productions', WELCOME, 'assets'))}${path.sep}`), true);
  assert.equal(testReal.startsWith(`${fs.realpathSync(path.join(workOf(built.root), 'productions', TEST_SHOW, 'assets'))}${path.sep}`), true);
});

test('shares one Title Card asset inside a production', (t) => {
  const built = stageFixture(t);
  assert.equal(stageBuilt(built).ok, true);
  const assetsDir = path.join(workOf(built.root), 'productions', WELCOME, 'assets');
  const files = fs.readdirSync(assetsDir).filter((name) => name !== 'manifest.json');
  assert.deepEqual(files, [`${CARD_WELCOME}.png`]);
  const script = fs.readFileSync(versionScript(built.root, WELCOME, WELCOME_V2), 'utf8');
  const reference = `@image: library:${WELCOME}/${CARD_WELCOME}`;
  assert.equal(script.split(reference).length - 1, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].assetId, CARD_WELCOME);
});

test('records production metadata and the asset manifest', (t) => {
  const built = stageFixture(t);
  assert.equal(stageBuilt(built).ok, true);
  const metadata = JSON.parse(fs.readFileSync(
    path.join(workOf(built.root), 'productions', WELCOME, 'metadata.json'),
    'utf8',
  ));
  assert.equal(metadata.id, WELCOME);
  assert.equal(metadata.originalProductionId, WELCOME);
  assert.equal(metadata.headVersionId, WELCOME_V2);
  assert.equal(metadata.versions[0].id, WELCOME_V1);
  assert.equal(metadata.versions[0].origin, 'original');
  assert.equal(metadata.versions[0].parentVersionId, null);
  assert.equal(metadata.versions[1].id, WELCOME_V2);
  assert.equal(metadata.versions[1].origin, 'migrated');
  assert.equal(metadata.versions[1].parentVersionId, WELCOME_V1);
  assert.equal(metadata.historicalImages[0].legacyPath, 'images/Title_Card.jpeg');
  assert.equal(metadata.historicalImages[0].byteSnapshot, false);
  assert.equal(metadata.historicalPreview.usesAssetSnapshots, false);
  assert.equal(metadata.historicalPreview.note, HISTORICAL_PREVIEW_NOTE);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(workOf(built.root), 'productions', WELCOME, 'assets', 'manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.productionId, WELCOME);
  assert.equal(manifest.assets[0].originalName, 'Title_Card.jpeg');
  assert.equal(manifest.assets[0].legacyPath, 'images/Title_Card.jpeg');
  assert.equal(manifest.assets[0].file, `${CARD_WELCOME}.png`);
  const asset = fs.readFileSync(path.join(workOf(built.root), 'productions', WELCOME, 'assets', manifest.assets[0].file));
  assert.equal(manifest.assets[0].contentHash, hashBuffer(asset));
  const disk = verifyStaging(built.root);
  const recorded = disk.productions[0].assets[0];
  assert.equal(recorded.byteHash, manifest.assets[0].contentHash);
  assert.equal(recorded.originalName, 'Title_Card.jpeg');
  assert.equal(disk.productions[0].historicalPreview.usesAssetSnapshots, false);
});

test('omits v2 when the script has no legacy image lines', (t) => {
  const root = makeRoot(t);
  const text = '# PLAIN\nNo images here.\n';
  fs.writeFileSync(path.join(root, 'script.txt'), text);
  const before = fs.readFileSync(path.join(root, 'script.txt'));
  const plan = planMigration({
    liveScript: text,
    liveId: PLAIN,
    productions: [{
      id: PLAIN,
      text,
      versions: { v1: PLAIN_V1 },
      assets: {},
    }],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.productions[0].versions.v2, null);
  const result = stageMigration({ root, plan, sources: [] });
  assert.equal(result.ok, true);
  const versionsDir = path.join(workOf(root), 'productions', PLAIN, 'versions');
  assert.deepEqual(fs.readdirSync(versionsDir), [PLAIN_V1]);
  assert.equal(fs.readFileSync(path.join(versionsDir, PLAIN_V1, 'script.txt')).equals(Buffer.from(text, 'utf8')), true);
  assert.equal(fs.readFileSync(path.join(root, 'script.txt')).equals(before), true);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(workOf(root), 'productions', PLAIN, 'assets', 'manifest.json'),
    'utf8',
  ));
  assert.deepEqual(manifest.assets, []);
  assert.equal(verifyStaging(root).productions[0].versions.length, 1);
});

test('fails safely when a source image is missing', (t) => {
  const built = stageFixture(t);
  const result = stageMigration({
    root: built.root,
    plan: built.plan,
    sources: [{ productionId: TEST_SHOW, assetId: CARD_TEST, path: built.testSource.path }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-source');
  assert.equal(result.ready, false);
  assert.equal(fs.existsSync(workOf(built.root)), false);
  assertFixtureUntouched(built);
  assertDormant(built.root);
});

test('fails safely when image bytes are not a supported image', (t) => {
  const built = stageFixture(t);
  const bad = path.join(built.root, 'sources', 'notes.txt');
  fs.writeFileSync(bad, 'this is not an image');
  const sources = sourceList(built).map((source) => (
    source.assetId === CARD_WELCOME ? { ...source, path: bad } : source
  ));
  const result = stageMigration({ root: built.root, plan: built.plan, sources });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-image');
  assert.equal(result.ready, false);
  assert.equal(fs.existsSync(workOf(built.root)), false);
  assertFixtureUntouched(built);
});

test('fails safely when an image exceeds the size limit', (t) => {
  const built = stageFixture(t);
  const result = stageBuilt(built, { maxImageBytes: 16 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'image-too-large');
  assert.equal(result.ready, false);
  assert.equal(fs.existsSync(workOf(built.root)), false);
  assertFixtureUntouched(built);
});

test('rejects a destination outside the temporary directory', (t) => {
  const built = stageFixture(t);
  const scriptBefore = hashFile(path.join(REPO, 'script.txt'));
  [
    'migration-work',
    REPO,
    os.tmpdir(),
    path.join(os.tmpdir(), 'prompter-stage-missing-root'),
  ].forEach((root) => {
    const result = stageMigration({ root, plan: built.plan, sources: sourceList(built) });
    assert.equal(result.ok, false, String(root));
    assert.equal(result.code, 'unsafe-destination', String(root));
    assert.equal(result.ready, false);
  });
  assert.equal(hashFile(path.join(REPO, 'script.txt')), scriptBefore);
  assert.equal(fs.existsSync(workOf(built.root)), false);
});

test('rejects a symlink that escapes the temporary directory', (t) => {
  const parent = makeRoot(t, 'prompter-stage-link-');
  const link = path.join(parent, 'escape');
  fs.symlinkSync('/no-such-prompter-stage-target', link);
  const linkedRoot = stageMigration({ root: link, plan: { ok: true }, sources: [] });
  assert.equal(linkedRoot.ok, false);
  assert.equal(linkedRoot.code, 'symlink-escape');
  assert.equal(fs.existsSync('/no-such-prompter-stage-target'), false);

  const built = stageFixture(t);
  const sourceLink = path.join(built.root, 'sources', 'linked.img');
  fs.symlinkSync(built.welcomeSource.path, sourceLink);
  const linkedSource = stageMigration({
    root: built.root,
    plan: built.plan,
    sources: sourceList(built).map((source) => (
      source.assetId === CARD_WELCOME ? { ...source, path: sourceLink } : source
    )),
  });
  assert.equal(linkedSource.ok, false);
  assert.equal(linkedSource.code, 'symlink-escape');
  assert.equal(fs.existsSync(workOf(built.root)), false);

  const rooted = makeRoot(t, 'prompter-stage-dirlink-');
  const text = welcomeText();
  const other = testShowText();
  const plan = twoShowPlan(text, other);
  const welcomeSource = writeSource(rooted, WELCOME, CARD_WELCOME, TINY_PNG);
  const testSource = writeSource(rooted, TEST_SHOW, CARD_TEST, jpegBytes(4));
  fs.symlinkSync('/no-such-prompter-stage-target', path.join(rooted, 'data'));
  const linkedData = stageMigration({
    root: rooted,
    plan,
    sources: [
      { productionId: WELCOME, assetId: CARD_WELCOME, path: welcomeSource.path },
      { productionId: TEST_SHOW, assetId: CARD_TEST, path: testSource.path },
    ],
  });
  assert.equal(linkedData.ok, false);
  assert.equal(linkedData.code, 'symlink-escape');
  assert.equal(fs.lstatSync(path.join(rooted, 'data')).isSymbolicLink(), true);
  assert.equal(fs.existsSync('/no-such-prompter-stage-target'), false);
});

test('rejects a version file whose existing bytes differ', (t) => {
  const built = stageFixture(t);
  const plantedDir = path.join(workOf(built.root), 'productions', WELCOME, 'versions', WELCOME_V1);
  fs.mkdirSync(plantedDir, { recursive: true });
  const planted = Buffer.from('# NOT THE ORIGINAL\n');
  const plantedPath = path.join(plantedDir, 'script.txt');
  fs.writeFileSync(plantedPath, planted);
  const result = stageBuilt(built);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'version-collision');
  assert.equal(result.status, 'conflict');
  assert.equal(result.ready, false);
  assert.equal(fs.readFileSync(plantedPath).equals(planted), true);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'PLAN.json')), false);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'READY')), false);
  assertFixtureUntouched(built);
});

test('reuses the original production, version, and asset ids on retry', (t) => {
  const built = stageFixture(t);
  const first = stageBuilt(built);
  assert.equal(first.ok, true);
  const v1Path = versionScript(built.root, WELCOME, WELCOME_V1);
  const assetPath = path.join(workOf(built.root), 'productions', WELCOME, 'assets', `${CARD_WELCOME}.png`);
  const v1Stat = fs.statSync(v1Path);
  const assetStat = fs.statSync(assetPath);
  const second = stageBuilt(built);
  assert.equal(second.ok, true);
  assert.equal(second.resumed, true);
  assert.equal(second.priorStatus, 'ready');
  assert.equal(second.planHash, first.planHash);
  assert.equal(fs.statSync(v1Path).mtimeMs, v1Stat.mtimeMs);
  assert.equal(fs.statSync(v1Path).ino, v1Stat.ino);
  assert.equal(fs.statSync(assetPath).mtimeMs, assetStat.mtimeMs);
  assert.equal(fs.statSync(assetPath).ino, assetStat.ino);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', WELCOME, 'versions', WELCOME_V1)), true);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', WELCOME, 'versions', WELCOME_V2)), true);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', TEST_SHOW, 'versions', TEST_V1)), true);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', TEST_SHOW, 'versions', TEST_V2)), true);
  const disk = verifyStaging(built.root);
  assert.equal(disk.ready, true);
  assert.deepEqual(disk.productions.map((production) => production.id), [WELCOME, TEST_SHOW]);
});

test('resumes a partial prepare without rewriting completed versions', (t) => {
  const built = stageFixture(t);
  assert.throws(
    () => stageBuilt(built, { onStage: stopAt('v2') }),
    (err) => err.code === 'injected-stop',
  );
  const v1Path = versionScript(built.root, WELCOME, WELCOME_V1);
  const v1Bytes = fs.readFileSync(v1Path);
  const v1Stat = fs.statSync(v1Path);
  assert.equal(v1Bytes.equals(Buffer.from(saved(built.plan, WELCOME).versions.v1.text, 'utf8')), true);
  assert.equal(fs.existsSync(versionScript(built.root, WELCOME, WELCOME_V2)), false);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'READY')), false);
  assert.equal(verifyStaging(built.root).ready, false);
  const second = stageBuilt(built);
  assert.equal(second.ok, true);
  assert.equal(second.resumed, true);
  assert.equal(second.priorStatus, 'incomplete');
  assert.equal(fs.readFileSync(v1Path).equals(v1Bytes), true);
  assert.equal(fs.statSync(v1Path).ino, v1Stat.ino);
  assert.equal(fs.statSync(v1Path).mtimeMs, v1Stat.mtimeMs);
  assert.equal(fs.readFileSync(versionScript(built.root, WELCOME, WELCOME_V2)).toString('utf8'), saved(built.plan, WELCOME).versions.v2.text);
  assert.equal(verifyStaging(built.root).ready, true);
  assertFixtureUntouched(built);
});

test('rejects a retry whose source bytes conflict with the recorded plan', (t) => {
  const built = stageFixture(t);
  assert.equal(stageBuilt(built).ok, true);
  const assetPath = path.join(workOf(built.root), 'productions', WELCOME, 'assets', `${CARD_WELCOME}.png`);
  const staged = fs.readFileSync(assetPath);
  const ready = fs.readFileSync(path.join(workOf(built.root), 'READY'));
  fs.writeFileSync(built.welcomeSource.path, jpegBytes(7));
  const result = stageBuilt(built);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'conflicting-plan');
  assert.equal(result.status, 'conflict');
  assert.equal(result.ready, false);
  assert.equal(fs.readFileSync(assetPath).equals(staged), true);
  assert.equal(fs.readFileSync(path.join(workOf(built.root), 'READY')).equals(ready), true);
  assert.equal(verifyStaging(built.root).ready, true);
});

test('does not mark the staging ready when asset copying is interrupted', (t) => {
  const built = stageFixture(t);
  assert.throws(
    () => stageBuilt(built, { onStage: stopAt('asset') }),
    (err) => err.code === 'injected-stop',
  );
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'READY')), false);
  const disk = verifyStaging(built.root);
  assert.equal(disk.ready, false);
  assert.equal(disk.ok, false);
  assert.equal(fs.existsSync(versionScript(built.root, WELCOME, WELCOME_V1)), true);
  assert.equal(fs.existsSync(versionScript(built.root, WELCOME, WELCOME_V2)), true);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'productions', WELCOME, 'assets', `${CARD_WELCOME}.png`)), false);
  assertFixtureUntouched(built);
  assertDormant(built.root);
});

test('leaves the fixture script.txt byte-identical', (t) => {
  const built = stageFixture(t);
  const before = fs.readFileSync(path.join(built.root, 'script.txt'));
  assert.equal(stageBuilt(built).ok, true);
  const after = fs.readFileSync(path.join(built.root, 'script.txt'));
  assert.equal(after.equals(before), true);
  assert.equal(after.equals(Buffer.from(built.welcome, 'utf8')), true);
  assert.notEqual(after.toString('utf8'), saved(built.plan, WELCOME).versions.v2.text);
  assert.equal(fs.readFileSync(path.join(built.root, 'script.previous.txt')).equals(before), true);
});

test('leaves fixture library scripts and the index unchanged', (t) => {
  const built = stageFixture(t);
  const index = fs.readFileSync(path.join(built.root, 'data', 'library', 'index.json'));
  const welcome = fs.readFileSync(path.join(built.root, 'data', 'library', 'scripts', `${WELCOME}.txt`));
  const other = fs.readFileSync(path.join(built.root, 'data', 'library', 'scripts', `${TEST_SHOW}.txt`));
  assert.equal(stageBuilt(built).ok, true);
  assert.equal(fs.readFileSync(path.join(built.root, 'data', 'library', 'index.json')).equals(index), true);
  assert.equal(fs.readFileSync(path.join(built.root, 'data', 'library', 'scripts', `${WELCOME}.txt`)).equals(welcome), true);
  assert.equal(fs.readFileSync(path.join(built.root, 'data', 'library', 'scripts', `${TEST_SHOW}.txt`)).equals(other), true);
  assert.equal(fs.readFileSync(path.join(built.root, 'images', 'Title_Card.jpeg')).equals(jpegBytes(9)), true);
});

test('does not write a live pointer, migration marker, or journal', (t) => {
  const realBefore = realFingerprint();
  assertCheckoutSeedIntact(REPO);
  const built = stageFixture(t);
  const result = stageBuilt(built);
  assert.equal(result.ok, true);
  assertDormant(built.root);
  assertDormant(REPO);
  assert.equal(fs.existsSync(path.join(workOf(built.root), 'READY')), true);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'migration-work')), false);
  assert.deepEqual(realFingerprint(), realBefore);
  assertFixtureUntouched(built);
});

test('a supplied title is verified before READY and a later title conflicts', (t) => {
  const root = makeRoot(t);
  const text = '# PLAIN\nNo images here.\n';
  const plan = planMigration({
    liveScript: text,
    liveId: PLAIN,
    productions: [{ id: PLAIN, text, versions: { v1: PLAIN_V1 }, assets: {} }],
  });
  const title = '  欢迎 — “Café”  ';
  const staged = stageMigration({ root, plan, sources: [], titles: { [PLAIN]: title } });
  assert.equal(staged.ok, true);
  const metadataPath = path.join(workOf(root), 'productions', PLAIN, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.title, title);
  assert.equal(verifyStaging(root).ready, true);
  const changed = { ...metadata, title: 'Changed' };
  fs.writeFileSync(metadataPath, `${JSON.stringify(changed, null, 2)}\n`);
  assert.equal(verifyStaging(root).ready, false);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const conflict = stageMigration({ root, plan, sources: [], titles: { [PLAIN]: 'Another title' } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflicting-plan');
  assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).title, title);
});
