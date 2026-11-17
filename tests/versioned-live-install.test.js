const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { runMigration } = require('../library-migration-cli');
const { recoverLiveFiles } = require('../live-script-store');
const { loadVersionedShow } = require('../server/versioned-show');
const {
  INSTALL_STAGES,
  InstallError,
  installVersionedLive,
  recoverVersionedInstall,
} = require('../server/versioned-live-install');

const REPO = path.resolve(__dirname, '..');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TWIN = '33333333-3333-4333-8333-333333333333';
const OWNED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SPARE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const LIVE_V1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const LIVE_V2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const LIVE_ASSET = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const OTHER_V1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const TWIN_V1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const TWIN_V2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const TWIN_ASSET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
const STALE_ID = '99999999-9999-4999-8999-999999999999';
const NOW = '2026-05-05T00:00:00.000Z';
const LIVE_TEXT = '# Live Show\n@image: images/Card.png\nPRIVATE-LIVE-CUE\n';
const OTHER_TEXT = `# Saved Show\n@image: library:${OTHER}/${OWNED}\nPRIVATE-SAVED-CUE\n`;
const TWIN_TEXT = '# Twin Show\n@image: images/Card.png\nPRIVATE-TWIN-CUE\n';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(dir) {
  const found = {};
  if (!fs.existsSync(dir)) return found;
  function walk(current) {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      const key = path.relative(dir, full);
      if (entry.isSymbolicLink()) {
        found[key] = `symlink:${fs.readlinkSync(full)}`;
        return;
      }
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      if (entry.name === '.writer.lock') return;
      found[key] = hashBuffer(fs.readFileSync(full));
    });
  }
  walk(dir);
  return found;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function ids(list) {
  const pending = list.slice();
  return () => pending.shift();
}

