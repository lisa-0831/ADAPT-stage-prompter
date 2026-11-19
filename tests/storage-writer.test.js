'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createPrompterServer } = require('../server');
const { StorageModeError } = require('../server/storage-mode');
const { runMigration } = require('../library-migration-cli');
const { acquireStorageWriter } = require('../server/storage-writer-lock');
const {
  PersistentAuthorizationError,
  authorizeVersionedPersistentRoot,
  beginPersistentMigration,
} = require('../server/persistent-authorization');
const { authorizeVersionedFixture } = require('../server/versioned-runtime');

const REPO = path.resolve(__dirname, '..');
const CHILD = path.join(__dirname, 'support', 'storage-writer-child.js');
const LIVE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LIVE_TEXT = '# Live Show\nOne\nTwo\nThree\n';
const OTHER_TEXT = '# Saved Show\nSaved one\nSaved two\nSaved three\n';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: mode || 0o600 });
  if (mode) fs.chmodSync(file, mode);
}

function makeRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeLegacy(root) {
  const library = path.join(root, 'data', 'library');
  fs.mkdirSync(path.join(library, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(library, 'scripts', `${LIVE}.txt`), LIVE_TEXT);
  fs.writeFileSync(path.join(library, 'scripts', `${OTHER}.txt`), OTHER_TEXT);
  fs.writeFileSync(path.join(root, 'script.txt'), LIVE_TEXT);
  fs.writeFileSync(path.join(root, 'script.previous.txt'), 'previous-live\n');
  writeJson(path.join(root, 'script.previous.txt.meta.json'), { liveId: null, textHash: 'ab'.repeat(32) });
  writeJson(path.join(library, 'index.json'), {
    version: 1,
    liveId: LIVE,
    scripts: [
      { id: LIVE, title: 'Live Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(LIVE_TEXT)) },
      { id: OTHER, title: 'Saved Show', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: sha256(Buffer.from(OTHER_TEXT)) },
    ],
  });
  return library;
}

function commitFixture(t) {
  const root = makeRoot(t, 'prompter-writer-lock-');
  const libraryDir = writeLegacy(root);
  let count = 0;
  const prepared = runMigration({
    command: 'prepare',
    root,
    createId: () => {
      count += 1;
      return `cccccccc-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
    },
    now: () => '2026-06-06T00:00:00.000Z',
  });
  assert.equal(prepared.ok, true, prepared.error);
  const committed = runMigration({ command: 'commit', root, createId: () => { throw new Error('unexpected id'); } });
  assert.equal(committed.ok, true, committed.error);
  return {
    root,
    libraryDir,
    scriptFile: path.join(root, 'script.txt'),
    previousFile: path.join(root, 'script.previous.txt'),
    journalDir: path.join(root, 'data', 'live-journal'),
  };
}

function snapshot(paths) {
  const files = [
    paths.scriptFile,
    path.join(paths.libraryDir, 'migration.json'),
    path.join(paths.libraryDir, 'live-state.json'),
  ];
  const productions = path.join(paths.libraryDir, 'productions');
  if (fs.existsSync(productions)) {
    fs.readdirSync(productions).filter((name) => !name.startsWith('.')).forEach((id) => {
      files.push(path.join(productions, id, 'metadata.json'));
    });
  }
  const journal = path.join(paths.journalDir, 'versioned-live');
  if (fs.existsSync(journal)) {
    fs.readdirSync(journal).forEach((name) => files.push(path.join(journal, name)));
  }
  return files.filter((file) => fs.existsSync(file) && fs.statSync(file).isFile()).map((file) => ({
    file,
    sha256: sha256(fs.readFileSync(file)),
  }));
}

function assertUnchanged(before) {
  before.forEach((entry) => {
    assert.equal(sha256(fs.readFileSync(entry.file)), entry.sha256, entry.file);
  });
}

function startChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const line = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child produced no line: ${stderr}`));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline).trim());
      }
    });
    child.on('exit', () => {
      if (!buffer.includes('\n')) {
        clearTimeout(timer);
        reject(new Error(`child exited early: ${buffer} ${stderr}`));
      }
    });
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return { child, line };
}

