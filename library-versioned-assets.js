const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseImageReference } = require('./script-library-model');
const { detectImage, displayAssetName, isValidScriptId } = require('./script-library');
const { createVersionStore } = require('./library-version-store');
const { classifyScriptImages } = require('./library-versioned-production-management');
const { loadVersionedShow } = require('./server/versioned-show');
const { assessWritableRoot } = require('./server/writable-root');
const { lockAround } = require('./server/storage-writer-lock');

// Fixture-only production assets. This module does not open a server, assign
// scenes, rewrite @image lines, or change a saved script version, the live
// pointer, or the compatibility mirror.
//
// One factory serializes its own uploads, deletions, lists, reads, readiness
// checks, and live reads. It does not share that queue with another factory,
// with M5 saveVersion, with M7D2, or with M7D3A. The versioned library
// service is the coordinator for one library root. Direct factory calls can
// still race with it. There is no cross-process lock.
//
// An asset id is immutable. The same id with different bytes is a conflict.
// A display filename is metadata and may be reused under a new id. The
// manifest is updated only after the image file has been written and hashed.
// An orphan file is not adopted unless this request names that asset id and
// the bytes match. A saved version that already names an id which is not in
// the manifest rejects the upload, so later bytes cannot fill a historical
// reference. That old version keeps its unresolved preview: the loader will
// not treat it as a verified image.
//
// assessProduction checks the saved head. A legacy images/ line stays
// unresolved even when the shared file exists. The versioned library service
// checks the exact target version and refuses a new activation when that
// check is not ready. Direct M7D2 calls that omit reviewActivation can still
// activate a shared-image version.
// readLiveAsset serves bytes only when the trusted loader's active script
// contains that exact production and asset id.

const UPLOAD_STAGES = Object.freeze([
  'before-file',
  'file-written',
  'before-manifest',
  'after-manifest',
  'before-response',
]);
const DELETE_STAGES = Object.freeze([
  'before-manifest',
  'after-manifest',
  'after-unlink',
]);
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

class AssetError extends Error {
  constructor(code, message, stage) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
    this.stage = stage || null;
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
  if (failAt === name) throw new AssetError('injected-failure', `Injected failure at ${name}.`, name);
}

function canonicalId(value) {
  if (!isValidScriptId(value)) return null;
  return value.toLowerCase();
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
  if (!assessWritableRoot(rootReal).ok) {
    return fail('unsafe-root', 'Asset management is limited to an explicit temporary fixture.');
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

function authorizeFile(rootReal, filePath, kind) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    return fail('unsafe-path', `The ${kind} path must be an explicit absolute path.`);
  }
  const lexical = path.resolve(filePath);
  const stat = lstatIfExists(lexical);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    return fail('unsafe-path', `The ${kind} path must be a real file.`);
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

function imageDirectives(text) {
  const found = [];
  String(text).split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*@image:\s*(.*?)\s*$/);
    if (!match) return;
    found.push(parseImageReference(match[1]));
  });
  return found;
}

function assetIdOf(entry) {
  return canonicalId(entry && (entry.assetId || entry.id));
}

