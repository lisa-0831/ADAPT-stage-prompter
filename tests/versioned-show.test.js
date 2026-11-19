const test = require('node:test');
const { assertCheckoutSeedIntact } = require('./support/checkout-seed');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { runMigration } = require('../library-migration-cli');
const { createVersionStore, openReadOnlyVersionStore, VersionStoreError } = require('../library-version-store');
const { loadVersionedShow } = require('../server/versioned-show');

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
const PLAIN = '17171717-1717-4171-8171-171717171717';
const PLAIN_V1 = '18181818-1818-4181-8181-181818181818';
const PLAIN_V2 = '19191919-1919-4191-8191-191919191919';
const PLAIN_V3 = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
const PLAIN_MIGRATION = '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b';
const SHOW_A = '14141414-1414-4141-8141-141414141414';
const SHOW_B = '15151515-1515-4151-8151-151515151515';
const SHOW_A_V1 = '16161616-1616-4161-8161-161616161616';
const SHOW_B_V1 = '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c';
const SHOW_MIGRATION = '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';
const UNICODE_TITLE = '  欢迎 — “Café”  ';
const PLAIN_TEXT = '# Plain Show\nPRIVATE-PLAIN-CUE\n';
const TEXT_V2 = '# Plain Show\nPRIVATE-V2-CUE\n';
const TEXT_V3 = '# Plain Show\nPRIVATE-V3-CUE\n';
const TEXT_A = '# Show A\nPRIVATE-A-CUE\n';
const TEXT_B = '# Show B\nPRIVATE-B-CUE\n';
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

function hashFile(file) {
  return hashBuffer(fs.readFileSync(file));
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-show-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(dir) {
  const found = {};
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
  return () => {
    if (!pending.length) throw new Error('unexpected id allocation');
    return pending.shift();
  };
}

function refusingIds() {
  return () => {
    throw new Error('unexpected id allocation');
  };
}

function writeProduction(root, production) {
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(library, 'scripts', `${production.id}.txt`), production.text);
  if (!production.assets || !production.assets.length) return;
  const dir = path.join(library, 'assets', production.id);
  fs.mkdirSync(dir, { recursive: true });
  production.assets.forEach((asset) => {
    fs.writeFileSync(path.join(dir, `${asset.id}.${asset.ext}`), asset.body);
  });
  writeJson(path.join(dir, 'manifest.json'), {
    version: 1,
    assets: production.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      ext: asset.ext,
      mime: asset.mime,
      bytes: asset.body.length,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  });
}

function writeShow(root, spec) {
  fs.writeFileSync(path.join(root, 'script.txt'), spec.liveText);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  Object.keys(spec.images || {}).forEach((name) => {
    fs.writeFileSync(path.join(root, 'images', name), spec.images[name]);
  });
  spec.productions.forEach((production) => writeProduction(root, production));
  writeJson(path.join(root, 'data', 'library', 'index.json'), {
    version: 1,
    liveId: spec.liveId,
    scripts: spec.productions.map((production) => ({
      id: production.id,
      title: production.title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: hashBuffer(Buffer.from(production.text)),
    })),
  });
}

function commitShow(root, idList) {
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: ids(idList),
    now: () => '2026-11-16T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({ command: 'commit', root, createId: refusingIds() });
  assert.equal(committed.ok, true, committed.error);
  assert.equal(committed.activated, false);
  assert.equal(committed.mirrorInstalled, false);
  return committed;
}

function plainFixture(t) {
  const root = makeRoot(t);
  writeShow(root, {
    liveText: PLAIN_TEXT,
    liveId: PLAIN,
    productions: [{ id: PLAIN, title: UNICODE_TITLE, text: PLAIN_TEXT }],
  });
  commitShow(root, [PLAIN_MIGRATION, PLAIN_V1]);
  return {
    root,
    libraryDir: path.join(root, 'data', 'library'),
    scriptFile: path.join(root, 'script.txt'),
  };
}

