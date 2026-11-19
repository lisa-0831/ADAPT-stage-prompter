const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseImageReference } = require('./script-library-model');
const { detectImage, displayAssetName, hashText, isValidScriptId } = require('./script-library');
const { isPersistentRootRetained } = require('./server/persistent-authorization');

// Writes an already validated migration plan into a caller-supplied temporary
// root. It does not read the live show, activate a production, or choose a
// destination from the working directory.

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SCHEMA = 1;
const HISTORICAL_PREVIEW_NOTE = 'Copied asset bytes belong to the migrated version. v1 keeps its legacy images/ paths. No preview resolver reads these copies for v1.';

const ACTIVATION_PATHS = [
  path.join('data', 'library', 'migration.json'),
  path.join('data', 'library', 'live-state.json'),
  path.join('data', 'library', 'productions'),
  path.join('data', 'live-journal'),
];

class StagingError extends Error {
  constructor(code, message, status = 'absent') {
    super(message);
    this.name = 'StagingError';
    this.code = code;
    this.status = status;
  }
}

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    Object.keys(value).sort().forEach((key) => {
      sorted[key] = canonicalize(value[key]);
    });
    return sorted;
  }
  return value;
}

function stableString(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function stableBytes(value) {
  return Buffer.from(stableString(value), 'utf8');
}

function insideStrict(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function contained(candidate, boundary) {
  return candidate === boundary || insideStrict(candidate, boundary);
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    // A directory fsync is not available on every filesystem.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function assertNoSymlink(boundaryReal, target) {
  const relative = path.relative(boundaryReal, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StagingError(
      'symlink-escape',
      'A staging path resolves outside the destination root.',
      'conflict',
    );
  }
  let current = boundaryReal;
  if (relative === '') return;
  relative.split(path.sep).forEach((part) => {
    current = path.join(current, part);
    const stat = lstatIfExists(current);
    if (stat && stat.isSymbolicLink()) {
      throw new StagingError(
        'symlink-escape',
        `Refusing to follow the symlink at ${part}.`,
        'conflict',
      );
    }
  });
}

function componentsStayInside(start, boundaryReal) {
  let current = path.resolve(start);
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    let currentReal;
    try {
      currentReal = fs.realpathSync(current);
    } catch (err) {
      return false;
    }
    if (currentReal === boundaryReal) return true;
    if (!insideStrict(currentReal, boundaryReal)) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

function locateRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new StagingError('unsafe-destination', 'A destination root is required.');
  }
  if (!path.isAbsolute(root)) {
    throw new StagingError(
      'unsafe-destination',
      'The destination root must be an absolute path. Staging does not use the working directory.',
    );
  }
  const lexical = path.resolve(root);
  const tmpReal = fs.realpathSync(os.tmpdir());
  const repoReal = fs.realpathSync(path.resolve(__dirname));
  const linkStat = lstatIfExists(lexical);
  if (!linkStat) {
    throw new StagingError('unsafe-destination', 'The destination root does not exist.');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(lexical);
  } catch (err) {
    if (linkStat.isSymbolicLink()) {
      throw new StagingError(
        'symlink-escape',
        'The destination root is a symlink that resolves outside the temporary directory.',
      );
    }
    throw new StagingError('unsafe-destination', 'The destination root does not exist.');
  }
  if (rootReal === repoReal || insideStrict(rootReal, repoReal) || insideStrict(repoReal, rootReal)) {
    throw new StagingError('unsafe-destination', 'The destination root must not be the repository.');
  }
  if (isPersistentRootRetained(rootReal)) {
    const retainedStat = fs.lstatSync(rootReal);
    if (retainedStat.isSymbolicLink() || !retainedStat.isDirectory()) {
      throw new StagingError('unsafe-destination', 'The destination root must be a directory.');
    }
    return { rootReal, tmpReal, repoReal, boundary: rootReal };
  }
  if (rootReal === tmpReal) {
    throw new StagingError(
      'unsafe-destination',
      'The destination root must be a subdirectory of the temporary directory.',
    );
  }
  if (!insideStrict(rootReal, tmpReal)) {
    if (linkStat.isSymbolicLink() || componentsStayInside(lexical, tmpReal) === false) {
      const lexicalTmp = path.resolve(os.tmpdir());
      const lexicalInside = contained(lexical, lexicalTmp) || contained(lexical, tmpReal);
      if (linkStat.isSymbolicLink() || lexicalInside) {
        throw new StagingError(
          'symlink-escape',
          'The destination root resolves outside the temporary directory.',
        );
      }
    }
    throw new StagingError(
      'unsafe-destination',
      'The destination root must be a subdirectory of the temporary directory.',
    );
  }
  if (!componentsStayInside(lexical, tmpReal)) {
    throw new StagingError(
      'symlink-escape',
      'The destination root resolves outside the temporary directory.',
    );
  }
  if (contained(rootReal, repoReal) || contained(repoReal, rootReal)) {
    throw new StagingError('unsafe-destination', 'The destination root must not be the repository.');
  }
  const realStat = fs.statSync(rootReal);
  if (!realStat.isDirectory()) {
    throw new StagingError('unsafe-destination', 'The destination root must be a directory.');
  }
  return { rootReal, tmpReal, repoReal, boundary: tmpReal };
}

function workDir(rootReal) {
  return path.join(rootReal, 'data', 'library', 'migration-work');
}

function copyPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new StagingError('invalid-plan', 'Staging requires a successful migration plan.');
  }
  try {
    return JSON.parse(JSON.stringify(plan));
  } catch (err) {
    throw new StagingError('invalid-plan', 'The migration plan cannot be staged.');
  }
}

function checkVersion(version, productionId, role, seenVersions) {
  if (!version || typeof version !== 'object') {
    throw new StagingError('invalid-plan', `Production ${productionId} is missing ${role}.`);
  }
  if (!isValidScriptId(version.id)) {
    throw new StagingError('invalid-id', `Production ${productionId} has an invalid ${role} id.`);
  }
  if (seenVersions.has(version.id)) {
    throw new StagingError('invalid-plan', `Version ${version.id} is used more than once.`);
  }
  seenVersions.add(version.id);
  if (typeof version.text !== 'string') {
    throw new StagingError('invalid-plan', `Version ${version.id} has no script text.`);
  }
  const bytes = Buffer.from(version.text, 'utf8');
  if (version.contentHash !== hashText(version.text) || version.contentHash !== hashBuffer(bytes)) {
    throw new StagingError(
      'hash-mismatch',
      `Version ${version.id} does not match its script bytes.`,
      'conflict',
    );
  }
  if (role === 'v1' && version.origin !== 'original') {
    throw new StagingError('invalid-plan', `Version ${version.id} is not marked as the original.`);
  }
  if (role === 'v2' && version.origin !== 'migrated') {
    throw new StagingError('invalid-plan', `Version ${version.id} is not marked as the migrated version.`);
  }
  if (role === 'v2' && version.legacyImagePolicy !== 'production-assets') {
    throw new StagingError('invalid-plan', `Version ${version.id} does not use production-owned images.`);
  }
  return bytes;
}

