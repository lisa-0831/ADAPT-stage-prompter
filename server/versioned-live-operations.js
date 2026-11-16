const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVersionStore } = require('../library-version-store');
const { detectImage } = require('../script-library');
const { loadVersionedShow } = require('./versioned-show');
const { detectStorageMode, StorageModeError } = require('./storage-mode');
const { recoverVersionedInstall } = require('./versioned-live-install');

// Fixture-only live operations. One factory owns one in-process queue.
// There is no cross-process lock. Save, publish, and set-live on the same
// factory cannot pass the saved-head check at the same time.
//
// Live journals share <journalDir>/versioned-live with the initial installer.
// The commit point is the rename of pending to committed. A pending journal
// is not active. After that rename the write order is live-state.json, then
// the script.txt mirror, then journal removal. migration.json is not rewritten.
//
// A crash after a version save and before that rename leaves the new saved
// head in place and Live unchanged (saved-not-live). A committed journal
// finishes that exact activation. Recovery does not consult the saved head,
// the Library liveId, or script.previous.txt.

const LIVE_STAGES = Object.freeze([
  'before-save',
  'after-save',
  'before-journal',
  'pending-written',
  'journal-committed',
  'before-live-state',
  'after-live-state',
  'before-mirror',
  'after-mirror',
  'before-cleanup',
]);
const LIVE_OPERATIONS = Object.freeze(['set-live', 'publish-live', 'restore-previous']);
const JOURNAL_FILES = Object.freeze(['plan.json', 'live-state.json', 'mirror.txt']);
const MAX_BYTES = 8 * 1024 * 1024;
const REPO_ROOT = path.resolve(__dirname, '..');

class OperationError extends Error {
  constructor(code, message, stage) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.stage = stage || null;
    if (stage === 'after-save') this.status = 'saved-not-live';
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
  if (stat.size > MAX_BYTES) return { invalid: true };
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
    throw new OperationError('injected-failure', `Injected failure at ${name}.`, name);
  }
}

function authorizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !path.isAbsolute(root)) {
    return fail('root-required', 'An explicit absolute root is required. The working directory is not used.');
  }
  const lexical = path.resolve(root);
  const stat = lstatIfExists(lexical);
  if (!stat) return fail('missing-root', 'The root directory does not exist.');
  if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('unsafe-root', 'The root must be a real directory.');
  let rootReal;
  try {
    rootReal = fs.realpathSync(lexical);
  } catch (err) {
    return fail('unsafe-root', 'The root directory could not be resolved.');
  }
  const repoReal = fs.realpathSync(REPO_ROOT);
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal === repoReal || insideStrict(rootReal, repoReal) || insideStrict(repoReal, rootReal)) {
    return fail('unsafe-root', 'Live operations are limited to an explicit temporary fixture.');
  }
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return fail('unsafe-root', 'Live operations are limited to an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function authorizeInside(rootReal, filePath, kind, directory) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    return fail('unsafe-path', `The ${kind} path must be an explicit absolute path.`);
  }
  const lexical = path.resolve(filePath);
  const stat = lstatIfExists(lexical);
  if (!stat || stat.isSymbolicLink()) return fail('unsafe-path', `The ${kind} path must be a real ${directory ? 'directory' : 'file'}.`);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    return fail('unsafe-path', `The ${kind} path must be a real ${directory ? 'directory' : 'file'}.`);
  }
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    return fail('unsafe-path', `The ${kind} path could not be resolved.`);
  }
  if (!insideStrict(real, rootReal)) return fail('unsafe-path', `The ${kind} path is outside the fixture root.`);
  return { ok: true, lexical, real };
}

function journalDirs(journalDir) {
  const root = path.join(journalDir, 'versioned-live');
  return { root, pending: path.join(root, 'pending'), committed: path.join(root, 'committed') };
}

function activation(productionId, versionId, contentHash) {
  return { productionId, versionId, contentHash };
}

