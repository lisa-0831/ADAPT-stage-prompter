const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMigration } = require('../library-migration-plan');
const { stageMigration } = require('../library-migration-staging');
const { hashText } = require('../script-library');
const { VersionStoreError, createVersionStore } = require('../library-version-store');

const REPO = path.resolve(__dirname, '..');
const PROD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const V1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASSET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PLAIN = '55555555-5555-4555-8555-555555555551';
const PLAIN_V1 = '55555555-5555-4555-8555-555555555552';
const TEXT = '# Scene\nHello\n';
const CREATED = '2026-11-16T04:00:00.000Z';
const CREATED_NEXT = '2026-11-16T05:00:00.000Z';

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

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assetRecord() {
  return {
    assetId: ASSET,
    file: `${ASSET}.png`,
    originalName: 'card.png',
    legacyPath: 'images/card.png',
    contentHash: hashBuffer(TINY_PNG),
    ext: 'png',
    mime: 'image/png',
    byteLength: TINY_PNG.length,
  };
}

function writeProduction(root, spec) {
  const body = spec || {};
  const id = body.id || PROD;
  const versionId = body.versionId || V1;
  const text = body.text == null ? TEXT : body.text;
  const dir = path.join(root, 'productions', id);
  const versionDir = path.join(dir, 'versions', versionId);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'script.txt'), text);
  const hash = hashText(text);
  const version = {
    id: versionId,
    productionId: id,
    role: body.role || 'v1',
    parentVersionId: body.parentVersionId == null ? null : body.parentVersionId,
    origin: body.origin || 'original',
    legacyImagePolicy: body.legacyImagePolicy || 'none',
    contentHash: hash,
    assetIds: body.assetIds || [],
  };
  fs.writeFileSync(path.join(versionDir, 'version.json'), `${JSON.stringify(version)}\n`);
  const metadata = {
    id,
    originalProductionId: id,
    headVersionId: versionId,
    versions: [{
      id: versionId,
      role: version.role,
      origin: version.origin,
      parentVersionId: version.parentVersionId,
      contentHash: hash,
    }],
    historicalImages: body.historicalImages || [],
    historicalPreview: { usesAssetSnapshots: false, note: 'Kept for the original lines.' },
  };
  if (body.generation != null) metadata.generation = body.generation;
  fs.writeFileSync(path.join(dir, 'metadata.json'), `${JSON.stringify(metadata)}\n`);
  const assets = body.assets || [];
  fs.writeFileSync(path.join(dir, 'assets', 'manifest.json'), `${JSON.stringify({
    productionId: id,
    assets: assets.map((asset) => {
      const copy = Object.assign({}, asset);
      delete copy.bytes;
      return copy;
    }),
  })}\n`);
  assets.forEach((asset) => {
    fs.writeFileSync(path.join(dir, 'assets', asset.file), asset.bytes);
  });
  return { id, versionId, text, hash, dir };
}

function storeFor(root, failAt) {
  return createVersionStore({ root, failAt });
}

function save(store, fields) {
  return store.saveVersion(Object.assign({
    productionId: PROD,
    expectedVersionId: V1,
    newVersionId: V2,
    text: '# Scene\nHello again\n',
    createdAt: CREATED,
  }, fields || {}));
}

function metadataOf(root, id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'productions', id || PROD, 'metadata.json'), 'utf8'));
}

function versionBytes(root, versionId) {
  const dir = path.join(root, 'productions', PROD, 'versions', versionId);
  return {
    script: fs.readFileSync(path.join(dir, 'script.txt')),
    meta: fs.readFileSync(path.join(dir, 'version.json')),
  };
}

function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  });
  return out.sort();
}

function fingerprint(dir) {
  const found = {};
  filesUnder(dir).forEach((file) => {
    found[path.relative(dir, file)] = hashBuffer(fs.readFileSync(file));
  });
  return found;
}

function realFingerprint() {
  const found = {};
  REAL_FILES.forEach((relative) => {
    found[relative] = hashBuffer(fs.readFileSync(path.join(REPO, relative)));
  });
  return found;
}