function createVersionedAssetManager(options) {
  const settings = options || {};
  const root = authorizeRoot(settings.root);
  const rejected = (result) => () => Promise.resolve(result);
  if (!root.ok) {
    return {
      ok: false,
      uploadAsset: rejected(root),
      listAssets: rejected(root),
      readAsset: rejected(root),
      deleteAsset: rejected(root),
      readLiveAsset: rejected(root),
      assessProduction: rejected(root),
    };
  }
  const library = authorizeDirectory(root.rootReal, settings.libraryDir, 'library');
  if (!library.ok) {
    return {
      ok: false,
      uploadAsset: rejected(library),
      listAssets: rejected(library),
      readAsset: rejected(library),
      deleteAsset: rejected(library),
      readLiveAsset: rejected(library),
      assessProduction: rejected(library),
    };
  }
  const script = settings.scriptFile == null
    ? null
    : authorizeFile(root.rootReal, settings.scriptFile, 'script mirror');
  if (script && !script.ok) {
    return {
      ok: false,
      uploadAsset: rejected(script),
      listAssets: rejected(script),
      readAsset: rejected(script),
      deleteAsset: rejected(script),
      readLiveAsset: rejected(script),
      assessProduction: rejected(script),
    };
  }
  let store = null;
  let storeError = null;
  try {
    store = createVersionStore({ root: library.real });
  } catch (err) {
    storeError = fail(err.code || 'unsafe-path', 'The production tree could not be opened.');
  }
  if (!store) {
    return {
      ok: false,
      uploadAsset: rejected(storeError),
      listAssets: rejected(storeError),
      readAsset: rejected(storeError),
      deleteAsset: rejected(storeError),
      readLiveAsset: rejected(storeError),
      assessProduction: rejected(storeError),
    };
  }

  const maxImageBytes = Number.isInteger(settings.maxImageBytes) && settings.maxImageBytes > 0
    ? settings.maxImageBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  const now = settings.now;
  const createId = typeof settings.createId === 'function' ? settings.createId : () => crypto.randomUUID();
  let chain = Promise.resolve();

  function exclusive(work) {
    const run = chain.then(() => lockAround(library.real, work), () => lockAround(library.real, work));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function timestamp() {
    const value = typeof now === 'function' ? now() : new Date().toISOString();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
    return value;
  }

  function productionDir(productionId) {
    const dir = path.join(library.real, 'productions', productionId);
    const stat = lstatIfExists(dir);
    if (!stat) return fail('missing-production', 'That production could not be found.');
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe-path', 'That production path is not a real directory.');
    }
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      return fail('unsafe-path', 'That production path could not be resolved.');
    }
    if (!insideStrict(real, library.real)) return fail('unsafe-path', 'That production path is outside the library.');
    return { ok: true, dir, real };
  }

  function assetsDir(production, create) {
    const dir = path.join(production.dir, 'assets');
    const stat = lstatIfExists(dir);
    if (!stat && create === false) return { ok: true, missing: true, dir, real: null };
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      return fail('unsafe-path', 'The asset directory is not a real directory.');
    }
    if (!stat) {
      fs.mkdirSync(dir);
      fsyncDirectory(production.dir);
    }
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      return fail('unsafe-path', 'The asset directory could not be resolved.');
    }
    if (!insideStrict(real, production.real)) return fail('unsafe-path', 'The asset directory is outside the production.');
    return { ok: true, dir, real };
  }

  function readManifest(productionId) {
    const filePath = path.join(library.real, 'productions', productionId, 'assets', 'manifest.json');
    const read = readNoFollow(filePath, 1024 * 1024);
    if (read.missing) return { ok: true, assets: [], bytes: null, missing: true };
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
    return { ok: true, manifest: value, assets: value.assets, bytes: read.bytes };
  }

  function entryFileName(entry, assetId) {
    const ext = entry && entry.ext;
    const fileName = typeof entry.file === 'string' && entry.file ? entry.file : `${assetId}.${ext}`;
    if (fileName !== path.basename(fileName) || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return null;
    }
    return fileName;
  }

  function verifyEntry(assets, entry) {
    const assetId = assetIdOf(entry);
    if (!assetId) return fail('corrupt-asset', 'That image id is not valid.');
    const fileName = entryFileName(entry, assetId);
    if (!fileName) return fail('corrupt-asset', 'That image path is not valid.');
    const filePath = path.join(assets.dir, fileName);
    const relative = path.relative(assets.real, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return fail('corrupt-asset', 'That image path is not valid.');
    const read = readNoFollow(filePath, maxImageBytes);
    if (read.missing) return fail('missing-asset', 'That image is not part of this production.');
    if (read.unsafe) return fail('unsafe-path', 'That image file is a symlink.');
    if (!read.bytes) return fail('corrupt-asset', 'That image file could not be read.');
    let real;
    try {
      real = fs.realpathSync(filePath);
    } catch (err) {
      return fail('unsafe-path', 'That image file could not be resolved.');
    }
    if (!insideStrict(real, assets.real)) return fail('unsafe-path', 'That image file is outside the production.');
    const detected = detectImage(read.bytes);
    if (!detected || detected.incomplete || !detected.ext) {
      return fail('corrupt-asset', 'That image file is not a complete JPEG, PNG, or WebP file.');
    }
    if (entry.ext && detected.ext !== entry.ext) return fail('corrupt-asset', 'That image file does not match its manifest.');
    const contentHash = hashBuffer(read.bytes);
    const expected = entry.contentHash || entry.sha256;
    if (!expected || expected !== contentHash) return fail('corrupt-asset', 'That image file does not match its manifest.');
    const declared = Number.isInteger(entry.byteLength) ? entry.byteLength : entry.bytes;
    if (Number.isInteger(declared) && declared !== read.bytes.length) {
      return fail('corrupt-asset', 'That image file does not match its manifest.');
    }
    return {
      ok: true,
      assetId,
      productionId: null,
      file: fileName,
      name: typeof entry.originalName === 'string' ? entry.originalName : (typeof entry.name === 'string' ? entry.name : 'Image'),
      ext: detected.ext,
      mime: detected.mime,
      byteLength: read.bytes.length,
      contentHash,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
      recordedReferenced: entry.referenced === false ? false : (entry.referenced === true ? true : null),
      bytes: read.bytes,
      filePath,
    };
  }

  function scanReferences(productionId) {
    const versionsDir = path.join(library.real, 'productions', productionId, 'versions');
    const stat = lstatIfExists(versionsDir);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('incomplete-inventory', 'The version directory could not be inspected.');
    }
    let names;
    try {
      names = fs.readdirSync(versionsDir);
    } catch (err) {
      return fail('incomplete-inventory', 'The version directory could not be inspected.');
    }
    const referenced = new Map();
    const versions = new Map();
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (/^\..+\.tmp$/.test(name)) continue;
      const versionId = canonicalId(name);
      if (!versionId || versionId !== name) {
        return fail('incomplete-inventory', 'A version directory could not be inspected.');
      }
      const dir = path.join(versionsDir, name);
      const dirStat = lstatIfExists(dir);
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        return fail('incomplete-inventory', 'A version directory could not be inspected.');
      }
      const version = store.readVersion(productionId, versionId);
      if (!version.ok) return fail('incomplete-inventory', 'A saved version could not be inspected.');
      versions.set(versionId, version.version.contentHash);
      const seen = new Set();
      imageDirectives(version.text).forEach((parsed) => {
        if (parsed.kind === 'library' && parsed.scriptId === productionId) seen.add(parsed.assetId);
      });
      (version.version.assetIds || []).forEach((assetId) => {
        const id = canonicalId(assetId);
        if (id) seen.add(id);
      });
      seen.forEach((assetId) => {
        if (!referenced.has(assetId)) referenced.set(assetId, []);
        referenced.get(assetId).push(versionId);
      });
    }
    const pointer = readActivations(productionId);
    if (!pointer.ok) return pointer;
    for (let index = 0; index < pointer.activations.length; index += 1) {
      const activation = pointer.activations[index];
      if (!versions.has(activation.versionId) || versions.get(activation.versionId) !== activation.contentHash) {
        return fail('incomplete-inventory', 'A live activation could not be matched to a saved version.');
      }
    }
    return { ok: true, referenced, activations: pointer.activations };
  }

  function readActivations(productionId) {
    const filePath = path.join(library.real, 'live-state.json');
    const read = readNoFollow(filePath, 1024 * 1024);
    if (read.missing) return { ok: true, activations: [] };
    if (!read.bytes) return fail('incomplete-inventory', 'live-state.json could not be read.');
    let state;
    try {
      state = JSON.parse(read.bytes.toString('utf8'));
    } catch (err) {
      return fail('incomplete-inventory', 'live-state.json could not be read.');
    }
    if (!state || state.schema !== 1) return fail('incomplete-inventory', 'live-state.json could not be read.');
    const activations = [];
    const currentId = canonicalId(state.productionId);
    const currentVersion = canonicalId(state.versionId);
    if (!currentId || !currentVersion || typeof state.contentHash !== 'string') {
      return fail('incomplete-inventory', 'live-state.json could not be read.');
    }
    if (currentId === productionId) {
      activations.push({ versionId: currentVersion, contentHash: state.contentHash });
    }
    if (state.previousActivation) {
      const previous = state.previousActivation;
      const previousId = canonicalId(previous.productionId);
      const previousVersion = canonicalId(previous.versionId);
      if (!previousId || !previousVersion || typeof previous.contentHash !== 'string') {
        return fail('incomplete-inventory', 'live-state.json could not be read.');
      }
      if (previousId === productionId) {
        activations.push({ versionId: previousVersion, contentHash: previous.contentHash });
      }
    }
    return { ok: true, activations };
  }

  function publicAsset(productionId, verified, referenced) {
    return {
      assetId: verified.assetId,
      productionId,
      file: verified.file,
      name: verified.name,
      ext: verified.ext,
      mime: verified.mime,
      byteLength: verified.byteLength,
      contentHash: verified.contentHash,
      createdAt: verified.createdAt,
      referenced: Boolean(referenced),
      unassigned: !referenced,
    };
  }

  function discardOwned(filePath, assetsReal) {
    try {
      if (!filePath) return;
      const base = path.basename(filePath);
      if (base.includes('..') || base !== path.basename(filePath)) return;
      const stat = lstatIfExists(filePath);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch (err) {
        return;
      }
      if (!insideStrict(real, assetsReal)) return;
      fs.unlinkSync(filePath);
    } catch (err) {
      // Leave a file whose ownership could not be confirmed.
    }
  }

  function uploadAsset(input) {
    return exclusive(async () => {
      const body = input || {};
      const failAt = body.failAt || '';
      const productionId = canonicalId(body.productionId);
      const assetId = canonicalId(body.assetId || createId());
      const requestId = body.requestId == null || body.requestId === '' ? null : canonicalId(body.requestId);
      if (!productionId || !assetId || (body.requestId && !requestId)) {
        return fail('invalid-id', 'The production and asset ids are not valid.');
      }
      if (!Buffer.isBuffer(body.body) || body.body.length === 0) {
        return fail('invalid-image', 'That file is not a JPEG, PNG, or WebP image.');
      }
      if (body.body.length > maxImageBytes) {
        return fail('too-large', `That image is too large. Use a file of ${maxImageBytes} bytes or smaller.`);
      }
      const detected = detectImage(body.body);
      if (!detected) return fail('invalid-image', 'That file is not a JPEG, PNG, or WebP image.');
      if (detected.incomplete) return fail('incomplete-image', 'That image file is incomplete. Try exporting it again.');
      const loaded = store.readProduction(productionId);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const inventory = scanReferences(productionId);
      if (!inventory.ok) return inventory;
      const production = productionDir(productionId);
      if (!production.ok) return production;
      const assets = assetsDir(production);
      if (!assets.ok) return assets;
      const manifest = readManifest(productionId);
      if (!manifest.ok) return manifest;
      const contentHash = hashBuffer(body.body);
      const displayName = displayAssetName(body.name);
      const existing = manifest.assets.find((entry) => assetIdOf(entry) === assetId);
      if (requestId) {
        const prior = manifest.assets.find((entry) => entry && entry.uploadRequestId === requestId && assetIdOf(entry) !== assetId);
        if (prior) return fail('conflict', 'That upload request already belongs to another asset.');
      }
      if (existing) {
        const verified = verifyEntry(assets, existing);
        if (!verified.ok) return verified;
        if (verified.contentHash !== contentHash || verified.byteLength !== body.body.length) {
          return fail('conflict', 'That asset id already exists with different bytes.');
        }
        return {
          ok: true,
          unchanged: true,
          status: 'stored',
          confirmed: true,
          asset: publicAsset(productionId, verified, inventory.referenced.has(assetId)),
        };
      }
      if (inventory.referenced.has(assetId)) {
        return fail('dangling-reference', 'A saved version already names that asset id, so these bytes were not attached to it.');
      }
      const fileName = `${assetId}.${detected.ext}`;
      const finalPath = path.join(assets.dir, fileName);
      const finalStat = lstatIfExists(finalPath);
      if (finalStat && finalStat.isSymbolicLink()) return fail('unsafe-path', 'That image file is a symlink.');
      if (finalStat && finalStat.isFile()) {
        const orphan = readNoFollow(finalPath, maxImageBytes);
        if (!orphan.bytes || hashBuffer(orphan.bytes) !== contentHash) {
          return fail('conflict', 'That asset id already exists with different bytes.');
        }
      }
      let ownedTemp = null;
      let ownedFinal = null;
      try {
        checkpoint(failAt, 'before-file');
        if (!finalStat) {
          const tempPath = path.join(assets.dir, `.upload-${assetId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
          writeAtomic(tempPath, body.body);
          ownedTemp = tempPath;
          const tempRead = readNoFollow(tempPath, maxImageBytes);
          if (!tempRead.bytes || hashBuffer(tempRead.bytes) !== contentHash) {
            return fail('corrupt-asset', 'The uploaded image did not match the bytes just written.');
          }
          fs.renameSync(tempPath, finalPath);
          ownedTemp = null;
          ownedFinal = finalPath;
          fsyncDirectory(assets.dir);
        }
        const stored = readNoFollow(finalPath, maxImageBytes);
        if (!stored.bytes || hashBuffer(stored.bytes) !== contentHash) {
          return fail('corrupt-asset', 'The uploaded image did not match the bytes just written.');
        }
        checkpoint(failAt, 'file-written');
        checkpoint(failAt, 'before-manifest');
        const fresh = readManifest(productionId);
        if (!fresh.ok) return fresh;
        if (fresh.assets.some((entry) => assetIdOf(entry) === assetId)) {
          const verified = verifyEntry(assets, fresh.assets.find((entry) => assetIdOf(entry) === assetId));
          if (verified.ok && verified.contentHash === contentHash) {
            ownedFinal = null;
            return {
              ok: true,
              unchanged: true,
              status: 'stored',
              confirmed: true,
              asset: publicAsset(productionId, verified, inventory.referenced.has(assetId)),
            };
          }
          return fail('conflict', 'That asset id already exists with different bytes.');
        }
        const createdAt = timestamp();
        if (!createdAt) return fail('invalid-clock', 'An asset needs a creation time.');
        const entry = {
          assetId,
          file: fileName,
          originalName: displayName,
          contentHash,
          ext: detected.ext,
          mime: detected.mime,
          byteLength: body.body.length,
          createdAt,
          referenced: false,
        };
        if (requestId) entry.uploadRequestId = requestId;
        const next = Object.assign({}, fresh.manifest || { productionId }, {
          productionId,
          assets: fresh.assets.concat([entry]),
        });
        writeAtomic(path.join(assets.dir, 'manifest.json'), stableBytes(next));
        ownedFinal = null;
        checkpoint(failAt, 'after-manifest');
        const confirmed = verifyEntry(assets, entry);
        if (!confirmed.ok || confirmed.contentHash !== contentHash) {
          return fail('indeterminate', 'The uploaded image could not be confirmed.', { status: 'indeterminate' });
        }
        checkpoint(failAt, 'before-response');
        return {
          ok: true,
          unchanged: false,
          status: 'stored',
          confirmed: true,
          asset: publicAsset(productionId, confirmed, false),
        };
      } catch (err) {
        if (err instanceof AssetError && (err.stage === 'after-manifest' || err.stage === 'before-response')) {
          const confirmed = verifyEntry(assets, {
            assetId,
            file: fileName,
            originalName: displayName,
            contentHash,
            ext: detected.ext,
            mime: detected.mime,
            byteLength: body.body.length,
          });
          const listed = readManifest(productionId);
          if (confirmed.ok && listed.ok && listed.assets.some((item) => assetIdOf(item) === assetId)) {
            return {
              ok: true,
              unchanged: false,
              recovered: true,
              confirmed: true,
              status: 'stored',
              asset: publicAsset(productionId, confirmed, inventory.referenced.has(assetId)),
            };
          }
          return fail('indeterminate', 'The uploaded image could not be confirmed.', { status: 'indeterminate' });
        }
        if (ownedTemp) discardOwned(ownedTemp, assets.real);
        if (ownedFinal && !manifest.assets.some((entry) => assetIdOf(entry) === assetId)) {
          discardOwned(ownedFinal, assets.real);
        }
        throw err;
      } finally {
        if (ownedTemp) discardOwned(ownedTemp, assets.real);
        if (ownedFinal) {
          const listed = readManifest(productionId);
          if (!listed.ok || !listed.assets.some((entry) => assetIdOf(entry) === assetId)) {
            discardOwned(ownedFinal, assets.real);
          }
        }
      }
    });
  }

  function listAssets(productionId) {
    return exclusive(async () => {
      const id = canonicalId(productionId);
      if (!id) return fail('invalid-id', 'That production id is not valid.');
      const loaded = store.readProduction(id);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const inventory = scanReferences(id);
      if (!inventory.ok) return inventory;
      const production = productionDir(id);
      if (!production.ok) return production;
      const assets = assetsDir(production, false);
      if (!assets.ok) return assets;
      if (assets.missing) return { ok: true, productionId: id, assets: [] };
      const manifest = readManifest(id);
      if (!manifest.ok) return manifest;
      const listed = [];
      for (let index = 0; index < manifest.assets.length; index += 1) {
        const verified = verifyEntry(assets, manifest.assets[index]);
        if (!verified.ok) return verified;
        listed.push(publicAsset(id, verified, inventory.referenced.has(verified.assetId)));
      }
      return { ok: true, productionId: id, assets: listed };
    });
  }

  function readAsset(productionId, assetId) {
    return exclusive(async () => readStored(productionId, assetId));
  }

  function readStored(productionId, assetId) {
    const id = canonicalId(productionId);
    const imageId = canonicalId(assetId);
    if (!id || !imageId) return fail('invalid-id', 'That image id is not valid.');
    const loaded = store.readProduction(id);
    if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
    const production = productionDir(id);
    if (!production.ok) return production;
    const assets = assetsDir(production, false);
    if (!assets.ok) return assets;
    if (assets.missing) return fail('missing-asset', 'That image is not part of this production.');
    const manifest = readManifest(id);
    if (!manifest.ok) return manifest;
    const entry = manifest.assets.find((item) => assetIdOf(item) === imageId);
    if (!entry) return fail('missing-asset', 'That image is not part of this production.');
    const verified = verifyEntry(assets, entry);
    if (!verified.ok) return verified;
    return {
      ok: true,
      productionId: id,
      assetId: imageId,
      name: verified.name,
      mime: verified.mime,
      ext: verified.ext,
      byteLength: verified.byteLength,
      contentHash: verified.contentHash,
      bytes: verified.bytes,
    };
  }

  function deleteAsset(input) {
    return exclusive(async () => {
      const body = input || {};
      const failAt = body.failAt || '';
      const productionId = canonicalId(body.productionId);
      const assetId = canonicalId(body.assetId);
      if (!productionId || !assetId) return fail('invalid-id', 'That image id is not valid.');
      const loaded = store.readProduction(productionId);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const inventory = scanReferences(productionId);
      if (!inventory.ok) return inventory;
      if (inventory.referenced.has(assetId)) {
        return fail('in-use', 'This image is still used by a saved version. Remove it from that version before deleting it.', {
          versions: inventory.referenced.get(assetId),
        });
      }
      const production = productionDir(productionId);
      if (!production.ok) return production;
      const assets = assetsDir(production, false);
      if (!assets.ok) return assets;
      if (assets.missing) return fail('missing-asset', 'That image is not part of this production.');
      const manifest = readManifest(productionId);
      if (!manifest.ok) return manifest;
      const entry = manifest.assets.find((item) => assetIdOf(item) === assetId);
      if (!entry) return fail('missing-asset', 'That image is not part of this production.');
      const verified = verifyEntry(assets, entry);
      if (!verified.ok) return verified;
      const next = Object.assign({}, manifest.manifest, {
        productionId,
        assets: manifest.assets.filter((item) => assetIdOf(item) !== assetId),
      });
      const nextBytes = stableBytes(next);
      try {
        checkpoint(failAt, 'before-manifest');
        writeAtomic(path.join(assets.dir, 'manifest.json'), nextBytes);
        checkpoint(failAt, 'after-manifest');
        const again = readNoFollow(verified.filePath, maxImageBytes);
        if (!again.bytes || hashBuffer(again.bytes) !== verified.contentHash) {
          return fail('indeterminate', 'The image bytes changed before they could be removed.', { status: 'indeterminate' });
        }
        fs.unlinkSync(verified.filePath);
        fsyncDirectory(assets.dir);
        checkpoint(failAt, 'after-unlink');
      } catch (err) {
        if (err instanceof AssetError && (err.stage === 'after-manifest' || err.stage === 'after-unlink')) {
          const listed = readManifest(productionId);
          if (!listed.ok) return fail('indeterminate', 'The asset manifest could not be confirmed.', { status: 'indeterminate' });
          if (listed.assets.some((item) => assetIdOf(item) === assetId)) {
            return fail('indeterminate', 'The asset manifest could not be confirmed.', { status: 'indeterminate' });
          }
          const leftover = lstatIfExists(verified.filePath);
          if (leftover && leftover.isFile() && !leftover.isSymbolicLink()) {
            const bytes = readNoFollow(verified.filePath, maxImageBytes);
            if (bytes.bytes && hashBuffer(bytes.bytes) === verified.contentHash) fs.unlinkSync(verified.filePath);
          }
          return {
            ok: true,
            deleted: true,
            recovered: true,
            confirmed: true,
            productionId,
            assetId,
          };
        }
        throw err;
      }
      const listed = readManifest(productionId);
      if (!listed.ok || listed.assets.some((item) => assetIdOf(item) === assetId) || lstatIfExists(verified.filePath)) {
        return fail('indeterminate', 'The deleted image could not be confirmed.', { status: 'indeterminate' });
      }
      return { ok: true, deleted: true, confirmed: true, productionId, assetId };
    });
  }

  function assessProduction(productionId) {
    return exclusive(async () => {
      const id = canonicalId(productionId);
      if (!id) return fail('invalid-id', 'That production id is not valid.');
      const loaded = store.readProduction(id);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const version = store.readVersion(id, loaded.production.headVersionId);
      if (!version.ok) return fail('incomplete-inventory', 'The saved head could not be inspected.');
      const manifest = readManifest(id);
      if (!manifest.ok) return manifest;
      const images = classifyScriptImages(id, version.text, manifest.assets);
      if (!images.activationReady) {
        return {
          ok: true,
          productionId: id,
          versionId: loaded.production.headVersionId,
          activationReady: false,
          imageStatus: images.imageStatus,
          unresolvedAssets: images.unresolvedAssets,
          unassignedAssets: images.unassignedAssets,
          legacyImages: images.legacyImages,
        };
      }
      const production = productionDir(id);
      if (!production.ok) return production;
      const referencedIds = imageDirectives(version.text)
        .filter((parsed) => parsed.kind === 'library' && parsed.scriptId === id)
        .map((parsed) => parsed.assetId);
      const assets = assetsDir(production, false);
      if (!assets.ok) return assets;
      if (assets.missing) {
        return {
          ok: true,
          productionId: id,
          versionId: loaded.production.headVersionId,
          activationReady: referencedIds.length === 0,
          imageStatus: referencedIds.length ? 'unresolved-library-images' : 'ready',
          unresolvedAssets: referencedIds.map((assetId) => ({ productionId: id, assetId })),
          unassignedAssets: images.unassignedAssets,
          legacyImages: [],
        };
      }
      for (let index = 0; index < referencedIds.length; index += 1) {
        const entry = manifest.assets.find((item) => assetIdOf(item) === referencedIds[index]);
        const verified = entry ? verifyEntry(assets, entry) : fail('missing-asset', 'That image is not part of this production.');
        if (!verified.ok) {
          return {
            ok: true,
            productionId: id,
            versionId: loaded.production.headVersionId,
            activationReady: false,
            imageStatus: 'unresolved-library-images',
            unresolvedAssets: [{ productionId: id, assetId: referencedIds[index] }],
            unassignedAssets: images.unassignedAssets,
            legacyImages: images.legacyImages,
          };
        }
      }
      return {
        ok: true,
        productionId: id,
        versionId: loaded.production.headVersionId,
        activationReady: true,
        imageStatus: 'ready',
        unresolvedAssets: [],
        unassignedAssets: images.unassignedAssets,
        legacyImages: [],
      };
    });
  }

  function readLiveAsset(productionId, assetId) {
    return exclusive(async () => {
      if (!script) return fail('script-required', 'A live image read needs the server-owned script mirror.');
      const id = canonicalId(productionId);
      const imageId = canonicalId(assetId);
      if (!id || !imageId) return fail('invalid-id', 'That image id is not valid.');
      const show = loadVersionedShow({
        libraryDir: library.lexical,
        scriptFile: script.lexical,
        maxImageBytes,
      });
      if (!show.ok || show.status !== 'loadable' || typeof show.text !== 'string') {
        return fail(show.code || 'not-live', 'The live script could not be verified.');
      }
      const allowed = imageDirectives(show.text).some((parsed) => (
        parsed.kind === 'library' && parsed.scriptId === id && parsed.assetId === imageId
      ));
      if (!allowed || show.productionId !== id) {
        return fail('not-live', 'That image is not part of the live script.');
      }
      const stored = readStored(id, imageId);
      if (!stored.ok) return stored;
      return {
        ok: true,
        productionId: id,
        assetId: imageId,
        mime: stored.mime,
        byteLength: stored.byteLength,
        contentHash: stored.contentHash,
        bytes: stored.bytes,
      };
    });
  }

  return {
    ok: true,
    uploadAsset,
    listAssets,
    readAsset,
    deleteAsset,
    readLiveAsset,
    assessProduction,
  };
}

module.exports = {
  UPLOAD_STAGES,
  DELETE_STAGES,
  AssetError,
  createVersionedAssetManager,
};