function imageFixture(t) {
  const root = makeRoot(t);
  writeShow(root, {
    liveText: LIVE_TEXT,
    liveId: OTHER,
    images: { 'Card.png': PNG },
    productions: [
      { id: LIVE, title: 'Live Show', text: LIVE_TEXT },
      {
        id: OTHER,
        title: UNICODE_TITLE,
        text: OTHER_TEXT,
        assets: [
          { id: OWNED, name: 'Owned.png', ext: 'png', mime: 'image/png', body: PNG },
          { id: SPARE, name: 'Spare.jpg', ext: 'jpg', mime: 'image/jpeg', body: JPEG },
        ],
      },
      { id: TWIN, title: 'Twin Show', text: TWIN_TEXT },
    ],
  });
  commitShow(root, [MIGRATION, LIVE_V1, LIVE_V2, LIVE_ASSET, OTHER_V1, TWIN_V1, TWIN_V2, TWIN_ASSET]);
  return {
    root,
    libraryDir: path.join(root, 'data', 'library'),
    scriptFile: path.join(root, 'script.txt'),
  };
}

function twoShowFixture(t) {
  const root = makeRoot(t);
  writeShow(root, {
    liveText: TEXT_A,
    liveId: SHOW_A,
    productions: [
      { id: SHOW_A, title: 'Show A', text: TEXT_A },
      { id: SHOW_B, title: UNICODE_TITLE, text: TEXT_B },
    ],
  });
  commitShow(root, [SHOW_MIGRATION, SHOW_A_V1, SHOW_B_V1]);
  return {
    root,
    libraryDir: path.join(root, 'data', 'library'),
    scriptFile: path.join(root, 'script.txt'),
  };
}

function markerPath(libraryDir) {
  return path.join(libraryDir, 'migration.json');
}

function livePath(libraryDir) {
  return path.join(libraryDir, 'live-state.json');
}

function versionFile(libraryDir, productionId, versionId, name) {
  return path.join(libraryDir, 'productions', productionId, 'versions', versionId, name);
}

function versionHash(libraryDir, productionId, versionId) {
  return JSON.parse(fs.readFileSync(versionFile(libraryDir, productionId, versionId, 'version.json'), 'utf8')).contentHash;
}

function versionScript(libraryDir, productionId, versionId) {
  return fs.readFileSync(versionFile(libraryDir, productionId, versionId, 'script.txt'), 'utf8');
}

function writeLiveState(libraryDir, state) {
  writeJson(livePath(libraryDir), state);
}

function liveDocument(productionId, versionId, contentHash, previousActivation) {
  return {
    schema: 1,
    productionId,
    versionId,
    contentHash,
    previousActivation: previousActivation || null,
    updatedAt: '2026-04-04T00:00:00.000Z',
    generation: 4,
  };
}

function installMarker(libraryDir) {
  const marker = JSON.parse(fs.readFileSync(markerPath(libraryDir), 'utf8'));
  marker.mirrorInstalled = true;
  writeJson(markerPath(libraryDir), marker);
  return marker;
}