function imageFixture(t) {
  const root = makeRoot(t);
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'Card.png'), PNG);
  [
    { id: LIVE, title: 'Live Show', text: LIVE_TEXT },
    { id: OTHER, title: 'Saved Show', text: OTHER_TEXT },
    { id: TWIN, title: 'Twin Show', text: TWIN_TEXT },
  ].forEach((production) => {
    fs.writeFileSync(path.join(library, 'scripts', `${production.id}.txt`), production.text);
  });
  const ownedDir = path.join(library, 'assets', OTHER);
  fs.mkdirSync(ownedDir, { recursive: true });
  fs.writeFileSync(path.join(ownedDir, `${OWNED}.png`), PNG);
  fs.writeFileSync(path.join(ownedDir, `${SPARE}.jpg`), JPEG);
  writeJson(path.join(ownedDir, 'manifest.json'), {
    version: 1,
    assets: [
      { id: OWNED, name: 'Owned.png', ext: 'png', mime: 'image/png', bytes: PNG.length, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: SPARE, name: 'Spare.jpg', ext: 'jpg', mime: 'image/jpeg', bytes: JPEG.length, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  writeJson(path.join(library, 'index.json'), {
    version: 1,
    liveId: OTHER,
    scripts: [
      { id: LIVE, title: 'Live Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: hashBuffer(Buffer.from(LIVE_TEXT)) },
      { id: OTHER, title: 'Saved Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: hashBuffer(Buffer.from(OTHER_TEXT)) },
      { id: TWIN, title: 'Twin Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: hashBuffer(Buffer.from(TWIN_TEXT)) },
    ],
  });
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: ids([MIGRATION, LIVE_V1, LIVE_V2, LIVE_ASSET, OTHER_V1, TWIN_V1, TWIN_V2, TWIN_ASSET]),
    now: () => '2026-11-16T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({ command: 'commit', root, createId: () => { throw new Error('unexpected id'); } });
  assert.equal(committed.ok, true, committed.error);
  const previous = fs.readFileSync(path.join(root, 'script.previous.txt'));
  writeJson(path.join(root, 'script.previous.txt.meta.json'), {
    liveId: STALE_ID,
    textHash: hashBuffer(previous),
  });
  return {
    root,
    libraryDir: library,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    metaFile: path.join(root, 'script.previous.txt.meta.json'),
    journalDir: path.join(root, 'data', 'live-journal'),
  };
}

function versionPath(fixture, versionId, name) {
  return path.join(fixture.libraryDir, 'productions', LIVE, 'versions', versionId, name);
}

function install(fixture, extra) {
  return installVersionedLive(Object.assign({
    now: () => NOW,
  }, fixture, extra || {}));
}

function crash(fixture, stage) {
  try {
    install(fixture, { failAt: stage });
  } catch (err) {
    return err;
  }
  return null;
}

function assertInstalled(fixture, beforeProductions) {
  const state = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'productions', LIVE, 'metadata.json'), 'utf8'));
  assert.equal(state.schema, 1);
  assert.equal(state.productionId, LIVE);
  assert.equal(state.versionId, LIVE_V2);
  assert.equal(state.contentHash, hashFile(versionPath(fixture, LIVE_V2, 'script.txt')));
  assert.equal(state.previousActivation, null);
  assert.equal(state.updatedAt, NOW);
  assert.equal(state.generation, 1);
  assert.equal(marker.schema, 2);
  assert.equal(marker.migrationId, MIGRATION);
  assert.equal(marker.productionId, LIVE);
  assert.equal(marker.versionId, LIVE_V2);
  assert.equal(marker.previousActivation, null);
  assert.equal(marker.mirrorInstalled, true);
  assert.equal(metadata.headVersionId, LIVE_V2);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(fs.readFileSync(versionPath(fixture, LIVE_V2, 'script.txt'))), true);
  assert.notEqual(hashFile(versionPath(fixture, LIVE_V1, 'script.txt')), hashFile(fixture.scriptFile));
  assert.deepEqual(snapshot(path.join(fixture.libraryDir, 'productions')), beforeProductions);
  const viewed = loadVersionedShow(fixture);
  assert.equal(viewed.status, 'loadable');
  assert.equal(viewed.productionId, LIVE);
  assert.equal(viewed.versionId, LIVE_V2);
  assert.equal(viewed.previousActivation, null);
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
}

test('initial installation writes live state and the v2 mirror once', (t) => {
  const fixture = imageFixture(t);
  const productions = snapshot(path.join(fixture.libraryDir, 'productions'));
  const v1 = fs.readFileSync(versionPath(fixture, LIVE_V1, 'script.txt'));
  const v2 = fs.readFileSync(versionPath(fixture, LIVE_V2, 'script.txt'));
  const meta = fs.readFileSync(fixture.metaFile);
  const previous = fs.readFileSync(fixture.previousFile);
  const index = fs.readFileSync(path.join(fixture.libraryDir, 'index.json'));
  const card = fs.readFileSync(path.join(fixture.root, 'images', 'Card.png'));
  assert.equal(v1.equals(Buffer.from(LIVE_TEXT)), true);
  assert.equal(v2.equals(v1), false);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(v1), true);
  const first = install(fixture);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.unchanged, false);
  assert.equal(first.productionId, LIVE);
  assert.equal(first.versionId, LIVE_V2);
  assert.equal(first.previousActivation, null);
  assert.equal(first.generation, 1);
  assert.equal(first.mirrorInstalled, true);
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
  assertInstalled(fixture, productions);
  assert.equal(fs.readFileSync(versionPath(fixture, LIVE_V1, 'script.txt')).equals(v1), true);
  assert.equal(fs.readFileSync(versionPath(fixture, LIVE_V2, 'script.txt')).equals(v2), true);
  assert.equal(fs.readFileSync(fixture.metaFile).equals(meta), true);
  assert.equal(fs.readFileSync(fixture.previousFile).equals(previous), true);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'index.json')).equals(index), true);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'images', 'Card.png')).equals(card), true);
  assert.equal(JSON.parse(fs.readFileSync(fixture.metaFile, 'utf8')).liveId, STALE_ID);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'));
  const stateBytes = fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'));
  const second = install(fixture);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.unchanged, true);
  assert.equal(second.generation, 1);
  assert.equal(second.previousActivation, null);
  assert.equal(second.productionId, LIVE);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json')).equals(stateBytes), true);
  assert.equal(state.generation, 1);
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

