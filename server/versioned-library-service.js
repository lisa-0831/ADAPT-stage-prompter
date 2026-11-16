const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('../script-editor-model');
const { isValidScriptId } = require('../script-library');
const { createVersionStore } = require('../library-version-store');
const {
  classifyScriptImages,
  createProductionManager,
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
    'POST /api/library': 'createProduction, then the existing separate image uploads. 201. An upload failure leaves the production in place.',
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
    return { ok: true, present: true, productionId, versionId, contentHash: state.contentHash };
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