function replaceScriptHash(libraryDir, productionId, versionId, text) {
  const bytes = Buffer.from(text, 'utf8');
  const contentHash = hashBuffer(bytes);
  fs.writeFileSync(versionFile(libraryDir, productionId, versionId, 'script.txt'), bytes);
  const metaPath = versionFile(libraryDir, productionId, versionId, 'version.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.contentHash = contentHash;
  writeJson(metaPath, meta);
  return contentHash;
}

function assetFile(libraryDir, productionId, fileName) {
  return path.join(libraryDir, 'productions', productionId, 'assets', fileName);
}

function quiet(fn) {
  const calls = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = methods.map((method) => console[method]);
  methods.forEach((method) => {
    console[method] = (...args) => calls.push(args);
  });
  try {
    return { result: fn(), calls };
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
}

test('a committed schema-2 fixture is initialization pending and writes nothing', (t) => {
  const fixture = plainFixture(t);
  const before = snapshot(fixture.root);
  const markerBefore = fs.readFileSync(markerPath(fixture.libraryDir));
  const logged = quiet(() => loadVersionedShow({
    libraryDir: fixture.libraryDir,
    scriptFile: fixture.scriptFile,
  }));
  const loaded = logged.result;
  assert.equal(logged.calls.length, 0);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'initialization-required');
  assert.equal(loaded.code, 'initialization-required');
  assert.equal(loaded.initializationPending, true);
  assert.equal(loaded.activationReady, false);
  assert.equal(loaded.marker.schema, 2);
  assert.equal(loaded.marker.state, 'committed');
  assert.equal(loaded.marker.previousActivation, null);
  assert.equal(loaded.marker.mirrorInstalled, false);
  assert.equal(loaded.productionId, PLAIN);
  assert.equal(loaded.versionId, PLAIN_V1);
  assert.equal(loaded.headVersionId, PLAIN_V1);
  assert.equal(loaded.savedHeadDiffers, false);
  assert.equal(loaded.text, PLAIN_TEXT);
  assert.equal(loaded.contentHash, versionHash(fixture.libraryDir, PLAIN, PLAIN_V1));
  assert.equal(loaded.title, UNICODE_TITLE);
  assert.equal(loaded.generation, null);
  assert.equal(loaded.liveState, null);
  assert.equal(loaded.previousActivation, null);
  assert.equal(loaded.parentVersionId, null);
  assert.equal(fs.existsSync(livePath(fixture.libraryDir)), false);
  assert.equal(fs.readFileSync(markerPath(fixture.libraryDir)).equals(markerBefore), true);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('a schema-1 marker does not become a previous activation', (t) => {
  const fixture = plainFixture(t);
  const current = JSON.parse(fs.readFileSync(markerPath(fixture.libraryDir), 'utf8'));
  const schema1 = {
    schema: 1,
    state: 'committed',
    migrationId: current.migrationId,
    productionId: current.productionId,
    versionId: current.versionId,
    previousVersionId: MISSING_ID,
    sourceScriptHash: current.sourceScriptHash,
    contentHash: current.contentHash,
    mirrorInstalled: false,
  };
  writeJson(markerPath(fixture.libraryDir), schema1);
  const before = fs.readFileSync(markerPath(fixture.libraryDir));
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'initialization-required');
  assert.equal(loaded.marker.schema, 1);
  assert.equal(loaded.marker.previousActivation, null);
  assert.equal(loaded.previousActivation, null);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.marker, 'previousVersionId'), false);
  assert.equal(fs.readFileSync(markerPath(fixture.libraryDir)).equals(before), true);
  assert.equal(JSON.parse(before.toString('utf8')).previousVersionId, MISSING_ID);
  assert.equal(fs.existsSync(livePath(fixture.libraryDir)), false);
});