function validPair(value) {
  return !!value
    && typeof value.productionId === 'string'
    && typeof value.versionId === 'string'
    && typeof value.contentHash === 'string'
    && /^[0-9a-f]{64}$/.test(value.contentHash);
}

function samePair(left, right) {
  return validPair(left) && validPair(right)
    && left.productionId === right.productionId
    && left.versionId === right.versionId
    && left.contentHash === right.contentHash;
}

function cueFor(operation, fromProduction, targetProduction, resetPosition) {
  if (operation === 'publish-live') {
    return resetPosition
      ? { action: 'reset', reason: 'explicit-reset' }
      : { action: 'preserve', reason: 'publish' };
  }
  if (fromProduction !== targetProduction) {
    return { action: 'reset', reason: operation === 'restore-previous' ? 'restore-different-production' : 'different-production' };
  }
  return { action: 'preserve', reason: operation === 'restore-previous' ? 'restore-same-production' : 'same-production' };
}

function readLiveJournal(dir) {
  const stat = lstatIfExists(dir);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('corrupt-journal', 'The live journal is not a real directory.');
  const planRead = readNoFollow(path.join(dir, 'plan.json'));
  if (!planRead.bytes) return fail('corrupt-journal', 'The live journal is incomplete.');
  let plan;
  try {
    plan = JSON.parse(planRead.bytes.toString('utf8'));
  } catch (err) {
    return fail('corrupt-journal', 'The live journal could not be read.');
  }
  if (plan && plan.schema === 2 && plan.operation === 'initial-live-install') {
    return { ok: true, kind: 'install' };
  }
  if (!plan || plan.schema !== 2 || !LIVE_OPERATIONS.includes(plan.operation)) {
    return fail('corrupt-journal', 'The live journal could not be read.');
  }
  const names = fs.readdirSync(dir);
  if (names.some((name) => !JOURNAL_FILES.includes(name) && !/^\..+\.tmp$/.test(name))) {
    return fail('corrupt-journal', 'The live journal contains an unexpected file.');
  }
  const files = {};
  for (let index = 0; index < JOURNAL_FILES.length; index += 1) {
    const read = readNoFollow(path.join(dir, JOURNAL_FILES[index]));
    if (!read.bytes) return fail('corrupt-journal', 'The live journal is incomplete.');
    files[JOURNAL_FILES[index]] = read.bytes;
  }
  if (!samePair(plan.from, plan.previousActivation) || samePair(plan.from, plan.target)) {
    return fail('corrupt-journal', 'The live journal does not match its activation.');
  }
  if (!Number.isInteger(plan.expectedGeneration) || plan.nextGeneration !== plan.expectedGeneration + 1) {
    return fail('corrupt-journal', 'The live journal generation is not valid.');
  }
  if (hashBuffer(files['live-state.json']) !== plan.liveStateHash || hashBuffer(files['mirror.txt']) !== plan.mirrorHash || plan.mirrorHash !== plan.target.contentHash) {
    return fail('corrupt-journal', 'The live journal does not match its recorded bytes.');
  }
  let recorded;
  try {
    recorded = JSON.parse(files['live-state.json'].toString('utf8'));
  } catch (err) {
    return fail('corrupt-journal', 'The live journal does not match its live state.');
  }
  if (!recorded || recorded.generation !== plan.nextGeneration || !samePair(recorded, plan.target) || !samePair(recorded.previousActivation, plan.from)) {
    return fail('corrupt-journal', 'The live journal does not match its live state.');
  }
  return { ok: true, kind: 'live', plan, liveBytes: files['live-state.json'], mirrorBytes: files['mirror.txt'] };
}

