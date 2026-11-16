const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrompterServer } = require('../server');
const { StorageModeError, detectStorageMode } = require('../server/storage-mode');
const { MigrationError, runCli, runMigration } = require('../library-migration-cli');

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
const SIMPLE = '12121212-1212-4121-8121-121212121212';
const SIMPLE_V1 = '13131313-1313-4131-8131-131313131313';
const SIMPLE_V2 = '14141414-1414-4141-8141-141414141414';
const SIMPLE_ASSET = '15151515-1515-4151-8151-151515151515';
const SIMPLE_MIGRATION = '16161616-1616-4161-8161-161616161616';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);
const LIVE_TEXT = '# Live Show\n@image: images/Card.png\nPRIVATE-LIVE-CUE\n';
const OTHER_TEXT = `# Saved Show\n@image: library:${OTHER}/${OWNED}\nPRIVATE-SAVED-CUE\n`;
const TWIN_TEXT = '# Twin Show\n@image: images/Card.png\nPRIVATE-TWIN-CUE\n';
const SIMPLE_TEXT = '# Simple\n@image: images/Card.png\nPRIVATE-SIMPLE-CUE\n';

const REAL_FILES = [
  'script.txt',
  'script.previous.txt',
  'script.previous.txt.meta.json',
  'data/library/index.json',
  'data/library/scripts/2d0f0937-fc36-4d27-a31e-d047c2fd5623.txt',
  'data/library/scripts/ee04e849-90d4-4eeb-b2a6-562b06067a32.txt',
  'images/Title_Card.jpeg',
  'images/Cap_Back2.jpeg',
  'images/Cap_Back3.jpeg',
  'images/Cap_Back4.jpeg',
];

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(dir) {
  const found = {};
  function walk(current) {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      found[path.relative(dir, full)] = hashBuffer(fs.readFileSync(full));
    });
  }
  walk(dir);
  return found;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assetManifest(assets) {
  return {
    version: 1,
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      ext: asset.ext,
      mime: asset.mime,
      bytes: asset.body.length,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
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
  writeJson(path.join(dir, 'manifest.json'), assetManifest(production.assets));
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

function fullShow(root) {
  writeShow(root, {
    liveText: LIVE_TEXT,
    liveId: OTHER,
    images: { 'Card.png': PNG },
    productions: [
      { id: LIVE, title: 'Live Show', text: LIVE_TEXT },
      {
        id: OTHER,
        title: 'Saved Show',
        text: OTHER_TEXT,
        assets: [
          { id: OWNED, name: 'Owned.png', ext: 'png', mime: 'image/png', body: PNG },
          { id: SPARE, name: 'Spare.jpg', ext: 'jpg', mime: 'image/jpeg', body: JPEG },
        ],
      },
      { id: TWIN, title: 'Twin Show', text: TWIN_TEXT },
    ],
  });
}

function simpleShow(root) {
  writeShow(root, {
    liveText: SIMPLE_TEXT,
    liveId: SIMPLE,
    images: { 'Card.png': PNG },
    productions: [{ id: SIMPLE, title: 'Simple', text: SIMPLE_TEXT }],
  });
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

function protectedFiles(root) {
  return [
    path.join(root, 'script.txt'),
    path.join(root, 'script.previous.txt'),
    path.join(root, 'script.previous.txt.meta.json'),
    path.join(root, 'data', 'library', 'index.json'),
    path.join(root, 'images', 'Card.png'),
  ];
}

function attemptOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'library', 'migration-attempt.json'), 'utf8'));
}