test('installed live state selects its version, including another production and an older head', async (t) => {
  const fixture = plainFixture(t);
  const store = createVersionStore({ root: fixture.libraryDir });
  const second = await store.saveVersion({
    productionId: PLAIN,
    expectedVersionId: PLAIN_V1,
    newVersionId: PLAIN_V2,
    text: TEXT_V2,
    createdAt: '2026-03-03T00:00:00.000Z',
  });
  assert.equal(second.ok, true, second.error);
  const third = await store.saveVersion({
    productionId: PLAIN,
    expectedVersionId: PLAIN_V2,
    newVersionId: PLAIN_V3,
    text: TEXT_V3,
    createdAt: '2026-03-04T00:00:00.000Z',
  });
  assert.equal(third.ok, true, third.error);
  const markerBefore = fs.readFileSync(markerPath(fixture.libraryDir));
  const v3Before = fs.readFileSync(versionFile(fixture.libraryDir, PLAIN, PLAIN_V3, 'script.txt'));
  installMarker(fixture.libraryDir);
  const v1Hash = versionHash(fixture.libraryDir, PLAIN, PLAIN_V1);
  const v2Hash = versionHash(fixture.libraryDir, PLAIN, PLAIN_V2);
  writeLiveState(fixture.libraryDir, liveDocument(PLAIN, PLAIN_V2, v2Hash, {
    productionId: PLAIN,
    versionId: PLAIN_V1,
    contentHash: v1Hash,
  }));
  fs.writeFileSync(fixture.scriptFile, TEXT_V2);
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'loadable');
  assert.equal(loaded.activationReady, true);
  assert.equal(loaded.productionId, PLAIN);
  assert.equal(loaded.versionId, PLAIN_V2);
  assert.equal(loaded.text, TEXT_V2);
  assert.equal(loaded.contentHash, v2Hash);
  assert.equal(loaded.headVersionId, PLAIN_V3);
  assert.equal(loaded.savedHeadDiffers, true);
  assert.equal(loaded.matchesInitialActivation, false);
  assert.equal(loaded.generation, 4);
  assert.deepEqual(loaded.previousActivation, {
    productionId: PLAIN,
    versionId: PLAIN_V1,
    contentHash: v1Hash,
  });
  assert.equal(loaded.parentVersionId, PLAIN_V1);
  assert.equal(loaded.marker.versionId, PLAIN_V1);
  assert.equal(JSON.parse(markerBefore.toString('utf8')).versionId, PLAIN_V1);
  assert.equal(fs.readFileSync(versionFile(fixture.libraryDir, PLAIN, PLAIN_V3, 'script.txt')).equals(v3Before), true);
  assert.notEqual(loaded.text, TEXT_V3);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('live state for production B does not return the marker production', (t) => {
  const fixture = twoShowFixture(t);
  installMarker(fixture.libraryDir);
  const hash = versionHash(fixture.libraryDir, SHOW_B, SHOW_B_V1);
  writeLiveState(fixture.libraryDir, liveDocument(SHOW_B, SHOW_B_V1, hash));
  fs.writeFileSync(fixture.scriptFile, TEXT_B);
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'loadable');
  assert.equal(loaded.productionId, SHOW_B);
  assert.equal(loaded.versionId, SHOW_B_V1);
  assert.equal(loaded.text, TEXT_B);
  assert.equal(loaded.title, UNICODE_TITLE);
  assert.equal(loaded.marker.productionId, SHOW_A);
  assert.equal(loaded.matchesInitialActivation, false);
  assert.equal(loaded.previousActivation, null);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('a finished installation without live state is refused and not rebuilt', (t) => {
  const fixture = plainFixture(t);
  installMarker(fixture.libraryDir);
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.status, 'refused');
  assert.equal(loaded.code, 'missing-live-state');
  assert.equal(loaded.text, null);
  assert.equal(JSON.stringify(loaded).includes('PRIVATE'), false);
  assert.equal(fs.existsSync(livePath(fixture.libraryDir)), false);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('malformed live state is refused and left in place', (t) => {
  const fixture = plainFixture(t);
  installMarker(fixture.libraryDir);
  fs.writeFileSync(livePath(fixture.libraryDir), '{');
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.code, 'invalid-live-state');
  assert.equal(loaded.text, null);
  assert.equal(fs.readFileSync(livePath(fixture.libraryDir), 'utf8'), '{');
  assert.deepEqual(snapshot(fixture.root), before);
});

test('a self-referential previous activation is refused', (t) => {
  const fixture = plainFixture(t);
  installMarker(fixture.libraryDir);
  const hash = versionHash(fixture.libraryDir, PLAIN, PLAIN_V1);
  writeLiveState(fixture.libraryDir, liveDocument(PLAIN, PLAIN_V1, hash, {
    productionId: PLAIN,
    versionId: PLAIN_V1,
    contentHash: hash,
  }));
  const before = fs.readFileSync(livePath(fixture.libraryDir));
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.code, 'invalid-previous-activation');
  assert.equal(loaded.text, null);
  assert.equal(fs.readFileSync(livePath(fixture.libraryDir)).equals(before), true);
});

test('a valid live state with an unfinished mirror installation asks for recovery', (t) => {
  const fixture = plainFixture(t);
  const hash = versionHash(fixture.libraryDir, PLAIN, PLAIN_V1);
  writeLiveState(fixture.libraryDir, liveDocument(PLAIN, PLAIN_V1, hash));
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'recovery-required');
  assert.equal(loaded.code, 'mirror-installation-incomplete');
  assert.deepEqual(loaded.recoveryRequirements, ['mirror-installation-incomplete']);
  assert.equal(loaded.matchesInitialActivation, true);
  assert.equal(loaded.text, PLAIN_TEXT);
  assert.equal(loaded.marker.mirrorInstalled, false);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('missing productions and versions are refused without a fallback', (t) => {
  const missingProduction = plainFixture(t);
  const marker = JSON.parse(fs.readFileSync(markerPath(missingProduction.libraryDir), 'utf8'));
  marker.productionId = MISSING_ID;
  writeJson(markerPath(missingProduction.libraryDir), marker);
  const missingProductionResult = loadVersionedShow(missingProduction);
  assert.equal(missingProductionResult.code, 'missing-production');
  assert.equal(missingProductionResult.text, null);
  assert.equal(fs.existsSync(path.join(missingProduction.libraryDir, 'productions', MISSING_ID)), false);

  const missingVersion = plainFixture(t);
  installMarker(missingVersion.libraryDir);
  writeLiveState(missingVersion.libraryDir, liveDocument(PLAIN, MISSING_ID, 'ab'.repeat(32)));
  const missingVersionResult = loadVersionedShow(missingVersion);
  assert.equal(missingVersionResult.code, 'missing-version');
  assert.equal(missingVersionResult.text, null);
  assert.equal(fs.existsSync(versionFile(missingVersion.libraryDir, PLAIN, MISSING_ID, 'script.txt')), false);
});

test('changed version bytes and a mismatched pointer hash are refused', (t) => {
  const changed = plainFixture(t);
  const scriptPath = versionFile(changed.libraryDir, PLAIN, PLAIN_V1, 'script.txt');
  const original = fs.readFileSync(scriptPath);
  const flipped = Buffer.from(original);
  flipped[flipped.length - 2] = flipped[flipped.length - 2] === 65 ? 66 : 65;
  fs.writeFileSync(scriptPath, flipped);
  const changedResult = loadVersionedShow(changed);
  assert.equal(changedResult.code, 'hash-mismatch');
  assert.equal(changedResult.text, null);
  assert.equal(JSON.stringify(changedResult).includes('PRIVATE'), false);
  assert.equal(fs.readFileSync(scriptPath).equals(flipped), true);

  const pointer = plainFixture(t);
  installMarker(pointer.libraryDir);
  writeLiveState(pointer.libraryDir, liveDocument(PLAIN, PLAIN_V1, 'cd'.repeat(32)));
  fs.writeFileSync(pointer.scriptFile, PLAIN_TEXT);
  const before = fs.readFileSync(versionFile(pointer.libraryDir, PLAIN, PLAIN_V1, 'script.txt'));
  const pointerResult = loadVersionedShow(pointer);
  assert.equal(pointerResult.code, 'hash-mismatch');
  assert.equal(pointerResult.text, null);
  assert.equal(fs.readFileSync(versionFile(pointer.libraryDir, PLAIN, PLAIN_V1, 'script.txt')).equals(before), true);
});

test('a stale compatibility mirror is reported and not rewritten', (t) => {
  const fixture = plainFixture(t);
  installMarker(fixture.libraryDir);
  const hash = versionHash(fixture.libraryDir, PLAIN, PLAIN_V1);
  writeLiveState(fixture.libraryDir, liveDocument(PLAIN, PLAIN_V1, hash));
  fs.writeFileSync(fixture.scriptFile, '# Plain Show\nSTALE-MIRROR\n');
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'recovery-required');
  assert.equal(loaded.code, 'mirror-recovery-required');
  assert.deepEqual(loaded.recoveryRequirements, ['mirror-recovery-required']);
  assert.equal(loaded.text, PLAIN_TEXT);
  assert.equal(loaded.versionId, PLAIN_V1);
  assert.equal(fs.readFileSync(fixture.scriptFile, 'utf8').includes('STALE-MIRROR'), true);
  assert.deepEqual(snapshot(fixture.root), before);
});

test('production images are verified by ownership, and unassigned images do not block the show', (t) => {
  const fixture = imageFixture(t);
  installMarker(fixture.libraryDir);
  const hash = versionHash(fixture.libraryDir, OTHER, OTHER_V1);
  writeLiveState(fixture.libraryDir, liveDocument(OTHER, OTHER_V1, hash));
  fs.writeFileSync(fixture.scriptFile, versionScript(fixture.libraryDir, OTHER, OTHER_V1));
  const spare = assetFile(fixture.libraryDir, OTHER, `${SPARE}.jpg`);
  const spareBytes = fs.readFileSync(spare);
  spareBytes[20] = spareBytes[20] === 1 ? 2 : 1;
  fs.writeFileSync(spare, spareBytes);
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'loadable');
  assert.equal(loaded.productionId, OTHER);
  assert.equal(loaded.legacyImagePolicy, 'production-assets');
  assert.equal(loaded.assets.length, 1);
  assert.equal(loaded.assets[0].assetId, OWNED);
  assert.equal(loaded.assets[0].productionId, OTHER);
  assert.equal(loaded.assets[0].contentHash, hashBuffer(PNG));
  assert.equal(loaded.assets.some((asset) => asset.assetId === SPARE), false);
  assert.deepEqual(snapshot(fixture.root), before);

  const foreignHash = replaceScriptHash(
    fixture.libraryDir,
    OTHER,
    OTHER_V1,
    `# Saved Show\n@image: library:${LIVE}/${LIVE_ASSET}\nPRIVATE-FOREIGN-CUE\n`,
  );
  writeLiveState(fixture.libraryDir, liveDocument(OTHER, OTHER_V1, foreignHash));
  const foreign = loadVersionedShow(fixture);
  assert.equal(foreign.code, 'foreign-asset');
  assert.equal(foreign.text, null);
  assert.equal(JSON.stringify(foreign).includes('PRIVATE-FOREIGN-CUE'), false);

  const missingHash = replaceScriptHash(
    fixture.libraryDir,
    OTHER,
    OTHER_V1,
    `# Saved Show\n@image: library:${OTHER}/${MISSING_ID}\nPRIVATE-MISSING-CUE\n`,
  );
  writeLiveState(fixture.libraryDir, liveDocument(OTHER, OTHER_V1, missingHash));
  const missing = loadVersionedShow(fixture);
  assert.equal(missing.code, 'missing-asset');
  assert.equal(missing.text, null);

  const ownedHash = replaceScriptHash(fixture.libraryDir, OTHER, OTHER_V1, OTHER_TEXT);
  writeLiveState(fixture.libraryDir, liveDocument(OTHER, OTHER_V1, ownedHash));
  const owned = assetFile(fixture.libraryDir, OTHER, `${OWNED}.png`);
  const ownedBytes = fs.readFileSync(owned);
  ownedBytes[20] = ownedBytes[20] === 1 ? 2 : 1;
  fs.writeFileSync(owned, ownedBytes);
  const corrupt = loadVersionedShow(fixture);
  assert.equal(corrupt.code, 'corrupt-asset');
  assert.equal(corrupt.text, null);
  assert.equal(fs.readFileSync(owned).equals(ownedBytes), true);
});

