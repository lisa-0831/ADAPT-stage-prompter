const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { detectStorageMode, StorageModeError } = require('./storage-mode');
const { validate } = require('../script-editor-model');
const { detectImage } = require('../script-library');
const { openReadOnlyVersionStore, VersionStoreError } = require('../library-version-store');

// Read-only view of a committed production tree. It does not create live
// state, update the migration marker, rewrite script.txt, or open a server.

const LIVE_STATE_NAME = 'live-state.json';
const MAX_STATE_BYTES = 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const LIVE_FIELDS = ['schema', 'productionId', 'versionId', 'contentHash', 'previousActivation', 'updatedAt', 'generation'];
const PREVIOUS_FIELDS = ['productionId', 'versionId', 'contentHash'];

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalId(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return SCRIPT_ID.test(id) ? id : null;
}

function canonicalHash(value) {
  if (typeof value !== 'string') return null;
  const hash = value.toLowerCase();
  return CONTENT_HASH.test(hash) ? hash : null;
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readNoFollow(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EPERM') {
      const error = new Error('Refusing to follow a symlink.');
      error.code = 'unsafe-path';
      throw error;
    }
    throw err;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function refused(code, error, extra) {
  const result = Object.assign({
    ok: false,
    status: 'refused',
    code,
    error,
    recoveryRequirements: [],
    initializationPending: false,
    text: null,
  }, extra || {});
  result.ok = false;
  result.status = 'refused';
  result.text = null;
  return result;
}

function resolveLibrary(libraryDir) {
  if (typeof libraryDir !== 'string' || libraryDir.length === 0 || libraryDir.includes('\0') || !path.isAbsolute(libraryDir)) {
    return refused('unsafe-path', 'The library directory must be an explicit absolute path.');
  }
  const lexical = path.resolve(libraryDir);
  const stat = lstatIfExists(lexical);
  if (!stat) return refused('missing-library', 'The library directory does not exist.');
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return refused('unsafe-path', 'The library directory must be a real directory.');
  }
  let libraryReal;
  try {
    libraryReal = fs.realpathSync(lexical);
  } catch (err) {
    return refused('unsafe-path', 'The library directory could not be resolved.');
  }
  if (!contained(libraryReal, libraryReal)) {
    return refused('unsafe-path', 'The library directory could not be resolved.');
  }
  return { ok: true, libraryDir: lexical, libraryReal };
}

function readJsonFile(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isFile()) return { unsafe: true };
  if (stat.size > MAX_STATE_BYTES) return { invalid: true };
  let bytes;
  try {
    bytes = readNoFollow(filePath);
  } catch (err) {
    if (err.code === 'unsafe-path') return { unsafe: true };
    throw err;
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
    return { value, bytes };
  } catch (err) {
    return { invalid: true };
  }
}

function validatePrevious(value, active) {
  if (value === null) return { ok: true, previousActivation: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid-previous-activation', error: 'The previous activation is not valid.' };
  }
  const unknown = Object.keys(value).filter((key) => !PREVIOUS_FIELDS.includes(key));
  if (unknown.length || PREVIOUS_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    return { ok: false, code: 'invalid-previous-activation', error: 'The previous activation is not valid.' };
  }
  const productionId = canonicalId(value.productionId);
  const versionId = canonicalId(value.versionId);
  const contentHash = canonicalHash(value.contentHash);
  if (!productionId || !versionId || !contentHash) {
    return { ok: false, code: 'invalid-previous-activation', error: 'The previous activation is not valid.' };
  }
  if (productionId === active.productionId && versionId === active.versionId) {
    return { ok: false, code: 'invalid-previous-activation', error: 'The previous activation points at the active version.' };
  }
  return {
    ok: true,
    previousActivation: { productionId, versionId, contentHash },
  };
}

function validateLiveState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid-live-state', error: 'live-state.json could not be read.' };
  }
  const unknown = Object.keys(value).filter((key) => !LIVE_FIELDS.includes(key));
  if (unknown.length || LIVE_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    return { ok: false, code: 'invalid-live-state', error: 'live-state.json is missing a required field.' };
  }
  if (value.schema !== 1) {
    return { ok: false, code: 'unsupported-schema', error: 'live-state.json uses a schema this loader does not recognize.' };
  }
  const productionId = canonicalId(value.productionId);
  const versionId = canonicalId(value.versionId);
  const contentHash = canonicalHash(value.contentHash);
  if (!productionId) return { ok: false, code: 'invalid-production-id', error: 'live-state.json has an invalid production id.' };
  if (!versionId) return { ok: false, code: 'invalid-version-id', error: 'live-state.json has an invalid version id.' };
  if (!contentHash) return { ok: false, code: 'invalid-content-hash', error: 'live-state.json has an invalid content hash.' };
  if (!Number.isInteger(value.generation) || value.generation < 1) {
    return { ok: false, code: 'invalid-live-state', error: 'live-state.json has an invalid generation.' };
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return { ok: false, code: 'invalid-live-state', error: 'live-state.json has an invalid timestamp.' };
  }
  const previous = validatePrevious(value.previousActivation, { productionId, versionId });
  if (!previous.ok) return previous;
  return {
    ok: true,
    liveState: {
      schema: 1,
      productionId,
      versionId,
      contentHash,
      previousActivation: previous.previousActivation,
      updatedAt: value.updatedAt,
      generation: value.generation,
    },
  };
}

