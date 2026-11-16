const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { runMigration } = require('../library-migration-cli');
const { installVersionedLive } = require('../server/versioned-live-install');
const {
  LIVE_STAGES,
  OperationError,
  createVersionedLiveOperations,
} = require('../server/versioned-live-operations');

const REPO = path.resolve(__dirname, '..');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OWNED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SPARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const LIVE_V1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const LIVE_V2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const LIVE_V3 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
const LIVE_V4 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5';
const LIVE_ASSET = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const OTHER_V1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const TWIN = '33333333-3333-4333-8333-333333333333';
const TWIN_V1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const TWIN_V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const TWIN_ASSET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
const FOREIGN_V = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc6';
const MISSING_V = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc7';
const MISSING_ASSET = '99999999-9999-4999-8999-999999999999';
const NOW = '2026-06-06T00:00:00.000Z';
const CREATED = '2026-06-06T01:00:00.000Z';
const LIVE_TEXT = '# Live Show\n@image: images/Card.png\nPRIVATE-LIVE-CUE\n';
const OTHER_TEXT = `# Saved Show\n@image: library:${OTHER}/${OWNED}\nPRIVATE-SAVED-CUE\n`;
const TWIN_TEXT = '# Twin Show\n@image: images/Card.png\nPRIVATE-TWIN-CUE\n';
const EDITED = '# Live Show\nEdited line\n';
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

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-live-ops-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function versionFile(fixture, productionId, versionId, name) {
  return path.join(fixture.libraryDir, 'productions', productionId, 'versions', versionId, name);
}

function metadata(fixture, productionId) {
  return JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'productions', productionId, 'metadata.json'), 'utf8'));
}

function liveState(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
}

async function installedFixture(t) {
  const root = makeRoot(t);
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: OTHER, textHash: 'ab'.repeat(32) });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'Card.png'), PNG);
  [
    [LIVE, LIVE_TEXT],
    [OTHER, OTHER_TEXT],
    [TWIN, TWIN_TEXT],
  ].forEach(([id, text]) => fs.writeFileSync(path.join(library, 'scripts', `${id}.txt`), text));
  const owned = path.join(library, 'assets', OTHER);
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, `${OWNED}.png`), PNG);
  fs.writeFileSync(path.join(owned, `${SPARE}.jpg`), JPEG);
  writeJson(path.join(owned, 'manifest.json'), {
    version: 1,
    assets: [
      { id: OWNED, name: 'Owned.png', ext: 'png', mime: 'image/png', bytes: PNG.length, createdAt: CREATED },
      { id: SPARE, name: 'Spare.jpg', ext: 'jpg', mime: 'image/jpeg', bytes: JPEG.length, createdAt: CREATED },
    ],
  });
  writeJson(path.join(library, 'index.json'), {
    version: 1,
    liveId: OTHER,
    scripts: [LIVE, OTHER, TWIN].map((id) => ({
      id,
      title: id,
      createdAt: CREATED,
      updatedAt: CREATED,
      revision: 'ab'.repeat(32),
    })),
  });
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: (() => {
      const pending = [MIGRATION, LIVE_V1, LIVE_V2, LIVE_ASSET, OTHER_V1, TWIN_V1, TWIN_V2, TWIN_ASSET];
      return () => pending.shift();
    })(),
    now: () => '2026-11-16T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({ command: 'commit', root, createId: () => { throw new Error('unexpected id'); } });
  assert.equal(committed.ok, true, committed.error);
  const fixture = {
    root,
    libraryDir: library,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    metaFile: path.join(root, 'script.previous.txt.meta.json'),
    journalDir: path.join(root, 'data', 'live-journal'),
  };
  fs.mkdirSync(fixture.journalDir, { recursive: true });
  const installed = installVersionedLive(Object.assign({ now: () => '2026-05-05T00:00:00.000Z' }, fixture));
  assert.equal(installed.ok, true, installed.error);
  fixture.ops = createVersionedLiveOperations(Object.assign({ now: () => NOW }, fixture));
  fixture.marker = fs.readFileSync(path.join(library, 'migration.json'));
  fixture.meta = fs.readFileSync(fixture.metaFile);
  fixture.previous = fs.readFileSync(fixture.previousFile);
  return fixture;
}

