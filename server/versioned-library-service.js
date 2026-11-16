const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('../script-editor-model');
const { isValidScriptId } = require('../script-library');
const { createVersionStore } = require('../library-version-store');
const {
  classifyScriptImages,
  createProductionManager,
  validateTitle,
} = require('../library-versioned-production-management');
const { createVersionedAssetManager } = require('../library-versioned-assets');
const { createVersionedLiveOperations } = require('./versioned-live-operations');

// Application-facing coordinator for one versioned library root.
//
// Create, rename, save, publish, upload, delete, set-live, and restore go
// through one in-process queue keyed by the library's real path. A second
// service for that path is refused. close() releases the path after the
// queue is idle. There is no cross-process lock: one server process may own
// a storage directory.
//
// Direct use of the underlying factories bypasses this queue. The HTTP
// adapter must call this service and must not construct those factories.
// updateProduction, activateSavedHead, publishCurrent, and restoreCurrent
// each hold this queue for the whole logical operation. A title change and
// a script save in one request cannot be split by another write.
// Reads are on the same queue so they do not run between a write's checks
// and its commit. The queue is not held across network work.
//
// Listing order is the production id, ascending. Dot directories, including
// .creating-*, plus migration-work and productions.incoming, are ignored.
// A corrupt or symlinked production is an invalid entry, not a row that can
// be activated. Live status comes from a verified live-state.json.

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const writers = new Map();

const HTTP_ADAPTER_CONTRACT = Object.freeze({
  staffToken: 'Library routes keep the staff token. GET /api/live/assets stays public and may return bytes only from readLiveAsset.',
  routes: Object.freeze({
    'GET /api/library': 'listProductions. live comes from live-state.json. Do not use index.json liveId. 200.',
    'POST /api/library': 'createProduction when trackIfCurrent is not true, then the existing separate image uploads. trackIfCurrent true returns the live production when its saved head is that live script. It does not create a duplicate or activate anything. 201 for a new production. An upload failure leaves the production in place.',
    'GET /api/library/:id': 'readProduction. 404 when missing. The saved-head content hash is the legacy revision.',
    'PUT /api/library/:id': 'Split a title change and a text change. Rename uses metadata generation. Save uses the saved-head version id. If one succeeds and the other conflicts, return 409 partial with the field that was saved. Do not drop either field.',
    'GET /api/library/:id/assets': 'listAssets. Staff only. 200.',
    'POST /api/library/:id/assets': 'uploadAsset. 201. Same asset id and bytes is the stored asset. Different bytes is 409 conflict.',
    'GET /api/library/:id/assets/:assetId': 'readAsset. Staff only. 404 when missing, foreign, or corrupt.',
    'DELETE /api/library/:id/assets/:assetId': 'deleteAsset. 409 when a retained version or live activation needs it.',
    'GET /api/live/assets/:productionId/:assetId': 'readLiveAsset. 404 unless the verified live script names that production and asset.',
    'POST /api/library/:id/live': 'setLiveVersion of the saved head after assessVersionForActivation. 409 when the head, live generation, or image readiness does not match.',
    'GET /script': 'Verified compatibility mirror text. text/plain.',
    'POST /script': 'publishLiveVersion for the live production. A legacy images/ line or a missing owned asset does not become live. 409 on a stale live generation.',
    'GET /script/previous': 'Text of previousActivation when that version is still stored. 404 when previousActivation is null.',
  }),
  identities: Object.freeze([
    'Legacy revision is the saved-head content hash.',
    'versionId identifies an immutable script version.',
    'metadata generation changes on rename and save.',
    'Live State generation changes only on activation.',
  ]),
});

function fail(code, error, extra) {
  return Object.assign({ ok: false, status: 'refused', code, error }, extra || {});
}

function insideStrict(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readNoFollow(filePath, maxBytes) {
  const stat = lstatIfExists(filePath);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isFile()) return { unsafe: true };
  if (stat.size > maxBytes) return { invalid: true };
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

function authorizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !path.isAbsolute(root)) {
    return fail('root-required', 'An explicit absolute root is required. The working directory is not used.');
  }
  const lexical = path.resolve(root);
  const stat = lstatIfExists(lexical);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return fail('unsafe-root', 'The root must be a real directory.');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(lexical);
  } catch (err) {
    return fail('unsafe-root', 'The root directory could not be resolved.');
  }
  const repoReal = fs.realpathSync(REPO_ROOT);
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal === repoReal || insideStrict(rootReal, repoReal) || insideStrict(repoReal, rootReal)) {
    return fail('unsafe-root', 'Versioned library service writes are limited to an explicit temporary fixture.');
  }
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return fail('unsafe-root', 'Versioned library service writes are limited to an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function authorizeDirectory(rootReal, filePath, kind) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    return fail('unsafe-path', `The ${kind} path must be an explicit absolute path.`);
  }
  const lexical = path.resolve(filePath);
  const stat = lstatIfExists(lexical);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return fail('unsafe-path', `The ${kind} path must be a real directory.`);
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