function payloadFile(t, value) {
  const file = path.join(fs.realpathSync(os.tmpdir()), `prompter-writer-payload-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

async function bootFixture(paths) {
  const server = await createPrompterServer({
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    libraryDir: paths.libraryDir,
    journalDir: paths.journalDir,
    staffToken: 'writer-staff',
    versionedFixture: authorizeVersionedFixture(paths),
  });
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  assert.equal(server.server.address().address, '127.0.0.1');
  return server;
}

test('one process owns a library and a second process cannot listen or write', async (t) => {
  const paths = commitFixture(t);
  const server = await bootFixture(paths);
  t.after(() => server.close());
  const before = snapshot(paths);
  const payload = payloadFile(t, paths);
  const booting = startChild(['boot', payload]);
  const refused = await booting.line;
  assert.equal(refused, 'REFUSED writer-locked');
  booting.child.kill('SIGKILL');
  const installing = startChild(['install', payload]);
  assert.equal(await installing.line, 'RESULT writer-locked');
  const saving = startChild(['save', payloadFile(t, { libraryDir: paths.libraryDir, input: {} })]);
  assert.equal(await saving.line, 'RESULT writer-locked');
  const preparing = startChild(['prepare', paths.root]);
  assert.equal(await preparing.line, 'RESULT writer-locked');
  assertUnchanged(before);
  assert.equal(server.server.listening, true);
});

test('an unrelated library can be locked while the first library stays owned', async (t) => {
  const first = makeRoot(t, 'prompter-writer-a-');
  const second = makeRoot(t, 'prompter-writer-b-');
  fs.mkdirSync(path.join(first, 'library'));
  fs.mkdirSync(path.join(second, 'library'));
  const hold = acquireStorageWriter(path.join(first, 'library'));
  t.after(() => hold.release());
  const child = startChild(['hold', path.join(second, 'library')]);
  assert.match(await child.line, /^READY /);
  child.child.stdin.end();
  await new Promise((resolve) => child.child.on('exit', resolve));
});

test('shutdown releases the lock and a restart can acquire it', async (t) => {
  const paths = commitFixture(t);
  const server = await bootFixture(paths);
  await server.close();
  const payload = payloadFile(t, paths);
  const child = startChild(['boot', payload]);
  assert.match(await child.line, /^LISTENING /);
  child.child.stdin.end();
  await new Promise((resolve) => child.child.on('exit', resolve));
  const again = await bootFixture(paths);
  assert.equal(again.server.listening, true);
  await again.close();
});

test('a failed startup releases the lock', async (t) => {
  const paths = commitFixture(t);
  const server = await bootFixture(paths);
  await server.close();
  const pending = path.join(paths.journalDir, 'versioned-live', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'plan.json'), '{not-json');
  await assert.rejects(() => bootFixture(paths));
  const child = startChild(['hold', paths.libraryDir]);
  assert.match(await child.line, /^READY /);
  child.child.stdin.end();
  await new Promise((resolve) => child.child.on('exit', resolve));
});

test('a killed owner releases the lock without deleting it', async (t) => {
  const root = makeRoot(t, 'prompter-writer-kill-');
  const library = path.join(root, 'library');
  fs.mkdirSync(library);
  const child = startChild(['hold', library]);
  assert.match(await child.line, /^READY /);
  const lockFile = path.join(library, '.writer.lock');
  assert.equal(fs.lstatSync(lockFile).isFile(), true);
  child.child.kill('SIGKILL');
  await new Promise((resolve) => child.child.on('exit', resolve));
  let hold = null;
  const deadline = Date.now() + 2000;
  let blocked = null;
  while (!hold && Date.now() < deadline) {
    try {
      hold = acquireStorageWriter(library);
    } catch (err) {
      blocked = err.code;
    }
  }
  assert.equal(hold && hold.libraryReal, fs.realpathSync(library), blocked);
  hold.release();
  assert.equal(fs.lstatSync(lockFile).isFile(), true);
});

test('a symlink alias and another spelling of the same library share one lock', async (t) => {
  const root = makeRoot(t, 'prompter-writer-alias-');
  const library = path.join(root, 'library');
  fs.mkdirSync(library);
  const link = path.join(root, 'alias');
  fs.symlinkSync(library, link);
  const hold = acquireStorageWriter(library);
  t.after(() => hold.release());
  const alias = startChild(['hold', link]);
  assert.equal(await alias.line, 'REFUSED writer-locked');
  alias.child.kill('SIGKILL');
  const viaVar = library.replace('/private/var/', '/var/');
  assert.notEqual(viaVar, library);
  assert.equal(fs.realpathSync(viaVar), fs.realpathSync(library));
  const spelled = startChild(['hold', viaVar]);
  assert.equal(await spelled.line, 'REFUSED writer-locked');
  spelled.child.kill('SIGKILL');
});

test('a migration claim conflicts with a running server and does not stage', async (t) => {
  const paths = commitFixture(t);
  const server = await bootFixture(paths);
  t.after(() => server.close());
  const before = snapshot(paths);
  const config = path.join(paths.root, 'migration-auth.json');
  writeJson(config, {
    schema: 1,
    purpose: 'adapt-persistent-migration',
    root: paths.root,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    journalDir: paths.journalDir,
    expectedLiveProductionId: LIVE,
    sourceManifest: { 'script.txt': sha256(fs.readFileSync(paths.scriptFile)) },
  });
  const child = startChild(['migrate', config]);
  assert.equal(await child.line, 'RESULT writer-locked');
  assertUnchanged(before);
});

test('legacy startup does not take a versioned writer lock', async (t) => {
  const root = makeRoot(t, 'prompter-writer-legacy-');
  const scriptFile = path.join(root, 'script.txt');
  fs.writeFileSync(scriptFile, 'legacy\n');
  const server = createPrompterServer({
    scriptFile,
    previousFile: path.join(root, 'script.previous.txt'),
    libraryDir: path.join(root, 'data', 'library'),
    journalDir: path.join(root, 'data', 'live-journal'),
  });
  t.after(() => new Promise((resolve) => server.server.close(resolve)));
  assert.equal(fs.existsSync(path.join(root, 'data', 'library', '.writer.lock')), false);
  assert.equal(server.mode, undefined);
});

test('fixture authorization still opens a temporary versioned library', async (t) => {
  const paths = commitFixture(t);
  const server = await bootFixture(paths);
  assert.equal(server.mode, 'versioned');
  assert.equal(server.getAwaitingLive(), false);
  await server.close();
  assert.equal(authorizeVersionedFixture.length, 1);
  assert.throws(() => authorizeVersionedFixture({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    previousFile: path.join(REPO, 'script.previous.txt'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
  }));
});

function runtimeConfig(paths, installation) {
  return {
    schema: 1,
    purpose: 'adapt-persistent-runtime',
    root: paths.root,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    journalDir: paths.journalDir,
    installation,
  };
}

function copyInstalled(source, dest) {
  fs.cpSync(source, dest, { recursive: true, dereference: false });
}

test('a persistent authorization matches one installation and rejects the others', async (t) => {
  const paths = commitFixture(t);
  const warmed = await bootFixture(paths);
  await warmed.close();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.adapt-m9c1-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const tmpReal = fs.realpathSync(os.tmpdir());
  assert.equal(outside === tmpReal || outside.startsWith(`${tmpReal}${path.sep}`), false);
  assert.equal(outside === REPO || outside.startsWith(`${REPO}${path.sep}`), false);
  copyInstalled(paths.root, path.join(outside, 'storage'));
  const stored = {
    root: path.join(outside, 'storage'),
    libraryDir: path.join(outside, 'storage', 'data', 'library'),
    scriptFile: path.join(outside, 'storage', 'script.txt'),
    previousFile: path.join(outside, 'storage', 'script.previous.txt'),
    journalDir: path.join(outside, 'storage', 'data', 'live-journal'),
  };
  const marker = JSON.parse(fs.readFileSync(path.join(stored.libraryDir, 'migration.json'), 'utf8'));
  const installation = {
    schema: marker.schema,
    state: marker.state,
    migrationId: marker.migrationId,
    productionId: marker.productionId,
    versionId: marker.versionId,
    contentHash: marker.contentHash,
  };
  const config = path.join(outside, 'runtime-auth.json');
  writeJson(config, runtimeConfig(stored, installation), 0o600);
  const token = authorizeVersionedPersistentRoot({ configPath: config });
  const server = await createPrompterServer({
    scriptFile: stored.scriptFile,
    previousFile: stored.previousFile,
    libraryDir: stored.libraryDir,
    journalDir: stored.journalDir,
    staffToken: 'persistent-staff',
    persistentRoot: token,
  });
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  assert.equal(server.mode, 'versioned');
  assert.equal(server.server.address().address, '127.0.0.1');
  const child = startChild(['boot', payloadFile(t, { mode: 'persistent', configPath: config, ...stored })]);
  assert.equal(await child.line, 'REFUSED writer-locked');
  child.child.kill('SIGKILL');
  await server.close();

  await assert.rejects(
    async () => createPrompterServer({
      scriptFile: stored.scriptFile,
      previousFile: stored.previousFile,
      libraryDir: stored.libraryDir,
      journalDir: stored.journalDir,
    }),
    (err) => err instanceof StorageModeError && err.code === 'unsupported-versioned-storage',
  );

  const other = path.join(outside, 'other-auth.json');
  writeJson(other, runtimeConfig({ ...stored, root: paths.root }, installation), 0o600);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: other }), PersistentAuthorizationError);

  const mismatched = path.join(outside, 'mismatch-auth.json');
  writeJson(mismatched, runtimeConfig(stored, { ...installation, migrationId: '33333333-3333-4333-8333-333333333333' }), 0o600);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: mismatched }), (err) => err.code === 'installation-mismatch');

  const missing = path.join(outside, 'missing-auth.json');
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: missing }), (err) => err.code === 'missing-authorization');

  const malformed = path.join(outside, 'malformed-auth.json');
  fs.writeFileSync(malformed, '{', { mode: 0o600 });
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: malformed }), (err) => err.code === 'malformed-authorization');

  const loose = path.join(outside, 'loose-auth.json');
  writeJson(loose, runtimeConfig(stored, installation), 0o644);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: loose }), (err) => err.code === 'unsafe-authorization');

  const linkedConfig = path.join(outside, 'linked-auth.json');
  fs.symlinkSync(config, linkedConfig);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: linkedConfig }), (err) => err.code === 'unsafe-authorization');

  const linkedRoot = path.join(outside, 'linked-root');
  fs.symlinkSync(stored.root, linkedRoot);
  const linkedRootConfig = path.join(outside, 'linked-root-auth.json');
  writeJson(linkedRootConfig, runtimeConfig({ ...stored, root: linkedRoot }, installation), 0o600);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: linkedRootConfig }), (err) => err.code === 'unsafe-path');

  const escaping = path.join(outside, 'escaping-auth.json');
  writeJson(escaping, runtimeConfig({ ...stored, libraryDir: paths.libraryDir }, installation), 0o600);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: escaping }), (err) => err.code === 'unsafe-path');

  const previous = process.env.PROMPTER_PERSISTENT_ROOT;
  const versioned = process.env.PROMPTER_VERSIONED;
  process.env.PROMPTER_PERSISTENT_ROOT = stored.root;
  process.env.PROMPTER_VERSIONED = '1';
  try {
    await assert.rejects(
      async () => createPrompterServer({
        scriptFile: stored.scriptFile,
        previousFile: stored.previousFile,
        libraryDir: stored.libraryDir,
        journalDir: stored.journalDir,
        headers: { 'x-persistent-root': stored.root },
        persistentRoot: { purpose: 'adapt-persistent-runtime', root: stored.root },
      }),
      (err) => err instanceof StorageModeError,
    );
  } finally {
    if (previous === undefined) delete process.env.PROMPTER_PERSISTENT_ROOT;
    else process.env.PROMPTER_PERSISTENT_ROOT = previous;
    if (versioned === undefined) delete process.env.PROMPTER_VERSIONED;
    else process.env.PROMPTER_VERSIONED = versioned;
  }
});

test('the checkout cannot authorize or receive a versioned writer lock', async (t) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.adapt-m9c1-repo-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const config = path.join(outside, 'repo-auth.json');
  writeJson(config, runtimeConfig({
    root: REPO,
    libraryDir: path.join(REPO, 'data', 'library'),
    scriptFile: path.join(REPO, 'script.txt'),
    previousFile: path.join(REPO, 'script.previous.txt'),
    journalDir: path.join(REPO, 'data', 'live-journal'),
  }, {
    schema: 2,
    state: 'committed',
    migrationId: '33333333-3333-4333-8333-333333333333',
    productionId: LIVE,
    versionId: OTHER,
    contentHash: 'ab'.repeat(32),
  }), 0o600);
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: config }), (err) => err.code === 'repository-root');
  const inside = path.join(REPO, '.m9c1-auth-test.json');
  writeJson(inside, { schema: 1 }, 0o600);
  t.after(() => fs.rmSync(inside, { force: true }));
  assert.throws(() => authorizeVersionedPersistentRoot({ configPath: inside }), (err) => err.code === 'unsafe-authorization');
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', '.writer.lock')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'data', 'library', 'migration.json')), false);
});