function expectation(fixture) {
  const state = liveState(fixture);
  return {
    expectedGeneration: state.generation,
    expectedVersionId: state.versionId,
    expectedContentHash: state.contentHash,
  };
}

test('save, set live, publish, and restore keep saved heads separate from live history', async (t) => {
  const fixture = await installedFixture(t);
  const mirror = fs.readFileSync(fixture.scriptFile);
  const stateBefore = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const legacy = await fixture.ops.saveLibraryVersion({
    productionId: LIVE,
    expectedVersionId: LIVE_V2,
    newVersionId: LIVE_V4,
    text: LIVE_TEXT,
    createdAt: CREATED,
  });
  assert.equal(legacy.code, 'legacy-image');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);
  assert.equal(fs.existsSync(versionFile(fixture, LIVE, LIVE_V4, 'script.txt')), false);
  const saved = await fixture.ops.saveLibraryVersion({
    productionId: LIVE,
    expectedVersionId: LIVE_V2,
    newVersionId: LIVE_V3,
    text: EDITED,
    createdAt: CREATED,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.unchanged, false);
  assert.equal(saved.currentVersionId, LIVE_V3);
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(stateBefore), true);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(mirror), true);
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  const same = await fixture.ops.saveLibraryVersion({
    productionId: LIVE,
    expectedVersionId: LIVE_V1,
    newVersionId: LIVE_V4,
    text: EDITED,
    createdAt: CREATED,
  });
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  assert.equal(same.currentVersionId, LIVE_V3);
  assert.equal(fs.existsSync(versionFile(fixture, LIVE, LIVE_V4, 'script.txt')), false);
  const stale = await fixture.ops.saveLibraryVersion({
    productionId: LIVE,
    expectedVersionId: LIVE_V2,
    newVersionId: LIVE_V4,
    text: '# Live Show\nAnother edit\n',
    createdAt: CREATED,
  });
  assert.equal(stale.code, 'conflict');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);

  const historical = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: LIVE_V1,
  }, expectation(fixture)));
  assert.equal(historical.ok, true, historical.error);
  assert.equal(historical.versionId, LIVE_V1);
  assert.equal(historical.previousActivation.versionId, LIVE_V2);
  assert.equal(historical.cue.action, 'preserve');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'index.json'), 'utf8')).liveId, OTHER);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(fs.readFileSync(versionFile(fixture, LIVE, LIVE_V1, 'script.txt'))), true);
  const repeated = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: LIVE_V1,
  }, expectation(fixture)));
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.generation, historical.generation);
  const staleLive = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: LIVE_V2,
  }, expectation(fixture), { expectedGeneration: 1 }));
  assert.equal(staleLive.code, 'stale-live');
  assert.equal(liveState(fixture).versionId, LIVE_V1);

  const switched = await fixture.ops.setLiveVersion(Object.assign({
    productionId: OTHER,
    useHead: true,
    expectedHeadVersionId: OTHER_V1,
  }, expectation(fixture)));
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.productionId, OTHER);
  assert.equal(switched.versionId, OTHER_V1);
  assert.equal(switched.previousActivation.productionId, LIVE);
  assert.equal(switched.previousActivation.versionId, LIVE_V1);
  assert.equal(switched.cue.action, 'reset');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(metadata(fixture, OTHER).headVersionId, OTHER_V1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'index.json'), 'utf8')).liveId, OTHER);

  const empty = await installedFixture(t);
  const untouched = snapshotBytes(empty);
  const missingHistory = await empty.ops.restorePreviousLive(expectation(empty));
  assert.equal(missingHistory.code, 'no-previous-activation');
  assert.deepEqual(snapshotBytes(empty), untouched);

  const restored = await fixture.ops.restorePreviousLive(expectation(fixture));
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.productionId, LIVE);
  assert.equal(restored.versionId, LIVE_V1);
  assert.equal(restored.previousActivation.productionId, OTHER);
  assert.equal(restored.previousActivation.versionId, OTHER_V1);
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(metadata(fixture, OTHER).headVersionId, OTHER_V1);
  assert.equal(fs.readdirSync(path.join(fixture.libraryDir, 'productions', LIVE, 'versions')).includes(LIVE_V4), false);
  assert.equal(fs.readFileSync(fixture.metaFile).equals(fixture.meta), true);
  assert.equal(fs.readFileSync(fixture.previousFile).equals(fixture.previous), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(fixture.marker), true);
  const toggled = await fixture.ops.restorePreviousLive(expectation(fixture));
  assert.equal(toggled.productionId, OTHER);
  assert.equal(toggled.versionId, OTHER_V1);
});

