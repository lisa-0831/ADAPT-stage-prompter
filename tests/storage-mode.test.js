const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');
const { createPrompterServer } = require('../server');
const { detectStorageMode, StorageModeError } = require('../server/storage-mode');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server.js');
const PRODUCTION = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';
const VERSION = '11111111-1111-4111-8111-111111111112';
const PREVIOUS = '11111111-1111-4111-8111-111111111111';
const MIGRATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_HASH = 'ab'.repeat(32);
const CONTENT_HASH = 'cd'.repeat(32);
const SCRIPT = '# Show\nSECRET-CUE-TEXT stays on disk.\n';

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompter-storage-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function marker(overrides = {}) {
  return {
    schema: 1,
    state: 'committed',
    migrationId: MIGRATION,
    sourceScriptHash: SOURCE_HASH,
    productionId: PRODUCTION,
    versionId: VERSION,
    contentHash: CONTENT_HASH,
    previousVersionId: PREVIOUS,
    mirrorInstalled: false,
    ...overrides,
  };
}

function writeMarker(libraryDir, value) {
  fs.mkdirSync(libraryDir, { recursive: true });
  const file = path.join(libraryDir, 'migration.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function layout(root) {
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  const metaFile = `${previousFile}.meta.json`;
  const libraryDir = path.join(root, 'data', 'library');
  const journalDir = path.join(root, 'data', 'live-journal');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(path.join(journalDir, 'pending'), { recursive: true });
  fs.writeFileSync(scriptFile, SCRIPT);
  fs.writeFileSync(previousFile, SCRIPT);
  const scriptHash = crypto.createHash('sha256').update(SCRIPT).digest('hex');
  fs.writeFileSync(metaFile, `${JSON.stringify({ liveId: null, textHash: scriptHash })}\n`);
  fs.writeFileSync(
    path.join(libraryDir, 'index.json'),
    `${JSON.stringify({ version: 1, liveId: PRODUCTION, scripts: [] }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(libraryDir, 'scripts-keep.txt'), 'library-bytes\n');
  fs.writeFileSync(path.join(journalDir, 'pending', 'note.txt'), 'journal-bytes\n');
  return { scriptFile, previousFile, metaFile, libraryDir, journalDir };
}

function fingerprint(files) {
  const found = {};
  files.forEach((file) => {
    found[file] = fs.existsSync(file) ? hashFile(file) : null;
  });
  return found;
}

function tracked(paths) {
  return [
    paths.scriptFile,
    paths.previousFile,
    paths.metaFile,
    path.join(paths.libraryDir, 'index.json'),
    path.join(paths.libraryDir, 'scripts-keep.txt'),
    path.join(paths.libraryDir, 'migration.json'),
    path.join(paths.journalDir, 'pending', 'note.txt'),
  ];
}

function optionsFor(paths) {
  return {
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
  };
}

function assertUnchanged(paths, before) {
  assert.deepEqual(fingerprint(tracked(paths)), before);
  assert.equal(fs.existsSync(path.join(paths.journalDir, 'pending', 'note.txt')), true);
}

function refusalCode(paths) {
  try {
    createPrompterServer(optionsFor(paths));
  } catch (err) {
    return err;
  }
  assert.fail('startup was expected to refuse');
  return null;
}

test('no marker selects legacy mode', (t) => {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'data', 'library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const detected = detectStorageMode({ libraryDir });
  assert.equal(detected.mode, 'legacy');
  assert.equal(detected.marker, undefined);
  assert.equal(fs.existsSync(path.join(libraryDir, 'migration.json')), false);
});

test('legacy mode preserves the existing startup sequence', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const beforeScript = fs.readFileSync(paths.scriptFile);
  const created = createPrompterServer(optionsFor(paths));
  t.after(async () => {
    await new Promise((resolve) => created.wss.close(() => resolve()));
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(() => resolve()));
    }
  });
  assert.equal(fs.existsSync(path.join(paths.journalDir, 'pending')), false);
  const index = JSON.parse(fs.readFileSync(path.join(paths.libraryDir, 'index.json'), 'utf8'));
  assert.equal(index.scripts.length, 1);
  assert.equal(index.scripts[0].revision, crypto.createHash('sha256').update(SCRIPT).digest('hex'));
  assert.equal(fs.readFileSync(paths.scriptFile).equals(beforeScript), true);
  assert.equal(created.server.listening, false);
});

test('a missing library directory is left uncreated by detection', (t) => {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'missing-library');
  const detected = detectStorageMode({ libraryDir });
  assert.equal(detected.mode, 'legacy');
  assert.equal(fs.existsSync(libraryDir), false);
});

test('a structurally valid migration marker is detected', (t) => {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'library');
  writeMarker(libraryDir, marker());
  const detected = detectStorageMode({ libraryDir });
  assert.equal(detected.mode, 'versioned');
  assert.equal(detected.supported, false);
  assert.equal(detected.marker.productionId, PRODUCTION);
  assert.equal(detected.marker.versionId, VERSION);
  assert.equal(detected.marker.schema, 1);
  assert.equal(detected.marker.previousActivation, null);
  assert.equal(detected.marker.previousVersionId, undefined);
  assert.equal(detected.marker.contentHash, CONTENT_HASH);
  assert.equal(detected.marker.mirrorInstalled, false);
  assert.equal(detected.marker.state, 'committed');
});

test('a valid but unsupported versioned marker refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker());
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err instanceof StorageModeError, true);
  assert.equal(err.code, 'unsupported-versioned-storage');
  assert.equal(err.message.includes('SECRET-CUE-TEXT'), false);
  assertUnchanged(paths, before);
});

test('invalid JSON refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, '{');
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err.code, 'invalid-json');
  assert.notEqual(err.code, 'unsupported-versioned-storage');
  assert.equal(err.message.includes('SECRET-CUE-TEXT'), false);
  assertUnchanged(paths, before);
});

test('an unsupported schema refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker({ schema: 4 }));
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err.code, 'unsupported-schema');
  assertUnchanged(paths, before);
});

test('an invalid production id refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker({ productionId: 'not-a-production' }));
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err.code, 'invalid-production-id');
  assert.equal(err.field, 'productionId');
  assertUnchanged(paths, before);
});

test('an invalid version id refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker({ versionId: '11111111-1111-1111-1111-111111111111' }));
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err.code, 'invalid-version-id');
  assert.equal(err.field, 'versionId');
  assertUnchanged(paths, before);
});

test('an invalid content hash refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker({ contentHash: 'not-a-hash' }));
  const before = fingerprint(tracked(paths));
  const err = refusalCode(paths);
  assert.equal(err.code, 'invalid-content-hash');
  assert.equal(err.field, 'contentHash');
  assertUnchanged(paths, before);
});

test('an unsafe marker symlink is rejected', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, `${JSON.stringify(marker())}\n`);
  const outsideBefore = hashFile(outside);
  fs.symlinkSync(outside, path.join(paths.libraryDir, 'migration.json'));
  const before = fingerprint(tracked(paths).filter((file) => !file.endsWith('migration.json')));
  const err = refusalCode(paths);
  assert.equal(err.code, 'unsafe-marker');
  assert.equal(err.message.includes('SECRET-CUE-TEXT'), false);
  assert.equal(hashFile(outside), outsideBefore);
  assert.equal(fs.lstatSync(path.join(paths.libraryDir, 'migration.json')).isSymbolicLink(), true);
  assert.deepEqual(
    fingerprint(tracked(paths).filter((file) => !file.endsWith('migration.json'))),
    before,
  );
});

test('rejected startup does not modify the temporary script.txt', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker());
  const before = hashFile(paths.scriptFile);
  refusalCode(paths);
  assert.equal(hashFile(paths.scriptFile), before);
  assert.equal(fs.readFileSync(paths.scriptFile, 'utf8'), SCRIPT);
});

test('rejected startup does not modify previous-script data', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker());
  const previous = hashFile(paths.previousFile);
  const meta = hashFile(paths.metaFile);
  refusalCode(paths);
  assert.equal(hashFile(paths.previousFile), previous);
  assert.equal(hashFile(paths.metaFile), meta);
});

test('rejected startup does not modify library files', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const markerFile = writeMarker(paths.libraryDir, marker());
  const index = hashFile(path.join(paths.libraryDir, 'index.json'));
  const kept = hashFile(path.join(paths.libraryDir, 'scripts-keep.txt'));
  const markerHash = hashFile(markerFile);
  refusalCode(paths);
  assert.equal(hashFile(path.join(paths.libraryDir, 'index.json')), index);
  assert.equal(hashFile(path.join(paths.libraryDir, 'scripts-keep.txt')), kept);
  assert.equal(hashFile(markerFile), markerHash);
  assert.equal(fs.existsSync(path.join(paths.libraryDir, 'scripts')), false);
});

test('rejected startup does not modify journal files', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker());
  const note = path.join(paths.journalDir, 'pending', 'note.txt');
  const before = hashFile(note);
  refusalCode(paths);
  assert.equal(hashFile(note), before);
  assert.equal(fs.statSync(path.join(paths.journalDir, 'pending')).isDirectory(), true);
});

test('rejected startup does not bind a network port', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  writeMarker(paths.libraryDir, marker());
  const child = spawnSync(process.execPath, ['-e', `
    const http = require('http');
    const original = http.createServer;
    let calls = 0;
    http.createServer = function (...args) {
      calls += 1;
      return original.apply(this, args);
    };
    const { createPrompterServer } = require(${JSON.stringify(SERVER)});
    try {
      const created = createPrompterServer(${JSON.stringify(optionsFor(paths))});
      console.log(created.server.listening ? 'LISTENING' : 'CREATED');
    } catch (err) {
      console.log('CODE ' + err.code);
      console.log('CALLS ' + calls);
    }
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /CODE unsupported-versioned-storage/);
  assert.match(child.stdout, /CALLS 0/);
  assert.equal(child.stdout.includes('LISTENING'), false);
  assert.equal(child.stdout.includes('SECRET-CUE-TEXT'), false);
});

