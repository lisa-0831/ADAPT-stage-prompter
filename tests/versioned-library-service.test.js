const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScriptLibrary } = require('../script-library');
const { runMigration } = require('../library-migration-cli');
const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { OperationError } = require('../server/versioned-live-operations');
const {
  HTTP_ADAPTER_CONTRACT,
  createVersionedLibraryService,
} = require('../server/versioned-library-service');

const REPO = path.resolve(__dirname, '..');
const PROD = '11111111-1111-4111-8111-111111111111';
const PROD_B = '22222222-2222-4222-8222-222222222222';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const VERSION_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const VERSION_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const ASSET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SPARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const NOW = '2026-06-06T00:00:00.000Z';
const CREATED = '2026-06-06T01:00:00.000Z';
const TITLE = '  欢迎 — “Café”  ';
const SCRIPT = '# Created Show\nHello there\n';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);
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

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-library-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openService(t, root) {
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'live-journal');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const scriptFile = path.join(root, 'script.txt');
  if (!fs.existsSync(scriptFile)) fs.writeFileSync(scriptFile, 'LIVE-MIRROR\n');
  const service = createVersionedLibraryService({
    root,
    libraryDir,
    scriptFile,
    journalDir,
    now: () => NOW,
  });
  t.after(() => service.close());
  return { root, libraryDir, scriptFile, journalDir, service };
}

function productionDir(fixture, productionId) {
  return path.join(fixture.libraryDir, 'productions', productionId || PROD);
}

function versionPath(fixture, versionId, name, productionId) {
  return path.join(productionDir(fixture, productionId), 'versions', versionId, name);
}

function metadata(fixture, productionId) {
  return JSON.parse(fs.readFileSync(path.join(productionDir(fixture, productionId), 'metadata.json'), 'utf8'));
}

function versionMeta(fixture, versionId, productionId) {
  return JSON.parse(fs.readFileSync(versionPath(fixture, versionId, 'version.json', productionId), 'utf8'));
}

