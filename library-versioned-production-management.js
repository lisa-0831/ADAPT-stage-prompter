const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('./script-editor-model');
const { parseImageReference } = require('./script-library-model');
const { hashText, isValidScriptId } = require('./script-library');
const { createVersionStore } = require('./library-version-store');

// Fixture-only production creation and rename. This module does not open a
// server, write Live State, or upload assets.
//
// One factory serializes its own create and rename calls. It does not share
// that queue with another factory, with M5 saveVersion, or with M7D2 live
// operations, and it does not lock another process. M7D3C has to call those
// writers through one coordinator before they share a library.
//
// The published name is <library>/productions/<uuid>. Files are written in a
// .creating-* directory this call created, verified, and then renamed. A
// dotted temporary directory is not a production id, so a crash before that
// rename does not publish a partial production. Only that owned temporary
// directory is removed. An existing UUID directory is never overwritten.

const CREATE_STAGES = Object.freeze([
  'before-directory',
  'version-script',
  'metadata',
  'manifest',
  'verify',
  'before-rename',
  'after-rename',
  'before-response',
]);
const RENAME_STAGES = Object.freeze([
  'before-metadata',
  'after-metadata',
]);
const SCHEMA = 1;
const TITLE_MAX = 120;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const REPO_ROOT = path.resolve(__dirname);
const HISTORICAL_IMAGE_NOTE = 'v1 keeps this images/ path. The text hash does not cover the image bytes, so replacing the shared file later changes what v1 displays.';
const PREVIEW_NOTE = 'The original version keeps its image lines. Shared images/ paths are not copied into this production.';