test('a custom library directory is honored', (t) => {
  const root = makeRoot(t);
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  const journalDir = path.join(root, 'journal');
  const customLibrary = path.join(root, 'custom-library');
  const defaultLibrary = path.join(root, 'data', 'library');
  fs.writeFileSync(scriptFile, SCRIPT);
  fs.writeFileSync(previousFile, SCRIPT);
  writeMarker(customLibrary, marker());
  const env = { ...process.env };
  delete env.SCRIPT_LIBRARY_DIR;
  env.SCRIPT_LIBRARY_DIR = customLibrary;
  const child = spawnSync(process.execPath, ['-e', `
    const { createPrompterServer } = require(${JSON.stringify(SERVER)});
    try {
      createPrompterServer({
        scriptFile: ${JSON.stringify(scriptFile)},
        previousFile: ${JSON.stringify(previousFile)},
        journalDir: ${JSON.stringify(journalDir)},
      });
      console.log('STARTED');
    } catch (err) {
      console.log('CODE ' + err.code);
    }
  `], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /CODE unsupported-versioned-storage/);
  assert.equal(fs.existsSync(defaultLibrary), false);
  assert.equal(fs.existsSync(path.join(customLibrary, 'scripts')), false);
});

test('independent server instances do not share storage-mode state', (t) => {
  const legacyRoot = makeRoot(t);
  const versionedRoot = makeRoot(t);
  const legacyPaths = layout(legacyRoot);
  const versionedPaths = layout(versionedRoot);
  writeMarker(versionedPaths.libraryDir, marker());
  const legacy = detectStorageMode({ libraryDir: legacyPaths.libraryDir });
  const versioned = detectStorageMode({ libraryDir: versionedPaths.libraryDir });
  assert.equal(legacy.mode, 'legacy');
  assert.equal(versioned.mode, 'versioned');
  assert.equal(detectStorageMode({ libraryDir: legacyPaths.libraryDir }).mode, 'legacy');
  const created = createPrompterServer(optionsFor(legacyPaths));
  t.after(async () => {
    await new Promise((resolve) => created.wss.close(() => resolve()));
  });
  const err = refusalCode(versionedPaths);
  assert.equal(err.code, 'unsupported-versioned-storage');
  assert.equal(created.library.getLiveId() !== null, true);
  assert.equal(fs.existsSync(path.join(versionedPaths.journalDir, 'pending', 'note.txt')), true);
});