function imageLine(productionId, assetId) {
  return `# Created Show\n@image: library:${productionId}/${assetId}\nAssigned\n`;
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

function liveDocument(productionId, versionId, contentHash, generation) {
  return {
    schema: 1,
    productionId,
    versionId,
    contentHash,
    previousActivation: null,
    updatedAt: NOW,
    generation: generation || 1,
  };
}

function installLive(fixture, productionId, versionId, generation) {
  const contentHash = versionMeta(fixture, versionId, productionId).contentHash;
  const text = fs.readFileSync(versionPath(fixture, versionId, 'script.txt', productionId));
  writeJson(path.join(fixture.libraryDir, 'migration.json'), marker(productionId, versionId, contentHash));
  writeJson(path.join(fixture.libraryDir, 'live-state.json'), liveDocument(productionId, versionId, contentHash, generation));
  fs.writeFileSync(fixture.scriptFile, text);
  return { contentHash, text, generation: generation || 1, versionId, productionId };
}

function liveExpectation(fixture) {
  const state = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  return {
    expectedGeneration: state.generation,
    expectedVersionId: state.versionId,
    expectedContentHash: state.contentHash,
  };
}

test('lists migrated and created productions without following unsafe entries', async (t) => {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(libraryDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'scripts', `${PROD}.txt`), SCRIPT);
  fs.writeFileSync(path.join(root, 'script.txt'), SCRIPT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  writeJson(path.join(libraryDir, 'index.json'), {
    version: 1,
    liveId: PROD_B,
    scripts: [{
      id: PROD,
      title: TITLE,
      createdAt: CREATED,
      updatedAt: CREATED,
      revision: hashBuffer(Buffer.from(SCRIPT)),
    }],
  });
  const ids = [MIGRATION, VERSION];
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: () => ids.shift(),
    now: () => NOW,
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({ command: 'commit', root, createId: () => { throw new Error('unexpected id'); } });
  assert.equal(committed.ok, true, committed.error);
  const fixture = openService(t, root);
  fs.mkdirSync(path.join(libraryDir, 'productions', '.creating-secret'));
  writeJson(path.join(libraryDir, 'productions', '.creating-secret', 'metadata.json'), { title: 'SECRET-CREATE' });
  fs.mkdirSync(path.join(libraryDir, 'productions', 'migration-work'));
  writeJson(path.join(libraryDir, 'productions', 'migration-work', 'metadata.json'), { title: 'SECRET-SCRATCH' });
  const outside = path.join(root, 'outside-production');
  fs.mkdirSync(outside);
  writeJson(path.join(outside, 'metadata.json'), { title: 'SECRET-LINK' });
  fs.symlinkSync(outside, path.join(libraryDir, 'productions', PROD_B));
  fs.mkdirSync(path.join(libraryDir, 'productions', VERSION));
  fs.writeFileSync(path.join(libraryDir, 'productions', VERSION, 'metadata.json'), '{');
  const before = hashFile(path.join(productionDir(fixture), 'metadata.json'));
  const listed = await fixture.service.listProductions();
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.order, 'production-id');
  assert.equal(listed.productions.length, 1);
  assert.equal(listed.productions[0].productionId, PROD);
  assert.equal(listed.productions[0].title, TITLE);
  assert.equal(listed.productions[0].headVersionId, VERSION);
  assert.equal(listed.productions[0].contentHash, versionMeta(fixture, VERSION).contentHash);
  assert.equal(listed.productions[0].generation, 1);
  assert.equal(listed.productions[0].live, false);
  assert.equal(JSON.stringify(listed).includes('SECRET-'), false);
  assert.equal(listed.invalid.some((entry) => entry.name === PROD_B && entry.code === 'unsafe-path'), true);
  assert.equal(listed.invalid.some((entry) => entry.code === 'corrupt-metadata'), true);
  assert.equal(listed.productions.some((entry) => entry.activationReady === true && entry.productionId === VERSION), false);
  assert.equal(hashFile(path.join(productionDir(fixture), 'metadata.json')), before);

  const created = await fixture.service.createProduction({
    productionId: '33333333-3333-4333-8333-333333333333',
    versionId: VERSION_B,
    title: 'Second',
    text: '# Second Show\nHello\n',
    createdAt: CREATED,
  });
  assert.equal(created.ok, true, created.error);
  const again = await fixture.service.listProductions();
  assert.deepEqual(again.productions.map((entry) => entry.productionId), [PROD, '33333333-3333-4333-8333-333333333333']);
  assert.equal(again.productions[1].title, 'Second');
  assert.equal(again.productions[1].headVersionId, VERSION_B);
});