test('publish activates the saved version and reports a saved-but-not-live crash', async (t) => {
  const fixture = await installedFixture(t);
  let early = null;
  try {
    await fixture.ops.publishLiveVersion(Object.assign({
      productionId: LIVE,
      expectedHeadVersionId: LIVE_V2,
      newVersionId: LIVE_V3,
      text: EDITED,
      createdAt: CREATED,
      failAt: 'before-save',
    }, expectation(fixture)));
  } catch (err) {
    early = err;
  }
  assert.equal(early.stage, 'before-save');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);
  assert.equal(fs.existsSync(versionFile(fixture, LIVE, LIVE_V3, 'script.txt')), false);
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  const wrong = await fixture.ops.publishLiveVersion(Object.assign({
    productionId: OTHER,
    expectedHeadVersionId: OTHER_V1,
    newVersionId: LIVE_V3,
    text: '# Saved Show\nNope\n',
    createdAt: CREATED,
  }, expectation(fixture)));
  assert.equal(wrong.code, 'wrong-production');
  assert.equal(fs.existsSync(versionFile(fixture, OTHER, LIVE_V3, 'script.txt')), false);
  const stale = await fixture.ops.publishLiveVersion(Object.assign({
    productionId: LIVE,
    expectedHeadVersionId: LIVE_V1,
    newVersionId: LIVE_V3,
    text: EDITED,
    createdAt: CREATED,
  }, expectation(fixture)));
  assert.equal(stale.code, 'conflict');
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);

  let partial = null;
  try {
    await fixture.ops.publishLiveVersion(Object.assign({
      productionId: LIVE,
      expectedHeadVersionId: LIVE_V2,
      newVersionId: LIVE_V3,
      text: EDITED,
      createdAt: CREATED,
      failAt: 'after-save',
    }, expectation(fixture)));
  } catch (err) {
    partial = err;
  }
  assert.equal(partial instanceof OperationError, true);
  assert.equal(partial.stage, 'after-save');
  assert.equal(partial.status, 'saved-not-live');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8').includes('PRIVATE-LIVE-CUE'), true);
  const retried = await fixture.ops.publishLiveVersion(Object.assign({
    productionId: LIVE,
    expectedHeadVersionId: LIVE_V2,
    newVersionId: LIVE_V4,
    text: EDITED,
    createdAt: CREATED,
    resetPosition: true,
  }, expectation(fixture)));
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.versionId, LIVE_V3);
  assert.equal(retried.cue.action, 'reset');
  assert.equal(retried.previousActivation.versionId, LIVE_V2);
  assert.equal(fs.existsSync(versionFile(fixture, LIVE, LIVE_V4, 'script.txt')), false);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8'), EDITED);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(fixture.marker), true);
});