test('every installation checkpoint resumes the same version', (t) => {
  INSTALL_STAGES.forEach((stage) => {
    const fixture = imageFixture(t);
    const productions = snapshot(path.join(fixture.libraryDir, 'productions'));
    const source = fs.readFileSync(fixture.scriptFile);
    const error = crash(fixture, stage);
    assert.equal(error instanceof InstallError, true);
    assert.equal(error.stage, stage);
    const viewed = loadVersionedShow(fixture);
    if (stage === 'before-journal' || stage === 'pending-written' || stage === 'journal-committed' || stage === 'before-live-state') {
      assert.equal(viewed.status, 'initialization-required');
      assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json')), false);
      assert.equal(fs.readFileSync(fixture.scriptFile).equals(source), true);
    } else if (stage === 'after-live-state' || stage === 'before-mirror') {
      assert.equal(viewed.status, 'recovery-required');
      assert.equal(viewed.versionId, LIVE_V2);
    } else if (stage === 'after-mirror' || stage === 'before-marker') {
      assert.equal(viewed.status, 'recovery-required');
      assert.equal(viewed.code, 'mirror-installation-incomplete');
      assert.equal(fs.readFileSync(fixture.scriptFile).equals(fs.readFileSync(versionPath(fixture, LIVE_V2, 'script.txt'))), true);
    } else {
      assert.equal(viewed.status, 'loadable');
    }
    if (stage === 'pending-written') {
      const pending = recoverVersionedInstall(fixture);
      assert.equal(pending.applied, false);
      assert.equal(pending.activated, false);
      assert.equal(pending.reason, 'pending');
      assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json')), false);
      assert.equal(fs.existsSync(path.join(fixture.journalDir, 'pending')), false);
      assert.equal(fs.existsSync(path.join(fixture.journalDir, 'committed')), false);
      const preserved = fs.readFileSync(fixture.scriptFile);
      recoverLiveFiles({
        scriptFile: fixture.scriptFile,
        previousFile: fixture.previousFile,
        metaFile: fixture.metaFile,
        journalDir: fixture.journalDir,
      });
      assert.equal(fs.readFileSync(fixture.scriptFile).equals(preserved), true);
      assert.equal(fs.existsSync(path.join(fixture.journalDir, 'versioned-live', 'pending')), true);
    }
    const resumed = stage === 'before-journal' || stage === 'pending-written'
      ? install(fixture)
      : recoverVersionedInstall(fixture);
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.productionId, LIVE);
    assert.equal(resumed.versionId, LIVE_V2);
    assert.equal(resumed.previousActivation, null);
    assertInstalled(fixture, productions);
  });
});

test('a pending journal for another production is not activated', (t) => {
  const fixture = imageFixture(t);
  const error = crash(fixture, 'pending-written');
  assert.equal(error.stage, 'pending-written');
  const planPath = path.join(fixture.journalDir, 'versioned-live', 'pending', 'plan.json');
  const statePath = path.join(fixture.journalDir, 'versioned-live', 'pending', 'live-state.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  plan.productionId = OTHER;
  state.productionId = OTHER;
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  plan.liveStateHash = hashBuffer(stateBytes);
  writeJson(planPath, plan);
  fs.writeFileSync(statePath, stateBytes);
  const source = fs.readFileSync(fixture.scriptFile);
  const resumed = install(fixture);
  assert.equal(resumed.code, 'journal-conflict');
  assert.equal(JSON.stringify(resumed).includes('PRIVATE'), false);
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json')), false);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(source), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json'), 'utf8')).mirrorInstalled, false);
});