test('checks the requested version and refuses a new shared-image activation', async (t) => {
  const fixture = openService(t, makeRoot(t));
  const created = await fixture.service.createProduction({
    productionId: PROD,
    versionId: VERSION,
    title: TITLE,
    text: SCRIPT,
    createdAt: CREATED,
  });
  assert.equal(created.ok, true, created.error);
  const historical = await fixture.service.assessVersionForActivation({ productionId: PROD, versionId: VERSION });
  assert.equal(historical.activationReady, true);
  assert.equal(historical.sharedLegacyImages, false);
  assert.equal(historical.versionId, VERSION);
  const uploaded = await fixture.service.uploadAsset({
    productionId: PROD,
    assetId: ASSET,
    name: 'Title_Card.jpeg',
    body: PNG,
  });
  assert.equal(uploaded.ok, true, uploaded.error);
  const saved = await fixture.service.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_B,
    text: imageLine(PROD, ASSET),
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  const headStill = metadata(fixture).headVersionId;
  const originalHash = hashFile(versionPath(fixture, VERSION, 'script.txt'));
  const older = await fixture.service.assessVersionForActivation({ productionId: PROD, versionId: VERSION });
  const current = await fixture.service.assessVersionForActivation({ productionId: PROD, versionId: VERSION_B });
  assert.equal(older.activationReady, true);
  assert.equal(older.versionId, VERSION);
  assert.equal(current.activationReady, true);
  assert.equal(current.imageStatus, 'ready');
  assert.equal(current.unassignedAssets.length, 0);
  assert.equal(metadata(fixture).headVersionId, headStill);
  assert.equal(hashFile(versionPath(fixture, VERSION, 'script.txt')), originalHash);

  const spare = await fixture.service.uploadAsset({
    productionId: PROD,
    assetId: SPARE,
    name: 'Spare.png',
    body: PNG,
  });
  assert.equal(spare.asset.unassigned, true);
  const withSpare = await fixture.service.assessVersionForActivation({ productionId: PROD, versionId: VERSION });
  assert.equal(withSpare.activationReady, true);
  assert.equal(withSpare.unassignedAssets.some((asset) => asset.assetId === SPARE), true);

  fs.writeFileSync(path.join(productionDir(fixture), 'assets', `${ASSET}.png`), JPEG);
  const corrupt = await fixture.service.assessVersionForActivation({ productionId: PROD, versionId: VERSION_B });
  assert.equal(corrupt.activationReady, false);
  assert.equal(corrupt.blocking.some((item) => item.code === 'corrupt-asset'), true);
  fs.writeFileSync(path.join(productionDir(fixture), 'assets', `${ASSET}.png`), PNG);

  const legacy = await fixture.service.createProduction({
    productionId: PROD_B,
    versionId: VERSION_C,
    title: 'Legacy',
    text: '# Legacy Show\n@image: images/Title_Card.jpeg\n',
    createdAt: CREATED,
  });
  assert.equal(legacy.ok, true, legacy.error);
  fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'images', 'Title_Card.jpeg'), JPEG);
  const shared = await fixture.service.assessVersionForActivation({ productionId: PROD_B, versionId: VERSION_C });
  assert.equal(shared.activationReady, false);
  assert.equal(shared.imageStatus, 'unresolved-shared-images');
  assert.equal(shared.sharedLegacyImages, true);
  const danglingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
  const danglingText = `# Created Show\n@image: library:${PROD}/${danglingId}\nOpen\n`;
  const unresolvedSave = await fixture.service.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION_B,
    newVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
    text: danglingText,
    createdAt: CREATED,
  });
  assert.equal(unresolvedSave.ok, false);
  const historicalProduction = await fixture.service.createProduction({
    productionId: '44444444-4444-4444-8444-444444444444',
    versionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc6',
    title: 'Dangling',
    text: `# Dangling Show\n@image: library:44444444-4444-4444-8444-444444444444/${danglingId}\nOpen\n`,
    createdAt: CREATED,
  });
  assert.equal(historicalProduction.ok, true, historicalProduction.error);
  const refusedFill = await fixture.service.uploadAsset({
    productionId: '44444444-4444-4444-8444-444444444444',
    assetId: danglingId,
    name: 'Title_Card.jpeg',
    body: PNG,
  });
  assert.equal(refusedFill.code, 'dangling-reference');
  assert.equal(fs.existsSync(path.join(productionDir(fixture, '44444444-4444-4444-8444-444444444444'), 'assets', `${danglingId}.png`)), false);
  assert.equal(metadata(fixture).headVersionId, VERSION_B);

  installLive(fixture, PROD, VERSION_B);
  const liveBefore = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const denied = await fixture.service.setLiveVersion(Object.assign({
    productionId: PROD_B,
    versionId: VERSION_C,
  }, liveExpectation(fixture)));
  assert.equal(denied.code, 'activation-not-ready');
  assert.equal(denied.sharedLegacyImages, true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(liveBefore), true);
  assert.equal(hashFile(versionPath(fixture, VERSION_C, 'script.txt', PROD_B)), hashBuffer(Buffer.from('# Legacy Show\n@image: images/Title_Card.jpeg\n')));
});