test('reads an M2 staged production without rewriting it', (t) => {
  const root = makeRoot(t);
  const text = '# PLAIN\nNo images here.\n';
  fs.writeFileSync(path.join(root, 'script.txt'), text);
  const plan = planMigration({
    liveScript: text,
    liveId: PLAIN,
    productions: [{ id: PLAIN, text, versions: { v1: PLAIN_V1 }, assets: {} }],
  });
  assert.equal(plan.ok, true);
  const staged = stageMigration({ root, plan, sources: [] });
  assert.equal(staged.ok, true);
  const work = path.join(root, 'data', 'library', 'migration-work');
  const before = fingerprint(path.join(work, 'productions', PLAIN));
  const store = storeFor(work);
  const head = store.readHead(PLAIN);
  assert.equal(head.ok, true);
  assert.equal(head.text, text);
  assert.equal(head.version.origin, 'original');
  assert.equal(head.version.parentVersionId, null);
  assert.equal(head.version.schema, null);
  assert.equal(head.version.legacyImagePolicy, 'none');
  const production = store.readProduction(PLAIN);
  assert.equal(production.production.currentVersionId, PLAIN_V1);
  assert.equal(production.production.headVersionId, PLAIN_V1);
  assert.equal(production.production.generation, 1);
  assert.equal(production.production.versions[0].origin, 'original');
  assert.deepEqual(fingerprint(path.join(work, 'productions', PLAIN)), before);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'productions')), false);
  assert.equal(fs.existsSync(path.join(work, 'migration.json')), false);
  assert.equal(fs.existsSync(path.join(work, 'live-state.json')), false);
});

test('a new version keeps the previous bytes and moves only the saved head', async (t) => {
  const root = makeRoot(t);
  const written = writeProduction(root);
  const before = versionBytes(root, V1);
  const pointer = Buffer.from('{"schema":1,"productionId":"old"}\n');
  const marker = Buffer.from('{"schema":1,"state":"committed"}\n');
  fs.writeFileSync(path.join(root, 'live-state.json'), pointer);
  fs.writeFileSync(path.join(root, 'migration.json'), marker);
  const store = storeFor(root);
  const saved = await save(store);
  assert.equal(saved.ok, true);
  assert.equal(saved.unchanged, false);
  assert.equal(saved.currentVersionId, V2);
  assert.equal(saved.generation, 2);
  assert.equal(saved.version.contentHash, hashText('# Scene\nHello again\n'));
  assert.equal(saved.version.parentVersionId, V1);
  assert.equal(saved.version.origin, 'edited');
  assert.equal(saved.version.createdAt, CREATED);
  const after = versionBytes(root, V1);
  assert.equal(after.script.equals(before.script), true);
  assert.equal(after.meta.equals(before.meta), true);
  const metadata = metadataOf(root);
  assert.equal(metadata.currentVersionId, V2);
  assert.equal(metadata.headVersionId, V2);
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.generation, 2);
  assert.equal(metadata.updatedAt, CREATED);
  assert.equal(metadata.historicalPreview.usesAssetSnapshots, false);
  assert.equal(metadata.versions[0].id, V1);
  assert.equal(metadata.versions[1].id, V2);
  assert.equal(fs.readFileSync(path.join(root, 'live-state.json')).equals(pointer), true);
  assert.equal(fs.readFileSync(path.join(root, 'migration.json')).equals(marker), true);
  const head = store.readHead(PROD);
  assert.equal(head.text, '# Scene\nHello again\n');
  const listed = store.listVersions(PROD);
  assert.deepEqual(listed.versions.map((entry) => entry.id), [V1, V2]);
  assert.equal(listed.versions[0].createdAt, null);
  assert.equal(listed.versions[1].createdAt, CREATED);
  assert.equal(listed.versions[1].current, true);
});

test('identical text does not create a version or bump generation', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const before = fingerprint(path.join(root, 'productions', PROD));
  const store = storeFor(root);
  const saved = await save(store, { text: TEXT, newVersionId: V2 });
  assert.equal(saved.ok, true);
  assert.equal(saved.unchanged, true);
  assert.equal(saved.currentVersionId, V1);
  assert.equal(saved.generation, 1);
  assert.deepEqual(fingerprint(path.join(root, 'productions', PROD)), before);
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'versions', V2)), false);
});

test('a stale expected version conflicts and leaves the head in place', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const store = storeFor(root);
  const first = await save(store);
  assert.equal(first.ok, true);
  const before = fingerprint(path.join(root, 'productions', PROD));
  const stale = await save(store, {
    expectedVersionId: V1,
    newVersionId: V3,
    text: '# Scene\nToo late\n',
    createdAt: CREATED_NEXT,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.currentVersionId, V2);
  assert.deepEqual(fingerprint(path.join(root, 'productions', PROD)), before);
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'versions', V3)), false);
});

test('two saves that start from the same head cannot both become head', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const store = storeFor(root);
  const [first, second] = await Promise.all([
    save(store, { newVersionId: V2, text: '# Scene\nFrom A\n', createdAt: CREATED }),
    save(store, { newVersionId: V3, text: '# Scene\nFrom B\n', createdAt: CREATED_NEXT }),
  ]);
  const results = [first, second];
  const won = results.filter((result) => result.ok);
  const lost = results.filter((result) => !result.ok);
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].code, 'conflict');
  assert.equal(lost[0].currentVersionId, won[0].currentVersionId);
  assert.equal(store.readHead(PROD).version.id, won[0].currentVersionId);
  const loserId = won[0].currentVersionId === V2 ? V3 : V2;
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'versions', loserId)), false);
});