test('a committed live journal resumes its recorded version, not the saved head', async (t) => {
  const fixture = await installedFixture(t);
  await fixture.ops.saveLibraryVersion({
    productionId: LIVE,
    expectedVersionId: LIVE_V2,
    newVersionId: LIVE_V3,
    text: EDITED,
    createdAt: CREATED,
  });
  const error = await crash(fixture, 'journal-committed', {
    productionId: LIVE,
    versionId: LIVE_V1,
  });
  assert.equal(error.stage, 'journal-committed');
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  const plan = path.join(fixture.journalDir, 'versioned-live', 'committed', 'plan.json');
  const planBytes = fs.readFileSync(plan);
  const blocked = installVersionedLive(Object.assign({ now: () => NOW }, fixture));
  assert.equal(blocked.code, 'journal-conflict');
  assert.equal(fs.readFileSync(plan).equals(planBytes), true);
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  const recovered = await fixture.ops.recoverLiveOperations();
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(liveState(fixture).versionId, LIVE_V1);
  assert.equal(liveState(fixture).previousActivation.versionId, LIVE_V2);
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V3);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(fs.readFileSync(versionFile(fixture, LIVE, LIVE_V1, 'script.txt'))), true);
});

test('pending live journals do not activate, and a corrupt journal is kept', async (t) => {
  const fixture = await installedFixture(t);
  const error = await crash(fixture, 'pending-written', {
    productionId: OTHER,
    versionId: OTHER_V1,
  });
  assert.equal(error.stage, 'pending-written');
  const pending = await fixture.ops.recoverLiveOperations();
  assert.equal(pending.applied, false);
  assert.equal(pending.activated, false);
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  const finished = await fixture.ops.setLiveVersion(Object.assign({
    productionId: OTHER,
    versionId: OTHER_V1,
  }, expectation(fixture)));
  assert.equal(finished.ok, true, finished.error);
  assert.equal(finished.versionId, OTHER_V1);

  const corrupt = await installedFixture(t);
  await crash(corrupt, 'journal-committed', { productionId: LIVE, versionId: LIVE_V1 });
  const plan = path.join(corrupt.journalDir, 'versioned-live', 'committed', 'plan.json');
  fs.writeFileSync(plan, '{');
  const refused = await corrupt.ops.recoverLiveOperations();
  assert.equal(refused.code, 'corrupt-journal');
  assert.equal(fs.readFileSync(plan, 'utf8'), '{');
  assert.equal(liveState(corrupt).versionId, LIVE_V2);
});

test('asset, mirror, and identity checks block unsafe activation', async (t) => {
  const fixture = await installedFixture(t);
  const spare = path.join(fixture.libraryDir, 'productions', OTHER, 'assets', `${SPARE}.jpg`);
  const spareBytes = fs.readFileSync(spare);
  spareBytes[20] = spareBytes[20] === 1 ? 2 : 1;
  fs.writeFileSync(spare, spareBytes);
  const unassigned = await fixture.ops.setLiveVersion(Object.assign({
    productionId: OTHER,
    versionId: OTHER_V1,
  }, expectation(fixture)));
  assert.equal(unassigned.ok, true, unassigned.error);
  await fixture.ops.restorePreviousLive(expectation(fixture));
  const owned = path.join(fixture.libraryDir, 'productions', OTHER, 'assets', `${OWNED}.png`);
  const ownedBytes = fs.readFileSync(owned);
  ownedBytes[20] = ownedBytes[20] === 1 ? 2 : 1;
  fs.writeFileSync(owned, ownedBytes);
  const corrupt = await fixture.ops.setLiveVersion(Object.assign({
    productionId: OTHER,
    versionId: OTHER_V1,
  }, expectation(fixture)));
  assert.equal(corrupt.code, 'corrupt-asset');
  assert.equal(liveState(fixture).versionId, LIVE_V2);
  fs.writeFileSync(owned, PNG);

  writeVersion(fixture, LIVE, FOREIGN_V, `# Live Show\n@image: library:${OTHER}/${OWNED}\nFOREIGN\n`);
  const foreign = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: FOREIGN_V,
  }, expectation(fixture)));
  assert.equal(foreign.code, 'foreign-asset');
  writeVersion(fixture, LIVE, MISSING_V, `# Live Show\n@image: library:${LIVE}/${MISSING_ASSET}\nMISSING\n`);
  const missing = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: MISSING_V,
  }, expectation(fixture)));
  assert.equal(missing.code, 'missing-asset');
  assert.equal(liveState(fixture).versionId, LIVE_V2);

  fs.writeFileSync(fixture.scriptFile, '# Live Show\nUNEXPECTED-MIRROR\n');
  const mirror = await fixture.ops.setLiveVersion(Object.assign({
    productionId: LIVE,
    versionId: LIVE_V1,
  }, expectation(fixture)));
  assert.equal(mirror.code, 'mirror-conflict');
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8').includes('UNEXPECTED-MIRROR'), true);
  assert.equal(JSON.stringify(mirror).includes('PRIVATE'), false);
});