test('keeps rename, save, delete, and live changes from erasing one another', async (t) => {
  const fixture = openService(t, makeRoot(t));
  assert.equal((await fixture.service.createProduction({
    productionId: PROD,
    versionId: VERSION,
    title: 'Original',
    text: SCRIPT,
    createdAt: CREATED,
  })).ok, true);
  const originalScript = hashFile(versionPath(fixture, VERSION, 'script.txt'));
  const [renamed, saved] = await Promise.all([
    fixture.service.renameProduction({ productionId: PROD, title: 'Updated', expectedGeneration: 1 }),
    fixture.service.saveVersion({
      productionId: PROD,
      expectedVersionId: VERSION,
      newVersionId: VERSION_B,
      text: '# Created Show\nSaved line\n',
      createdAt: CREATED,
    }),
  ]);
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(metadata(fixture).title, 'Updated');
  assert.equal(metadata(fixture).headVersionId, VERSION_B);
  assert.equal(hashFile(versionPath(fixture, VERSION, 'script.txt')), originalScript);
  assert.equal(fs.readFileSync(versionPath(fixture, VERSION_B, 'script.txt'), 'utf8').includes('Saved line'), true);

  const uploaded = await fixture.service.uploadAsset({
    productionId: PROD,
    assetId: ASSET,
    name: 'Card.png',
    body: PNG,
  });
  assert.equal(uploaded.ok, true, uploaded.error);
  const [referenced, removed] = await Promise.all([
    fixture.service.saveVersion({
      productionId: PROD,
      expectedVersionId: VERSION_B,
      newVersionId: VERSION_C,
      text: imageLine(PROD, ASSET),
      createdAt: CREATED,
    }),
    fixture.service.deleteAsset({ productionId: PROD, assetId: ASSET }),
  ]);
  assert.equal(referenced.ok, true, referenced.error);
  assert.equal(removed.code, 'in-use');
  assert.equal(hashFile(path.join(productionDir(fixture), 'assets', `${ASSET}.png`)), hashBuffer(PNG));
  assert.equal(metadata(fixture).title, 'Updated');
  assert.equal(metadata(fixture).headVersionId, VERSION_C);

  installLive(fixture, PROD, VERSION_B);
  const [activated, deleted] = await Promise.all([
    fixture.service.setLiveVersion(Object.assign({
      productionId: PROD,
      versionId: VERSION_C,
    }, liveExpectation(fixture))),
    fixture.service.deleteAsset({ productionId: PROD, assetId: ASSET }),
  ]);
  assert.equal(activated.ok, true, activated.error);
  assert.equal(activated.versionId, VERSION_C);
  assert.equal(deleted.code, 'in-use');
  const liveState = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(liveState.versionId, VERSION_C);
  assert.equal(liveState.contentHash, versionMeta(fixture, VERSION_C).contentHash);
  assert.equal(hashFile(path.join(productionDir(fixture), 'assets', `${ASSET}.png`)), hashBuffer(PNG));
  assert.equal(metadata(fixture).headVersionId, VERSION_C);

  const publishedText = '# Created Show\nPublished line\n';
  const [published, switched] = await Promise.all([
    fixture.service.publishLiveVersion(Object.assign({
      productionId: PROD,
      expectedHeadVersionId: VERSION_C,
      newVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
      text: publishedText,
      createdAt: CREATED,
    }, liveExpectation(fixture))),
    fixture.service.setLiveVersion(Object.assign({
      productionId: PROD,
      versionId: VERSION_B,
    }, liveExpectation(fixture))),
  ]);
  assert.equal(published.ok, true, published.error);
  assert.equal(switched.code, 'stale-live');
  const after = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(after.versionId, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4');
  assert.equal(after.contentHash, hashBuffer(Buffer.from(publishedText)));
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), publishedText);
  assert.equal(metadata(fixture).headVersionId, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4');
  assert.equal(metadata(fixture).title, 'Updated');
  const listed = await fixture.service.listProductions();
  assert.equal(listed.productions[0].live, true);
  assert.equal(listed.productions[0].liveVersionId, after.versionId);
  assert.equal(listed.productions[0].title, 'Updated');
  writeJson(path.join(fixture.libraryDir, 'index.json'), { version: 1, liveId: PROD_B, scripts: [] });
  const ignored = await fixture.service.listProductions();
  assert.equal(ignored.productions[0].live, true);
  assert.equal(ignored.liveState.productionId, PROD);
});