class ProductionError extends Error {
  constructor(code, message, stage) {
    super(message);
    this.name = 'ProductionError';
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

function readNoFollow(filePath) {
  const stat = lstatIfExists(filePath);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isFile()) return { unsafe: true };
  if (stat.size > MAX_SCRIPT_BYTES) return { invalid: true };
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
    throw new ProductionError('injected-failure', `Injected failure at ${name}.`, name);
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
    return fail('unsafe-root', 'Production management is limited to an explicit temporary fixture.');
  }
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return fail('unsafe-root', 'Production management is limited to an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function authorizeInside(rootReal, filePath, kind) {
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

function generationOf(metadata) {
  return Number.isInteger(metadata.generation) && metadata.generation >= 0
    ? metadata.generation
    : 1;
}

function validateTitle(title) {
  if (typeof title !== 'string') return fail('missing-title', 'Enter a title for this production.');
  if (/[\u0000-\u001F]/.test(title)) return fail('invalid-title', 'That title contains characters that cannot be saved.');
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return fail('missing-title', 'Enter a title that includes a name for this production.');
  }
  if (title.length > TITLE_MAX || trimmed.length > TITLE_MAX) {
    return fail('invalid-title', 'That title is too long. Use 120 characters or fewer.');
  }
  return { ok: true, title };
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

function classifyScriptImages(productionId, text, manifestAssets) {
  const id = canonicalId(productionId);
  const assets = Array.isArray(manifestAssets) ? manifestAssets : [];
  const listed = new Map();
  assets.forEach((asset) => {
    const assetId = canonicalId(asset && (asset.assetId || asset.id));
    if (assetId && !listed.has(assetId)) listed.set(assetId, asset);
  });
  const legacyImages = [];
  const historicalImages = [];
  const unresolvedAssets = [];
  const assigned = new Set();
  const seenLegacy = new Set();
  let foreign = false;
  let invalid = false;
  imageDirectives(text).forEach((parsed) => {
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'legacy') {
      if (!seenLegacy.has(parsed.path)) {
        seenLegacy.add(parsed.path);
        legacyImages.push({ path: parsed.path, shared: true, immutable: false });
        historicalImages.push({
          legacyPath: parsed.path,
          name: parsed.path.slice('images/'.length),
          byteSnapshot: false,
          dependency: 'shared-images',
          note: HISTORICAL_IMAGE_NOTE,
        });
      }
      return;
    }
    if (parsed.kind !== 'library' || !id) {
      invalid = true;
      return;
    }
    if (parsed.scriptId !== id) {
      foreign = true;
      return;
    }
    if (!listed.has(parsed.assetId)) {
      if (!unresolvedAssets.some((asset) => asset.assetId === parsed.assetId)) {
        unresolvedAssets.push({ productionId: id, assetId: parsed.assetId });
      }
      return;
    }
    assigned.add(parsed.assetId);
  });
  const unassignedAssets = [];
  listed.forEach((asset, assetId) => {
    if (!assigned.has(assetId)) unassignedAssets.push({ assetId, referenced: false });
  });
  let imageStatus = 'ready';
  if (invalid) imageStatus = 'invalid-image-reference';
  else if (foreign) imageStatus = 'foreign-asset';
  else if (legacyImages.length) imageStatus = 'unresolved-shared-images';
  else if (unresolvedAssets.length) imageStatus = 'unresolved-library-images';
  const activationReady = imageStatus === 'ready';
  let legacyImagePolicy = 'none';
  if (legacyImages.length) legacyImagePolicy = 'shared-images';
  else if (unresolvedAssets.length || assigned.size) legacyImagePolicy = 'production-assets';
  return {
    ok: !invalid && !foreign,
    imageStatus,
    activationReady,
    legacyImagePolicy,
    legacyImages,
    historicalImages,
    unresolvedAssets,
    unassignedAssets,
  };
}

function createProductionManager(options) {
  const root = authorizeRoot(options && options.root);
  const settings = options || {};
  const rejected = (result) => () => Promise.resolve(result);
  if (!root.ok) {
    return {
      ok: false,
      createProduction: rejected(root),
      renameProduction: rejected(root),
      readProduction: rejected(root),
    };
  }
  const library = authorizeInside(root.rootReal, settings.libraryDir, 'library');
  if (!library.ok) {
    return {
      ok: false,
      createProduction: rejected(library),
      renameProduction: rejected(library),
      readProduction: rejected(library),
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
      createProduction: rejected(storeError),
      renameProduction: rejected(storeError),
      readProduction: rejected(storeError),
    };
  }

  let chain = Promise.resolve();
  const now = settings.now;
  const createId = typeof settings.createId === 'function' ? settings.createId : () => crypto.randomUUID();

  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function timestamp() {
    const value = typeof now === 'function' ? now() : new Date().toISOString();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
    return value;
  }

  function productionsDir() {
    const dir = path.join(library.real, 'productions');
    const stat = lstatIfExists(dir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      return fail('unsafe-path', 'The productions directory is not a real directory.');
    }
    if (!stat) {
      fs.mkdirSync(dir);
      fsyncDirectory(library.real);
    }
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      return fail('unsafe-path', 'The productions directory could not be resolved.');
    }
    if (!insideStrict(real, library.real)) return fail('unsafe-path', 'The productions directory is outside the library.');
    return { ok: true, dir, real };
  }

  function productionPath(productions, productionId) {
    return path.join(productions, productionId);
  }

  function resultFrom(productionId, versionId, title, createdAt, generation, contentHash, images, extra) {
    return Object.assign({
      ok: true,
      status: 'created',
      confirmed: true,
      productionId,
      versionId,
      title,
      createdAt,
      generation,
      contentHash,
      headVersionId: versionId,
      activated: false,
      imageStatus: images.imageStatus,
      activationReady: images.activationReady,
      legacyImagePolicy: images.legacyImagePolicy,
      legacyImages: images.legacyImages,
      historicalImages: images.historicalImages,
      unresolvedAssets: images.unresolvedAssets,
      unassignedAssets: images.unassignedAssets,
    }, extra || {});
  }

  function readManifestAssets(dir) {
    const parsed = readNoFollow(path.join(dir, 'assets', 'manifest.json'));
    if (!parsed.bytes) return [];
    try {
      const value = JSON.parse(parsed.bytes.toString('utf8'));
      return value && Array.isArray(value.assets) ? value.assets : [];
    } catch (err) {
      return [];
    }
  }