function inspectMirror(scriptFile, contentHash) {
  if (scriptFile == null) return { ok: true, requirement: null };
  if (typeof scriptFile !== 'string' || scriptFile.includes('\0') || !path.isAbsolute(scriptFile)) {
    return { ok: false, code: 'unsafe-path', error: 'The script file must be an explicit absolute path.' };
  }
  const stat = lstatIfExists(scriptFile);
  if (!stat) return { ok: true, requirement: 'mirror-recovery-required' };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, code: 'unsafe-path', error: 'The script mirror is not a regular file.' };
  }
  let bytes;
  try {
    bytes = readNoFollow(scriptFile);
  } catch (err) {
    if (err.code === 'unsafe-path') return { ok: false, code: 'unsafe-path', error: 'The script mirror is not a regular file.' };
    throw err;
  }
  if (hashBuffer(bytes) !== contentHash) return { ok: true, requirement: 'mirror-recovery-required' };
  return { ok: true, requirement: null };
}

function inspectSharedImage(scriptFile, legacyPath, maxImageBytes) {
  if (typeof scriptFile !== 'string' || !path.isAbsolute(scriptFile)) {
    return { ok: false, code: 'unresolved-image', error: 'A shared image could not be resolved.' };
  }
  const name = legacyPath.slice('images/'.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, code: 'unsafe-path', error: 'A legacy image name is not safe.' };
  }
  const imagesDir = path.join(path.dirname(scriptFile), 'images');
  const dirStat = lstatIfExists(imagesDir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return { ok: false, code: 'unresolved-image', error: 'A shared image could not be resolved.' };
  }
  const filePath = path.join(imagesDir, name);
  const stat = lstatIfExists(filePath);
  if (!stat) return { ok: false, code: 'unresolved-image', error: 'A shared image could not be resolved.' };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, code: 'unsafe-path', error: 'A shared image is not a regular file.' };
  }
  let imagesReal;
  let fileReal;
  try {
    imagesReal = fs.realpathSync(imagesDir);
    fileReal = fs.realpathSync(filePath);
  } catch (err) {
    return { ok: false, code: 'unsafe-path', error: 'A shared image could not be resolved.' };
  }
  if (!contained(imagesReal, fileReal) || path.basename(fileReal) !== name) {
    return { ok: false, code: 'unsafe-path', error: 'A shared image resolves outside images/.' };
  }
  let bytes;
  try {
    bytes = readNoFollow(filePath);
  } catch (err) {
    if (err.code === 'unsafe-path') return { ok: false, code: 'unsafe-path', error: 'A shared image is not a regular file.' };
    throw err;
  }
  if (bytes.length > maxImageBytes) {
    return { ok: false, code: 'image-too-large', error: 'A shared image is larger than the allowed size.' };
  }
  const detected = detectImage(bytes);
  if (!detected || detected.incomplete || !detected.ext) {
    return { ok: false, code: 'unresolved-image', error: 'A shared image is not a complete image file.' };
  }
  return {
    ok: true,
    image: {
      path: legacyPath,
      shared: true,
      immutable: false,
      byteLength: bytes.length,
    },
  };
}

function versionFailure(result) {
  if (result.code === 'missing-parent' || result.code === 'missing-production') {
    const missingVersion = result.code === 'missing-parent';
    return refused(
      missingVersion ? 'missing-version' : 'missing-production',
      missingVersion ? 'The selected version could not be found.' : 'The selected production could not be found.',
    );
  }
  if (result.code === 'corrupt-version') {
    return refused('hash-mismatch', 'The selected version does not match its recorded bytes.');
  }
  return refused(result.code || 'corrupt-version', 'The selected version could not be read.');
}

function loadSelected(store, productionId, versionId, expectedHash, maxImageBytes, scriptFile) {
  const production = store.readProduction(productionId);
  if (!production.ok) return versionFailure(production);
  const version = store.readVersion(productionId, versionId);
  if (!version.ok) return versionFailure(version);
  if (version.version.contentHash !== expectedHash || version.version.productionId !== productionId) {
    return refused('hash-mismatch', 'The selected version does not match its recorded bytes.');
  }
  const checked = validate(version.text);
  if (!checked.ok) return refused('invalid-script', 'The selected script could not be validated.');
  const images = store.describeImages(productionId, version.text);
  if (!images.ok) return refused(images.code, images.error);
  if (images.assets.some((asset) => asset.byteLength > maxImageBytes)) {
    return refused('image-too-large', 'A production image is larger than the allowed size.');
  }
  const legacyImages = [];
  for (let index = 0; index < images.legacyImages.length; index += 1) {
    const shared = inspectSharedImage(scriptFile, images.legacyImages[index].path, maxImageBytes);
    if (!shared.ok) return refused(shared.code, shared.error);
    legacyImages.push(shared.image);
  }
  return {
    ok: true,
    production,
    version,
    images: {
      assets: images.assets,
      legacyImages,
      legacyImagePolicy: images.legacyImagePolicy,
    },
  };
}