test('one writer owns a library root, and a failed write leaves the queue usable', async (t) => {
  const fixture = openService(t, makeRoot(t));
  const other = createVersionedLibraryService({
    root: fixture.root,
    libraryDir: fs.realpathSync(fixture.libraryDir),
    scriptFile: fixture.scriptFile,
    journalDir: fixture.journalDir,
    now: () => NOW,
  });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'writer-active');
  const blocked = await other.createProduction({
    productionId: PROD,
    versionId: VERSION,
    title: 'Other',
    text: SCRIPT,
    createdAt: CREATED,
  });
  assert.equal(blocked.code, 'writer-active');
  assert.equal(fs.existsSync(productionDir(fixture)), false);
  await fixture.service.close();
  const reopened = createVersionedLibraryService({
    root: fixture.root,
    libraryDir: fixture.libraryDir,
    scriptFile: fixture.scriptFile,
    journalDir: fixture.journalDir,
    now: () => NOW,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.ok, true);
  assert.equal((await reopened.createProduction({
    productionId: PROD,
    versionId: VERSION,
    title: 'Original',
    text: SCRIPT,
    createdAt: CREATED,
  })).ok, true);
  await assert.rejects(
    () => reopened.uploadAsset({
      productionId: PROD,
      assetId: ASSET,
      name: 'Card.png',
      body: PNG,
      failAt: 'file-written',
    }),
    (err) => err && err.code === 'injected-failure',
  );
  const listed = await reopened.listAssets(PROD);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.assets.length, 0);
  const renamed = await reopened.renameProduction({
    productionId: PROD,
    title: 'After failure',
    expectedGeneration: 1,
  });
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(metadata({ libraryDir: fixture.libraryDir }, PROD).title, 'After failure');
});