function canonicalId(value) {
  if (!isValidScriptId(value)) return null;
  return value.toLowerCase();
}

function ignoredProductionName(name) {
  return name.startsWith('.') || name === 'migration-work' || name === 'productions.incoming';
}

function refusedService(result) {
  const method = () => Promise.resolve(result);
  return {
    ok: false,
    code: result.code,
    listProductions: method,
    readProduction: method,
    createProduction: method,
    renameProduction: method,
    saveVersion: method,
    uploadAsset: method,
    listAssets: method,
    readAsset: method,
    deleteAsset: method,
    assessProduction: method,
    assessVersionForActivation: method,
    readProductionDetail: method,
    updateProduction: method,
    readLiveShow: method,
    resolveTrackCurrent: method,
    activateSavedHead: method,
    publishCurrent: method,
    restoreCurrent: method,
    setLiveVersion: method,
    publishLiveVersion: method,
    restorePreviousLive: method,
    recoverLiveOperations: method,
    readLiveAsset: method,
    close() {},
  };
}

function createVersionedLibraryService(options) {
  const settings = options || {};
  const root = authorizeRoot(settings.root);
  if (!root.ok) return refusedService(root);
  const library = authorizeDirectory(root.rootReal, settings.libraryDir, 'library');
  if (!library.ok) return refusedService(library);
  if (typeof settings.scriptFile !== 'string' || typeof settings.journalDir !== 'string') {
    return refusedService(fail('unsafe-path', 'The script mirror and journal directory are required.'));
  }
  const scriptFile = settings.scriptFile;
  const journalDir = settings.journalDir;
  const scriptStat = lstatIfExists(path.resolve(scriptFile));
  if (!scriptStat || scriptStat.isSymbolicLink() || !scriptStat.isFile()) {
    return refusedService(fail('unsafe-path', 'The script mirror must be a real file.'));
  }
  const journal = authorizeDirectory(root.rootReal, journalDir, 'journal');
  if (!journal.ok) return refusedService(journal);
  let scriptReal;
  try {
    scriptReal = fs.realpathSync(path.resolve(scriptFile));
  } catch (err) {
    return refusedService(fail('unsafe-path', 'The script mirror could not be resolved.'));
  }
  if (!insideStrict(scriptReal, root.rootReal)) {
    return refusedService(fail('unsafe-path', 'The script mirror is outside the fixture root.'));
  }
  if (writers.has(library.real)) {
    return refusedService(fail('writer-active', 'This library already has a writer in this process.'));
  }

  const slot = { chain: Promise.resolve() };
  writers.set(library.real, slot);
  const maxImageBytes = Number.isInteger(settings.maxImageBytes) && settings.maxImageBytes > 0
    ? settings.maxImageBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  let store;
  try {
    store = createVersionStore({ root: library.real });
  } catch (err) {
    writers.delete(library.real);
    return refusedService(fail(err.code || 'unsafe-path', 'The production tree could not be opened.'));
  }
  const productions = createProductionManager({
    root: root.rootReal,
    libraryDir: library.lexical,
    now: settings.now,
    createId: settings.createId,
  });
  const assets = createVersionedAssetManager({
    root: root.rootReal,
    libraryDir: library.lexical,
    scriptFile: path.resolve(scriptFile),
    maxImageBytes,
    now: settings.now,
    createId: settings.createId,
  });
  if (!productions.ok || !assets.ok) {
    writers.delete(library.real);
    return refusedService(fail('unsafe-path', 'The production tree could not be opened.'));
  }

  let closed = false;

  function exclusive(work) {
    if (closed || writers.get(library.real) !== slot) {
      return Promise.resolve(fail('closed', 'This library writer is closed.'));
    }
    const run = slot.chain.then(() => work(), () => work());
    slot.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function close() {
    closed = true;
    const release = slot.chain.then(() => undefined, () => undefined);
    return release.then(() => {
      if (writers.get(library.real) === slot) writers.delete(library.real);
    });
  }

  function readManifestAssets(productionId) {
    const filePath = path.join(library.real, 'productions', productionId, 'assets', 'manifest.json');
    const read = readNoFollow(filePath, 1024 * 1024);
    if (read.missing) return { ok: true, assets: [] };
    if (!read.bytes) return fail(read.unsafe ? 'unsafe-path' : 'corrupt-asset', 'The asset manifest could not be read.');
    let value;
    try {
      value = JSON.parse(read.bytes.toString('utf8'));
    } catch (err) {
      return fail('corrupt-asset', 'The asset manifest could not be read.');
    }
    if (!value || !Array.isArray(value.assets)) return fail('corrupt-asset', 'The asset manifest could not be read.');
    if (value.productionId && canonicalId(value.productionId) !== productionId) {
      return fail('corrupt-asset', 'The asset manifest names a different production.');
    }
    return { ok: true, assets: value.assets };
  }

  function assessStored(productionId, versionId) {
    const id = canonicalId(productionId);
    const targetId = canonicalId(versionId);
    if (!id || !targetId) return fail('invalid-id', 'That production or version id is not valid.');
    const version = store.readVersion(id, targetId);
    if (!version.ok) {
      return fail(version.code === 'missing-parent' ? 'missing-version' : (version.code || 'corrupt-version'), version.error || 'That version could not be read.');
    }
    if (version.version.productionId !== id || version.version.id !== targetId) {
      return fail('corrupt-version', 'That version names a different production or version.');
    }
    const formatted = validate(version.text);
    const manifest = readManifestAssets(id);
    const described = store.describeImages(id, version.text);
    const classified = manifest.ok
      ? classifyScriptImages(id, version.text, manifest.assets)
      : null;
    const blocking = [];
    if (!formatted.ok) {
      blocking.push({
        code: 'invalid-script',
        message: formatted.errors[0] ? formatted.errors[0].message : 'The script could not be validated.',
      });
    }
    if (!manifest.ok) blocking.push({ code: manifest.code, message: manifest.error });
    if (!described.ok) blocking.push({ code: described.code || 'unresolved-library-images', message: described.error || 'An image could not be verified.' });
    const legacyImages = described.ok ? described.legacyImages : [];
    if (legacyImages.length) {
      blocking.push({
        code: 'unresolved-shared-images',
        message: 'This version still depends on shared images/ files.',
      });
    }
    if (described.ok && described.assets.some((asset) => asset.byteLength > maxImageBytes)) {
      blocking.push({ code: 'image-too-large', message: 'A production image is larger than the allowed size.' });
    }
    let imageStatus = 'ready';
    if (!formatted.ok) imageStatus = 'invalid-script';
    else if (!manifest.ok) imageStatus = 'corrupt-asset';
    else if (classified && classified.imageStatus !== 'ready') imageStatus = classified.imageStatus;
    else if (!described.ok) imageStatus = described.code === 'foreign-asset' || described.code === 'invalid-image-reference'
      ? described.code
      : 'unresolved-library-images';
    else if (blocking.some((item) => item.code === 'image-too-large')) imageStatus = 'image-too-large';
    const sharedLegacyImages = legacyImages.length > 0 || imageStatus === 'unresolved-shared-images';
    return {
      ok: true,
      activationReady: blocking.length === 0 && imageStatus === 'ready',
      imageStatus,
      productionId: id,
      versionId: targetId,
      contentHash: version.version.contentHash,
      blocking,
      sharedLegacyImages,
      legacyImagePolicy: version.version.legacyImagePolicy || null,
      unresolvedAssets: classified && classified.unresolvedAssets ? classified.unresolvedAssets : [],
      unassignedAssets: classified && classified.unassignedAssets ? classified.unassignedAssets : [],
      legacyImages,
    };
  }

  function reviewActivation(target) {
    const assessed = assessStored(target.productionId, target.versionId);
    if (!assessed.ok) return assessed;
    if (!assessed.activationReady) {
      return fail('activation-not-ready', 'That version is not ready to go live.', {
        imageStatus: assessed.imageStatus,
        sharedLegacyImages: assessed.sharedLegacyImages,
        blocking: assessed.blocking,
        productionId: assessed.productionId,
        versionId: assessed.versionId,
      });
    }
    return { ok: true };
  }

  const live = createVersionedLiveOperations({
    root: root.rootReal,
    libraryDir: library.lexical,
    scriptFile: path.resolve(scriptFile),
    journalDir: journal.lexical,
    now: settings.now,
    reviewActivation,
  });
  if (!live.ok) {
    writers.delete(library.real);
    return refusedService(fail('unsafe-path', 'The live operations could not be opened.'));
  }

  function committedDir() {
    return path.join(journal.real, 'versioned-live', 'committed');
  }

  function interpretLive(result) {
    const committed = lstatIfExists(committedDir());
    if (
      result
      && result.ok === false
      && result.code === 'activation-not-ready'
      && result.status !== 'saved-not-live'
      && committed
      && committed.isDirectory()
    ) {
      return Object.assign({}, result, {
        code: 'compatibility-issue',
        status: 'compatibility-issue',
        applied: false,
        error: 'The recorded live journal targets a version that is not eligible for activation. It was left in place.',
      });
    }
    return result;
  }

  function readLivePointer() {
    const filePath = path.join(library.real, 'live-state.json');
    const read = readNoFollow(filePath, 1024 * 1024);
    if (read.missing) return { ok: true, present: false };
    if (!read.bytes) return fail('invalid-live-state', 'live-state.json could not be read.');
    let state;
    try {
      state = JSON.parse(read.bytes.toString('utf8'));
    } catch (err) {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
    const productionId = canonicalId(state && state.productionId);
    const versionId = canonicalId(state && state.versionId);
    if (!state || state.schema !== 1 || !productionId || !versionId || typeof state.contentHash !== 'string') {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
    const version = store.readVersion(productionId, versionId);
    if (!version.ok || version.version.contentHash !== state.contentHash) {
      return fail('invalid-live-state', 'live-state.json does not match a stored version.');
    }
    return {
      ok: true,
      present: true,
      productionId,
      versionId,
      contentHash: state.contentHash,
      generation: Number.isInteger(state.generation) ? state.generation : null,
    };
  }

  function listProductions() {
    return exclusive(() => {
      const dir = path.join(library.real, 'productions');
      const stat = lstatIfExists(dir);
      if (!stat) return { ok: true, order: 'production-id', productions: [], invalid: [], liveState: { ok: true, present: false } };
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return fail('unsafe-path', 'The production directory is not a real directory.');
      }
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        return fail('unsafe-path', 'The production directory could not be read.');
      }
      const productions = [];
      const invalid = [];
      names.slice().sort().forEach((name) => {
        if (ignoredProductionName(name)) return;
        const entryPath = path.join(dir, name);
        const entryStat = lstatIfExists(entryPath);
        if (!entryStat) return;
        if (entryStat.isSymbolicLink()) {
          invalid.push({ name, code: 'unsafe-path', error: 'That production path is a symlink.' });
          return;
        }
        if (!entryStat.isDirectory()) {
          invalid.push({ name, code: 'unexpected-entry', error: 'That production entry is not a directory.' });
          return;
        }
        const productionId = canonicalId(name);
        if (!productionId || productionId !== name) {
          invalid.push({ name, code: 'invalid-id', error: 'That production directory is not a production id.' });
          return;
        }
        const loaded = store.readProduction(productionId);
        if (!loaded.ok) {
          invalid.push({
            name: productionId,
            code: loaded.code || 'corrupt-metadata',
            error: loaded.error || 'The production metadata could not be read.',
          });
          return;
        }
        const headId = loaded.production.headVersionId;
        const version = store.readVersion(productionId, headId);
        if (!version.ok) {
          invalid.push({
            name: productionId,
            code: version.code === 'missing-parent' ? 'missing-version' : (version.code || 'corrupt-version'),
            error: version.error || 'The saved head could not be read.',
          });
          return;
        }
        const readiness = assessStored(productionId, headId);
        productions.push({
          productionId,
          title: loaded.production.title,
          headVersionId: headId,
          contentHash: version.version.contentHash,
          createdAt: loaded.production.createdAt || null,
          updatedAt: loaded.production.updatedAt || null,
          generation: loaded.production.generation,
          activationReady: Boolean(readiness.ok && readiness.activationReady),
          imageStatus: readiness.ok ? readiness.imageStatus : (readiness.code || 'corrupt-version'),
          sharedLegacyImages: Boolean(readiness.ok && readiness.sharedLegacyImages),
        });
      });
      productions.sort((left, right) => (left.productionId < right.productionId ? -1 : 1));
      invalid.sort((left, right) => (left.name < right.name ? -1 : 1));
      const pointer = readLivePointer();
      const liveId = pointer.ok && pointer.present ? pointer.productionId : null;
      return {
        ok: true,
        order: 'production-id',
        productions: productions.map((row) => Object.assign({}, row, {
          live: row.productionId === liveId,
          liveVersionId: row.productionId === liveId ? pointer.versionId : null,
          liveGeneration: row.productionId === liveId ? pointer.generation : null,
        })),
        invalid,
        liveState: pointer.ok
          ? { ok: true, present: pointer.present, productionId: pointer.productionId || null, versionId: pointer.versionId || null }
          : { ok: false, code: pointer.code, error: pointer.error },
      };
    });
  }

  function assessVersionForActivation(input) {
    return exclusive(() => {
      const body = input || {};
      return assessStored(body.productionId, body.versionId);
    });
  }

  function assessProduction(productionId) {
    return exclusive(() => {
      const id = canonicalId(productionId);
      if (!id) return fail('invalid-id', 'That production id is not valid.');
      const loaded = store.readProduction(id);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      return assessStored(id, loaded.production.headVersionId);
    });
  }

  function timestamp() {
    const value = typeof settings.now === 'function' ? settings.now() : new Date().toISOString();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
    return value;
  }

  function freshId() {
    const created = typeof settings.createId === 'function' ? settings.createId() : crypto.randomUUID();
    return canonicalId(created);
  }

  function snapshot(productionId) {
    const loaded = store.readProduction(productionId);
    if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
    const version = store.readVersion(productionId, loaded.production.headVersionId);
    if (!version.ok) {
      return fail(
        version.code === 'missing-parent' ? 'missing-version' : (version.code || 'corrupt-version'),
        version.error || 'The saved head could not be read.',
      );
    }
    const readiness = assessStored(productionId, loaded.production.headVersionId);
    const pointer = readLivePointer();
    const live = Boolean(pointer.ok && pointer.present && pointer.productionId === productionId);
    return {
      ok: true,
      productionId,
      title: loaded.production.title,
      createdAt: loaded.production.createdAt || null,
      updatedAt: loaded.production.updatedAt || null,
      generation: loaded.production.generation,
      headVersionId: loaded.production.headVersionId,
      contentHash: version.version.contentHash,
      text: version.text,
      activationReady: Boolean(readiness.ok && readiness.activationReady),
      imageStatus: readiness.ok ? readiness.imageStatus : (readiness.code || 'corrupt-version'),
      sharedLegacyImages: Boolean(readiness.ok && readiness.sharedLegacyImages),
      live,
      liveVersionId: live ? pointer.versionId : null,
      liveGeneration: live ? pointer.generation : null,
      liveProductionId: pointer.ok && pointer.present ? pointer.productionId : null,
    };
  }

  function readLiveRecord() {
    const filePath = path.join(library.real, 'live-state.json');
    const read = readNoFollow(filePath, 1024 * 1024);
    if (read.missing) return { ok: true, present: false };
    if (!read.bytes) return fail('invalid-live-state', 'live-state.json could not be read.');
    let state;
    try {
      state = JSON.parse(read.bytes.toString('utf8'));
    } catch (err) {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
    const productionId = canonicalId(state && state.productionId);
    const versionId = canonicalId(state && state.versionId);
    if (
      !state
      || state.schema !== 1
      || !productionId
      || !versionId
      || typeof state.contentHash !== 'string'
      || !Number.isInteger(state.generation)
      || state.generation < 1
    ) {
      return fail('invalid-live-state', 'live-state.json could not be read.');
    }
    const version = store.readVersion(productionId, versionId);
    if (!version.ok || version.version.contentHash !== state.contentHash) {
      return fail('invalid-live-state', 'live-state.json does not match a stored version.');
    }
    const mirror = readNoFollow(path.resolve(scriptFile), 8 * 1024 * 1024);
    if (!mirror.bytes || !mirror.bytes.equals(Buffer.from(version.text, 'utf8'))) {
      return fail('mirror-conflict', 'The compatibility mirror does not match the live version.');
    }
    const production = store.readProduction(productionId);
    let previousActivation = null;
    if (state.previousActivation != null) {
      const previous = state.previousActivation;
      const previousProductionId = canonicalId(previous && previous.productionId);
      const previousVersionId = canonicalId(previous && previous.versionId);
      if (!previousProductionId || !previousVersionId || typeof previous.contentHash !== 'string') {
        return fail('invalid-live-state', 'live-state.json could not be read.');
      }
      const previousVersion = store.readVersion(previousProductionId, previousVersionId);
      if (!previousVersion.ok || previousVersion.version.contentHash !== previous.contentHash) {
        return fail('invalid-live-state', 'The previous activation does not match a stored version.');
      }
      previousActivation = {
        productionId: previousProductionId,
        versionId: previousVersionId,
        contentHash: previous.contentHash,
        text: previousVersion.text,
      };
    }
    return {
      ok: true,
      present: true,
      productionId,
      versionId,
      contentHash: state.contentHash,
      generation: state.generation,
      text: version.text,
      title: production.ok ? production.production.title : '',
      previousActivation,
    };
  }

  function liveExpectations(body, record) {
    const requestedGeneration = Object.prototype.hasOwnProperty.call(body, 'expectedLiveGeneration')
      ? body.expectedLiveGeneration
      : record.generation;
    const requestedVersion = Object.prototype.hasOwnProperty.call(body, 'expectedLiveVersionId')
      ? body.expectedLiveVersionId
      : record.versionId;
    const requestedHash = Object.prototype.hasOwnProperty.call(body, 'expectedLiveContentHash')
      ? body.expectedLiveContentHash
      : record.contentHash;
    if (
      requestedGeneration !== record.generation
      || canonicalId(requestedVersion) !== record.versionId
      || requestedHash !== record.contentHash
    ) {
      return fail('stale-live', 'The live version changed after this operation was prepared.');
    }
    return {
      ok: true,
      expectedGeneration: record.generation,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
    };
  }

  function readProductionDetail(productionId) {
    return exclusive(() => snapshot(canonicalId(productionId) || productionId));
  }

  function updateProduction(input) {
    return exclusive(async () => {
      const body = input || {};
      const productionId = canonicalId(body.productionId);
      if (!productionId) return fail('invalid-id', 'That production id is not valid.');
      const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
      const hasText = Object.prototype.hasOwnProperty.call(body, 'text');
      if (!hasTitle && !hasText) return fail('invalid-script', 'A title or a script is required.');
      if (typeof body.expectedRevision !== 'string' || body.expectedRevision === '') {
        return fail('revision-required', 'The script revision was missing, so nothing was saved.');
      }
      let titled = null;
      if (hasTitle) {
        titled = validateTitle(body.title);
        if (!titled.ok) return titled;
      }
      const current = snapshot(productionId);
      if (!current.ok) return current;
      if (current.contentHash !== body.expectedRevision) {
        return fail('conflict', 'This saved script was changed after you opened it. Your edits were not saved over that newer copy.', {
          field: hasText ? 'text' : 'title',
          generation: current.generation,
          headVersionId: current.headVersionId,
          contentHash: current.contentHash,
        });
      }
      if (Object.prototype.hasOwnProperty.call(body, 'expectedGeneration')) {
        if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 1) {
          return fail('generation-required', 'A rename needs the production generation it was based on.');
        }
        if (body.expectedGeneration !== current.generation) {
          return fail('conflict', 'The production title changed after this rename was prepared.', {
            field: 'title',
            generation: current.generation,
          });
        }
      }
      const textDiffers = hasText && body.text !== current.text;
      if (textDiffers) {
        if (typeof body.text !== 'string') return fail('invalid-script', 'The script could not be read.');
        if (body.expectedVersionId != null && canonicalId(body.expectedVersionId) !== current.headVersionId) {
          return fail('conflict', 'The production changed after this version was opened.', {
            field: 'text',
            currentVersionId: current.headVersionId,
          });
        }
        const formatted = validate(body.text);
        if (!formatted.ok) {
          const message = formatted.errors[0] && formatted.errors[0].message
            ? formatted.errors[0].message
            : 'This script could not be saved.';
          return fail('invalid-script', message);
        }
      }
      let versionId = null;
      let createdAt = null;
      if (textDiffers) {
        versionId = canonicalId(body.newVersionId) || freshId();
        createdAt = typeof body.createdAt === 'string' ? body.createdAt : timestamp();
        if (!versionId || !createdAt) {
          return fail('invalid-id', 'A new version needs an id and a creation time.');
        }
      }
      let titleUnchanged = !hasTitle;
      if (hasTitle) {
        const renamed = await productions.renameProduction({
          productionId,
          title: titled.title,
          expectedGeneration: current.generation,
        });
        if (!renamed.ok) return renamed;
        titleUnchanged = Boolean(renamed.unchanged);
      }
      if (!textDiffers) {
        const after = snapshot(productionId);
        if (!after.ok) return after;
        return {
          ok: true,
          unchanged: titleUnchanged,
          titleSaved: hasTitle && !titleUnchanged,
          textSaved: false,
          production: after,
        };
      }
      const saved = await store.saveVersion({
        productionId,
        expectedVersionId: current.headVersionId,
        newVersionId: versionId,
        text: body.text,
        createdAt,
      });
      const after = snapshot(productionId);
      if (!saved.ok) {
        return {
          ok: false,
          partial: hasTitle && !titleUnchanged,
          titleSaved: hasTitle && !titleUnchanged,
          textSaved: false,
          field: 'text',
          code: saved.code,
          error: saved.error,
          production: after.ok ? after : null,
        };
      }
      if (!after.ok) return after;
      return {
        ok: true,
        unchanged: false,
        titleSaved: hasTitle && !titleUnchanged,
        textSaved: !saved.unchanged,
        production: after,
      };
    });
  }

  function readLiveShow() {
    return exclusive(() => readLiveRecord());
  }

  function resolveTrackCurrent(input) {
    return exclusive(() => {
      const text = input && input.text;
      if (typeof text !== 'string') return fail('invalid-script', 'The script could not be read.');
      const record = readLiveRecord();
      if (!record.ok) return record;
      if (!record.present) {
        return fail('not-installed', 'There is no live show to save. Nothing was created, and the live show was not changed.');
      }
      const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      if (digest !== record.contentHash) {
        return fail('live-mismatch', 'That script is not the current live show. Nothing was created, and the live show was not changed.');
      }
      const head = snapshot(record.productionId);
      if (!head.ok) return head;
      if (head.contentHash !== record.contentHash) {
        return fail('saved-head-differs', 'The live show is already stored on this production, and its saved copy is different. A second production was not created, and the live show was not changed.', {
          productionId: record.productionId,
          versionId: record.versionId,
          headVersionId: head.headVersionId,
        });
      }
      return {
        ok: true,
        tracked: true,
        activated: false,
        production: head,
      };
    });
  }

  async function deliverLive(result) {
    if (!result || result.ok !== true) return result;
    if (typeof settings.onLiveCommit !== 'function') {
      return Object.assign({}, result, { synchronized: false });
    }
    try {
      const sync = await settings.onLiveCommit(result);
      return Object.assign({}, result, { synchronized: Boolean(sync && sync.synchronized) });
    } catch (err) {
      return Object.assign({}, result, { synchronized: false });
    }
  }

  function activateSavedHead(input) {
    return exclusive(async () => {
      const body = input || {};
      const productionId = canonicalId(body.productionId);
      if (!productionId) return fail('invalid-id', 'That production id is not valid.');
      if (typeof body.expectedRevision !== 'string' || body.expectedRevision === '') {
        return fail('revision-required', 'The script revision was missing, so this script was not set live. Open the library again and review the script before setting it live.');
      }
      const head = snapshot(productionId);
      if (!head.ok) return head;
      if (head.contentHash !== body.expectedRevision) {
        return fail('conflict', 'This saved script changed after you reviewed it. It was not set live. Review the latest version, then set it live again.');
      }
      const record = readLiveRecord();
      if (!record.ok) return record;
      if (!record.present) return fail('not-installed', 'The versioned show has not finished initial installation.');
      const expected = liveExpectations(body, record);
      if (!expected.ok) return expected;
      const activated = await live.setLiveVersion({
        productionId,
        useHead: true,
        expectedHeadVersionId: head.headVersionId,
        versionId: head.headVersionId,
        expectedGeneration: expected.expectedGeneration,
        expectedVersionId: expected.expectedVersionId,
        expectedContentHash: expected.expectedContentHash,
        failAt: body.failAt || '',
      }).then(interpretLive);
      if (activated && activated.ok) {
        activated.previousTitle = record.title || '';
        activated.title = head.title;
        activated.resetPosition = Boolean(activated.cue && activated.cue.action === 'reset');
      }
      return deliverLive(activated);
    });
  }

  function publishCurrent(input) {
    return exclusive(async () => {
      const body = input || {};
      const record = readLiveRecord();
      if (!record.ok) return record;
      if (!record.present) return fail('not-installed', 'The versioned show has not finished initial installation.');
      const requested = body.productionId ? canonicalId(body.productionId) : null;
      if (body.productionId && !requested) return fail('invalid-id', 'That production id is not valid.');
      if (requested && requested !== record.productionId) {
        return fail('wrong-production', 'A live publish can change only the production that is live.');
      }
      const head = snapshot(record.productionId);
      if (!head.ok) return head;
      if (typeof body.expectedRevision === 'string' && body.expectedRevision !== '' && body.expectedRevision !== head.contentHash) {
        return fail('conflict', 'This saved script was changed after you opened it. Your edits were not saved over that newer copy.');
      }
      const expected = liveExpectations(body, record);
      if (!expected.ok) return expected;
      if (typeof body.text !== 'string') return fail('invalid-script', 'The script could not be read.');
      const versionId = canonicalId(body.newVersionId) || freshId();
      const createdAt = typeof body.createdAt === 'string' ? body.createdAt : timestamp();
      if (!versionId || !createdAt) return fail('invalid-clock', 'A published version needs an id and a creation time.');
      const published = await live.publishLiveVersion({
        productionId: record.productionId,
        text: body.text,
        newVersionId: versionId,
        createdAt,
        expectedHeadVersionId: head.headVersionId,
        expectedGeneration: expected.expectedGeneration,
        expectedVersionId: expected.expectedVersionId,
        expectedContentHash: expected.expectedContentHash,
        resetPosition: body.resetPosition === true,
        failAt: body.failAt || '',
      }).then(interpretLive);
      return deliverLive(published);
    });
  }

  function restoreCurrent(input) {
    return exclusive(async () => {
      const body = input || {};
      const record = readLiveRecord();
      if (!record.ok) return record;
      if (!record.present) return fail('not-installed', 'The versioned show has not finished initial installation.');
      if (!record.previousActivation) {
        return fail('no-previous-activation', 'There is no previous live activation to restore.');
      }
      if (typeof body.text !== 'string' || body.text !== record.previousActivation.text) {
        return fail('invalid-script', 'The previous script could not be restored. The live show was not changed.');
      }
      const expected = liveExpectations(body, record);
      if (!expected.ok) return expected;
      const restored = await live.restorePreviousLive({
        expectedGeneration: expected.expectedGeneration,
        expectedVersionId: expected.expectedVersionId,
        expectedContentHash: expected.expectedContentHash,
        failAt: body.failAt || '',
      }).then(interpretLive);
      return deliverLive(restored);
    });
  }

  return {
    ok: true,
    libraryReal: library.real,
    listProductions,
    readProduction: (productionId) => exclusive(() => productions.readProduction(productionId)),
    createProduction: (input) => exclusive(() => productions.createProduction(input)),
    renameProduction: (input) => exclusive(() => productions.renameProduction(input)),
    saveVersion: (input) => exclusive(() => store.saveVersion(input)),
    uploadAsset: (input) => exclusive(() => assets.uploadAsset(input)),
    listAssets: (productionId) => exclusive(() => assets.listAssets(productionId)),
    readAsset: (productionId, assetId) => exclusive(() => assets.readAsset(productionId, assetId)),
    deleteAsset: (input) => exclusive(() => assets.deleteAsset(input)),
    assessProduction,
    assessVersionForActivation,
    readProductionDetail,
    updateProduction,
    readLiveShow,
    resolveTrackCurrent,
    activateSavedHead,
    publishCurrent,
    restoreCurrent,
    setLiveVersion: (input) => exclusive(() => live.setLiveVersion(input).then(interpretLive)),
    publishLiveVersion: (input) => exclusive(() => live.publishLiveVersion(input).then(interpretLive)),
    restorePreviousLive: (input) => exclusive(() => live.restorePreviousLive(input).then(interpretLive)),
    recoverLiveOperations: () => exclusive(() => live.recoverLiveOperations().then(interpretLive)),
    readLiveAsset: (productionId, assetId) => exclusive(() => assets.readLiveAsset(productionId, assetId)),
    close,
  };
}

module.exports = {
  HTTP_ADAPTER_CONTRACT,
  createVersionedLibraryService,
};