function validatePlan(plan) {
  if (plan.ok !== true) {
    throw new StagingError('invalid-plan', 'Staging requires a successful migration plan.');
  }
  if (!plan.activation || plan.activation.commit !== false) {
    throw new StagingError('activation-refused', 'Staging cannot activate a migration.');
  }
  if (!Array.isArray(plan.productions) || plan.productions.length === 0) {
    throw new StagingError('invalid-plan', 'The plan has no productions.');
  }
  if (!isValidScriptId(plan.liveProductionId) || !plan.pointer) {
    throw new StagingError('invalid-plan', 'The plan has no live production.');
  }
  const seenVersions = new Set();
  const seenProductions = new Set();
  const assetOwners = new Map();
  plan.productions.forEach((production) => {
    if (!production || !isValidScriptId(production.id)) {
      throw new StagingError('invalid-id', 'A production id is not valid.');
    }
    if (seenProductions.has(production.id)) {
      throw new StagingError('invalid-plan', `Production ${production.id} appears more than once.`);
    }
    seenProductions.add(production.id);
    const versions = production.versions || {};
    checkVersion(versions.v1, production.id, 'v1', seenVersions);
    if (versions.v2) checkVersion(versions.v2, production.id, 'v2', seenVersions);
    if (versions.v1.parentVersionId !== null) {
      throw new StagingError('invalid-plan', `Version ${versions.v1.id} cannot have a parent.`);
    }
    if (versions.v2 && versions.v2.parentVersionId !== versions.v1.id) {
      throw new StagingError('invalid-plan', `Version ${versions.v2.id} must parent to its original version.`);
    }
    const headId = versions.v2 ? versions.v2.id : versions.v1.id;
    if (production.headVersionId !== headId) {
      throw new StagingError('invalid-plan', `Production ${production.id} has an unexpected head version.`);
    }
    (production.assetMappings || []).forEach((mapping) => {
      claimOwnedAsset(assetOwners, production.id, mapping && mapping.assetId);
    });
    (production.retainedLibraryReferences || []).forEach((reference) => {
      claimOwnedAsset(assetOwners, production.id, reference && reference.assetId);
    });
    (production.historicalImages || []).forEach((image) => {
      if (!image || image.byteSnapshot !== false) {
        throw new StagingError(
          'invalid-plan',
          `Production ${production.id} claims a historical image snapshot that was not taken.`,
        );
      }
    });
    [versions.v1, versions.v2].filter(Boolean).forEach((version) => {
      (version.assetIds || []).forEach((assetId) => {
        if (assetOwners.get(assetId) !== production.id) {
          throw new StagingError(
            'invalid-plan',
            `Version ${version.id} names asset ${assetId} without a mapping for this production.`,
          );
        }
      });
    });
  });
  const live = plan.productions.find((production) => production.id === plan.liveProductionId);
  if (!live) {
    throw new StagingError('invalid-plan', 'The live production is not in the plan.');
  }
  const head = live.versions.v2 || live.versions.v1;
  if (plan.pointer.productionId !== live.id
    || plan.pointer.versionId !== head.id
    || plan.pointer.contentHash !== head.contentHash) {
    throw new StagingError('invalid-plan', 'The recorded pointer does not match the live production head.');
  }
}

function claimOwnedAsset(owners, productionId, assetId) {
  if (!isValidScriptId(assetId)) {
    throw new StagingError('invalid-id', `Production ${productionId} has an invalid asset id.`);
  }
  const owner = owners.get(assetId);
  if (owner && owner !== productionId) {
    throw new StagingError(
      'shared-asset-id',
      `Asset ${assetId} is proposed for both ${owner} and ${productionId}.`,
      'conflict',
    );
  }
  owners.set(assetId, productionId);
}

function imageLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_IMAGE_BYTES;
}

function requiredAssets(plan) {
  const required = [];
  const seen = new Set();
  plan.productions.forEach((production) => {
    (production.assetMappings || []).forEach((mapping) => {
      const key = `${production.id}/${mapping.assetId}`;
      if (seen.has(key)) return;
      seen.add(key);
      required.push({
        productionId: production.id,
        assetId: mapping.assetId,
        originalName: displayAssetName(mapping.name),
        legacyPath: mapping.legacyPath || null,
      });
    });
    (production.retainedLibraryReferences || []).forEach((reference) => {
      if (!reference || !isValidScriptId(reference.assetId)) {
        throw new StagingError('invalid-id', `Production ${production.id} retains an invalid asset id.`);
      }
      const key = `${production.id}/${reference.assetId}`;
      if (seen.has(key)) return;
      seen.add(key);
      required.push({
        productionId: production.id,
        assetId: reference.assetId,
        originalName: null,
        legacyPath: null,
      });
    });
  });
  return required;
}

function prepareSources(plan, sources, maxImageBytes, located) {
  if (sources === undefined) sources = [];
  if (!Array.isArray(sources)) {
    throw new StagingError('invalid-plan', 'Image sources must be a list.');
  }
  const required = requiredAssets(plan);
  const byKey = new Map();
  sources.forEach((source) => {
    if (!source || typeof source !== 'object') {
      throw new StagingError('invalid-plan', 'An image source is missing.');
    }
    const productionId = typeof source.productionId === 'string' ? source.productionId.toLowerCase() : '';
    const assetId = typeof source.assetId === 'string' ? source.assetId.toLowerCase() : '';
    if (!isValidScriptId(productionId) || !isValidScriptId(assetId)) {
      throw new StagingError('invalid-id', 'An image source has an invalid id.');
    }
    const key = `${productionId}/${assetId}`;
    if (byKey.has(key)) {
      throw new StagingError('invalid-plan', `Image source ${key} was supplied more than once.`);
    }
    byKey.set(key, source);
  });
  const prepared = required.map((item) => {
    const source = byKey.get(`${item.productionId}/${item.assetId}`);
    if (!source) {
      throw new StagingError(
        'missing-source',
        `No image file was supplied for asset ${item.assetId}.`,
      );
    }
    byKey.delete(`${item.productionId}/${item.assetId}`);
    const read = readSource(source.path, maxImageBytes, located);
    return {
      productionId: item.productionId,
      assetId: item.assetId,
      originalName: item.originalName || displayAssetName(path.basename(source.path)),
      legacyPath: item.legacyPath,
      ext: read.ext,
      mime: read.mime,
      bytes: read.bytes,
      byteLength: read.bytes.length,
      contentHash: read.contentHash,
    };
  });
  if (byKey.size) {
    throw new StagingError('invalid-plan', 'An image source is not used by this migration plan.');
  }
  return prepared.map((asset) => ({ ...asset, referenced: true }));
}