test('dry run reports the fixture and writes nothing', (t) => {
  const root = makeRoot(t);
  fullShow(root);
  const before = snapshot(root);
  const report = runMigration({ command: 'dry-run', root, createId: refusingIds() });
  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.safeToPrepare, true);
  assert.equal(report.productionCount, 3);
  assert.equal(report.liveProductionId, LIVE);
  assert.equal(report.libraryLiveId, OTHER);
  assert.equal(report.liveIdDrift, true);
  assert.equal(report.proposedVersions.v1, 3);
  assert.equal(report.proposedVersions.v2, 2);
  assert.equal(report.legacyImageConversions.length, 2);
  assert.deepEqual(report.unassignedAssets.map((asset) => asset.assetId), [SPARE]);
  assert.equal(report.blockingErrors.length, 0);
  assert.equal(JSON.stringify(report).includes('PRIVATE-LIVE-CUE'), false);
  const verified = runMigration({ command: 'verify', root });
  assert.equal(verified.readOnly, true);
  assert.equal(verified.ready, false);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-attempt.json')), false);
});

test('a missing legacy image blocks preparation', (t) => {
  const root = makeRoot(t);
  writeShow(root, {
    liveText: LIVE_TEXT,
    liveId: LIVE,
    productions: [{ id: LIVE, title: 'Live Show', text: LIVE_TEXT }],
  });
  const before = snapshot(root);
  const result = runMigration({ command: 'prepare', root, createId: refusingIds() });
  assert.equal(result.safeToPrepare, false);
  assert.equal(result.blockingErrors.some((error) => error.code === 'missing-image' && error.path === 'images/Card.png'), true);
  assert.equal(JSON.stringify(result).includes('PRIVATE-LIVE-CUE'), false);
  assert.deepEqual(snapshot(root), before);
});

test('an explicit temporary root is required', (t) => {
  const messages = [];
  const stdout = { write(chunk) { messages.push(chunk); } };
  assert.equal(runCli(['--dry-run'], { stdout }), 1);
  assert.equal(JSON.parse(messages[0]).code, 'root-required');
  const root = makeRoot(t);
  assert.equal(runMigration({ command: 'prepare', root: 'relative/fixture' }).code, 'root-required');
  const missing = path.join(os.tmpdir(), `prompter-missing-${process.pid}`);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(runMigration({ command: 'prepare', root: missing }).code, 'missing-root');
  assert.equal(runMigration({ command: 'prepare', root: REPO }).code, 'unsafe-root');
  assert.equal(runMigration({ command: 'commit', root: REPO }).code, 'unsafe-root');
  assert.equal(runMigration({ command: 'dry-run', root: REPO }).code, 'unsafe-root');
});

test('missing and ambiguous live matches block preparation without writes', (t) => {
  const missing = makeRoot(t);
  writeShow(missing, {
    liveText: '# Nobody\nNo match.\n',
    liveId: LIVE,
    productions: [
      { id: LIVE, title: 'Live Show', text: '# Live Show\nHello.\n' },
      { id: OTHER, title: 'Saved Show', text: '# Saved Show\nHello.\n' },
    ],
  });
  const missingBefore = snapshot(missing);
  const missingResult = runMigration({ command: 'prepare', root: missing, createId: refusingIds() });
  assert.equal(missingResult.safeToPrepare, false);
  assert.equal(missingResult.code, 'no-live-match');
  assert.deepEqual(snapshot(missing), missingBefore);

  const ambiguous = makeRoot(t);
  const same = '# Same\nHello.\n';
  writeShow(ambiguous, {
    liveText: same,
    liveId: LIVE,
    productions: [
      { id: LIVE, title: 'One', text: same },
      { id: OTHER, title: 'Two', text: same },
    ],
  });
  const ambiguousBefore = snapshot(ambiguous);
  const ambiguousResult = runMigration({ command: 'prepare', root: ambiguous, createId: refusingIds() });
  assert.equal(ambiguousResult.code, 'ambiguous-live-match');
  assert.deepEqual(ambiguousResult.blockingErrors[0].productionIds, [LIVE, OTHER]);
  assert.deepEqual(snapshot(ambiguous), ambiguousBefore);
});