  function confirmCreate(productions, plan) {
    const dir = productionPath(productions, plan.productionId);
    const stat = lstatIfExists(dir);
    if (!stat) return { ok: false, code: 'missing-production', missing: true };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('indeterminate', 'The production directory could not be confirmed.', { status: 'indeterminate' });
    }
    const metadataRead = readNoFollow(path.join(dir, 'metadata.json'));
    const scriptRead = readNoFollow(path.join(dir, 'versions', plan.versionId, 'script.txt'));
    const versionRead = readNoFollow(path.join(dir, 'versions', plan.versionId, 'version.json'));
    const manifestRead = readNoFollow(path.join(dir, 'assets', 'manifest.json'));
    if (!metadataRead.bytes || !scriptRead.bytes || !versionRead.bytes || !manifestRead.bytes) {
      return fail('indeterminate', 'The published production could not be read back.', { status: 'indeterminate' });
    }
    let metadata;
    let version;
    let manifest;
    try {
      metadata = JSON.parse(metadataRead.bytes.toString('utf8'));
      version = JSON.parse(versionRead.bytes.toString('utf8'));
      manifest = JSON.parse(manifestRead.bytes.toString('utf8'));
    } catch (err) {
      return fail('indeterminate', 'The published production could not be read back.', { status: 'indeterminate' });
    }
    const same = metadata
      && metadata.id === plan.productionId
      && metadata.title === plan.title
      && metadata.headVersionId === plan.versionId
      && scriptRead.bytes.equals(plan.scriptBytes)
      && version
      && version.id === plan.versionId
      && version.productionId === plan.productionId
      && version.contentHash === plan.contentHash
      && version.origin === 'original'
      && manifest
      && manifest.productionId === plan.productionId
      && Array.isArray(manifest.assets);
    if (!same) return fail('conflict', 'That production id already exists with different content.');
    return {
      ok: true,
      match: true,
      createdAt: metadata.createdAt,
      generation: generationOf(metadata),
    };
  }

  function findRequest(productions, requestId, productionId) {
    let names;
    try {
      names = fs.readdirSync(productions);
    } catch (err) {
      return fail('unsafe-path', 'The productions directory could not be read.');
    }
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (!canonicalId(name) || name === productionId) continue;
      const metadataRead = readNoFollow(path.join(productions, name, 'metadata.json'));
      if (!metadataRead.bytes) continue;
      try {
        const metadata = JSON.parse(metadataRead.bytes.toString('utf8'));
        if (metadata && metadata.creationRequestId === requestId) {
          return fail('conflict', 'That creation request already belongs to another production.', {
            productionId: name,
          });
        }
      } catch (err) {
        return fail('indeterminate', 'An existing production could not be read.', { status: 'indeterminate' });
      }
    }
    return { ok: true };
  }

  function discardOwnedTemp(tempDir, productionsReal, versionId) {
    try {
      if (!tempDir) return;
      const base = path.basename(tempDir);
      if (!base.startsWith('.creating-') || base.includes('..')) return;
      const stat = lstatIfExists(tempDir);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
      let real;
      try {
        real = fs.realpathSync(tempDir);
      } catch (err) {
        return;
      }
      if (!insideStrict(real, productionsReal)) return;
      const versionDir = path.join(real, 'versions', versionId);
      const assetsDir = path.join(real, 'assets');
      const known = [
        path.join(versionDir, 'script.txt'),
        path.join(versionDir, 'version.json'),
        path.join(real, 'metadata.json'),
        path.join(assetsDir, 'manifest.json'),
      ];
      const top = fs.readdirSync(real);
      const allowedTop = new Set(['metadata.json', 'versions', 'assets']);
      if (top.some((name) => !allowedTop.has(name) && !/^\..+\.tmp$/.test(name))) return;
      known.forEach((filePath) => {
        const fileStat = lstatIfExists(filePath);
        if (fileStat && fileStat.isFile() && !fileStat.isSymbolicLink()) fs.unlinkSync(filePath);
      });
      [versionDir, path.join(real, 'versions'), assetsDir, real].forEach((dir) => {
        const dirStat = lstatIfExists(dir);
        if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      });
    } catch (err) {
      // Leave an unconfirmed temporary directory in place.
    }
  }

  function buildPlan(input) {
    const body = input || {};
    const productionId = canonicalId(body.productionId || createId());
    const versionId = canonicalId(body.versionId || createId());
    const requestId = body.requestId == null || body.requestId === ''
      ? null
      : canonicalId(body.requestId);
    if (!productionId || !versionId || (body.requestId && !requestId)) {
      return fail('invalid-id', 'The production and version ids are not valid.');
    }
    if (productionId === versionId) return fail('invalid-id', 'A production and its first version need different ids.');
    const titled = validateTitle(body.title);
    if (!titled.ok) return titled;
    if (typeof body.text !== 'string') return fail('invalid-script', 'The script could not be read.');
    const scriptBytes = Buffer.from(body.text, 'utf8');
    if (scriptBytes.length > MAX_SCRIPT_BYTES) return fail('invalid-script', 'The script is too large.');
    const checked = validate(body.text);
    if (!checked.ok) {
      const message = checked.errors[0] && checked.errors[0].message
        ? checked.errors[0].message
        : 'This script could not be saved.';
      return fail('invalid-script', message);
    }
    const createdAt = typeof body.createdAt === 'string' && !Number.isNaN(Date.parse(body.createdAt))
      ? body.createdAt
      : null;
    if (!createdAt) return fail('invalid-clock', 'A production needs a creation time.');
    const images = classifyScriptImages(productionId, body.text, []);
    if (!images.ok) {
      return fail(
        images.imageStatus,
        images.imageStatus === 'foreign-asset'
          ? 'An image belongs to a different production.'
          : 'An image line is not a supported reference.',
      );
    }
    const contentHash = hashBuffer(scriptBytes);
    if (contentHash !== hashText(body.text)) return fail('invalid-script', 'The script bytes could not be hashed.');
    const versionDocument = {
      id: versionId,
      productionId,
      role: 'v1',
      parentVersionId: null,
      origin: 'original',
      legacyImagePolicy: images.legacyImagePolicy,
      contentHash,
      assetIds: [],
      createdAt,
    };
    const metadata = {
      schema: SCHEMA,
      id: productionId,
      originalProductionId: productionId,
      title: titled.title,
      createdAt,
      updatedAt: createdAt,
      currentVersionId: versionId,
      headVersionId: versionId,
      generation: 1,
      versions: [{
        id: versionId,
        role: 'v1',
        origin: 'original',
        parentVersionId: null,
        contentHash,
      }],
      historicalImages: images.historicalImages,
      historicalPreview: {
        usesAssetSnapshots: false,
        note: PREVIEW_NOTE,
      },
    };
    if (requestId) metadata.creationRequestId = requestId;
    const manifest = { productionId, assets: [] };
    return {
      ok: true,
      productionId,
      versionId,
      requestId,
      title: titled.title,
      createdAt,
      contentHash,
      scriptBytes,
      images,
      versionBytes: stableBytes(versionDocument),
      metadataBytes: stableBytes(metadata),
      manifestBytes: stableBytes(manifest),
    };
  }

  function createProduction(input) {
    return exclusive(async () => {
      const failAt = input && input.failAt ? input.failAt : '';
      const plan = buildPlan(input);
      if (!plan.ok) return plan;
      const catalog = path.join(library.real, 'productions');
      const catalogStat = lstatIfExists(catalog);
      if (catalogStat && (catalogStat.isSymbolicLink() || !catalogStat.isDirectory())) {
        return fail('unsafe-path', 'The productions directory is not a real directory.');
      }
      if (catalogStat) {
        const existing = confirmCreate(catalog, plan);
        if (existing.ok) {
          return resultFrom(
            plan.productionId,
            plan.versionId,
            plan.title,
            existing.createdAt,
            existing.generation,
            plan.contentHash,
            plan.images,
            { unchanged: true },
          );
        }
        if (!existing.missing) return existing;
        if (plan.requestId) {
          const prior = findRequest(catalog, plan.requestId, plan.productionId);
          if (!prior.ok) return prior;
        }
      }
      checkpoint(failAt, 'before-directory');
      const located = productionsDir();
      if (!located.ok) return located;
      const tempName = `.creating-${plan.productionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      const tempDir = path.join(located.dir, tempName);
      let owned = null;
      try {
        fs.mkdirSync(tempDir);
        owned = tempDir;
        fsyncDirectory(located.dir);
        checkpoint(failAt, 'version-script');
        const versionDir = path.join(tempDir, 'versions', plan.versionId);
        fs.mkdirSync(versionDir, { recursive: true });
        writeAtomic(path.join(versionDir, 'script.txt'), plan.scriptBytes);
        writeAtomic(path.join(versionDir, 'version.json'), plan.versionBytes);
        fsyncDirectory(versionDir);
        checkpoint(failAt, 'metadata');
        writeAtomic(path.join(tempDir, 'metadata.json'), plan.metadataBytes);
        checkpoint(failAt, 'manifest');
        fs.mkdirSync(path.join(tempDir, 'assets'));
        writeAtomic(path.join(tempDir, 'assets', 'manifest.json'), plan.manifestBytes);
        fsyncDirectory(path.join(tempDir, 'assets'));
        fsyncDirectory(tempDir);
        const verifiedScript = readNoFollow(path.join(versionDir, 'script.txt'));
        const verifiedVersion = readNoFollow(path.join(versionDir, 'version.json'));
        const verifiedMetadata = readNoFollow(path.join(tempDir, 'metadata.json'));
        const verifiedManifest = readNoFollow(path.join(tempDir, 'assets', 'manifest.json'));
        const verified = verifiedScript.bytes && verifiedScript.bytes.equals(plan.scriptBytes)
          && verifiedVersion.bytes && verifiedVersion.bytes.equals(plan.versionBytes)
          && verifiedMetadata.bytes && verifiedMetadata.bytes.equals(plan.metadataBytes)
          && verifiedManifest.bytes && verifiedManifest.bytes.equals(plan.manifestBytes);
        if (!verified) return fail('corrupt-production', 'The new production did not match the bytes just written.');
        checkpoint(failAt, 'verify');
        checkpoint(failAt, 'before-rename');
        const dest = productionPath(located.dir, plan.productionId);
        const destStat = lstatIfExists(dest);
        if (destStat && destStat.isSymbolicLink()) return fail('unsafe-path', 'The production path is a symlink.');
        if (destStat) {
          const raced = confirmCreate(located.dir, plan);
          if (raced.ok) {
            return resultFrom(plan.productionId, plan.versionId, plan.title, raced.createdAt, raced.generation, plan.contentHash, plan.images, { unchanged: true });
          }
          return raced.missing ? fail('conflict', 'That production id appeared during creation.') : raced;
        }
        fs.renameSync(tempDir, dest);
        owned = null;
        fsyncDirectory(located.dir);
        checkpoint(failAt, 'after-rename');
        const confirmed = confirmCreate(located.dir, plan);
        if (!confirmed.ok) return confirmed.status === 'indeterminate' ? confirmed : fail('indeterminate', 'The published production could not be confirmed.', { status: 'indeterminate' });
        checkpoint(failAt, 'before-response');
        const readable = store.readProduction(plan.productionId);
        if (!readable.ok || readable.production.headVersionId !== plan.versionId || readable.production.title !== plan.title) {
          return fail('indeterminate', 'The published production could not be confirmed.', { status: 'indeterminate' });
        }
        return resultFrom(plan.productionId, plan.versionId, plan.title, confirmed.createdAt, confirmed.generation, plan.contentHash, plan.images, { unchanged: false });
      } catch (err) {
        if (owned) discardOwnedTemp(owned, located.real, plan.versionId);
        if (err instanceof ProductionError && (err.stage === 'after-rename' || err.stage === 'before-response')) {
          const confirmed = confirmCreate(located.dir, plan);
          if (confirmed.ok) {
            return resultFrom(plan.productionId, plan.versionId, plan.title, confirmed.createdAt, confirmed.generation, plan.contentHash, plan.images, {
              unchanged: false,
              recovered: true,
            });
          }
          return fail('indeterminate', 'The published production could not be confirmed.', { status: 'indeterminate' });
        }
        throw err;
      } finally {
        if (owned) discardOwnedTemp(owned, located.real, plan.versionId);
      }
    });
  }

  function renameProduction(input) {
    return exclusive(async () => {
      const body = input || {};
      const failAt = body.failAt || '';
      const productionId = canonicalId(body.productionId);
      if (!productionId) return fail('invalid-id', 'That production id is not valid.');
      const titled = validateTitle(body.title);
      if (!titled.ok) return titled;
      if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 1) {
        return fail('generation-required', 'A rename needs the production generation it was based on.');
      }
      const updatedAt = timestamp();
      if (!updatedAt) return fail('invalid-clock', 'The rename timestamp is not valid.');
      const loaded = store.readProduction(productionId);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const metadataRead = readNoFollow(path.join(library.real, 'productions', productionId, 'metadata.json'));
      if (!metadataRead.bytes) return fail('corrupt-metadata', 'The production metadata could not be read.');
      let metadata;
      try {
        metadata = JSON.parse(metadataRead.bytes.toString('utf8'));
      } catch (err) {
        return fail('corrupt-metadata', 'The production metadata could not be read.');
      }
      const generation = generationOf(metadata);
      if (generation !== body.expectedGeneration) {
        return fail('conflict', 'The production title changed after this rename was prepared.', {
          generation,
        });
      }
      if (metadata.title === titled.title) {
        return {
          ok: true,
          unchanged: true,
          status: 'renamed',
          productionId,
          title: metadata.title,
          generation,
          updatedAt: metadata.updatedAt || null,
          headVersionId: loaded.production.headVersionId,
          activated: false,
        };
      }
      const next = Object.assign({}, metadata, {
        title: titled.title,
        updatedAt,
        generation: generation + 1,
      });
      const bytes = stableBytes(next);
      checkpoint(failAt, 'before-metadata');
      const metadataPath = path.join(library.real, 'productions', productionId, 'metadata.json');
      try {
        writeAtomic(metadataPath, bytes);
        checkpoint(failAt, 'after-metadata');
      } catch (err) {
        if (err instanceof ProductionError && err.stage === 'after-metadata') {
          const again = readNoFollow(metadataPath);
          if (again.bytes && again.bytes.equals(bytes)) {
            return {
              ok: true,
              unchanged: false,
              recovered: true,
              confirmed: true,
              status: 'renamed',
              productionId,
              title: titled.title,
              generation: generation + 1,
              updatedAt,
              headVersionId: loaded.production.headVersionId,
              activated: false,
            };
          }
          return fail('indeterminate', 'The renamed production could not be confirmed.', { status: 'indeterminate' });
        }
        throw err;
      }
      const again = store.readProduction(productionId);
      if (!again.ok || again.production.title !== titled.title || again.production.generation !== generation + 1 || again.production.headVersionId !== loaded.production.headVersionId) {
        return fail('indeterminate', 'The renamed production could not be confirmed.', { status: 'indeterminate' });
      }
      return {
        ok: true,
        unchanged: false,
        confirmed: true,
        status: 'renamed',
        productionId,
        title: titled.title,
        generation: generation + 1,
        updatedAt,
        headVersionId: again.production.headVersionId,
        activated: false,
      };
    });
  }

  function readProduction(productionId) {
    return exclusive(async () => {
      const id = canonicalId(productionId);
      if (!id) return fail('invalid-id', 'That production id is not valid.');
      const loaded = store.readProduction(id);
      if (!loaded.ok) return fail(loaded.code || 'missing-production', loaded.error || 'That production could not be read.');
      const version = store.readVersion(id, loaded.production.headVersionId);
      if (!version.ok) return fail(version.code === 'missing-parent' ? 'missing-version' : (version.code || 'corrupt-version'), version.error || 'The saved head could not be read.');
      const images = classifyScriptImages(id, version.text, readManifestAssets(path.join(library.real, 'productions', id)));
      return {
        ok: true,
        production: loaded.production,
        contentHash: version.version.contentHash,
        origin: version.version.origin,
        legacyImagePolicy: version.version.legacyImagePolicy,
        imageStatus: images.imageStatus,
        activationReady: images.activationReady,
        legacyImages: images.legacyImages,
        unresolvedAssets: images.unresolvedAssets,
        unassignedAssets: images.unassignedAssets,
      };
    });
  }

  return {
    ok: true,
    createProduction,
    renameProduction,
    readProduction,
  };
}

module.exports = {
  CREATE_STAGES,
  RENAME_STAGES,
  ProductionError,
  classifyScriptImages,
  createProductionManager,
};