function resolveTitles(plan, titles) {
  const resolved = {};
  if (titles == null) {
    plan.productions.forEach((production) => {
      resolved[production.id] = null;
    });
    return resolved;
  }
  if (typeof titles !== 'object' || Array.isArray(titles)) {
    throw new StagingError('invalid-plan', 'Production titles must be an object.');
  }
  const seen = new Set();
  plan.productions.forEach((production) => {
    if (!Object.prototype.hasOwnProperty.call(titles, production.id)) {
      throw new StagingError('missing-title', `Production ${production.id} has no title.`);
    }
    if (typeof titles[production.id] !== 'string') {
      throw new StagingError('invalid-plan', `Production ${production.id} has a title that is not text.`);
    }
    resolved[production.id] = titles[production.id];
    seen.add(production.id);
  });
  Object.keys(titles).forEach((id) => {
    if (!seen.has(id)) {
      throw new StagingError('invalid-plan', 'A title was supplied for a production that is not in the plan.');
    }
  });
  return resolved;
}

function prepareUnassigned(plan, unassigned, maxImageBytes, located, assigned) {
  if (unassigned == null) return [];
  if (!Array.isArray(unassigned)) {
    throw new StagingError('invalid-plan', 'Unassigned images must be a list.');
  }
  const productionIds = new Set(plan.productions.map((production) => production.id));
  const assignedKeys = new Set(assigned.map((asset) => `${asset.productionId}/${asset.assetId}`));
  const seen = new Set();
  return unassigned.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new StagingError('invalid-plan', 'An unassigned image is missing.');
    }
    const productionId = typeof item.productionId === 'string' ? item.productionId.toLowerCase() : '';
    const assetId = typeof item.assetId === 'string' ? item.assetId.toLowerCase() : '';
    if (!isValidScriptId(productionId) || !isValidScriptId(assetId)) {
      throw new StagingError('invalid-id', 'An unassigned image has an invalid id.');
    }
    if (!productionIds.has(productionId)) {
      throw new StagingError('invalid-plan', 'An unassigned image names a production that is not in the plan.');
    }
    const key = `${productionId}/${assetId}`;
    if (seen.has(key) || assignedKeys.has(key)) {
      throw new StagingError('invalid-plan', `Unassigned image ${key} was supplied more than once.`);
    }
    seen.add(key);
    const read = readSource(item.path, maxImageBytes, located);
    return {
      productionId,
      assetId,
      originalName: displayAssetName(item.originalName || path.basename(item.path)),
      legacyPath: null,
      ext: read.ext,
      mime: read.mime,
      bytes: read.bytes,
      byteLength: read.bytes.length,
      contentHash: read.contentHash,
      referenced: false,
    };
  });
}

function readSource(sourcePath, maxImageBytes, located) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
    throw new StagingError('unsafe-source', 'Each image source must be an absolute path.');
  }
  const lexical = path.resolve(sourcePath);
  const stat = lstatIfExists(lexical);
  if (!stat) {
    throw new StagingError('missing-source', 'An image source does not exist.');
  }
  if (stat.isSymbolicLink()) {
    throw new StagingError('symlink-escape', 'An image source is a symlink.');
  }
  if (!stat.isFile()) {
    throw new StagingError('unsafe-source', 'An image source must be a regular file.');
  }
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    throw new StagingError('symlink-escape', 'An image source resolves outside the temporary directory.');
  }
  const boundary = located.boundary || located.tmpReal;
  if (!insideStrict(real, boundary)) {
    throw new StagingError('symlink-escape', 'An image source resolves outside the authorized destination.');
  }
  if (!componentsStayInside(lexical, boundary)) {
    throw new StagingError('symlink-escape', 'An image source resolves outside the authorized destination.');
  }
  if (contained(real, located.repoReal)) {
    throw new StagingError('unsafe-source', 'An image source must not be a file in this repository.');
  }
  if (stat.size > maxImageBytes) {
    throw new StagingError('image-too-large', 'An image source is larger than the allowed size.');
  }
  const bytes = fs.readFileSync(lexical);
  if (bytes.length > maxImageBytes) {
    throw new StagingError('image-too-large', 'An image source is larger than the allowed size.');
  }
  const detected = detectImage(bytes);
  if (!detected || detected.incomplete || !detected.ext) {
    throw new StagingError('invalid-image', 'An image source is not a complete JPEG, PNG, or WebP file.');
  }
  return { bytes, ext: detected.ext, mime: detected.mime, contentHash: hashBuffer(bytes) };
}

function versionIdentity(version) {
  return {
    id: version.id,
    parentVersionId: version.parentVersionId,
    origin: version.origin,
    legacyImagePolicy: version.legacyImagePolicy,
    contentHash: version.contentHash,
    assetIds: version.assetIds || [],
  };
}

function stagingIdentity(plan, assets, titles) {
  return {
    schema: SCHEMA,
    liveProductionId: plan.liveProductionId,
    pointer: {
      productionId: plan.pointer.productionId,
      versionId: plan.pointer.versionId,
      contentHash: plan.pointer.contentHash,
      origin: plan.pointer.origin,
    },
    activation: {
      commit: false,
      reason: plan.activation.reason,
    },
    warnings: plan.warnings || [],
    productions: plan.productions.map((production) => ({
      id: production.id,
      title: titles[production.id],
      headVersionId: production.headVersionId,
      versions: {
        v1: versionIdentity(production.versions.v1),
        v2: production.versions.v2 ? versionIdentity(production.versions.v2) : null,
      },
      assetMappings: production.assetMappings || [],
      retainedLibraryReferences: production.retainedLibraryReferences || [],
      historicalImages: production.historicalImages || [],
    })),
    sources: assets.map((asset) => ({
      productionId: asset.productionId,
      assetId: asset.assetId,
      originalName: asset.originalName,
      legacyPath: asset.legacyPath,
      ext: asset.ext,
      mime: asset.mime,
      byteLength: asset.byteLength,
      contentHash: asset.contentHash,
      referenced: asset.referenced !== false,
    })),
  };
}

function versionDocument(productionId, version, role) {
  return {
    id: version.id,
    productionId,
    role,
    parentVersionId: version.parentVersionId,
    origin: version.origin,
    legacyImagePolicy: version.legacyImagePolicy,
    contentHash: version.contentHash,
    assetIds: version.assetIds || [],
  };
}