test('recovers a committed text journal and leaves an ineligible journal in place', async (t) => {
  const fixture = openService(t, makeRoot(t));
  assert.equal((await fixture.service.createProduction({
    productionId: PROD,
    versionId: VERSION,
    title: 'Original',
    text: SCRIPT,
    createdAt: CREATED,
  })).ok, true);
  const saved = await fixture.service.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION,
    newVersionId: VERSION_B,
    text: '# Created Show\nNext line\n',
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  installLive(fixture, PROD, VERSION);
  await assert.rejects(
    () => fixture.service.setLiveVersion(Object.assign({
      productionId: PROD,
      versionId: VERSION_B,
      failAt: 'journal-committed',
    }, liveExpectation(fixture))),
    (err) => err instanceof OperationError && err.stage === 'journal-committed',
  );
  const pendingLive = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const journal = path.join(fixture.journalDir, 'versioned-live', 'committed', 'plan.json');
  assert.equal(fs.existsSync(journal), true);
  const stalled = await fixture.service.setLiveVersion(Object.assign({
    productionId: PROD,
    versionId: VERSION,
  }, liveExpectation(fixture)));
  assert.equal(stalled.code, 'stale-live');
  const recovered = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  assert.equal(recovered.versionId, VERSION_B);
  assert.equal(fs.existsSync(journal), false);
  assert.equal(metadata(fixture).headVersionId, VERSION_B);
  assert.notEqual(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(pendingLive), true);

  const legacy = await fixture.service.createProduction({
    productionId: PROD_B,
    versionId: VERSION_C,
    title: 'Legacy',
    text: '# Legacy Show\n@image: images/Title_Card.jpeg\n',
    createdAt: CREATED,
  });
  assert.equal(legacy.ok, true, legacy.error);
  fs.mkdirSync(path.join(fixture.root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'images', 'Title_Card.jpeg'), JPEG);
  const { createVersionedLiveOperations } = require('../server/versioned-live-operations');
  const direct = createVersionedLiveOperations({
    root: fixture.root,
    libraryDir: fixture.libraryDir,
    scriptFile: fixture.scriptFile,
    journalDir: fixture.journalDir,
    now: () => NOW,
  });
  await assert.rejects(
    () => direct.setLiveVersion(Object.assign({
      productionId: PROD_B,
      versionId: VERSION_C,
      failAt: 'journal-committed',
    }, {
      expectedGeneration: recovered.generation,
      expectedVersionId: recovered.versionId,
      expectedContentHash: recovered.contentHash,
    })),
    (err) => err instanceof OperationError && err.stage === 'journal-committed',
  );
  const planBefore = fs.readFileSync(journal);
  const liveBefore = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const versionBefore = hashFile(versionPath(fixture, VERSION_C, 'script.txt', PROD_B));
  const refused = await fixture.service.recoverLiveOperations();
  assert.equal(refused.code, 'compatibility-issue');
  assert.equal(refused.applied, false);
  assert.equal(fs.readFileSync(journal).equals(planBefore), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(liveBefore), true);
  assert.equal(hashFile(versionPath(fixture, VERSION_C, 'script.txt', PROD_B)), versionBefore);
  const overwritten = await fixture.service.setLiveVersion(Object.assign({
    productionId: PROD,
    versionId: VERSION,
  }, {
    expectedGeneration: recovered.generation,
    expectedVersionId: recovered.versionId,
    expectedContentHash: recovered.contentHash,
  }));
  assert.equal(overwritten.code, 'compatibility-issue');
  assert.equal(fs.readFileSync(journal).equals(planBefore), true);
  assert.equal(JSON.parse(liveBefore.toString('utf8')).versionId, VERSION_B);

  const pendingDir = path.join(fixture.journalDir, 'versioned-live', 'pending');
  fs.rmSync(path.join(fixture.journalDir, 'versioned-live', 'committed'), { recursive: true });
  await assert.rejects(
    () => fixture.service.setLiveVersion(Object.assign({
      productionId: PROD,
      versionId: VERSION,
      failAt: 'pending-written',
    }, liveExpectation(fixture))),
    (err) => err instanceof OperationError && err.stage === 'pending-written',
  );
  const pendingPlan = fs.readFileSync(path.join(pendingDir, 'plan.json'));
  const third = await fixture.service.saveVersion({
    productionId: PROD,
    expectedVersionId: VERSION_B,
    newVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
    text: '# Created Show\nThird line\n',
    createdAt: CREATED,
  });
  assert.equal(third.ok, true, third.error);
  const conflict = await fixture.service.setLiveVersion(Object.assign({
    productionId: PROD,
    versionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
  }, liveExpectation(fixture)));
  assert.equal(conflict.code, 'journal-conflict');
  assert.equal(fs.readFileSync(path.join(pendingDir, 'plan.json')).equals(pendingPlan), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8')).versionId, VERSION_B);
});

test('legacy creation and startup stay in place while repository bytes stay unchanged', async (t) => {
  assert.equal(HTTP_ADAPTER_CONTRACT.routes['PUT /api/library/:id'].includes('Split'), true);
  assert.equal(HTTP_ADAPTER_CONTRACT.routes['GET /api/live/assets/:productionId/:assetId'].includes('readLiveAsset'), true);
  const root = makeRoot(t);
  const legacyDir = path.join(root, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacy = createScriptLibrary({ dir: legacyDir });
  legacy.open();
  const created = legacy.create({ title: 'M4 Show', text: '# M4 Show\nHello\n' });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.title, 'M4 Show');
  assert.equal(fs.existsSync(path.join(legacyDir, 'productions')), false);
  const started = createPrompterServer({
    scriptFile: path.join(root, 'legacy-script.txt'),
    libraryDir: path.join(root, 'legacy-library'),
    journalDir: path.join(root, 'legacy-journal'),
    staffToken: 'test-token',
  });
  assert.equal(started.server.listening, false);
  started.wss.close();
  started.server.close();
  const versionedDir = path.join(root, 'versioned');
  fs.mkdirSync(versionedDir, { recursive: true });
  writeJson(path.join(versionedDir, 'migration.json'), marker(PROD, VERSION, 'ab'.repeat(32)));
  assert.throws(
    () => createPrompterServer({
      scriptFile: path.join(root, 'versioned-script.txt'),
      libraryDir: versionedDir,
      journalDir: path.join(root, 'versioned-journal'),
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );
  Object.keys(REAL_FILES).forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), REAL_FILES[file], file);
  });
  ['data/library/migration.json', 'data/library/live-state.json', 'data/library/productions', 'data/live-journal'].forEach((file) => {
    assert.equal(fs.existsSync(path.join(REPO, file)), false, file);
  });
});