test('missing or corrupt live state after installation is not rebuilt', (t) => {
  const fixture = imageFixture(t);
  assert.equal(install(fixture).ok, true);
  const marker = fs.readFileSync(path.join(fixture.libraryDir, 'migration.json'));
  const script = fs.readFileSync(fixture.scriptFile);
  fs.rmSync(path.join(fixture.libraryDir, 'live-state.json'));
  const missing = install(fixture);
  assert.equal(missing.code, 'missing-live-state');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json')), false);
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'migration.json')).equals(marker), true);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(script), true);

  writeJson(path.join(fixture.libraryDir, 'live-state.json'), { schema: 1 });
  fs.writeFileSync(path.join(fixture.libraryDir, 'live-state.json'), '{');
  const corrupt = install(fixture);
  assert.equal(corrupt.code, 'invalid-live-state');
  assert.equal(fs.readFileSync(path.join(fixture.libraryDir, 'live-state.json'), 'utf8'), '{');
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(script), true);
});

test('a corrupt journal is refused and left in place', (t) => {
  const fixture = imageFixture(t);
  assert.equal(crash(fixture, 'journal-committed').stage, 'journal-committed');
  const planPath = path.join(fixture.journalDir, 'versioned-live', 'committed', 'plan.json');
  fs.writeFileSync(planPath, '{');
  const source = fs.readFileSync(fixture.scriptFile);
  const recovered = recoverVersionedInstall(fixture);
  assert.equal(recovered.code, 'corrupt-journal');
  assert.equal(JSON.stringify(recovered).includes('PRIVATE'), false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), '{');
  assert.equal(fs.existsSync(path.join(fixture.libraryDir, 'live-state.json')), false);
  assert.equal(fs.readFileSync(fixture.scriptFile).equals(source), true);
});

test('an unexpected mirror and a corrupt image block installation', (t) => {
  const unexpected = imageFixture(t);
  const productions = snapshot(path.join(unexpected.libraryDir, 'productions'));
  fs.writeFileSync(unexpected.scriptFile, '# Live Show\nUNEXPECTED-MIRROR\n');
  const refused = install(unexpected);
  assert.equal(refused.code, 'mirror-conflict');
  assert.equal(fs.readFileSync(unexpected.scriptFile, 'utf8').includes('UNEXPECTED-MIRROR'), true);
  assert.equal(fs.existsSync(path.join(unexpected.libraryDir, 'live-state.json')), false);
  assert.deepEqual(snapshot(path.join(unexpected.libraryDir, 'productions')), productions);

  const image = imageFixture(t);
  const asset = path.join(image.libraryDir, 'productions', LIVE, 'assets', `${LIVE_ASSET}.png`);
  const bytes = fs.readFileSync(asset);
  bytes[20] = bytes[20] === 1 ? 2 : 1;
  fs.writeFileSync(asset, bytes);
  const corrupt = install(image);
  assert.equal(corrupt.code, 'corrupt-asset');
  assert.equal(fs.readFileSync(asset).equals(bytes), true);
  assert.equal(fs.existsSync(path.join(image.libraryDir, 'live-state.json')), false);
  fs.rmSync(asset);
  const missing = install(image);
  assert.equal(missing.code, 'missing-asset');
  assert.equal(fs.existsSync(path.join(image.libraryDir, 'live-state.json')), false);
});

test('installation refuses the repository and does not change its files', () => {
  const refused = installVersionedLive({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    previousFile: path.join(REPO, 'script.previous.txt'),
    metaFile: path.join(REPO, 'script.previous.txt.meta.json'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
    now: () => NOW,
  });
  assert.equal(refused.code, 'unsafe-root');
  assert.equal(installVersionedLive({ root: 'relative/fixture' }).code, 'root-required');
  Object.keys(REAL_FILES).forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), REAL_FILES[file]);
  });
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'migration.json')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'live-state.json')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'productions')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'live-journal')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', '.writer.lock')), false);
});