test('a committed marker with a stale mirror is not treated as a malformed marker', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const scriptHash = crypto.createHash('sha256').update(SCRIPT).digest('hex');
  assert.notEqual(scriptHash, CONTENT_HASH);
  writeMarker(paths.libraryDir, marker({
    sourceScriptHash: scriptHash,
    contentHash: CONTENT_HASH,
    mirrorInstalled: false,
  }));
  const detected = detectStorageMode({ libraryDir: paths.libraryDir });
  assert.equal(detected.mode, 'versioned');
  assert.equal(detected.supported, false);
  assert.equal(detected.marker.contentHash, CONTENT_HASH);
  const malformed = layout(path.join(root, 'bad'));
  writeMarker(malformed.libraryDir, '{');
  const err = refusalCode(paths);
  const bad = refusalCode(malformed);
  assert.equal(err.code, 'unsupported-versioned-storage');
  assert.equal(bad.code, 'invalid-json');
  assert.notEqual(err.code, bad.code);
});

test('normal legacy startup still sends script then state', async (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const created = createPrompterServer(optionsFor(paths));
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await new Promise((resolve) => created.wss.close(() => resolve()));
    if (created.server.listening) {
      await new Promise((resolve) => created.server.close(() => resolve()));
    }
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const messages = [];
  const socket = new WebSocket(`ws://127.0.0.1:${created.server.address().port}`);
  sockets.push(socket);
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (messages.some((message) => message.type === 'state')) {
        resolve();
        return;
      }
      if (Date.now() - start > 3000) {
        reject(new Error('timed out waiting for the cue'));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
  assert.deepEqual(messages.map((message) => message.type), ['script', 'state']);
  assert.equal(messages[0].slides[0].title, 'Show');
  assert.equal(messages[1].state.slideIndex, 0);
});

test('the default library location is the script directory when no override is set', (t) => {
  const root = makeRoot(t);
  const scriptFile = path.join(root, 'script.txt');
  const previousFile = path.join(root, 'script.previous.txt');
  fs.writeFileSync(scriptFile, SCRIPT);
  fs.writeFileSync(previousFile, SCRIPT);
  const env = { ...process.env };
  delete env.SCRIPT_LIBRARY_DIR;
  const child = spawnSync(process.execPath, ['-e', `
    const { createPrompterServer } = require(${JSON.stringify(SERVER)});
    const created = createPrompterServer({
      scriptFile: ${JSON.stringify(scriptFile)},
      previousFile: ${JSON.stringify(previousFile)},
      journalDir: ${JSON.stringify(path.join(root, 'journal'))},
    });
    created.wss.close();
    created.server.close();
    console.log('STARTED');
  `], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /STARTED/);
  const indexPath = path.join(root, 'data', 'library', 'index.json');
  assert.equal(fs.existsSync(indexPath), true);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.scripts.length, 1);
});

