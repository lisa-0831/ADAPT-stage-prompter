const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadVersionedShow } = require('./versioned-show');
const { detectStorageMode, StorageModeError } = require('./storage-mode');

// Fixture-only initial installation. The commit point is the rename of
// versioned-live/pending to versioned-live/committed. Nothing before that
// rename changes Live State, script.txt, or migration.json. Recovery finishes
// a committed journal and does not apply a pending one.
//
// Write order after the commit point:
//   1. live-state.json
//   2. script.txt compatibility mirror
//   3. migration.json mirrorInstalled flag
//   4. removal of the committed journal
//
// The journal lives under <journalDir>/versioned-live so legacy schema-1
// recovery, which owns <journalDir>/pending and <journalDir>/committed,
// neither applies nor deletes it. script.previous.txt and its metadata are
// observed and preserved. They are not a previous live activation.

const INSTALL_STAGES = Object.freeze([
  'before-journal',
  'pending-written',
  'journal-committed',
  'before-live-state',
  'after-live-state',
  'before-mirror',
  'after-mirror',
  'before-marker',
  'after-marker',
  'before-cleanup',
]);

const JOURNAL_NAMESPACE = 'versioned-live';
const PLAN_NAME = 'plan.json';
const STATE_NAME = 'live-state.json';
const MIRROR_NAME = 'mirror.txt';
const MARKER_NAME = 'marker.json';
const JOURNAL_FILES = Object.freeze([PLAN_NAME, STATE_NAME, MIRROR_NAME, MARKER_NAME]);
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const { assessWritableRoot } = require('./writable-root');
const { lockAround } = require('./storage-writer-lock');

class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function insideStrict(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function stableBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fail(code, error, extra) {
  return Object.assign({ ok: false, status: 'refused', code, error }, extra || {});
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    // Directory fsync is not available on every filesystem.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isFile()) return { unsafe: true };
  if (stat.size > MAX_JOURNAL_BYTES) return { invalid: true };
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EPERM') return { unsafe: true };
    throw err;
  }
  try {
    return { bytes: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomic(filePath, bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (_) { /* The descriptor may already be closed. */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* The temp file may already be gone. */ }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);
  fsyncDirectory(dir);
}

function checkpoint(failAt, name) {
  if (failAt === name) {
    const error = new InstallError('injected-failure', `Injected failure at ${name}.`);
    error.stage = name;
    throw error;
  }
}

function authorizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    return fail('root-required', 'An explicit absolute root is required. The working directory is not used.');
  }
  if (!path.isAbsolute(root)) {
    return fail('root-required', 'The root must be an absolute path. The working directory is not used.');
  }
  const lexical = path.resolve(root);
  const stat = lstatIfExists(lexical);
  if (!stat) return fail('missing-root', 'The root directory does not exist.');
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return fail('unsafe-root', 'The root must be a real directory.');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(lexical);
  } catch (err) {
    return fail('unsafe-root', 'The root directory could not be resolved.');
  }
  if (!assessWritableRoot(rootReal).ok) {
    return fail('unsafe-root', 'Installation is limited to an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function authorizePath(rootReal, filePath, kind) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    return fail('unsafe-path', `The ${kind} path must be an explicit absolute path.`);
  }
  const lexical = path.resolve(filePath);
  const stat = lstatIfExists(lexical);
  if (!stat) return { ok: true, missing: true, lexical };
  if (stat.isSymbolicLink()) return fail('unsafe-path', `The ${kind} path is a symlink.`);
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    return fail('unsafe-path', `The ${kind} path could not be resolved.`);
  }
  if (!insideStrict(real, rootReal) && real !== rootReal) {
    return fail('unsafe-path', `The ${kind} path is outside the fixture root.`);
  }
  return { ok: true, missing: false, lexical, real, stat };
}

function requireFile(rootReal, filePath, kind) {
  const located = authorizePath(rootReal, filePath, kind);
  if (!located.ok) return located;
  if (located.missing || !located.stat.isFile()) return fail('missing-path', `The ${kind} file is not a regular file.`);
  return located;
}

function requireDirectory(rootReal, filePath, kind) {
  const located = authorizePath(rootReal, filePath, kind);
  if (!located.ok) return located;
  if (located.missing || !located.stat.isDirectory()) {
    return fail('missing-path', `The ${kind} directory is not a real directory.`);
  }
  return located;
}