test('committed journals finish the recorded version and ignore a newer activation', async (t) => {
  const openStages = ['before-journal', 'pending-written'];
  const committedStages = ['journal-committed', 'before-live-state', 'after-live-state', 'before-mirror', 'after-mirror', 'before-cleanup'];
  for (let index = 0; index < openStages.length; index += 1) {
    const stage = openStages[index];
    const fixture = await installedFixture(t);
    const before = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
    const mirror = fs.readFileSync(fixture.scriptFile);
    const error = await crash(fixture, stage, { productionId: LIVE, versionId: LIVE_V1 });
    assert.equal(error.stage, stage);
    const recovered = await fixture.ops.recoverLiveOperations();
    assert.equal(recovered.activated, false);
    assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(before), true);
    assert.equal(fs.readFileSync(fixture.scriptFile).equals(mirror), true);
    assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);
  }
  for (let index = 0; index < committedStages.length; index += 1) {
    const stage = committedStages[index];
    const fixture = await installedFixture(t);
    const error = await crash(fixture, stage, { productionId: LIVE, versionId: LIVE_V1 });
    assert.equal(error.stage, stage);
    if (stage === 'after-live-state' || stage === 'before-mirror') {
      assert.equal(liveState(fixture).versionId, LIVE_V1);
      assert.notEqual(hashFile(fixture.scriptFile), liveState(fixture).contentHash);
    }
    const recovered = await fixture.ops.recoverLiveOperations();
    assert.equal(recovered.ok, true, `${stage} ${recovered.error}`);
    assert.equal(recovered.activated, true);
    assert.equal(liveState(fixture).versionId, LIVE_V1);
    assert.equal(liveState(fixture).previousActivation.versionId, LIVE_V2);
    assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);
    assert.equal(hashFile(fixture.scriptFile), liveState(fixture).contentHash);
    assert.equal(fs.existsSync(path.join(fixture.journalDir, 'versioned-live', 'committed')), false);
  }

  const stale = await installedFixture(t);
  await crash(stale, 'journal-committed', { productionId: LIVE, versionId: LIVE_V1 });
  const statePath = path.join(stale.libraryDir, 'live-state.json');
  const newer = liveState(stale);
  newer.generation = 2;
  fs.writeFileSync(statePath, `${JSON.stringify(newer, null, 2)}\n`);
  const refused = await stale.ops.recoverLiveOperations();
  assert.equal(refused.code, 'stale-live');
  assert.equal(liveState(stale).versionId, LIVE_V2);
  assert.equal(liveState(stale).generation, 2);
  assert.equal(fs.existsSync(path.join(stale.journalDir, 'versioned-live', 'committed', 'plan.json')), true);
  assert.equal(metadata(stale, LIVE).headVersionId, LIVE_V2);
});