function metadataDocument(production, title) {
  const versions = [{
    id: production.versions.v1.id,
    role: 'v1',
    origin: production.versions.v1.origin,
    parentVersionId: production.versions.v1.parentVersionId,
    contentHash: production.versions.v1.contentHash,
  }];
  if (production.versions.v2) {
    versions.push({
      id: production.versions.v2.id,
      role: 'v2',
      origin: production.versions.v2.origin,
      parentVersionId: production.versions.v2.parentVersionId,
      contentHash: production.versions.v2.contentHash,
    });
  }
  const document = {
    id: production.id,
    originalProductionId: production.id,
    headVersionId: production.headVersionId,
    versions,
    historicalImages: production.historicalImages || [],
    historicalPreview: {
      usesAssetSnapshots: false,
      note: HISTORICAL_PREVIEW_NOTE,
    },
  };
  if (typeof title === 'string') document.title = title;
  return document;
}

function manifestDocument(productionId, assets) {
  return {
    productionId,
    assets: assets.map((asset) => {
      const entry = {
        assetId: asset.assetId,
        file: `${asset.assetId}.${asset.ext}`,
        originalName: asset.originalName,
        legacyPath: asset.legacyPath,
        contentHash: asset.contentHash,
        ext: asset.ext,
        mime: asset.mime,
        byteLength: asset.byteLength,
      };
      if (asset.referenced === false) entry.referenced = false;
      return entry;
    }),
  };
}

function planDocument(identity, planHash, state) {
  return {
    ...identity,
    state,
    planHash,
  };
}

function readyDocument(planHash) {
  return {
    state: 'ready',
    commit: false,
    planHash,
  };
}

function productionDir(rootReal, productionId) {
  return path.join(workDir(rootReal), 'productions', productionId);
}

function expectedFiles(rootReal, plan, assets, identity, planHash, titles) {
  const files = [];
  plan.productions.forEach((production) => {
    const dir = productionDir(rootReal, production.id);
    const owned = assets.filter((asset) => asset.productionId === production.id);
    addVersion(files, dir, production.id, production.versions.v1, 'v1');
    if (production.versions.v2) addVersion(files, dir, production.id, production.versions.v2, 'v2');
    owned.forEach((asset) => {
      files.push({
        path: path.join(dir, 'assets', `${asset.assetId}.${asset.ext}`),
        bytes: asset.bytes,
        label: `asset ${asset.assetId}`,
        kind: 'asset',
      });
    });
    files.push({
      path: path.join(dir, 'assets', 'manifest.json'),
      bytes: stableBytes(manifestDocument(production.id, owned)),
      label: `manifest ${production.id}`,
      kind: 'manifest',
    });
    files.push({
      path: path.join(dir, 'metadata.json'),
      bytes: stableBytes(metadataDocument(production, titles[production.id])),
      label: `metadata ${production.id}`,
      kind: 'metadata',
    });
  });
  files.push({
    path: path.join(workDir(rootReal), 'PLAN.json'),
    bytes: stableBytes(planDocument(identity, planHash, 'preparing')),
    label: 'PLAN.json',
    kind: 'plan',
  });
  return files;
}

function addVersion(files, dir, productionId, version, role) {
  const versionDir = path.join(dir, 'versions', version.id);
  files.push({
    path: path.join(versionDir, 'script.txt'),
    bytes: Buffer.from(version.text, 'utf8'),
    label: `${role} script ${version.id}`,
    kind: 'version',
  });
  files.push({
    path: path.join(versionDir, 'version.json'),
    bytes: stableBytes(versionDocument(productionId, version, role)),
    label: `${role} metadata ${version.id}`,
    kind: 'version',
  });
}

function activationHits(rootReal) {
  const hits = [];
  ACTIVATION_PATHS.forEach((relative) => {
    const full = path.join(rootReal, relative);
    assertNoSymlink(rootReal, full);
    if (lstatIfExists(full)) hits.push(relative);
  });
  return hits;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function assessExisting(rootReal, files, planHash) {
  const hits = activationHits(rootReal);
  if (hits.length) {
    throw new StagingError(
      'activation-artifact',
      'Refusing to stage while a live pointer, migration marker, or journal is present.',
      'corrupt',
    );
  }
  const work = workDir(rootReal);
  const workStat = lstatIfExists(work);
  if (!workStat) return { status: 'absent' };
  if (workStat.isSymbolicLink()) {
    throw new StagingError('symlink-escape', 'migration-work is a symlink.', 'conflict');
  }
  assertNoSymlink(rootReal, work);
  const planPath = path.join(work, 'PLAN.json');
  const planStat = lstatIfExists(planPath);
  let recorded = null;
  if (planStat) {
    if (planStat.isSymbolicLink() || !planStat.isFile()) {
      throw new StagingError('corrupt-staging', 'PLAN.json is not a regular file.', 'corrupt');
    }
    recorded = readJsonFile(planPath);
    if (!recorded || recorded.schema !== SCHEMA || typeof recorded.planHash !== 'string') {
      throw new StagingError('corrupt-staging', 'PLAN.json cannot be read.', 'corrupt');
    }
    if (recorded.planHash !== planHash) {
      throw new StagingError(
        'conflicting-plan',
        'The existing staging plan does not match this migration plan.',
        'conflict',
      );
    }
  }
  const productionIds = new Set();
  files.forEach((file) => {
    const relative = path.relative(path.join(work, 'productions'), file.path);
    const top = relative.split(path.sep)[0];
    if (top && top !== '..' && file.kind !== 'plan') productionIds.add(top);
  });
  const productionsDir = path.join(work, 'productions');
  const productionsStat = lstatIfExists(productionsDir);
  if (productionsStat) {
    if (productionsStat.isSymbolicLink() || !productionsStat.isDirectory()) {
      throw new StagingError('symlink-escape', 'productions is not a real directory.', 'conflict');
    }
    fs.readdirSync(productionsDir).forEach((name) => {
      if (!productionIds.has(name)) {
        throw new StagingError(
          'conflicting-plan',
          `Production ${name} is already present and is not part of this plan.`,
          'conflict',
        );
      }
    });
  }
  let sawContent = Boolean(recorded);
  files.forEach((file) => {
    if (file.kind === 'plan') return;
    assertNoSymlink(rootReal, file.path);
    const stat = lstatIfExists(file.path);
    if (!stat) return;
    sawContent = true;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new StagingError('symlink-escape', `${file.label} is not a regular file.`, 'conflict');
    }
    const existing = fs.readFileSync(file.path);
    if (!existing.equals(file.bytes)) {
      throw new StagingError(
        'version-collision',
        `${file.label} already exists with different bytes and was left unchanged.`,
        'conflict',
      );
    }
  });
  const readyPath = path.join(work, 'READY');
  const readyStat = lstatIfExists(readyPath);
  if (readyStat) {
    if (readyStat.isSymbolicLink() || !readyStat.isFile()) {
      throw new StagingError('corrupt-staging', 'READY is not a regular file.', 'corrupt');
    }
    const ready = readJsonFile(readyPath);
    const missing = files.some((file) => file.kind !== 'plan' && !lstatIfExists(file.path));
    if (!recorded || !ready || ready.commit !== false || ready.planHash !== planHash || ready.state !== 'ready' || missing) {
      throw new StagingError('corrupt-staging', 'READY does not match the staged files.', 'corrupt');
    }
    return { status: 'ready', planState: recorded.state };
  }
  if (recorded && recorded.state === 'ready') {
    throw new StagingError('corrupt-staging', 'PLAN.json says ready but the READY marker is missing.', 'corrupt');
  }
  if (!recorded && !sawContent && !productionsStat) return { status: 'absent' };
  return { status: 'incomplete', planState: recorded ? recorded.state : null };
}