test('the original v1 reports the shared image and does not rewrite the reference', (t) => {
  const fixture = imageFixture(t);
  installMarker(fixture.libraryDir);
  const hash = versionHash(fixture.libraryDir, LIVE, LIVE_V1);
  writeLiveState(fixture.libraryDir, liveDocument(LIVE, LIVE_V1, hash));
  fs.writeFileSync(fixture.scriptFile, versionScript(fixture.libraryDir, LIVE, LIVE_V1));
  const before = snapshot(fixture.root);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'loadable');
  assert.equal(loaded.versionId, LIVE_V1);
  assert.equal(loaded.headVersionId, LIVE_V2);
  assert.equal(loaded.savedHeadDiffers, true);
  assert.equal(loaded.legacyImagePolicy, 'shared-images');
  assert.equal(loaded.historicalImagesImmutable, false);
  assert.equal(loaded.legacyImages.length, 1);
  assert.equal(loaded.legacyImages[0].path, 'images/Card.png');
  assert.equal(loaded.legacyImages[0].shared, true);
  assert.equal(loaded.legacyImages[0].immutable, false);
  assert.equal(loaded.text.includes('@image: images/Card.png'), true);
  assert.equal(loaded.text.includes('library:'), false);
  assert.deepEqual(snapshot(fixture.root), before);

  fs.rmSync(path.join(fixture.root, 'images', 'Card.png'));
  const unresolved = loadVersionedShow(fixture);
  assert.equal(unresolved.code, 'unresolved-image');
  assert.equal(unresolved.text, null);
  assert.equal(fs.existsSync(versionFile(fixture.libraryDir, LIVE, LIVE_V2, 'script.txt')), true);
});