function versionBytes(libraryReal, productionId, versionId) {
  const scriptPath = path.join(libraryReal, 'productions', productionId, 'versions', versionId, 'script.txt');
  const relative = path.relative(libraryReal, scriptPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fail('unsafe-path', 'The version path is outside the library.');
  const read = readNoFollow(scriptPath);
  if (read.missing) return fail('missing-version', 'The selected version could not be found.');
  if (!read.bytes) return fail('unsafe-path', 'The selected version could not be read safely.');
  let real;
  try {
    real = fs.realpathSync(scriptPath);
  } catch (err) {
    return fail('unsafe-path', 'The selected version could not be read safely.');
  }
  if (!insideStrict(real, libraryReal)) return fail('unsafe-path', 'The version path is outside the library.');
  return { ok: true, bytes: read.bytes, hash: hashBuffer(read.bytes) };
}

function sharedImage(scriptFile, legacyPath) {
  const name = legacyPath.slice('images/'.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return fail('unsafe-path', 'A legacy image name is not safe.');
  const filePath = path.join(path.dirname(scriptFile), 'images', name);
  const read = readNoFollow(filePath);
  if (read.missing) return fail('unresolved-image', 'A shared image could not be resolved.');
  if (!read.bytes) return fail('unsafe-path', 'A shared image is not a regular file.');
  const detected = detectImage(read.bytes);
  if (!detected || detected.incomplete) return fail('unresolved-image', 'A shared image is not a complete image file.');
  return { ok: true };
}

function verifyTarget(store, libraryReal, scriptFile, productionId, versionId) {
  const version = store.readVersion(productionId, versionId);
  if (!version.ok) {
    return fail(version.code === 'missing-parent' ? 'missing-version' : (version.code || 'corrupt-version'), version.error || 'The selected version could not be read.');
  }
  const images = store.describeImages(productionId, version.text);
  if (!images.ok) return fail(images.code, images.error);
  for (let index = 0; index < images.legacyImages.length; index += 1) {
    const shared = sharedImage(scriptFile, images.legacyImages[index].path);
    if (!shared.ok) return shared;
  }
  const bytes = versionBytes(libraryReal, productionId, versionId);
  if (!bytes.ok) return bytes;
  if (bytes.hash !== version.version.contentHash) return fail('hash-mismatch', 'The selected version does not match its recorded bytes.');
  return { ok: true, version: version.version, hash: bytes.hash, bytes: bytes.bytes };
}

function createVersionedLiveOperations(options) {
  const root = authorizeRoot(options && options.root);
  if (!root.ok) {
    const rejected = () => Promise.resolve(root);
    return {
      ok: false,
      saveLibraryVersion: rejected,
      setLiveVersion: rejected,
      publishLiveVersion: rejected,
      restorePreviousLive: rejected,
      recoverLiveOperations: rejected,
    };
  }
  const library = authorizeInside(root.rootReal, options.libraryDir, 'library', true);
  const script = authorizeInside(root.rootReal, options.scriptFile, 'script mirror', false);
  const journal = authorizeInside(root.rootReal, options.journalDir, 'journal', true);
  const opened = library.ok && script.ok && journal.ok ? { library, script, journal } : null;
  const refusal = !library.ok ? library : (!script.ok ? script : journal);
  let store = null;
  if (opened) {
    try {
      store = createVersionStore({ root: library.real });
    } catch (err) {
      store = null;
      opened.storeError = fail(err.code || 'unsafe-path', 'The production tree could not be opened.');
    }
  }
  const dirs = opened ? journalDirs(journal.lexical) : null;
  let chain = Promise.resolve();
  const defaultFailAt = options && options.failAt ? options.failAt : '';
  const now = options && options.now;

  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function context(failAt) {
    if (!opened) return refusal;
    if (!store) return opened.storeError;
    return {
      ok: true,
      library,
      script,
      journal,
      store,
      dirs,
      rootReal: root.rootReal,
      failAt: failAt || defaultFailAt,
      now,
    };
  }

  function timestamp(ctx) {
    const value = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
    return value;
  }

  function show(ctx) {
    const loaded = loadVersionedShow({
      libraryDir: ctx.library.lexical,
      scriptFile: ctx.script.lexical,
    });
    if (!loaded.ok) return fail(loaded.code || 'refused', loaded.error || 'The versioned show could not be loaded.');
    if (!loaded.marker || loaded.marker.mirrorInstalled !== true) {
      return fail('not-installed', 'The versioned show has not finished initial installation.');
    }
    if (loaded.status !== 'loadable') {
      const drifted = loaded.recoveryRequirements && loaded.recoveryRequirements.indexOf('mirror-recovery-required') !== -1;
      return fail(
        drifted ? 'mirror-conflict' : (loaded.code || 'not-loadable'),
        'The compatibility mirror does not match the active version.',
      );
    }
    return { ok: true, loaded };
  }

  function finishInstall(ctx) {
    const committed = readLiveJournal(ctx.dirs.committed);
    if (committed.missing) return { ok: true };
    if (!committed.ok) return committed;
    if (committed.kind !== 'install') return { ok: true, live: committed };
    const recovered = recoverVersionedInstall({
      root: ctx.rootReal,
      libraryDir: ctx.library.lexical,
      scriptFile: ctx.script.lexical,
      previousFile: path.join(path.dirname(ctx.script.lexical), 'script.previous.txt'),
      metaFile: path.join(path.dirname(ctx.script.lexical), 'script.previous.txt.meta.json'),
      journalDir: ctx.journal.lexical,
    });
    if (!recovered.ok) return recovered;
    return { ok: true };
  }

  function applyLiveJournal(ctx, journalRecord) {
    const plan = journalRecord.plan;
    const target = verifyTarget(ctx.store, ctx.library.real, ctx.script.lexical, plan.target.productionId, plan.target.versionId);
    if (!target.ok) return target;
    if (!target.bytes.equals(journalRecord.mirrorBytes)) {
      return fail('hash-mismatch', 'The selected version does not match the live journal.');
    }
    let marker;
    try {
      marker = detectStorageMode({ libraryDir: ctx.library.lexical });
    } catch (err) {
      if (err instanceof StorageModeError) return fail(err.code, 'The migration marker cannot be used.');
      throw err;
    }
    const markerBytes = readNoFollow(path.join(ctx.library.lexical, 'migration.json'));
    if (!markerBytes.bytes || !marker || !marker.marker || marker.marker.mirrorInstalled !== true) {
      return fail('marker-conflict', 'The migration marker changed during the live operation.');
    }
    const stateFile = path.join(ctx.library.lexical, 'live-state.json');
    const stateNow = readNoFollow(stateFile);
    if (!stateNow.bytes) return fail('invalid-live-state', 'live-state.json could not be read.');
    let current;
    try {
      current = JSON.parse(stateNow.bytes.toString('utf8'));
    } catch (err) {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
    const atTarget = stateNow.bytes.equals(journalRecord.liveBytes);
    const atOrigin = current.generation === plan.expectedGeneration && samePair(current, plan.from);
    if (!atTarget && !atOrigin) {
      return fail('stale-live', 'A newer live activation is already recorded.');
    }
    const mirrorNow = readNoFollow(ctx.script.lexical);
    if (!mirrorNow.bytes) return fail('mirror-conflict', 'The compatibility mirror changed during the live operation.');
    const mirrorHash = hashBuffer(mirrorNow.bytes);
    if (mirrorHash !== plan.target.contentHash && mirrorHash !== plan.from.contentHash) {
      return fail('mirror-conflict', 'The compatibility mirror changed during the live operation.');
    }
    checkpoint(ctx.failAt, 'journal-committed');
    checkpoint(ctx.failAt, 'before-live-state');
    if (!atTarget) writeAtomic(stateFile, journalRecord.liveBytes);
    checkpoint(ctx.failAt, 'after-live-state');
    checkpoint(ctx.failAt, 'before-mirror');
    if (mirrorHash !== plan.target.contentHash) writeAtomic(ctx.script.lexical, journalRecord.mirrorBytes);
    checkpoint(ctx.failAt, 'after-mirror');
    checkpoint(ctx.failAt, 'before-cleanup');
    JOURNAL_FILES.forEach((name) => fs.unlinkSync(path.join(ctx.dirs.committed, name)));
    if (fs.readdirSync(ctx.dirs.committed).length === 0) fs.rmdirSync(ctx.dirs.committed);
    const markerAfter = readNoFollow(path.join(ctx.library.lexical, 'migration.json'));
    if (!markerAfter.bytes || !markerAfter.bytes.equals(markerBytes.bytes)) {
      return fail('marker-conflict', 'The migration marker changed during the live operation.');
    }
    return {
      ok: true,
      unchanged: false,
      status: 'activated',
      operation: plan.operation,
      productionId: plan.target.productionId,
      versionId: plan.target.versionId,
      contentHash: plan.target.contentHash,
      previousActivation: plan.from,
      generation: plan.nextGeneration,
      updatedAt: plan.updatedAt,
      cue: plan.cue,
    };
  }

  function settle(ctx) {
    const pending = lstatIfExists(ctx.dirs.pending);
    const committed = lstatIfExists(ctx.dirs.committed);
    if (pending && committed) return fail('journal-conflict', 'The live journal has both a pending and a committed copy.');
    if (committed) {
      const record = readLiveJournal(ctx.dirs.committed);
      if (!record.ok) return record;
      if (record.kind === 'install') {
        const finished = finishInstall(ctx);
        if (!finished.ok) return finished;
      } else {
        const applied = applyLiveJournal(ctx, record);
        if (!applied.ok) return applied;
      }
    }
    return { ok: true };
  }

  function guardPending(ctx, requestPlan) {
    if (!lstatIfExists(ctx.dirs.pending)) return { ok: true, pending: false };
    const record = readLiveJournal(ctx.dirs.pending);
    if (!record.ok) return record;
    if (record.kind === 'install') return fail('journal-conflict', 'An initial installation journal is still pending.');
    const plan = record.plan;
    const matches = requestPlan
      && plan.operation === requestPlan.operation
      && plan.expectedGeneration === requestPlan.expectedGeneration
      && samePair(plan.from, requestPlan.from)
      && samePair(plan.target, requestPlan.target);
    if (!matches) return fail('journal-conflict', 'A pending live journal targets a different activation.');
    fs.renameSync(ctx.dirs.pending, ctx.dirs.committed);
    fsyncDirectory(path.dirname(ctx.dirs.committed));
    return applyLiveJournal(ctx, record);
  }

  async function activate(ctx, operation, from, target, resetPosition) {
    const updatedAt = timestamp(ctx);
    if (!updatedAt) return fail('invalid-clock', 'The live operation timestamp is not valid.');
    const nextGeneration = from.generation + 1;
    const previousActivation = activation(from.productionId, from.versionId, from.contentHash);
    const targetPair = activation(target.version.productionId, target.version.id, target.hash);
    const cue = cueFor(operation, from.productionId, target.version.productionId, resetPosition);
    const liveState = {
      schema: 1,
      productionId: targetPair.productionId,
      versionId: targetPair.versionId,
      contentHash: targetPair.contentHash,
      previousActivation,
      updatedAt,
      generation: nextGeneration,
    };
    const liveBytes = stableBytes(liveState);
    const plan = {
      schema: 2,
      operation,
      expectedGeneration: from.generation,
      nextGeneration,
      updatedAt,
      from: previousActivation,
      target: targetPair,
      previousActivation,
      liveStateHash: hashBuffer(liveBytes),
      mirrorHash: target.hash,
      cue,
    };
    const guarded = guardPending(ctx, plan);
    if (!guarded.ok || guarded.status === 'activated') return guarded;
    checkpoint(ctx.failAt, 'before-journal');
    fs.mkdirSync(ctx.dirs.pending, { recursive: true });
    writeAtomic(path.join(ctx.dirs.pending, 'plan.json'), stableBytes(plan));
    writeAtomic(path.join(ctx.dirs.pending, 'live-state.json'), liveBytes);
    writeAtomic(path.join(ctx.dirs.pending, 'mirror.txt'), target.bytes);
    fsyncDirectory(ctx.dirs.pending);
    checkpoint(ctx.failAt, 'pending-written');
    fs.renameSync(ctx.dirs.pending, ctx.dirs.committed);
    fsyncDirectory(path.dirname(ctx.dirs.committed));
    const written = readLiveJournal(ctx.dirs.committed);
    if (!written.ok) return written;
    return applyLiveJournal(ctx, written);
  }

  function expectLive(loaded, input) {
    if (input.expectedGeneration !== loaded.generation) return fail('stale-live', 'The live generation changed after this operation was prepared.');
    if (input.expectedVersionId !== loaded.versionId || input.expectedContentHash !== loaded.contentHash) {
      return fail('stale-live', 'The live version changed after this operation was prepared.');
    }
    return { ok: true };
  }

  function saveLibraryVersion(input) {
    return exclusive(async () => {
      const ctx = context();
      if (!ctx.ok) return ctx;
      const settled = settle(ctx);
      if (!settled.ok) return settled;
      if (lstatIfExists(ctx.dirs.pending)) return fail('journal-conflict', 'A pending live journal is still present.');
      const body = input || {};
      return ctx.store.saveVersion({
        productionId: body.productionId,
        expectedVersionId: body.expectedVersionId,
        newVersionId: body.newVersionId,
        text: body.text,
        createdAt: body.createdAt,
      });
    });
  }

  function setLiveVersion(input) {
    return exclusive(async () => {
      const ctx = context(input && input.failAt);
      if (!ctx.ok) return ctx;
      const settled = settle(ctx);
      if (!settled.ok) return settled;
      const current = show(ctx);
      if (!current.ok) return current;
      const loaded = current.loaded;
      const expected = expectLive(loaded, input || {});
      if (!expected.ok) return expected;
      const body = input || {};
      let versionId = body.versionId;
      if (body.useHead) {
        const head = ctx.store.readProduction(body.productionId);
        if (!head.ok) return fail(head.code || 'missing-production', head.error || 'The production could not be read.');
        if (body.expectedHeadVersionId !== head.production.headVersionId) {
          return fail('conflict', 'The saved head changed after this version was selected.');
        }
        versionId = head.production.headVersionId;
      }
      const target = verifyTarget(ctx.store, ctx.library.real, ctx.script.lexical, body.productionId, versionId);
      if (!target.ok) return target;
      if (loaded.productionId === body.productionId && loaded.versionId === target.version.id && loaded.contentHash === target.hash) {
        return {
          ok: true,
          unchanged: true,
          status: 'loadable',
          productionId: loaded.productionId,
          versionId: loaded.versionId,
          contentHash: loaded.contentHash,
          previousActivation: loaded.previousActivation,
          generation: loaded.generation,
          cue: { action: 'preserve', reason: 'already-active' },
        };
      }
      const heads = {
        live: ctx.store.readProduction(loaded.productionId),
        target: ctx.store.readProduction(body.productionId),
      };
      if (!heads.live.ok || !heads.target.ok) {
        return fail(heads.live.code || heads.target.code || 'missing-production', 'A saved head could not be read.');
      }
      const activated = await activate(ctx, 'set-live', loaded, target, false);
      if (!activated.ok) return activated;
      const liveAfter = ctx.store.readProduction(loaded.productionId);
      const targetAfter = ctx.store.readProduction(body.productionId);
      if (!liveAfter.ok || !targetAfter.ok || liveAfter.production.headVersionId !== heads.live.production.headVersionId || targetAfter.production.headVersionId !== heads.target.production.headVersionId) {
        return fail('head-changed', 'A live activation changed a saved head.');
      }
      return activated;
    });
  }

  function publishLiveVersion(input) {
    return exclusive(async () => {
      const ctx = context(input && input.failAt);
      if (!ctx.ok) return ctx;
      const settled = settle(ctx);
      if (!settled.ok) return settled;
      const current = show(ctx);
      if (!current.ok) return current;
      const loaded = current.loaded;
      const body = input || {};
      if (body.productionId !== loaded.productionId) {
        return fail('wrong-production', 'A live publish can change only the production that is live.');
      }
      const expected = expectLive(loaded, body);
      if (!expected.ok) return expected;
      checkpoint(ctx.failAt, 'before-save');
      const saved = await ctx.store.saveVersion({
        productionId: body.productionId,
        expectedVersionId: body.expectedHeadVersionId,
        newVersionId: body.newVersionId,
        text: body.text,
        createdAt: body.createdAt,
      });
      if (!saved.ok) return saved;
      checkpoint(ctx.failAt, 'after-save');
      const versionId = saved.currentVersionId;
      const target = verifyTarget(ctx.store, ctx.library.real, ctx.script.lexical, body.productionId, versionId);
      if (!target.ok) {
        return Object.assign(target, { status: 'saved-not-live', versionId });
      }
      if (loaded.versionId === versionId && loaded.contentHash === target.hash) {
        return {
          ok: true,
          unchanged: true,
          status: 'loadable',
          productionId: loaded.productionId,
          versionId,
          contentHash: target.hash,
          previousActivation: loaded.previousActivation,
          generation: loaded.generation,
          cue: { action: 'preserve', reason: 'already-active' },
        };
      }
      const activated = await activate(ctx, 'publish-live', loaded, target, body.resetPosition === true);
      if (!activated.ok) return Object.assign({ status: 'saved-not-live', versionId }, activated);
      return Object.assign({ savedVersionId: versionId }, activated);
    });
  }

  function restorePreviousLive(input) {
    return exclusive(async () => {
      const ctx = context(input && input.failAt);
      if (!ctx.ok) return ctx;
      const settled = settle(ctx);
      if (!settled.ok) return settled;
      const current = show(ctx);
      if (!current.ok) return current;
      const loaded = current.loaded;
      const body = input || {};
      const expected = expectLive(loaded, body);
      if (!expected.ok) return expected;
      if (!loaded.previousActivation) return fail('no-previous-activation', 'There is no previous live activation to restore.');
      const previous = loaded.previousActivation;
      const target = verifyTarget(ctx.store, ctx.library.real, ctx.script.lexical, previous.productionId, previous.versionId);
      if (!target.ok) return target;
      if (target.hash !== previous.contentHash) return fail('hash-mismatch', 'The previous activation does not match its stored version.');
      const heads = [loaded.productionId, previous.productionId].filter((id, index, list) => list.indexOf(id) === index)
        .map((id) => ({ id, head: ctx.store.readProduction(id) }));
      const restored = await activate(ctx, 'restore-previous', loaded, target, false);
      if (!restored.ok) return restored;
      for (let index = 0; index < heads.length; index += 1) {
        const again = ctx.store.readProduction(heads[index].id);
        if (!again.ok || again.production.headVersionId !== heads[index].head.production.headVersionId) {
          return fail('head-changed', 'Restore changed a saved head.');
        }
      }
      return restored;
    });
  }

  function recoverLiveOperations() {
    return exclusive(async () => {
      const ctx = context('');
      if (!ctx.ok) return ctx;
      ctx.failAt = '';
      if (lstatIfExists(ctx.dirs.pending) && !lstatIfExists(ctx.dirs.committed)) {
        const pending = readLiveJournal(ctx.dirs.pending);
        if (!pending.ok) return pending;
        return { ok: true, applied: false, activated: false, reason: 'pending' };
      }
      const hadCommitted = Boolean(lstatIfExists(ctx.dirs.committed));
      const settled = settle(ctx);
      if (!settled.ok) return settled;
      const applied = hadCommitted && !lstatIfExists(ctx.dirs.committed);
      return { ok: true, applied, activated: applied };
    });
  }

  return {
    ok: Boolean(opened && store),
    saveLibraryVersion,
    setLiveVersion,
    publishLiveVersion,
    restorePreviousLive,
    recoverLiveOperations,
  };
}

module.exports = {
  LIVE_STAGES,
  OperationError,
  createVersionedLiveOperations,
};