function cleanupTemps(rootReal) {
  const work = workDir(rootReal);
  const stat = lstatIfExists(work);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  const real = fs.realpathSync(work);
  if (!contained(real, rootReal)) return;
  const stack = [real];
  while (stack.length) {
    const current = stack.pop();
    const currentStat = fs.lstatSync(current);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) continue;
    fs.readdirSync(current).forEach((name) => {
      const full = path.join(current, name);
      const child = fs.lstatSync(full);
      if (child.isSymbolicLink()) return;
      if (child.isDirectory()) {
        stack.push(full);
        return;
      }
      if (child.isFile() && name.startsWith('.') && name.endsWith('.tmp')) {
        fs.unlinkSync(full);
      }
    });
  }
}

let tempSerial = 0;

function commitNewFile(filePath, bytes, rootReal) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertNoSymlink(rootReal, filePath);
  const parent = path.dirname(filePath);
  const existing = lstatIfExists(filePath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new StagingError('symlink-escape', 'Refusing to replace a non-file staging path.', 'conflict');
    }
    const current = fs.readFileSync(filePath);
    if (current.equals(payload)) return { reused: true };
    throw new StagingError(
      'version-collision',
      'An existing staging file has different bytes and was left unchanged.',
      'conflict',
    );
  }
  const parentStat = lstatIfExists(parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new StagingError('corrupt-staging', 'A staging directory is missing.', 'incomplete');
  }
  tempSerial += 1;
  const tmp = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${tempSerial}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const readBack = fs.readFileSync(tmp);
  if (!readBack.equals(payload) || hashBuffer(readBack) !== hashBuffer(payload)) {
    fs.unlinkSync(tmp);
    throw new StagingError('hash-mismatch', 'A staged file did not match the bytes just written.', 'incomplete');
  }
  if (lstatIfExists(filePath)) {
    fs.unlinkSync(tmp);
    return commitNewFile(filePath, payload, rootReal);
  }
  fs.renameSync(tmp, filePath);
  fsyncDirectory(parent);
  const finalBytes = fs.readFileSync(filePath);
  const finalStat = fs.lstatSync(filePath);
  if (finalStat.isSymbolicLink() || !finalBytes.equals(payload)) {
    throw new StagingError('hash-mismatch', 'A staged file did not match the bytes just written.', 'incomplete');
  }
  return { reused: false };
}

function ensureDir(dir, rootReal) {
  assertNoSymlink(rootReal, dir);
  const existing = lstatIfExists(dir);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new StagingError('symlink-escape', 'Refusing to follow a symlink while creating staging directories.', 'conflict');
    }
    const real = fs.realpathSync(dir);
    if (!contained(real, rootReal)) {
      throw new StagingError('symlink-escape', 'A staging directory resolves outside the destination root.', 'conflict');
    }
    return real;
  }
  const parent = path.dirname(dir);
  const parentStat = lstatIfExists(parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new StagingError('symlink-escape', 'A parent staging directory is not a real directory.', 'conflict');
  }
  fs.mkdirSync(dir);
  fsyncDirectory(parent);
  const real = fs.realpathSync(dir);
  if (!contained(real, rootReal)) {
    throw new StagingError('symlink-escape', 'A staging directory resolves outside the destination root.', 'conflict');
  }
  return real;
}

function ensureWork(rootReal) {
  ensureDir(path.join(rootReal, 'data'), rootReal);
  ensureDir(path.join(rootReal, 'data', 'library'), rootReal);
  return ensureDir(workDir(rootReal), rootReal);
}