test('unsafe library paths and symlink escapes are refused', (t) => {
  const fixture = plainFixture(t);
  const relative = loadVersionedShow({ libraryDir: 'data/library', scriptFile: fixture.scriptFile });
  assert.equal(relative.code, 'unsafe-path');
  const missing = loadVersionedShow({
    libraryDir: path.join(fixture.root, 'missing-library'),
    scriptFile: fixture.scriptFile,
  });
  assert.equal(missing.code, 'missing-library');
  assert.equal(fs.existsSync(path.join(fixture.root, 'missing-library')), false);
  const nulled = loadVersionedShow({ libraryDir: `${fixture.libraryDir}\0`, scriptFile: fixture.scriptFile });
  assert.equal(nulled.code, 'unsafe-path');

  const link = path.join(fixture.root, 'library-link');
  fs.symlinkSync(fixture.libraryDir, link);
  const linked = loadVersionedShow({ libraryDir: link, scriptFile: fixture.scriptFile });
  assert.equal(linked.code, 'unsafe-path');

  const outside = path.join(fixture.root, 'outside-marker.json');
  const outsideBytes = fs.readFileSync(markerPath(fixture.libraryDir));
  fs.writeFileSync(outside, outsideBytes);
  fs.rmSync(markerPath(fixture.libraryDir));
  fs.symlinkSync(outside, markerPath(fixture.libraryDir));
  const markerLink = loadVersionedShow(fixture);
  assert.equal(markerLink.code, 'unsafe-marker');
  assert.equal(fs.readFileSync(outside).equals(outsideBytes), true);

  const restored = plainFixture(t);
  const outsideScript = path.join(restored.root, 'outside-script.txt');
  fs.writeFileSync(outsideScript, 'OUTSIDE-SCRIPT\n');
  fs.rmSync(versionFile(restored.libraryDir, PLAIN, PLAIN_V1, 'script.txt'));
  fs.symlinkSync(outsideScript, versionFile(restored.libraryDir, PLAIN, PLAIN_V1, 'script.txt'));
  const versionLink = loadVersionedShow(restored);
  assert.equal(versionLink.code, 'unsafe-path');
  assert.equal(versionLink.text, null);
  assert.equal(fs.readFileSync(outsideScript, 'utf8'), 'OUTSIDE-SCRIPT\n');

  const image = imageFixture(t);
  installMarker(image.libraryDir);
  const hash = versionHash(image.libraryDir, OTHER, OTHER_V1);
  writeLiveState(image.libraryDir, liveDocument(OTHER, OTHER_V1, hash));
  const owned = assetFile(image.libraryDir, OTHER, `${OWNED}.png`);
  const outsideImage = path.join(image.root, 'outside.png');
  fs.writeFileSync(outsideImage, PNG);
  fs.rmSync(owned);
  fs.symlinkSync(outsideImage, owned);
  const assetLink = loadVersionedShow(image);
  assert.equal(assetLink.code, 'unsafe-path');
  assert.equal(assetLink.text, null);
  assert.equal(fs.readFileSync(outsideImage).equals(PNG), true);
});