test('a journal blocks preparation and stays unchanged', (t) => {
  const root = makeRoot(t);
  simpleShow(root);
  const journal = path.join(root, 'data', 'live-journal', 'pending', 'note.txt');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, 'journal-bytes\n');
  const before = hashBuffer(fs.readFileSync(journal));
  const result = runMigration({ command: 'prepare', root, createId: refusingIds() });
  assert.equal(result.code, 'activation-artifact');
  assert.equal(hashBuffer(fs.readFileSync(journal)), before);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-attempt.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);
});

test('two productions keep their scripts, owned assets, and distinct image copies', (t) => {
  const root = makeRoot(t);
  fullShow(root);
  const before = snapshot(root);
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: ids([MIGRATION, LIVE_V1, LIVE_V2, LIVE_ASSET, OTHER_V1, TWIN_V1, TWIN_V2, TWIN_ASSET]),
    now: () => '2026-11-16T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.activated, false);
  assert.equal(prepared.liveProductionId, LIVE);
  assert.equal(prepared.pointer.versionId, LIVE_V2);
  assert.equal(prepared.pointer.previousVersionId, LIVE_V1);
  assert.equal(prepared.pointer.productionId, LIVE);
  const liveOriginal = fs.readFileSync(path.join(root, 'data', 'library', 'migration-work', 'productions', LIVE, 'versions', LIVE_V1, 'script.txt'));
  assert.equal(liveOriginal.equals(Buffer.from(LIVE_TEXT)), true);
  const liveMigrated = fs.readFileSync(path.join(root, 'data', 'library', 'migration-work', 'productions', LIVE, 'versions', LIVE_V2, 'script.txt'), 'utf8');
  assert.equal(liveMigrated.includes(`library:${LIVE}/${LIVE_ASSET}`), true);
  assert.equal(liveMigrated.includes('images/Card.png'), false);
  const otherVersions = fs.readdirSync(path.join(root, 'data', 'library', 'migration-work', 'productions', OTHER, 'versions'));
  assert.deepEqual(otherVersions, [OTHER_V1]);
  const otherOriginal = fs.readFileSync(path.join(root, 'data', 'library', 'migration-work', 'productions', OTHER, 'versions', OTHER_V1, 'script.txt'), 'utf8');
  assert.equal(otherOriginal, OTHER_TEXT);
  const liveCopy = path.join(root, 'data', 'library', 'migration-work', 'productions', LIVE, 'assets', `${LIVE_ASSET}.png`);
  const twinCopy = path.join(root, 'data', 'library', 'migration-work', 'productions', TWIN, 'assets', `${TWIN_ASSET}.png`);
  assert.equal(fs.readFileSync(liveCopy).equals(PNG), true);
  assert.equal(fs.readFileSync(twinCopy).equals(PNG), true);
  assert.equal(fs.statSync(liveCopy).ino === fs.statSync(twinCopy).ino, false);
  assert.equal(fs.statSync(liveCopy).nlink, 1);
  assert.equal(fs.statSync(twinCopy).nlink, 1);
  const spare = path.join(root, 'data', 'library', 'migration-work', 'productions', OTHER, 'assets', `${SPARE}.jpg`);
  assert.equal(fs.readFileSync(spare).equals(JPEG), true);
  assert.equal(otherOriginal.includes(SPARE), false);
  assert.equal(otherOriginal.includes(OWNED), true);
  protectedFiles(root).forEach((file) => {
    assert.equal(before[path.relative(root, file)], hashBuffer(fs.readFileSync(file)));
  });
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'live-state.json')), false);

  const committed = runMigration({ command: 'commit', root, createId: refusingIds() });
  assert.equal(committed.ok, true);
  assert.equal(committed.committed, true);
  assert.equal(committed.activated, false);
  assert.equal(committed.mirrorInstalled, false);
  assert.equal(committed.marker.productionId, LIVE);
  assert.equal(committed.marker.versionId, LIVE_V2);
  assert.equal(committed.marker.mirrorInstalled, false);
  const publishedManifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'library', 'productions', OTHER, 'assets', 'manifest.json'), 'utf8'));
  assert.equal(publishedManifest.assets.some((asset) => asset.assetId === SPARE && asset.referenced === false), true);
  assert.equal(publishedManifest.assets.some((asset) => asset.assetId === OWNED), true);
  const markerFile = path.join(root, 'data', 'library', 'migration.json');
  const markerBytes = fs.readFileSync(markerFile);
  const again = runMigration({ command: 'commit', root, createId: refusingIds() });
  assert.equal(again.alreadyCommitted, true);
  assert.equal(fs.readFileSync(markerFile).equals(markerBytes), true);
  const mode = detectStorageMode({ libraryDir: path.join(root, 'data', 'library') });
  assert.equal(mode.mode, 'versioned');
  assert.equal(mode.supported, false);
  assert.throws(
    () => createPrompterServer({
      scriptFile: path.join(root, 'script.txt'),
      libraryDir: path.join(root, 'data', 'library'),
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );
  assert.equal(fs.readFileSync(path.join(root, 'script.txt')).equals(Buffer.from(LIVE_TEXT)), true);
  const refused = runMigration({ command: 'abort', root });
  assert.equal(refused.code, 'abort-refused');
  assert.equal(fs.readFileSync(markerFile).equals(markerBytes), true);
});