function ensureParents(filePath, rootReal) {
  const work = workDir(rootReal);
  const relative = path.relative(work, path.dirname(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StagingError('symlink-escape', 'A staging file escapes migration-work.', 'conflict');
  }
  let current = work;
  if (relative === '') return;
  relative.split(path.sep).forEach((part) => {
    current = path.join(current, part);
    ensureDir(current, rootReal);
  });
}

function checkpoint(onStage, stage, detail) {
  if (typeof onStage !== 'function') return;
  onStage(stage, detail);
}

function replacePlanState(rootReal, identity, planHash) {
  const planPath = path.join(workDir(rootReal), 'PLAN.json');
  const current = readJsonFile(planPath);
  if (!current || current.planHash !== planHash) {
    throw new StagingError('conflicting-plan', 'PLAN.json changed before it could be marked ready.', 'conflict');
  }
  if (current.state === 'ready') return;
  const next = stableBytes(planDocument(identity, planHash, 'ready'));
  tempSerial += 1;
  const tmp = path.join(workDir(rootReal), `.PLAN.json.${process.pid}.${tempSerial}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, next);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const again = readJsonFile(planPath);
  if (!again || again.planHash !== planHash || again.state !== 'preparing') {
    fs.unlinkSync(tmp);
    throw new StagingError('conflicting-plan', 'PLAN.json changed before it could be marked ready.', 'conflict');
  }
  fs.renameSync(tmp, planPath);
  fsyncDirectory(workDir(rootReal));
  const written = fs.readFileSync(planPath);
  if (!written.equals(next)) {
    throw new StagingError('hash-mismatch', 'PLAN.json did not match the ready record.', 'incomplete');
  }
}

function imageTokens(text) {
  const tokens = [];
  String(text).split(/\r\n|\n|\r/).forEach((line) => {
    const match = /^\s*@image:\s*(.*)$/.exec(line);
    if (!match) return;
    const trailing = (/\s*$/.exec(match[1]) || [''])[0];
    tokens.push(match[1].slice(0, match[1].length - trailing.length));
  });
  return tokens;
}

function verifyStaging(root) {
  let located;
  try {
    located = locateRoot(root);
  } catch (err) {
    if (err instanceof StagingError) {
      return {
        ok: false,
        consistent: false,
        ready: false,
        state: 'absent',
        code: err.code,
        planHash: null,
        productions: [],
        problems: [{ code: err.code, message: err.message }],
        activationFiles: [],
      };
    }
    throw err;
  }
  try {
    return verifyLocated(located.rootReal);
  } catch (err) {
    if (err instanceof StagingError) {
      return {
        ok: false,
        consistent: false,
        ready: false,
        state: err.status === 'conflict' ? 'conflict' : 'corrupt',
        code: err.code,
        planHash: null,
        productions: [],
        problems: [{ code: err.code, message: err.message }],
        activationFiles: activationSafe(located.rootReal),
      };
    }
    throw err;
  }
}

function activationSafe(rootReal) {
  try {
    return activationHits(rootReal);
  } catch (err) {
    return [];
  }
}

function verifyLocated(rootReal) {
  const problems = [];
  const work = workDir(rootReal);
  const activationFiles = activationHits(rootReal);
  activationFiles.forEach((relative) => {
    problems.push({
      code: 'activation-artifact',
      message: `${relative} is present. Staging does not activate a migration.`,
    });
  });
  const workStat = lstatIfExists(work);
  if (!workStat) {
    return {
      ok: false,
      consistent: false,
      ready: false,
      state: 'absent',
      code: problems.length ? 'activation-artifact' : null,
      planHash: null,
      productions: [],
      problems,
      activationFiles,
    };
  }
  if (workStat.isSymbolicLink() || !workStat.isDirectory()) {
    problems.push({ code: 'symlink-escape', message: 'migration-work is not a real directory.' });
    return failedVerify(problems, activationFiles, null, 'corrupt');
  }
  const plan = readJsonFile(path.join(work, 'PLAN.json'));
  if (!plan || plan.schema !== SCHEMA || typeof plan.planHash !== 'string' || !Array.isArray(plan.productions)) {
    problems.push({ code: 'corrupt-staging', message: 'PLAN.json is missing or unreadable.' });
    return failedVerify(problems, activationFiles, null, 'corrupt');
  }
  const productions = [];
  const inodes = new Map();
  plan.productions.forEach((production) => {
    productions.push(verifyProduction(rootReal, plan, production, problems, inodes));
  });
  const readyPath = path.join(work, 'READY');
  const readyStat = lstatIfExists(readyPath);
  let ready = false;
  if (readyStat) {
    if (readyStat.isSymbolicLink() || !readyStat.isFile()) {
      problems.push({ code: 'corrupt-staging', message: 'READY is not a regular file.' });
    } else {
      const readyDoc = readJsonFile(readyPath);
      if (!readyDoc || readyDoc.state !== 'ready' || readyDoc.commit !== false || readyDoc.planHash !== plan.planHash) {
        problems.push({ code: 'corrupt-staging', message: 'READY does not match PLAN.json.' });
      } else {
        ready = problems.length === 0;
      }
    }
  }
  const consistent = problems.length === 0 && productions.every((production) => production.complete);
  if (ready && !consistent) ready = false;
  let state = 'incomplete';
  if (problems.some((problem) => problem.code === 'corrupt-staging' || problem.code === 'hash-mismatch' || problem.code === 'symlink-escape')) {
    state = 'corrupt';
  } else if (ready && consistent) {
    state = 'ready';
  } else if (consistent) {
    state = 'preparing';
  }
  return {
    ok: state === 'ready',
    consistent,
    ready: state === 'ready',
    state,
    code: problems[0] ? problems[0].code : null,
    planHash: plan.planHash,
    planState: plan.state,
    productions,
    problems,
    activationFiles,
  };
}

function failedVerify(problems, activationFiles, planHash, state) {
  return {
    ok: false,
    consistent: false,
    ready: false,
    state,
    code: problems[0] ? problems[0].code : null,
    planHash,
    productions: [],
    problems,
    activationFiles,
  };
}

function verifyProduction(rootReal, plan, production, problems, inodes) {
  const dir = productionDir(rootReal, production.id);
  const record = {
    id: production.id,
    directory: dir,
    headVersionId: production.headVersionId,
    complete: true,
    versions: [],
    assets: [],
    historicalImages: [],
    historicalPreview: null,
  };
  if (!isValidScriptId(production.id)) {
    problems.push({ code: 'corrupt-staging', message: `Production id ${production.id} is not valid.` });
    record.complete = false;
    return record;
  }
  const metadataPath = path.join(dir, 'metadata.json');
  const metadata = readOwnedJson(metadataPath, rootReal, problems, `metadata ${production.id}`);
  if (!metadata) {
    record.complete = false;
  } else {
    record.historicalImages = metadata.historicalImages || [];
    record.historicalPreview = metadata.historicalPreview || null;
    if (metadata.id !== production.id || metadata.originalProductionId !== production.id) {
      problems.push({ code: 'corrupt-staging', message: `Metadata for ${production.id} does not match its directory.` });
      record.complete = false;
    }
    if (metadata.headVersionId !== production.headVersionId) {
      problems.push({ code: 'corrupt-staging', message: `Metadata for ${production.id} has an unexpected head.` });
      record.complete = false;
    }
    const expectedTitle = typeof production.title === 'string' ? production.title : null;
    const actualTitle = typeof metadata.title === 'string' ? metadata.title : null;
    if (actualTitle !== expectedTitle) {
      problems.push({ code: 'corrupt-staging', message: `Metadata for ${production.id} has a different title.` });
      record.complete = false;
    }
    if (!metadata.historicalPreview || metadata.historicalPreview.usesAssetSnapshots !== false) {
      problems.push({
        code: 'corrupt-staging',
        message: `Metadata for ${production.id} claims v1 preview bytes are already snapshotted.`,
      });
      record.complete = false;
    }
    (metadata.historicalImages || []).forEach((image) => {
      if (!image || image.byteSnapshot !== false) {
        problems.push({
          code: 'corrupt-staging',
          message: `Historical image metadata for ${production.id} claims a byte snapshot.`,
        });
        record.complete = false;
      }
    });
  }
  ['v1', 'v2'].forEach((role) => {
    const version = production.versions && production.versions[role];
    if (!version) {
      const unexpected = path.join(dir, 'versions');
      const versionsStat = role === 'v2' ? lstatIfExists(unexpected) : null;
      if (versionsStat && versionsStat.isDirectory()) {
        const names = fs.readdirSync(unexpected);
        const v1Id = production.versions && production.versions.v1 && production.versions.v1.id;
        names.forEach((name) => {
          if (name !== v1Id) {
            problems.push({ code: 'corrupt-staging', message: `Unexpected version directory ${name}.` });
            record.complete = false;
          }
        });
      }
      return;
    }
    const versionDir = path.join(dir, 'versions', version.id);
    const scriptPath = path.join(versionDir, 'script.txt');
    const versionPath = path.join(versionDir, 'version.json');
    const scriptStat = lstatIfExists(scriptPath);
    if (!scriptStat || scriptStat.isSymbolicLink() || !scriptStat.isFile()) {
      problems.push({ code: 'missing-file', message: `${role} script for ${version.id} is missing.` });
      record.complete = false;
      return;
    }
    assertNoSymlink(rootReal, scriptPath);
    const scriptBytes = fs.readFileSync(scriptPath);
    const byteHash = hashBuffer(scriptBytes);
    const versionDoc = readOwnedJson(versionPath, rootReal, problems, `version ${version.id}`);
    if (!versionDoc || versionDoc.contentHash !== version.contentHash || byteHash !== version.contentHash) {
      problems.push({
        code: 'hash-mismatch',
        message: `${role} script ${version.id} does not match its recorded hash.`,
      });
      record.complete = false;
    }
    if (versionDoc && versionDoc.parentVersionId !== version.parentVersionId) {
      problems.push({ code: 'corrupt-staging', message: `${role} parent for ${version.id} does not match the plan.` });
      record.complete = false;
    }
    if (versionDoc && (versionDoc.origin !== version.origin || versionDoc.productionId !== production.id || versionDoc.role !== role)) {
      problems.push({ code: 'corrupt-staging', message: `${role} metadata for ${version.id} does not match the plan.` });
      record.complete = false;
    }
    const text = scriptBytes.toString('utf8');
    if (role === 'v1') {
      (production.historicalImages || []).forEach((image) => {
        if (!text.includes(image.legacyPath)) {
          problems.push({
            code: 'missing-reference',
            message: `Original version ${version.id} no longer contains ${image.legacyPath}.`,
          });
          record.complete = false;
        }
      });
    }
    if (role === 'v2') {
      imageTokens(text).forEach((token) => {
        const parsed = parseImageReference(token);
        if (parsed.kind === 'legacy') {
          problems.push({
            code: 'missing-reference',
            message: `Migrated version ${version.id} still contains ${parsed.path}.`,
          });
          record.complete = false;
        }
        if (parsed.kind === 'library' && parsed.scriptId !== production.id) {
          problems.push({
            code: 'missing-reference',
            message: `Migrated version ${version.id} points at production ${parsed.scriptId}.`,
          });
          record.complete = false;
        }
      });
    }
    record.versions.push({
      id: version.id,
      role,
      origin: version.origin,
      parentVersionId: version.parentVersionId,
      contentHash: version.contentHash,
      byteHash,
      byteLength: scriptBytes.length,
    });
  });
  const manifestPath = path.join(dir, 'assets', 'manifest.json');
  const manifest = readOwnedJson(manifestPath, rootReal, problems, `manifest ${production.id}`);
  const expectedSources = (plan.sources || []).filter((source) => source.productionId === production.id);
  if (!manifest) {
    record.complete = false;
  } else if (manifest.productionId !== production.id || !Array.isArray(manifest.assets)) {
    problems.push({ code: 'corrupt-staging', message: `Manifest for ${production.id} is not usable.` });
    record.complete = false;
  } else {
    if (manifest.assets.length !== expectedSources.length) {
      problems.push({ code: 'missing-reference', message: `Manifest for ${production.id} does not match the recorded sources.` });
      record.complete = false;
    }
    manifest.assets.forEach((asset) => {
      const source = expectedSources.find((item) => item.assetId === asset.assetId);
      const assetPath = path.join(dir, 'assets', asset.file || '');
      const assetStat = lstatIfExists(assetPath);
      if (!source || !assetStat || assetStat.isSymbolicLink() || !assetStat.isFile()) {
        problems.push({
          code: 'missing-reference',
          message: `Asset ${asset.assetId} is missing from production ${production.id}.`,
        });
        record.complete = false;
        return;
      }
      assertNoSymlink(rootReal, assetPath);
      const assetReal = fs.realpathSync(assetPath);
      const assetsReal = fs.realpathSync(path.join(dir, 'assets'));
      if (!contained(assetReal, assetsReal) || path.basename(assetPath) !== `${asset.assetId}.${asset.ext}`) {
        problems.push({ code: 'symlink-escape', message: `Asset ${asset.assetId} is outside its production directory.` });
        record.complete = false;
        return;
      }
      const assetBytes = fs.readFileSync(assetPath);
      const byteHash = hashBuffer(assetBytes);
      const detected = detectImage(assetBytes);
      if (byteHash !== asset.contentHash || byteHash !== source.contentHash || !detected || detected.ext !== asset.ext) {
        problems.push({ code: 'hash-mismatch', message: `Asset ${asset.assetId} does not match its recorded bytes.` });
        record.complete = false;
      }
      if (source.referenced === false ? asset.referenced !== false : asset.referenced === false) {
        problems.push({ code: 'corrupt-staging', message: `Asset ${asset.assetId} has an unexpected assignment.` });
        record.complete = false;
      }
      const fileStat = fs.statSync(assetPath);
      const inodeKey = `${fileStat.dev}:${fileStat.ino}`;
      const previous = inodes.get(inodeKey);
      if (previous && previous !== assetPath) {
        problems.push({ code: 'shared-inode', message: `Asset ${asset.assetId} is hard-linked to another production.` });
        record.complete = false;
      }
      inodes.set(inodeKey, assetPath);
      if (fileStat.nlink !== 1) {
        problems.push({ code: 'shared-inode', message: `Asset ${asset.assetId} has more than one directory entry.` });
        record.complete = false;
      }
      record.assets.push({
        assetId: asset.assetId,
        file: asset.file,
        originalName: asset.originalName,
        legacyPath: asset.legacyPath,
        contentHash: asset.contentHash,
        byteHash,
        ext: asset.ext,
        inode: fileStat.ino,
        nlink: fileStat.nlink,
      });
    });
    record.versions.filter((version) => version.role === 'v2').forEach((version) => {
      const scriptPath = path.join(dir, 'versions', version.id, 'script.txt');
      if (!lstatIfExists(scriptPath)) return;
      imageTokens(fs.readFileSync(scriptPath, 'utf8')).forEach((token) => {
        const parsed = parseImageReference(token);
        if (parsed.kind !== 'library') return;
        const owned = record.assets.some((asset) => asset.assetId === parsed.assetId);
        if (!owned) {
          problems.push({
            code: 'missing-reference',
            message: `Migrated version ${version.id} references missing asset ${parsed.assetId}.`,
          });
          record.complete = false;
        }
      });
    });
  }
  return record;
}

function readOwnedJson(filePath, rootReal, problems, label) {
  const stat = lstatIfExists(filePath);
  if (!stat) {
    problems.push({ code: 'missing-file', message: `${label} is missing.` });
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    problems.push({ code: 'symlink-escape', message: `${label} is not a regular file.` });
    return null;
  }
  assertNoSymlink(rootReal, filePath);
  const parsed = readJsonFile(filePath);
  if (!parsed) {
    problems.push({ code: 'corrupt-staging', message: `${label} cannot be read.` });
  }
  return parsed;
}

function failureResult(err) {
  return {
    ok: false,
    status: err.status || 'absent',
    code: err.code,
    errors: [{ code: err.code, message: err.message }],
    ready: false,
  };
}

function resolveStaging(located, source) {
  const plan = copyPlan(source.plan);
  validatePlan(plan);
  const titles = resolveTitles(plan, source.titles);
  const limit = imageLimit(source.maxImageBytes);
  const assigned = prepareSources(plan, source.sources, limit, located);
  const unassigned = prepareUnassigned(plan, source.unassigned, limit, located, assigned);
  const assets = assigned.concat(unassigned);
  const identity = stagingIdentity(plan, assets, titles);
  const planHash = hashBuffer(stableBytes(identity));
  const files = expectedFiles(located.rootReal, plan, assets, identity, planHash, titles);
  return { plan, assets, identity, planHash, files, titles };
}

function describeStaging(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  try {
    const located = locateRoot(source.root);
    const resolved = resolveStaging(located, source);
    return {
      ok: true,
      planHash: resolved.planHash,
      preparingPlan: stableBytes(planDocument(resolved.identity, resolved.planHash, 'preparing')),
      readyPlan: stableBytes(planDocument(resolved.identity, resolved.planHash, 'ready')),
      ready: stableBytes(readyDocument(resolved.planHash)),
      files: resolved.files
        .filter((file) => path.basename(file.path) !== 'PLAN.json')
        .map((file) => ({
          relative: path.relative(workDir(located.rootReal), file.path).split(path.sep).join('/'),
          bytes: file.bytes,
        })),
    };
  } catch (err) {
    if (err instanceof StagingError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

function stageMigration(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  let located = null;
  try {
    located = locateRoot(source.root);
    const resolved = resolveStaging(located, source);
    const { plan, assets, identity, planHash, files } = resolved;
    const prior = assessExisting(located.rootReal, files, planHash);
    if (prior.status === 'ready') {
      if (prior.planState !== 'ready') replacePlanState(located.rootReal, identity, planHash);
      const verification = verifyStaging(source.root);
      if (!verification.ready) {
        throw new StagingError('corrupt-staging', 'READY does not match the staged files.', 'corrupt');
      }
      return {
        ok: true,
        status: 'ready',
        ready: true,
        resumed: true,
        priorStatus: 'ready',
        planHash,
        workDir: workDir(located.rootReal),
        verification,
      };
    }
    const work = ensureWork(located.rootReal);
    fsyncDirectory(work);
    checkpoint(source.onStage, 'directories', { workDir: work });
    const planFile = files.find((file) => file.kind === 'plan');
    ensureParents(planFile.path, located.rootReal);
    commitNewFile(planFile.path, planFile.bytes, located.rootReal);
    fsyncDirectory(work);
    checkpoint(source.onStage, 'plan', { planHash });
    writeVersions(source.onStage, located.rootReal, plan, files, 'v1');
    writeVersions(source.onStage, located.rootReal, plan, files, 'v2');
    writeAssets(source.onStage, located.rootReal, plan, assets);
    writeDocuments(source.onStage, located.rootReal, files, 'manifest');
    writeDocuments(source.onStage, located.rootReal, files, 'metadata');
    cleanupTemps(located.rootReal);
    const checked = verifyStaging(source.root);
    if (!checked.consistent) {
      const problem = checked.problems[0];
      throw new StagingError(
        problem ? problem.code : 'corrupt-staging',
        problem ? problem.message : 'Staged files are incomplete.',
        'incomplete',
      );
    }
    checkpoint(source.onStage, 'ready', { planHash });
    commitNewFile(
      path.join(work, 'READY'),
      stableBytes(readyDocument(planHash)),
      located.rootReal,
    );
    fsyncDirectory(work);
    replacePlanState(located.rootReal, identity, planHash);
    fsyncDirectory(path.dirname(work));
    const verification = verifyStaging(source.root);
    if (!verification.ready) {
      throw new StagingError('corrupt-staging', 'Staging finished without a verifiable READY marker.', 'incomplete');
    }
    return {
      ok: true,
      status: 'ready',
      ready: true,
      resumed: prior.status === 'incomplete',
      priorStatus: prior.status,
      planHash,
      workDir: work,
      verification,
    };
  } catch (err) {
    if (located) cleanupTemps(located.rootReal);
    if (err instanceof StagingError) return failureResult(err);
    throw err;
  }
}

function writeVersions(onStage, rootReal, plan, files, role) {
  plan.productions.forEach((production) => {
    const version = production.versions[role];
    if (!version) return;
    checkpoint(onStage, role, { productionId: production.id, versionId: version.id });
    const versionDir = path.join(productionDir(rootReal, production.id), 'versions', version.id);
    files.filter((file) => file.kind === 'version' && file.path.startsWith(`${versionDir}${path.sep}`)).forEach((file) => {
      ensureParents(file.path, rootReal);
      commitNewFile(file.path, file.bytes, rootReal);
    });
  });
}

function writeAssets(onStage, rootReal, plan, assets) {
  plan.productions.forEach((production) => {
    assets.filter((asset) => asset.productionId === production.id).forEach((asset) => {
      checkpoint(onStage, 'asset', { productionId: production.id, assetId: asset.assetId });
      const filePath = path.join(productionDir(rootReal, production.id), 'assets', `${asset.assetId}.${asset.ext}`);
      ensureParents(filePath, rootReal);
      const written = commitNewFile(filePath, asset.bytes, rootReal);
      const saved = fs.readFileSync(filePath);
      if (hashBuffer(saved) !== asset.contentHash || !saved.equals(asset.bytes)) {
        throw new StagingError('hash-mismatch', `Asset ${asset.assetId} did not match its source bytes.`, 'incomplete');
      }
      if (!written) return;
    });
  });
}

function writeDocuments(onStage, rootReal, files, kind) {
  files.filter((file) => file.kind === kind).forEach((file) => {
    const productionId = kind === 'metadata'
      ? path.basename(path.dirname(file.path))
      : path.basename(path.dirname(path.dirname(file.path)));
    checkpoint(onStage, kind, { productionId });
    ensureParents(file.path, rootReal);
    commitNewFile(file.path, file.bytes, rootReal);
  });
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  HISTORICAL_PREVIEW_NOTE,
  describeStaging,
  stageMigration,
  verifyStaging,
};