test('image references must belong to this production and stay on older versions', async (t) => {
  const root = makeRoot(t);
  const asset = assetRecord();
  const legacyText = '# Scene\n@image: images/Title_Card.jpeg\nHello\n';
  writeProduction(root, {
    text: legacyText,
    legacyImagePolicy: 'shared-images',
    historicalImages: [{ legacyPath: 'images/Title_Card.jpeg', byteSnapshot: false }],
    assets: [Object.assign({ bytes: TINY_PNG }, asset)],
  });
  const store = storeFor(root);
  const rejectedLegacy = await save(store, {
    text: '# Scene\n@image: images/Title_Card.jpeg\nChanged\n',
  });
  assert.equal(rejectedLegacy.ok, false);
  assert.equal(rejectedLegacy.code, 'legacy-image');
  const foreign = `# Scene\n@image: library:${OTHER}/${ASSET}\nHello\n`;
  const rejectedForeign = await save(store, { text: foreign });
  assert.equal(rejectedForeign.ok, false);
  assert.equal(rejectedForeign.code, 'foreign-asset');
  const missing = `# Scene\n@image: library:${PROD}/12121212-1212-4121-8121-121212121212\nHello\n`;
  const rejectedMissing = await save(store, { text: missing });
  assert.equal(rejectedMissing.ok, false);
  assert.equal(rejectedMissing.code, 'missing-asset');
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'versions', V2)), false);
  const owned = `# One\n@image: library:${PROD}/${ASSET}\nHello\n---\n# Two\n@image: library:${PROD}/${ASSET}\nAgain\n`;
  const saved = await save(store, { text: owned });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.version.assetIds, [ASSET]);
  assert.equal(saved.version.legacyImagePolicy, 'production-assets');
  const original = store.readVersion(PROD, V1);
  assert.equal(original.text, legacyText);
  assert.deepEqual(original.version.assetIds, []);
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'assets', `${ASSET}.png`)), true);
});

test('an existing version directory is not overwritten', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const planted = path.join(root, 'productions', PROD, 'versions', V2);
  fs.mkdirSync(planted);
  const script = Buffer.from('# Scene\nPlanted\n');
  fs.writeFileSync(path.join(planted, 'script.txt'), script);
  fs.writeFileSync(path.join(planted, 'version.json'), `${JSON.stringify({
    id: V2,
    productionId: PROD,
    contentHash: hashText(script.toString('utf8')),
    parentVersionId: V1,
    origin: 'edited',
  })}\n`);
  const store = storeFor(root);
  const saved = await save(store, { text: '# Scene\nDifferent\n' });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'version-exists');
  assert.equal(fs.readFileSync(path.join(planted, 'script.txt')).equals(script), true);
  assert.equal(metadataOf(root).headVersionId, V1);
});

test('invalid ids and corrupt metadata fail before a version is created', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const store = storeFor(root);
  const badId = await save(store, { productionId: 'not-a-uuid' });
  assert.equal(badId.ok, false);
  assert.equal(badId.code, 'invalid-id');
  const badVersion = await save(store, { newVersionId: 'also-bad' });
  assert.equal(badVersion.code, 'invalid-id');
  fs.writeFileSync(path.join(root, 'productions', PROD, 'metadata.json'), '{');
  assert.equal(store.readProduction(PROD).code, 'corrupt-metadata');
  const saved = await save(store);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'corrupt-metadata');
  assert.equal(fs.existsSync(path.join(root, 'productions', PROD, 'versions', V2)), false);
  const schemaRoot = makeRoot(t);
  writeProduction(schemaRoot);
  const metadata = metadataOf(schemaRoot);
  metadata.schema = 2;
  fs.writeFileSync(path.join(schemaRoot, 'productions', PROD, 'metadata.json'), `${JSON.stringify(metadata)}\n`);
  const rejected = await save(storeFor(schemaRoot));
  assert.equal(rejected.code, 'unsupported-schema');
});

test('a missing parent version fails and leaves metadata unchanged', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const metadataPath = path.join(root, 'productions', PROD, 'metadata.json');
  const before = fs.readFileSync(metadataPath);
  fs.rmSync(path.join(root, 'productions', PROD, 'versions', V1), { recursive: true });
  const saved = await save(storeFor(root));
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'missing-parent');
  assert.equal(fs.readFileSync(metadataPath).equals(before), true);
});