test('a directory named migration.json is rejected and left in place', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const markerDir = path.join(paths.libraryDir, 'migration.json');
  fs.mkdirSync(markerDir);
  fs.writeFileSync(path.join(markerDir, 'keep.txt'), 'keep\n');
  const err = refusalCode(paths);
  assert.equal(err.code, 'unsafe-marker');
  assert.equal(fs.readFileSync(path.join(markerDir, 'keep.txt'), 'utf8'), 'keep\n');
});

function markerV2(overrides = {}) {
  return {
    schema: 2,
    state: 'committed',
    migrationId: MIGRATION,
    sourceScriptHash: SOURCE_HASH,
    productionId: PRODUCTION,
    versionId: VERSION,
    contentHash: CONTENT_HASH,
    previousActivation: null,
    mirrorInstalled: false,
    ...overrides,
  };
}

test('a schema-1 marker is versioned storage with no previous activation', (t) => {
  const root = makeRoot(t);
  const libraryDir = path.join(root, 'library');
  const selfFile = writeMarker(libraryDir, marker({ previousVersionId: VERSION }));
  const selfBefore = fs.readFileSync(selfFile);
  const detected = detectStorageMode({ libraryDir });
  assert.equal(detected.mode, 'versioned');
  assert.equal(detected.supported, false);
  assert.equal(detected.marker.schema, 1);
  assert.equal(detected.marker.previousActivation, null);
  assert.equal(detected.marker.previousVersionId, undefined);
  assert.equal(fs.readFileSync(selfFile).equals(selfBefore), true);
  const otherRoot = makeRoot(t);
  const otherDir = path.join(otherRoot, 'library');
  const otherFile = writeMarker(otherDir, marker({ previousVersionId: PREVIOUS }));
  const otherBefore = fs.readFileSync(otherFile);
  const again = detectStorageMode({ libraryDir: otherDir });
  assert.equal(again.marker.previousActivation, null);
  assert.equal(again.marker.versionId, VERSION);
  assert.equal(fs.readFileSync(otherFile).equals(otherBefore), true);
});

test('a schema-2 marker is recognized and still refuses startup', (t) => {
  const root = makeRoot(t);
  const paths = layout(root);
  const file = writeMarker(paths.libraryDir, markerV2());
  const before = fs.readFileSync(file);
  const detected = detectStorageMode({ libraryDir: paths.libraryDir });
  assert.equal(detected.mode, 'versioned');
  assert.equal(detected.supported, false);
  assert.equal(detected.marker.schema, 2);
  assert.equal(detected.marker.previousActivation, null);
  const err = refusalCode(paths);
  assert.equal(err.code, 'unsupported-versioned-storage');
  assert.notEqual(err.code, 'unsupported-schema');
  assert.equal(fs.readFileSync(file).equals(before), true);
});

test('malformed schema-1 and schema-2 markers stay distinct from versioned runtime refusal', (t) => {
  const cases = [
    [marker({ previousVersionId: null }), 'missing-field'],
    [marker({ previousVersionId: 'not-a-version' }), 'invalid-version-id'],
    [markerV2({ previousActivation: { productionId: PRODUCTION, versionId: PREVIOUS } }), 'invalid-field'],
    [markerV2({ previousVersionId: PREVIOUS }), 'invalid-field'],
  ];
  cases.forEach(([value, code]) => {
    const root = makeRoot(t);
    const paths = layout(root);
    writeMarker(paths.libraryDir, value);
    const err = refusalCode(paths);
    assert.equal(err.code, code);
    assert.notEqual(err.code, 'unsupported-versioned-storage');
  });
  const missing = makeRoot(t);
  const missingPaths = layout(missing);
  const withoutActivation = markerV2();
  delete withoutActivation.previousActivation;
  writeMarker(missingPaths.libraryDir, withoutActivation);
  assert.equal(refusalCode(missingPaths).code, 'missing-field');
});