test('partial preparation resumes with the original ids', (t) => {
  const root = makeRoot(t);
  simpleShow(root);
  assert.throws(
    () => runMigration({
      command: 'prepare',
      root,
      failAt: 'v1',
      createId: ids([SIMPLE_MIGRATION, SIMPLE_V1, SIMPLE_V2, SIMPLE_ASSET]),
    }),
    (err) => err instanceof MigrationError && err.code === 'injected-failure',
  );
  const recorded = attemptOf(root);
  assert.equal(recorded.migrationId, SIMPLE_MIGRATION);
  assert.equal(recorded.ids[SIMPLE].v1, SIMPLE_V1);
  assert.equal(recorded.ids[SIMPLE].v2, SIMPLE_V2);
  const resumed = runMigration({ command: 'prepare', root, createId: refusingIds() });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.migrationId, SIMPLE_MIGRATION);
  assert.equal(resumed.pointer.versionId, SIMPLE_V2);
  const original = fs.readFileSync(path.join(root, 'data', 'library', 'migration-work', 'productions', SIMPLE, 'versions', SIMPLE_V1, 'script.txt'));
  assert.equal(original.equals(Buffer.from(SIMPLE_TEXT)), true);
});

test('source changes and an invalid READY block commit', (t) => {
  const changed = makeRoot(t);
  simpleShow(changed);
  const prepared = runMigration({
    command: 'prepare',
    root: changed,
    createId: ids([SIMPLE_MIGRATION, SIMPLE_V1, SIMPLE_V2, SIMPLE_ASSET]),
  });
  assert.equal(prepared.ok, true);
  fs.writeFileSync(path.join(changed, 'script.txt'), '# Simple\n@image: images/Card.png\nSECRET-NEW-TEXT\n');
  const conflict = runMigration({ command: 'commit', root: changed, createId: refusingIds() });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'source-changed');
  assert.equal(conflict.conflicts.some((entry) => entry.kind === 'live-script' && entry.path === 'script.txt'), true);
  assert.equal(JSON.stringify(conflict).includes('SECRET-NEW-TEXT'), false);
  assert.equal(fs.existsSync(path.join(changed, 'data', 'library', 'migration.json')), false);

  const invalid = makeRoot(t);
  simpleShow(invalid);
  assert.equal(runMigration({
    command: 'prepare',
    root: invalid,
    createId: ids([SIMPLE_MIGRATION, SIMPLE_V1, SIMPLE_V2, SIMPLE_ASSET]),
  }).ok, true);
  fs.writeFileSync(path.join(invalid, 'data', 'library', 'migration-work', 'READY'), '{');
  const refused = runMigration({ command: 'commit', root: invalid });
  assert.equal(refused.ok, false);
  assert.equal(refused.activated, false);
  assert.equal(fs.existsSync(path.join(invalid, 'data', 'library', 'migration.json')), false);
  assert.equal(fs.readFileSync(path.join(invalid, 'script.txt')).equals(Buffer.from(SIMPLE_TEXT)), true);
});