function journalPaths(journalDir) {
  const root = path.join(journalDir, JOURNAL_NAMESPACE);
  return {
    root,
    pending: path.join(root, 'pending'),
    committed: path.join(root, 'committed'),
  };
}

function containedFile(dir, name) {
  const filePath = path.join(dir, name);
  if (path.basename(filePath) !== name) return null;
  const relative = path.relative(dir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return filePath;
}

function readJournal(dir) {
  const stat = lstatIfExists(dir);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('corrupt-journal', 'The installation journal is not a real directory.');
  const planPeek = readNoFollow(path.join(dir, PLAN_NAME));
  if (planPeek.bytes) {
    let peeked = null;
    try {
      peeked = JSON.parse(planPeek.bytes.toString('utf8'));
    } catch (err) {
      return fail('corrupt-journal', 'The installation journal could not be read.');
    }
    if (peeked && peeked.schema === 2 && typeof peeked.operation === 'string' && peeked.operation !== 'initial-live-install') {
      return fail('journal-conflict', 'The installation journal belongs to another operation.');
    }
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return fail('corrupt-journal', 'The installation journal could not be read.');
  }
  const extras = names.filter((name) => !JOURNAL_FILES.includes(name) && !/^\..+\.tmp$/.test(name));
  if (extras.length) return fail('corrupt-journal', 'The installation journal contains an unexpected file.');
  const files = {};
  for (let index = 0; index < JOURNAL_FILES.length; index += 1) {
    const name = JOURNAL_FILES[index];
    const filePath = containedFile(dir, name);
    const read = filePath ? readNoFollow(filePath) : { missing: true };
    if (!read.bytes) return fail('corrupt-journal', 'The installation journal is incomplete.');
    files[name] = read.bytes;
  }
  let plan;
  try {
    plan = JSON.parse(files[PLAN_NAME].toString('utf8'));
  } catch (err) {
    return fail('corrupt-journal', 'The installation journal could not be read.');
  }
  if (!plan || plan.schema !== 2 || plan.operation !== 'initial-live-install' || plan.previousActivation !== null || plan.generation !== 1) {
    return fail('corrupt-journal', 'The installation journal is not an initial installation.');
  }
  const fields = ['migrationId', 'productionId', 'versionId', 'contentHash', 'sourceScriptHash', 'updatedAt', 'liveStateHash', 'mirrorHash', 'markerBeforeHash', 'markerAfterHash', 'previousFileHash', 'metaFileHash'];
  if (fields.some((field) => typeof plan[field] !== 'string' || plan[field].length === 0)) {
    return fail('corrupt-journal', 'The installation journal is incomplete.');
  }
  if (hashBuffer(files[STATE_NAME]) !== plan.liveStateHash) return fail('corrupt-journal', 'The installation journal does not match its live state.');
  if (hashBuffer(files[MIRROR_NAME]) !== plan.mirrorHash || plan.mirrorHash !== plan.contentHash) {
    return fail('corrupt-journal', 'The installation journal does not match its mirror.');
  }
  if (hashBuffer(files[MARKER_NAME]) !== plan.markerAfterHash) {
    return fail('corrupt-journal', 'The installation journal does not match its marker.');
  }
  let recordedState;
  try {
    recordedState = JSON.parse(files[STATE_NAME].toString('utf8'));
  } catch (err) {
    return fail('corrupt-journal', 'The installation journal does not match its live state.');
  }
  if (!recordedState
    || recordedState.schema !== 1
    || recordedState.productionId !== plan.productionId
    || recordedState.versionId !== plan.versionId
    || recordedState.contentHash !== plan.contentHash
    || recordedState.previousActivation !== null
    || recordedState.generation !== 1
    || recordedState.updatedAt !== plan.updatedAt) {
    return fail('corrupt-journal', 'The installation journal does not match its live state.');
  }
  return {
    ok: true,
    plan,
    liveBytes: files[STATE_NAME],
    mirrorBytes: files[MIRROR_NAME],
    markerBytes: files[MARKER_NAME],
  };
}

function versionScript(libraryReal, productionId, versionId) {
  const scriptPath = path.join(libraryReal, 'productions', productionId, 'versions', versionId, 'script.txt');
  const relative = path.relative(libraryReal, scriptPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fail('unsafe-path', 'The version path is outside the library.');
  const read = readNoFollow(scriptPath);
  if (read.missing) return fail('missing-version', 'The selected version could not be found.');
  if (read.unsafe || read.invalid || !read.bytes) return fail('unsafe-path', 'The selected version could not be read safely.');
  let real;
  try {
    real = fs.realpathSync(scriptPath);
  } catch (err) {
    return fail('unsafe-path', 'The selected version could not be read safely.');
  }
  if (!insideStrict(real, libraryReal)) return fail('unsafe-path', 'The version path is outside the library.');
  return { ok: true, bytes: read.bytes, hash: hashBuffer(read.bytes) };
}

function sameActivation(plan, marker) {
  return plan.migrationId === marker.migrationId
    && plan.productionId === marker.productionId
    && plan.versionId === marker.versionId
    && plan.contentHash === marker.contentHash
    && plan.sourceScriptHash === marker.sourceScriptHash
    && plan.generation === 1
    && plan.previousActivation === null;
}

function installedFlag(bytes) {
  const text = bytes.toString('utf8');
  const token = '"mirrorInstalled": false';
  if (text.split(token).length !== 2) return null;
  return Buffer.from(text.replace(token, '"mirrorInstalled": true'), 'utf8');
}

function applyJournal(context, journal) {
  const version = versionScript(context.library.real, journal.plan.productionId, journal.plan.versionId);
  if (!version.ok) return version;
  if (version.hash !== journal.plan.contentHash || !version.bytes.equals(journal.mirrorBytes)) {
    return fail('hash-mismatch', 'The selected version does not match the installation journal.');
  }
  const previous = readNoFollow(context.previous.lexical);
  const meta = readNoFollow(context.meta.lexical);
  if (!previous.bytes || hashBuffer(previous.bytes) !== journal.plan.previousFileHash) {
    return fail('metadata-conflict', 'The previous-script file changed during installation.');
  }
  if (!meta.bytes || hashBuffer(meta.bytes) !== journal.plan.metaFileHash) {
    return fail('metadata-conflict', 'The previous-script metadata changed during installation.');
  }
  const markerFile = path.join(context.library.lexical, 'migration.json');
  const stateFile = path.join(context.library.lexical, 'live-state.json');
  const markerNow = readNoFollow(markerFile);
  if (!markerNow.bytes) return fail('unsafe-path', 'The migration marker could not be read.');
  const markerHash = hashBuffer(markerNow.bytes);
  const installed = markerHash === journal.plan.markerAfterHash;
  const original = markerHash === journal.plan.markerBeforeHash;
  if (!installed && !original) return fail('marker-conflict', 'The migration marker changed during installation.');
  const stateNow = readNoFollow(stateFile);
  if (stateNow.unsafe) return fail('unsafe-path', 'live-state.json is not a regular file.');
  if (installed && !stateNow.bytes) {
    return fail('missing-live-state', 'The migration is installed, but the live pointer is missing.');
  }
  if (stateNow.invalid) return fail('invalid-live-state', 'live-state.json could not be read.');
  if (stateNow.bytes && !stateNow.bytes.equals(journal.liveBytes)) {
    return fail('live-state-conflict', 'Live State does not match this installation.');
  }
  const mirrorNow = readNoFollow(context.script.lexical);
  if (!mirrorNow.bytes) return fail('mirror-conflict', 'The compatibility mirror changed during installation.');
  const mirrorHash = hashBuffer(mirrorNow.bytes);
  if (mirrorHash !== journal.plan.contentHash && mirrorHash !== journal.plan.sourceScriptHash) {
    return fail('mirror-conflict', 'The compatibility mirror changed during installation.');
  }
  if (installed && mirrorHash !== journal.plan.contentHash) {
    return fail('mirror-conflict', 'The compatibility mirror changed after installation.');
  }

  checkpoint(context.failAt, 'journal-committed');
  checkpoint(context.failAt, 'before-live-state');
  if (!stateNow.bytes) writeAtomic(stateFile, journal.liveBytes);
  checkpoint(context.failAt, 'after-live-state');
  checkpoint(context.failAt, 'before-mirror');
  if (mirrorHash !== journal.plan.contentHash) writeAtomic(context.script.lexical, journal.mirrorBytes);
  checkpoint(context.failAt, 'after-mirror');
  checkpoint(context.failAt, 'before-marker');
  if (!installed) writeAtomic(markerFile, journal.markerBytes);
  checkpoint(context.failAt, 'after-marker');
  checkpoint(context.failAt, 'before-cleanup');
  const removal = removeJournal(context.committedDir, journal);
  if (!removal.ok) return removal;
  return {
    ok: true,
    unchanged: false,
    status: 'installed',
    migrationId: journal.plan.migrationId,
    productionId: journal.plan.productionId,
    versionId: journal.plan.versionId,
    contentHash: journal.plan.contentHash,
    previousActivation: null,
    generation: 1,
    updatedAt: journal.plan.updatedAt,
    mirrorInstalled: true,
  };
}

function removeJournal(dir, journal) {
  const again = readJournal(dir);
  if (!again.ok || again.plan.liveStateHash !== journal.plan.liveStateHash) {
    return fail('corrupt-journal', 'The installation journal changed before cleanup.');
  }
  JOURNAL_FILES.forEach((name) => {
    const filePath = containedFile(dir, name);
    if (filePath) fs.unlinkSync(filePath);
  });
  fs.readdirSync(dir).forEach((name) => {
    if (!/^\..+\.tmp$/.test(name)) return;
    const filePath = path.join(dir, name);
    const stat = lstatIfExists(filePath);
    if (stat && stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(filePath);
  });
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  const parent = path.dirname(dir);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  return { ok: true };
}

function writeJournal(pendingDir, payload) {
  fs.mkdirSync(pendingDir, { recursive: true });
  writeAtomic(path.join(pendingDir, PLAN_NAME), payload.planBytes);
  writeAtomic(path.join(pendingDir, STATE_NAME), payload.liveBytes);
  writeAtomic(path.join(pendingDir, MIRROR_NAME), payload.mirrorBytes);
  writeAtomic(path.join(pendingDir, MARKER_NAME), payload.markerBytes);
  fsyncDirectory(pendingDir);
}

function preparePayload(context, markerBytes, versionBytes, existingLiveBytes) {
  const markerAfter = installedFlag(markerBytes);
  if (!markerAfter) return fail('marker-conflict', 'The migration marker installation flag could not be updated.');
  let liveBytes = existingLiveBytes || null;
  let updatedAt = null;
  if (liveBytes) {
    try {
      updatedAt = JSON.parse(liveBytes.toString('utf8')).updatedAt;
    } catch (err) {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
  } else {
    updatedAt = typeof context.now === 'function' ? context.now() : new Date().toISOString();
    if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
      return fail('invalid-clock', 'The installation timestamp is not valid.');
    }
    liveBytes = stableBytes({
      schema: 1,
      productionId: context.marker.productionId,
      versionId: context.marker.versionId,
      contentHash: context.marker.contentHash,
      previousActivation: null,
      updatedAt,
      generation: 1,
    });
  }
  const plan = {
    schema: 2,
    operation: 'initial-live-install',
    migrationId: context.marker.migrationId,
    productionId: context.marker.productionId,
    versionId: context.marker.versionId,
    contentHash: context.marker.contentHash,
    sourceScriptHash: context.marker.sourceScriptHash,
    previousActivation: null,
    generation: 1,
    updatedAt,
    liveStateHash: hashBuffer(liveBytes),
    mirrorHash: hashBuffer(versionBytes),
    markerBeforeHash: hashBuffer(markerBytes),
    markerAfterHash: hashBuffer(markerAfter),
    previousFileHash: context.previousHash,
    metaFileHash: context.metaHash,
  };
  return {
    ok: true,
    planBytes: stableBytes(plan),
    liveBytes,
    mirrorBytes: Buffer.from(versionBytes),
    markerBytes: markerAfter,
  };
}

function locate(options) {
  const root = authorizeRoot(options && options.root);
  if (!root.ok) return root;
  const library = requireDirectory(root.rootReal, options.libraryDir, 'library');
  if (!library.ok) return library;
  const script = requireFile(root.rootReal, options.scriptFile, 'script mirror');
  if (!script.ok) return script;
  const previous = requireFile(root.rootReal, options.previousFile, 'previous script');
  if (!previous.ok) return previous;
  const meta = requireFile(root.rootReal, options.metaFile, 'previous metadata');
  if (!meta.ok) return meta;
  const journalLocated = authorizePath(root.rootReal, options.journalDir, 'journal');
  if (!journalLocated.ok) return journalLocated;
  if (!journalLocated.missing && !journalLocated.stat.isDirectory()) {
    return fail('unsafe-path', 'The journal path is not a real directory.');
  }
  if (journalLocated.missing) {
    const parent = authorizePath(root.rootReal, path.dirname(journalLocated.lexical), 'journal parent');
    if (!parent.ok || parent.missing || !parent.stat.isDirectory()) {
      return fail('unsafe-path', 'The journal directory cannot be created inside the fixture.');
    }
  }
  const previousBytes = readNoFollow(previous.lexical);
  const metaBytes = readNoFollow(meta.lexical);
  if (!previousBytes.bytes || !metaBytes.bytes) {
    return fail('unsafe-path', 'The previous-script files could not be read safely.');
  }
  const layout = journalPaths(journalLocated.lexical);
  return {
    ok: true,
    rootReal: root.rootReal,
    library,
    script,
    previous,
    meta,
    journalDir: journalLocated.lexical,
    pendingDir: layout.pending,
    committedDir: layout.committed,
    previousHash: hashBuffer(previousBytes.bytes),
    metaHash: hashBuffer(metaBytes.bytes),
    failAt: options.failAt || '',
    now: options.now,
    maxImageBytes: options.maxImageBytes,
  };
}

function currentMarker(context) {
  let detected;
  try {
    detected = detectStorageMode({ libraryDir: context.library.lexical });
  } catch (err) {
    if (err instanceof StorageModeError) return fail(err.code, 'The migration marker cannot be used.');
    throw err;
  }
  if (!detected || detected.mode !== 'versioned' || !detected.marker) {
    return fail('missing-marker', 'This library has no committed migration marker.');
  }
  const markerBytes = readNoFollow(path.join(context.library.lexical, 'migration.json'));
  if (!markerBytes.bytes) return fail('unsafe-path', 'The migration marker could not be read.');
  return { ok: true, marker: detected.marker, bytes: markerBytes.bytes };
}

function inspectShow(context) {
  const loaded = loadVersionedShow({
    libraryDir: context.library.lexical,
    scriptFile: context.script.lexical,
    maxImageBytes: context.maxImageBytes,
  });
  if (!loaded.ok) {
    return fail(loaded.code || 'refused', loaded.error || 'The versioned show could not be loaded.');
  }
  return { ok: true, loaded };
}

function finishCommitted(context) {
  const journal = readJournal(context.committedDir);
  if (journal.missing) return { ok: true, missing: true };
  if (!journal.ok) return journal;
  const marker = currentMarker(context);
  if (!marker.ok) return marker;
  if (!sameActivation(journal.plan, marker.marker)) {
    return fail('journal-conflict', 'The installation journal targets a different production.');
  }
  const shown = inspectShow(context);
  if (!shown.ok && shown.code !== 'missing-live-state' && shown.code !== 'invalid-live-state') return shown;
  if (marker.marker.mirrorInstalled && !shown.ok) return shown;
  return applyJournal(context, journal);
}

function promotionMatches(journal, marker) {
  return journal.ok && sameActivation(journal.plan, marker);
}

function canLockLibrary(libraryDir) {
  if (typeof libraryDir !== 'string' || !path.isAbsolute(libraryDir)) return false;
  let stat;
  try {
    stat = fs.lstatSync(path.resolve(libraryDir));
  } catch (err) {
    return false;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  try {
    return assessWritableRoot(fs.realpathSync(path.resolve(libraryDir))).ok === true;
  } catch (err) {
    return false;
  }
}

function installVersionedLive(options) {
  const libraryDir = options && options.libraryDir;
  if (!canLockLibrary(libraryDir)) return installVersionedLiveUnlocked(options);
  return lockAround(libraryDir, () => installVersionedLiveUnlocked(options));
}

function installVersionedLiveUnlocked(options) {
  const context = locate(options || {});
  if (!context.ok) return context;
  const committed = lstatIfExists(context.committedDir);
  const pending = lstatIfExists(context.pendingDir);
  if (committed && pending) return fail('journal-conflict', 'The installation journal has both a pending and a committed copy.');
  if (committed) {
    const finished = finishCommitted(context);
    if (!finished.missing) return finished;
  }
  if (pending) {
    const journal = readJournal(context.pendingDir);
    if (!journal.ok) return journal;
    const marker = currentMarker(context);
    if (!marker.ok) return marker;
    if (!promotionMatches(journal, marker.marker)) {
      return fail('journal-conflict', 'The pending installation targets a different production.');
    }
    fs.renameSync(context.pendingDir, context.committedDir);
    fsyncDirectory(path.dirname(context.committedDir));
    return finishCommitted(context);
  }

  const shown = inspectShow(context);
  if (!shown.ok) return shown;
  const loaded = shown.loaded;
  if (loaded.status === 'loadable') {
    return {
      ok: true,
      unchanged: true,
      status: 'loadable',
      migrationId: loaded.marker.migrationId,
      productionId: loaded.productionId,
      versionId: loaded.versionId,
      contentHash: loaded.contentHash,
      previousActivation: loaded.previousActivation,
      generation: loaded.generation,
      mirrorInstalled: true,
    };
  }
  const sameVersion = loaded.marker.productionId === loaded.productionId
    && loaded.marker.versionId === loaded.versionId
    && loaded.marker.contentHash === loaded.contentHash
    && loaded.previousActivation === null;
  if (sameVersion && loaded.generation !== null && loaded.generation !== 1) {
    return fail('generation-conflict', 'The initial installation generation conflicts with Live State.');
  }
  const initial = sameVersion && (loaded.generation === null || loaded.generation === 1);
  if (!initial || (loaded.status !== 'initialization-required' && loaded.status !== 'recovery-required')) {
    return fail('live-state-conflict', 'Live State does not match the initial migration activation.');
  }
  const marker = currentMarker(context);
  if (!marker.ok) return marker;
  if (marker.marker.mirrorInstalled) {
    return fail('missing-live-state', 'The migration is installed, but the live pointer is missing.');
  }
  const version = versionScript(context.library.real, marker.marker.productionId, marker.marker.versionId);
  if (!version.ok) return version;
  if (version.hash !== marker.marker.contentHash) {
    return fail('hash-mismatch', 'The selected version does not match its recorded bytes.');
  }
  const mirror = readNoFollow(context.script.lexical);
  if (!mirror.bytes) return fail('unsafe-path', 'The compatibility mirror could not be read.');
  const mirrorHash = hashBuffer(mirror.bytes);
  if (mirrorHash !== marker.marker.sourceScriptHash && mirrorHash !== marker.marker.contentHash) {
    return fail('mirror-conflict', 'The compatibility mirror does not match the committed migration.');
  }
  const existingLive = readNoFollow(path.join(context.library.lexical, 'live-state.json'));
  if (existingLive.unsafe || existingLive.invalid) {
    return fail('invalid-live-state', 'live-state.json could not be read.');
  }
  const payload = preparePayload(
    Object.assign({}, context, { marker: marker.marker }),
    marker.bytes,
    version.bytes,
    existingLive.bytes || null,
  );
  if (!payload.ok) return payload;
  checkpoint(context.failAt, 'before-journal');
  fs.mkdirSync(context.journalDir, { recursive: true });
  writeJournal(context.pendingDir, payload);
  checkpoint(context.failAt, 'pending-written');
  fs.renameSync(context.pendingDir, context.committedDir);
  fsyncDirectory(path.dirname(context.committedDir));
  const written = readJournal(context.committedDir);
  if (!written.ok) return written;
  return applyJournal(context, written);
}

function recoverVersionedInstall(options) {
  const libraryDir = options && options.libraryDir;
  if (!canLockLibrary(libraryDir)) return recoverVersionedInstallUnlocked(options);
  return lockAround(libraryDir, () => recoverVersionedInstallUnlocked(options));
}

function recoverVersionedInstallUnlocked(options) {
  const context = locate(options || {});
  if (!context.ok) return context;
  context.failAt = '';
  const committed = lstatIfExists(context.committedDir);
  const pending = lstatIfExists(context.pendingDir);
  if (committed && pending) return fail('journal-conflict', 'The installation journal has both a pending and a committed copy.');
  if (pending && !committed) {
    const journal = readJournal(context.pendingDir);
    if (!journal.ok) return journal;
    return {
      ok: true,
      applied: false,
      activated: false,
      reason: 'pending',
      productionId: journal.plan.productionId,
      versionId: journal.plan.versionId,
    };
  }
  if (!committed) return { ok: true, applied: false, activated: false, reason: 'absent' };
  const finished = finishCommitted(context);
  if (!finished.ok) return finished;
  return Object.assign({ applied: true, activated: true }, finished);
}

module.exports = {
  INSTALL_STAGES,
  JOURNAL_NAMESPACE,
  InstallError,
  installVersionedLive,
  recoverVersionedInstall,
};