test('a failure before the metadata commit keeps the previous head and leaves an orphan', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const metadataPath = path.join(root, 'productions', PROD, 'metadata.json');
  const before = fs.readFileSync(metadataPath);
  const failed = await save(storeFor(root, 'before-metadata'));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'incomplete');
  assert.equal(failed.currentVersionId, V1);
  assert.equal(fs.readFileSync(metadataPath).equals(before), true);
  const orphans = storeFor(root).listOrphans(PROD);
  assert.deepEqual(orphans.orphans, [{ id: V2, complete: true, current: false }]);
  assert.equal(storeFor(root).readHead(PROD).version.id, V1);
  const partialRoot = makeRoot(t);
  writeProduction(partialRoot);
  const partialMeta = fs.readFileSync(path.join(partialRoot, 'productions', PROD, 'metadata.json'));
  const partial = await save(storeFor(partialRoot, 'version-script'));
  assert.equal(partial.code, 'incomplete');
  assert.equal(fs.readFileSync(path.join(partialRoot, 'productions', PROD, 'metadata.json')).equals(partialMeta), true);
  assert.equal(fs.existsSync(path.join(partialRoot, 'productions', PROD, 'versions', V2, 'script.txt')), true);
  assert.equal(fs.existsSync(path.join(partialRoot, 'productions', PROD, 'versions', V2, 'version.json')), false);
  assert.equal(storeFor(partialRoot).listOrphans(PROD).orphans[0].complete, false);
});

test('a retry finishes an orphan without rewriting its bytes', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const failed = await save(storeFor(root, 'before-metadata'));
  assert.equal(failed.code, 'incomplete');
  const before = versionBytes(root, V2);
  const retried = await save(storeFor(root));
  assert.equal(retried.ok, true);
  assert.equal(retried.currentVersionId, V2);
  assert.equal(retried.generation, 2);
  const after = versionBytes(root, V2);
  assert.equal(after.script.equals(before.script), true);
  assert.equal(after.meta.equals(before.meta), true);
  assert.deepEqual(storeFor(root).listOrphans(PROD).orphans, []);
  const committed = versionBytes(root, V2);
  const original = versionBytes(root, V1);
  const again = await save(storeFor(root), {
    expectedVersionId: V2,
    newVersionId: V1,
    text: '# Scene\nA different retry\n',
    createdAt: CREATED_NEXT,
  });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'version-exists');
  assert.equal(versionBytes(root, V2).script.equals(committed.script), true);
  assert.equal(versionBytes(root, V2).meta.equals(committed.meta), true);
  assert.equal(versionBytes(root, V1).script.equals(original.script), true);
  assert.equal(versionBytes(root, V1).meta.equals(original.meta), true);
  assert.equal(metadataOf(root).currentVersionId, V2);
});

test('metadata generation advances only when the head changes', async (t) => {
  const root = makeRoot(t);
  writeProduction(root, { generation: 7 });
  const store = storeFor(root);
  const first = await save(store);
  assert.equal(first.generation, 8);
  const second = await save(store, {
    expectedVersionId: V2,
    newVersionId: V3,
    text: '# Scene\nThird\n',
    createdAt: CREATED_NEXT,
  });
  assert.equal(second.generation, 9);
  const same = await save(store, {
    expectedVersionId: V3,
    newVersionId: '99999999-9999-4999-8999-999999999999',
    text: '# Scene\nThird\n',
    createdAt: '2026-11-16T06:00:00.000Z',
  });
  assert.equal(same.unchanged, true);
  assert.equal(same.generation, 9);
  assert.equal(metadataOf(root).generation, 9);
});

test('a metadata failure after the rename reports the committed head', async (t) => {
  const root = makeRoot(t);
  writeProduction(root);
  const saved = await save(storeFor(root, 'after-metadata'));
  assert.equal(saved.ok, true);
  assert.equal(saved.syncWarning, true);
  assert.equal(saved.currentVersionId, V2);
  assert.equal(storeFor(root).readHead(PROD).version.id, V2);
  assert.equal(metadataOf(root).generation, 2);
});

test('reads and listings do not change files', (t) => {
  const root = makeRoot(t);
  writeProduction(root, { assets: [Object.assign({ bytes: TINY_PNG }, assetRecord())] });
  const dir = path.join(root, 'productions', PROD);
  const before = fingerprint(dir);
  const store = storeFor(root);
  assert.equal(store.readProduction(PROD).ok, true);
  assert.equal(store.readVersion(PROD, V1).ok, true);
  assert.equal(store.readHead(PROD).ok, true);
  assert.equal(store.listVersions(PROD).ok, true);
  assert.deepEqual(store.listOrphans(PROD).orphans, []);
  assert.deepEqual(fingerprint(dir), before);
});

test('the store refuses a root inside the repository', () => {
  assert.throws(() => createVersionStore({ root: REPO }), VersionStoreError);
  assertCheckoutSeedIntact(REPO);
});

test('repository production files stay byte-identical', () => {
  const before = realFingerprint();
  assert.equal(before['script.txt'], 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0');
  const after = realFingerprint();
  assert.deepEqual(after, before);
});