test('live operations in one process are serialized and startup still refuses', async (t) => {
  const fixture = await installedFixture(t);
  const [saved, activated] = await Promise.all([
    fixture.ops.saveLibraryVersion({
      productionId: OTHER,
      expectedVersionId: OTHER_V1,
      newVersionId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
      text: '# Saved Show\nQueued edit\n',
      createdAt: CREATED,
    }),
    fixture.ops.setLiveVersion(Object.assign({
      productionId: LIVE,
      versionId: LIVE_V1,
    }, expectation(fixture))),
  ]);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(activated.ok, true, activated.error);
  assert.equal(metadata(fixture, OTHER).headVersionId, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2');
  assert.equal(metadata(fixture, LIVE).headVersionId, LIVE_V2);
  assert.equal(liveState(fixture).versionId, LIVE_V1);
  assert.equal(hashFile(fixture.scriptFile), liveState(fixture).contentHash);
  const [first, second] = await Promise.all([
    fixture.ops.saveLibraryVersion({
      productionId: LIVE,
      expectedVersionId: LIVE_V2,
      newVersionId: LIVE_V3,
      text: '# Live Show\nFirst edit\n',
      createdAt: CREATED,
    }),
    fixture.ops.saveLibraryVersion({
      productionId: LIVE,
      expectedVersionId: LIVE_V2,
      newVersionId: LIVE_V4,
      text: '# Live Show\nSecond edit\n',
      createdAt: CREATED,
    }),
  ]);
  const results = [first, second].sort((left, right) => Number(right.ok) - Number(left.ok));
  assert.equal(results[0].ok, true);
  assert.equal(results[1].code, 'conflict');
  assert.equal([LIVE_V3, LIVE_V4].includes(metadata(fixture, LIVE).headVersionId), true);
  assert.equal(liveState(fixture).versionId, LIVE_V1);
  assert.equal(hashFile(fixture.scriptFile), liveState(fixture).contentHash);
  let startup = null;
  try {
    createPrompterServer({
      scriptFile: fixture.scriptFile,
      previousFile: fixture.previousFile,
      libraryDir: fixture.libraryDir,
      journalDir: fixture.journalDir,
    });
  } catch (err) {
    startup = err;
  }
  assert.equal(startup instanceof StorageModeError, true);
  assert.equal(startup.code, 'unsupported-versioned-storage');
});

test('ordinary live operations refuse the repository and leave it unchanged', async () => {
  const ops = createVersionedLiveOperations({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
  });
  const refused = await ops.setLiveVersion({ productionId: LIVE, versionId: LIVE_V1 });
  assert.equal(refused.code, 'unsafe-root');
  Object.keys(REAL_FILES).forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), REAL_FILES[file]);
  });
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'migration.json')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'live-state.json')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'productions')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'live-journal')), false);
  assert.equal(LIVE_STAGES.includes('journal-committed'), true);
});

function snapshotBytes(fixture) {
  return {
    live: fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')),
    script: fs.readFileSync(fixture.scriptFile),
    marker: fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')),
    meta: fs.readFileSync(fixture.metaFile),
  };
}

function writeVersion(fixture, productionId, versionId, text) {
  const bytes = Buffer.from(text, 'utf8');
  const dir = path.join(fixture.libraryDir, 'productions', productionId, 'versions', versionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'script.txt'), bytes);
  writeJson(path.join(dir, 'version.json'), {
    id: versionId,
    productionId,
    role: 'edited',
    parentVersionId: null,
    origin: 'edited',
    legacyImagePolicy: 'production-assets',
    contentHash: hashBuffer(bytes),
    assetIds: [],
  });
}

async function crash(fixture, stage, request) {
  try {
    await fixture.ops.setLiveVersion(Object.assign({
      failAt: stage,
    }, expectation(fixture), request));
  } catch (err) {
    return err;
  }
  return null;
}