function confirmPrevious(store, previous) {
  if (!previous) return { ok: true };
  const version = store.readVersion(previous.productionId, previous.versionId);
  if (!version.ok || version.version.contentHash !== previous.contentHash) {
    return refused('invalid-previous-activation', 'The previous activation does not match a stored version.');
  }
  return { ok: true };
}

function loadVersionedShow(options) {
  const settings = options || {};
  const maxImageBytes = Number.isInteger(settings.maxImageBytes) && settings.maxImageBytes > 0
    ? settings.maxImageBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  const located = resolveLibrary(settings.libraryDir);
  if (!located.ok) return located;
  let detected;
  try {
    detected = detectStorageMode({ libraryDir: located.libraryDir });
  } catch (err) {
    if (err instanceof StorageModeError) return refused(err.code, 'The migration marker cannot be used.');
    throw err;
  }
  if (!detected || detected.mode !== 'versioned' || !detected.marker) {
    return refused('missing-marker', 'This library has no committed migration marker.');
  }
  const marker = detected.marker;
  let store;
  try {
    store = openReadOnlyVersionStore({ root: located.libraryReal });
  } catch (err) {
    if (err instanceof VersionStoreError) return refused(err.code || 'unsafe-path', 'The production tree could not be opened.');
    throw err;
  }
  const statePath = path.join(located.libraryDir, LIVE_STATE_NAME);
  const stateFile = readJsonFile(statePath);
  if (stateFile.unsafe) return refused('unsafe-path', 'live-state.json is not a regular file.');
  if (stateFile.invalid) return refused('invalid-live-state', 'live-state.json could not be read.');
  let liveState = null;
  if (!stateFile.missing) {
    const parsed = validateLiveState(stateFile.value);
    if (!parsed.ok) return refused(parsed.code, parsed.error);
    liveState = parsed.liveState;
  }
  if (marker.mirrorInstalled && !liveState) {
    return refused('missing-live-state', 'The migration is installed, but the live pointer is missing.', {
      marker,
    });
  }
  const selected = liveState || {
    productionId: marker.productionId,
    versionId: marker.versionId,
    contentHash: marker.contentHash,
    previousActivation: null,
    generation: null,
  };
  let loaded;
  try {
    loaded = loadSelected(
      store,
      selected.productionId,
      selected.versionId,
      selected.contentHash,
      maxImageBytes,
      settings.scriptFile,
    );
  } catch (err) {
    if (err instanceof VersionStoreError || err.code === 'unsafe-path') {
      return refused('unsafe-path', 'A production file could not be read safely.');
    }
    throw err;
  }
  if (!loaded.ok) return Object.assign({ marker }, loaded, { text: null, status: 'refused', ok: false });
  const previous = confirmPrevious(store, liveState ? liveState.previousActivation : null);
  if (!previous.ok) return Object.assign({ marker }, previous);
  const mirror = inspectMirror(settings.scriptFile, loaded.version.version.contentHash);
  if (!mirror.ok) return refused(mirror.code, mirror.error, { marker });
  const recoveryRequirements = [];
  const initializationPending = Boolean(!marker.mirrorInstalled && !liveState);
  if (!initializationPending && !marker.mirrorInstalled && liveState) {
    recoveryRequirements.push('mirror-installation-incomplete');
  }
  if (mirror.requirement) recoveryRequirements.push(mirror.requirement);
  let status = 'loadable';
  if (initializationPending) status = 'initialization-required';
  else if (recoveryRequirements.length) status = 'recovery-required';
  const matchesInitialActivation = selected.productionId === marker.productionId
    && selected.versionId === marker.versionId
    && selected.contentHash === marker.contentHash;
  return {
    ok: true,
    status,
    code: status === 'loadable' ? null : (initializationPending ? 'initialization-required' : recoveryRequirements[0]),
    recoveryRequirements,
    initializationPending,
    activationReady: status === 'loadable',
    marker,
    matchesInitialActivation,
    productionId: selected.productionId,
    versionId: selected.versionId,
    contentHash: loaded.version.version.contentHash,
    text: loaded.version.text,
    title: loaded.production.production.title,
    headVersionId: loaded.production.production.headVersionId,
    savedHeadDiffers: loaded.production.production.headVersionId !== selected.versionId,
    generation: liveState ? liveState.generation : null,
    liveState,
    previousActivation: liveState ? liveState.previousActivation : null,
    parentVersionId: loaded.version.version.parentVersionId,
    legacyImagePolicy: loaded.images.legacyImagePolicy,
    historicalImagesImmutable: loaded.images.legacyImages.length ? false : null,
    assets: loaded.images.assets.map((asset) => ({
      assetId: asset.assetId,
      productionId: asset.productionId,
      ext: asset.ext,
      byteLength: asset.byteLength,
      contentHash: asset.contentHash,
    })),
    legacyImages: loaded.images.legacyImages,
  };
}

module.exports = {
  LIVE_STATE_NAME,
  loadVersionedShow,
};