test('startup still refuses a committed marker before opening the show', (t) => {
  const fixture = plainFixture(t);
  const journalDir = path.join(fixture.root, 'data', 'live-journal');
  fs.mkdirSync(path.join(journalDir, 'pending'), { recursive: true });
  const before = snapshot(fixture.root);
  let error = null;
  try {
    createPrompterServer({
      scriptFile: fixture.scriptFile,
      previousFile: path.join(fixture.root, 'script.previous.txt'),
      libraryDir: fixture.libraryDir,
      journalDir,
    });
  } catch (err) {
    error = err;
  }
  assert.equal(error instanceof StorageModeError, true);
  assert.equal(error.code, 'unsupported-versioned-storage');
  assert.equal(fs.existsSync(livePath(fixture.libraryDir)), false);
  assert.deepEqual(snapshot(fixture.root), before);
  const loaded = loadVersionedShow(fixture);
  assert.equal(loaded.status, 'initialization-required');
});

test('the writable version store still rejects this repository', () => {
  assert.throws(
    () => createVersionStore({ root: REPO }),
    (err) => err instanceof VersionStoreError && err.code === 'unsafe-path',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-readonly-'));
  try {
    const opened = openReadOnlyVersionStore({ root });
    assert.equal(opened.readOnly, true);
    assert.equal(opened.saveVersion, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repository show, library, images, and journal stay untouched', () => {
  const expected = {
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
  REAL_FILES.forEach((file) => {
    assert.equal(hashFile(path.join(REPO, file)), expected[file]);
  });
  assertCheckoutSeedIntact(REPO);
});