test('abort removes staging before commit and refuses after it', (t) => {
  const root = makeRoot(t);
  simpleShow(root);
  const before = snapshot(root);
  assert.equal(runMigration({
    command: 'prepare',
    root,
    createId: ids([SIMPLE_MIGRATION, SIMPLE_V1, SIMPLE_V2, SIMPLE_ASSET]),
  }).ok, true);
  const aborted = runMigration({ command: 'abort', root });
  assert.equal(aborted.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-work')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'migration-attempt.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', 'productions')), false);
  protectedFiles(root).forEach((file) => {
    assert.equal(before[path.relative(root, file)], hashBuffer(fs.readFileSync(file)));
  });
  assert.equal(fs.readFileSync(path.join(root, 'data', 'library', 'scripts', `${SIMPLE}.txt`)).equals(Buffer.from(SIMPLE_TEXT)), true);
});

test('crashes before the marker leave legacy mode authoritative', (t) => {
  ['inspect', 'plan', 'v1', 'v2', 'asset', 'ready', 'before-publish', 'after-publish', 'after-marker'].forEach((point) => {
    const root = makeRoot(t);
    simpleShow(root);
    const scriptBefore = fs.readFileSync(path.join(root, 'script.txt'));
    const prepareOptions = {
      command: 'prepare',
      root,
      createId: ids([SIMPLE_MIGRATION, SIMPLE_V1, SIMPLE_V2, SIMPLE_ASSET]),
    };
    if (['inspect', 'plan', 'v1', 'v2', 'asset', 'ready'].includes(point)) {
      assert.throws(
        () => runMigration(Object.assign({ failAt: point }, prepareOptions)),
        (err) => err instanceof MigrationError && err.code === 'injected-failure',
      );
    } else {
      assert.equal(runMigration(prepareOptions).ok, true);
      assert.throws(
        () => runMigration({ command: 'commit', root, failAt: point, createId: refusingIds() }),
        (err) => err instanceof MigrationError && err.code === 'injected-failure',
      );
    }
    const libraryDir = path.join(root, 'data', 'library');
    if (point !== 'after-marker') {
      assert.equal(detectStorageMode({ libraryDir }).mode, 'legacy');
      assert.equal(fs.existsSync(path.join(libraryDir, 'migration.json')), false);
    } else {
      assert.equal(detectStorageMode({ libraryDir }).mode, 'versioned');
      const marker = fs.readFileSync(path.join(libraryDir, 'migration.json'));
      const retried = runMigration({ command: 'commit', root, createId: refusingIds() });
      assert.equal(retried.alreadyCommitted, true);
      assert.equal(fs.readFileSync(path.join(libraryDir, 'migration.json')).equals(marker), true);
    }
    assert.equal(fs.readFileSync(path.join(root, 'script.txt')).equals(scriptBefore), true);
    if (point === 'plan' || point === 'v1') {
      const resumed = runMigration({ command: 'prepare', root, createId: refusingIds() });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.migrationId, SIMPLE_MIGRATION);
    }
  });
});

test('repository production files stay byte-identical', () => {
  const before = {};
  REAL_FILES.forEach((relative) => {
    before[relative] = hashBuffer(fs.readFileSync(path.join(REPO, relative)));
  });
  assert.equal(before['script.txt'], 'ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0');
  assert.equal(runMigration({ command: 'prepare', root: REPO }).code, 'unsafe-root');
  REAL_FILES.forEach((relative) => {
    assert.equal(hashBuffer(fs.readFileSync(path.join(REPO, relative))), before[relative]);
  });
  ['data/library/migration.json', 'data/library/productions', 'data/library/migration-work', 'data/live-journal'].forEach((relative) => {
    assert.equal(fs.existsSync(path.join(REPO, relative)), false);
  });
});
