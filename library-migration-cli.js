const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMigration } = require('./library-migration-plan');
const { describeStaging, stageMigration, verifyStaging } = require('./library-migration-staging');
const { createVersionStore } = require('./library-version-store');
const { lockAround } = require('./server/storage-writer-lock');
const { parseImageReference } = require('./script-library-model');
const {
  detectImage,
  displayAssetName,
  hashText,
  isValidScriptId,
  titleFromScript,
} = require('./script-library');

// Fixture-only migration commands. Every root must be an explicit temporary
// directory. This module does not migrate the ADAPT checkout. Prepare, abort,
// and commit take the same kernel flock as a running versioned server, so
// they cannot write a library that server already owns. A persistent
// migration claim is beginPersistentMigration in server/persistent-authorization.js.
// That claim does not stage or commit a library. M9C2 has to connect it.

const ATTEMPT_NAME = 'migration-attempt.json';
const MARKER_NAME = 'migration.json';
const INCOMING_NAME = 'productions.incoming';
const COMMANDS = ['dry-run', 'prepare', 'verify', 'abort', 'commit'];
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = { jpg: true, png: true, webp: true };

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
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

function contained(candidate, boundary) {
  return candidate === boundary || insideStrict(candidate, boundary);
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, error: message }, extra || {});
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
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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
    try { fs.unlinkSync(tmp); } catch (_) { /* The temp file may already be gone. */ }
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fsyncDirectory(dir);
}

function stableBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function posixRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function authorizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    return fail('root-required', 'An explicit absolute --root is required. The working directory is not used.');
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
  const repoReal = fs.realpathSync(path.resolve(__dirname));
  if (contained(rootReal, repoReal) || contained(repoReal, rootReal)) {
    return fail('unsafe-root', 'This checkout cannot be inspected or migrated by the fixture command.');
  }
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return fail('unsafe-root', 'This command only accepts an explicit temporary fixture.');
  }
  return { ok: true, rootReal };
}

function libraryDir(rootReal) {
  return path.join(rootReal, 'data', 'library');
}

function attemptPath(rootReal) {
  return path.join(libraryDir(rootReal), ATTEMPT_NAME);
}

function markerPath(rootReal) {
  return path.join(libraryDir(rootReal), MARKER_NAME);
}

function workDir(rootReal) {
  return path.join(libraryDir(rootReal), 'migration-work');
}

function imageLines(text) {
  const found = [];
  String(text).split(/\r\n|\n|\r/).forEach((line) => {
    const match = /^(\s*@image:\s*)(.*)$/.exec(line);
    if (!match) return;
    const trailing = (/\s*$/.exec(match[2]) || [''])[0];
    const token = match[2].slice(0, match[2].length - trailing.length);
    found.push({ token, parsed: parseImageReference(token) });
  });
  return found;
}

function pushError(errors, error) {
  errors.push(error);
}

function publicToken(value) {
  if (typeof value !== 'string' || value.length > 160 || /[\r\n]/.test(value)) return null;
  return value;
}

function readJsonObject(filePath) {
  const read = readNoFollow(filePath);
  if (read.missing) return { missing: true };
  if (read.unsafe) return { unsafe: true };
  try {
    const value = JSON.parse(read.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true, bytes: read.bytes };
    return { value, bytes: read.bytes };
  } catch (err) {
    return { invalid: true, bytes: read.bytes };
  }
}

function hashTree(dir) {
  const found = {};
  const stat = lstatIfExists(dir);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { unsafe: true };
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        found[posixRelative(dir, full)] = { unsafe: true };
        return;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        return;
      }
      if (!entry.isFile()) return;
      const read = readNoFollow(full);
      found[posixRelative(dir, full)] = read.bytes ? hashBuffer(read.bytes) : { unsafe: true };
    });
  }
  return found;
}

function inspectAssetFile(filePath, maxImageBytes) {
  const read = readNoFollow(filePath);
  if (read.missing) return { error: 'missing-asset' };
  if (read.unsafe || !read.bytes) return { error: 'unsafe-path' };
  if (read.bytes.length > maxImageBytes) return { error: 'image-too-large' };
  const detected = detectImage(read.bytes);
  if (!detected || detected.incomplete || !detected.ext) return { error: 'invalid-image' };
  return {
    bytes: read.bytes,
    ext: detected.ext,
    mime: detected.mime,
    contentHash: hashBuffer(read.bytes),
    byteLength: read.bytes.length,
  };
}

function inspect(rootReal, maxImageBytes) {
  const errors = [];
  const warnings = [];
  const fingerprint = {
    liveScript: null,
    previousScript: null,
    previousMeta: null,
    index: null,
    scripts: {},
    images: {},
    manifests: {},
    assets: {},
    journal: null,
  };
  const livePath = path.join(rootReal, 'script.txt');
  const liveRead = readNoFollow(livePath);
  let liveText = null;
  if (liveRead.missing) pushError(errors, { code: 'missing-live-script', message: 'script.txt is missing.' });
  else if (liveRead.unsafe) pushError(errors, { code: 'unsafe-path', message: 'script.txt is not a regular file.' });
  else {
    fingerprint.liveScript = hashBuffer(liveRead.bytes);
    const asText = liveRead.bytes.toString('utf8');
    if (!Buffer.from(asText, 'utf8').equals(liveRead.bytes)) {
      pushError(errors, { code: 'invalid-script-bytes', message: 'script.txt is not valid UTF-8.' });
    } else {
      liveText = asText;
    }
  }

  ['script.previous.txt', 'script.previous.txt.meta.json'].forEach((name) => {
    const read = readNoFollow(path.join(rootReal, name));
    const key = name === 'script.previous.txt' ? 'previousScript' : 'previousMeta';
    if (read.missing) return;
    if (read.unsafe) {
      pushError(errors, { code: 'unsafe-path', message: `${name} is not a regular file.` });
      return;
    }
    fingerprint[key] = hashBuffer(read.bytes);
  });

  const journal = hashTree(path.join(rootReal, 'data', 'live-journal'));
  if (journal && journal.unsafe) pushError(errors, { code: 'unsafe-path', message: 'The live journal is not a real directory.' });
  else fingerprint.journal = journal;

  const indexFile = path.join(libraryDir(rootReal), 'index.json');
  const indexRead = readJsonObject(indexFile);
  let index = null;
  if (indexRead.missing) pushError(errors, { code: 'missing-library', message: 'The library index is missing.' });
  else if (indexRead.unsafe) pushError(errors, { code: 'unsafe-path', message: 'The library index is not a regular file.' });
  else if (indexRead.invalid || indexRead.value.version !== 1 || !Array.isArray(indexRead.value.scripts)) {
    pushError(errors, { code: 'corrupt-index', message: 'The library index could not be read.' });
  } else {
    index = indexRead.value;
    fingerprint.index = hashBuffer(indexRead.bytes);
  }

  const scriptsDir = path.join(libraryDir(rootReal), 'scripts');
  const scriptsStat = lstatIfExists(scriptsDir);
  const fileIds = [];
  if (scriptsStat && scriptsStat.isSymbolicLink()) {
    pushError(errors, { code: 'unsafe-path', message: 'The scripts directory is a symlink.' });
  } else if (scriptsStat && scriptsStat.isDirectory()) {
    fs.readdirSync(scriptsDir).forEach((name) => {
      const match = /^([0-9a-f-]{36})\.txt$/i.exec(name);
      if (!match) {
        pushError(errors, { code: 'unexpected-file', path: `data/library/scripts/${name}`, message: 'The scripts directory contains an unexpected file.' });
        return;
      }
      fileIds.push(match[1].toLowerCase());
    });
  }

  const indexed = new Map();
  if (index) {
    index.scripts.forEach((entry) => {
      const id = entry && typeof entry.id === 'string' ? entry.id.toLowerCase() : '';
      if (!isValidScriptId(id)) {
        pushError(errors, { code: 'invalid-id', message: 'A library entry does not have a valid id.' });
        return;
      }
      if (indexed.has(id)) {
        pushError(errors, { code: 'duplicate-production-id', productionId: id, message: 'A production id appears more than once.' });
        return;
      }
      indexed.set(id, entry);
    });
  }
  fileIds.forEach((id) => {
    if (!indexed.has(id)) indexed.set(id, { id, title: '', unindexed: true });
  });
  if (index) {
    indexed.forEach((entry, id) => {
      if (!fileIds.includes(id)) {
        pushError(errors, { code: 'missing-script', productionId: id, message: 'A library entry has no script file.' });
      }
    });
  }

  const productions = [];
  Array.from(indexed.keys()).sort().forEach((id) => {
    if (!isValidScriptId(id)) return;
    const entry = indexed.get(id);
    const scriptPath = path.join(scriptsDir, `${id}.txt`);
    const read = readNoFollow(scriptPath);
    if (read.missing || read.unsafe || !read.bytes) return;
    const text = read.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(read.bytes)) {
      pushError(errors, { code: 'invalid-script-bytes', productionId: id, message: 'A saved script is not valid UTF-8.' });
      return;
    }
    fingerprint.scripts[id] = hashBuffer(read.bytes);
    const assets = inspectProductionAssets(rootReal, id, text, maxImageBytes, errors, fingerprint);
    const lines = imageLines(text);
    const legacyImages = [];
    lines.forEach((line) => {
      if (line.parsed.kind === 'legacy') {
        if (!legacyImages.includes(line.parsed.path)) legacyImages.push(line.parsed.path);
        inspectLegacyImage(rootReal, id, line.parsed.path, maxImageBytes, errors, fingerprint);
        return;
      }
      if (line.parsed.kind === 'library') {
        if (line.parsed.scriptId !== id) {
          pushError(errors, {
            code: 'foreign-library-image',
            productionId: id,
            assetId: line.parsed.assetId,
            message: 'An image reference points at a different production.',
          });
        }
        return;
      }
      pushError(errors, {
        code: 'unsafe-image-path',
        productionId: id,
        message: 'An image line is not a supported images/ name or a library reference.',
      });
    });
    const title = entry && entry.unindexed
      ? (titleFromScript(text) || 'Untitled script')
      : (entry && typeof entry.title === 'string'
        ? entry.title
        : (titleFromScript(text) || 'Untitled script'));
    productions.push({
      id,
      title,
      text,
      bytes: read.bytes,
      contentHash: hashText(text),
      legacyImages,
      needsRewrite: legacyImages.length > 0,
      assets,
    });
  });

  let liveProductionId = null;
  if (liveText != null) {
    const liveBytes = Buffer.from(liveText, 'utf8');
    const matches = productions.filter((production) => production.bytes.equals(liveBytes));
    if (matches.length === 0) {
      pushError(errors, { code: 'no-live-match', message: 'No saved production matches the live script bytes.' });
    } else if (matches.length > 1) {
      pushError(errors, {
        code: 'ambiguous-live-match',
        productionIds: matches.map((production) => production.id),
        message: 'More than one saved production matches the live script bytes.',
      });
    } else {
      liveProductionId = matches[0].id;
    }
  }

  const libraryLiveId = index && isValidScriptId(index.liveId) ? index.liveId.toLowerCase() : null;
  const liveIdDrift = Boolean(liveProductionId && libraryLiveId !== liveProductionId);
  if (liveIdDrift) {
    warnings.push({
      code: 'live-id-drift',
      libraryLiveId,
      actualProductionId: liveProductionId,
      message: 'The library live id does not match the live script bytes and was ignored.',
    });
  } else if (index && index.liveId && !libraryLiveId) {
    warnings.push({
      code: 'live-id-drift',
      libraryLiveId: publicToken(index.liveId),
      actualProductionId: liveProductionId,
      message: 'The library live id is not a valid production id and was ignored.',
    });
  }

  return {
    errors,
    warnings,
    fingerprint,
    liveText,
    liveScriptHash: fingerprint.liveScript,
    libraryLiveId,
    liveIdDrift,
    liveProductionId,
    productions,
    safeToPrepare: errors.length === 0 && Boolean(liveProductionId),
  };
}

function inspectLegacyImage(rootReal, productionId, legacyPath, maxImageBytes, errors, fingerprint) {
  if (!Object.prototype.hasOwnProperty.call(fingerprint.images, legacyPath)) {
    const filePath = path.resolve(rootReal, legacyPath);
    if (!contained(filePath, path.join(rootReal, 'images')) && filePath !== path.join(rootReal, 'images')) {
      pushError(errors, { code: 'unsafe-path', productionId, path: legacyPath, message: 'A legacy image path escapes images/.' });
      return;
    }
    const checked = inspectAssetFile(filePath, maxImageBytes);
    if (checked.error) {
      pushError(errors, {
        code: checked.error === 'missing-asset' ? 'missing-image' : checked.error,
        productionId,
        path: legacyPath,
        message: 'A legacy image could not be used.',
      });
      return;
    }
    fingerprint.images[legacyPath] = checked.contentHash;
  }
}

function inspectProductionAssets(rootReal, productionId, text, maxImageBytes, errors, fingerprint) {
  const dir = path.join(libraryDir(rootReal), 'assets', productionId);
  const stat = lstatIfExists(dir);
  const referenced = new Set();
  imageLines(text).forEach((line) => {
    if (line.parsed.kind === 'library' && line.parsed.scriptId === productionId) referenced.add(line.parsed.assetId);
  });
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    pushError(errors, { code: 'unsafe-path', productionId, message: 'A production asset directory is not a real directory.' });
    return [];
  }
  const manifestRead = readJsonObject(path.join(dir, 'manifest.json'));
  if (manifestRead.missing) {
    pushError(errors, { code: 'missing-manifest', productionId, message: 'A production asset directory has no manifest.' });
    return [];
  }
  if (manifestRead.unsafe || manifestRead.invalid || manifestRead.value.version !== 1 || !Array.isArray(manifestRead.value.assets)) {
    pushError(errors, { code: 'corrupt-manifest', productionId, message: 'A production asset manifest could not be read.' });
    return [];
  }
  fingerprint.manifests[productionId] = hashBuffer(manifestRead.bytes);
  const listed = new Set();
  const assets = [];
  manifestRead.value.assets.forEach((asset) => {
    const assetId = asset && typeof asset.id === 'string' ? asset.id.toLowerCase() : '';
    if (!isValidScriptId(assetId) || listed.has(assetId)) {
      pushError(errors, { code: 'invalid-id', productionId, message: 'A production asset id is not valid.' });
      return;
    }
    listed.add(assetId);
    const ext = asset.ext;
    if (!IMAGE_EXT[ext]) {
      pushError(errors, { code: 'invalid-image', productionId, assetId, message: 'A production asset has an unsupported type.' });
      return;
    }
    const filePath = path.join(dir, `${assetId}.${ext}`);
    const checked = inspectAssetFile(filePath, maxImageBytes);
    if (checked.error) {
      pushError(errors, { code: checked.error, productionId, assetId, message: 'A production asset could not be used.' });
      return;
    }
    if (checked.ext !== ext) {
      pushError(errors, { code: 'invalid-image', productionId, assetId, message: 'A production asset does not match its manifest.' });
      return;
    }
    if (Number.isInteger(asset.bytes) && asset.bytes !== checked.byteLength) {
      pushError(errors, { code: 'corrupt-asset', productionId, assetId, message: 'A production asset length does not match its manifest.' });
      return;
    }
    fingerprint.assets[`${productionId}/${assetId}`] = checked.contentHash;
    assets.push({
      assetId,
      ext: checked.ext,
      mime: checked.mime,
      originalName: displayAssetName(asset.name),
      contentHash: checked.contentHash,
      byteLength: checked.byteLength,
      referenced: referenced.has(assetId),
      absolutePath: filePath,
    });
  });
  referenced.forEach((assetId) => {
    if (!listed.has(assetId)) {
      pushError(errors, { code: 'missing-asset', productionId, assetId, message: 'A script image is not in that production manifest.' });
    }
  });
  fs.readdirSync(dir).forEach((name) => {
    if (name === 'manifest.json') return;
    const match = /^([0-9a-f-]{36})\.(png|jpg|webp)$/i.exec(name);
    const assetId = match ? match[1].toLowerCase() : '';
    if (!assetId || !listed.has(assetId)) {
      pushError(errors, {
        code: 'unlisted-asset',
        productionId,
        path: `data/library/assets/${productionId}/${name}`,
        message: 'A production asset file is not listed in its manifest.',
      });
    }
  });
  return assets;
}

function reportOf(inventory) {
  const productions = inventory.productions.map((production) => ({
    id: production.id,
    title: production.title,
    contentHash: production.contentHash,
    legacyImages: production.legacyImages.slice(),
    ownedAssets: production.assets.filter((asset) => asset.referenced).map(publicAsset),
    unassignedAssets: production.assets.filter((asset) => !asset.referenced).map(publicAsset),
  }));
  const blockingErrors = inventory.errors.map(publicError);
  return {
    ok: blockingErrors.length === 0,
    command: 'dry-run',
    readOnly: true,
    safeToPrepare: inventory.safeToPrepare,
    productionCount: productions.length,
    productions,
    liveScriptHash: inventory.liveScriptHash,
    libraryLiveId: inventory.libraryLiveId,
    liveIdDrift: inventory.liveIdDrift,
    liveProductionId: inventory.liveProductionId,
    legacyImageConversions: productions.flatMap((production) => production.legacyImages.map((legacyPath) => ({
      productionId: production.id,
      legacyPath,
    }))),
    missingOrInvalidImages: blockingErrors.filter((error) => (
      error.code === 'missing-image' || error.code === 'invalid-image' || error.code === 'missing-asset' || error.code === 'unsafe-path'
    )),
    unassignedAssets: productions.flatMap((production) => production.unassignedAssets.map((asset) => ({
      productionId: production.id,
      assetId: asset.assetId,
      contentHash: asset.contentHash,
    }))),
    proposedVersions: {
      v1: productions.length,
      v2: inventory.productions.filter((production) => production.needsRewrite).length,
    },
    unresolvedReferences: blockingErrors.filter((error) => (
      error.code === 'foreign-library-image' || error.code === 'unsafe-image-path' || error.code === 'missing-asset' || error.code === 'missing-image'
    )),
    blockingErrors,
    warnings: inventory.warnings.map(publicError),
  };
}

function publicAsset(asset) {
  return {
    assetId: asset.assetId,
    contentHash: asset.contentHash,
    ext: asset.ext,
    originalName: asset.originalName,
    byteLength: asset.byteLength,
  };
}

function publicError(error) {
  const copy = { code: error.code, message: error.message };
  ['productionId', 'assetId', 'path', 'legacyPath', 'productionIds', 'libraryLiveId', 'actualProductionId'].forEach((key) => {
    if (error[key] !== undefined) copy[key] = error[key];
  });
  return copy;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const sorted = {};
  Object.keys(value).sort().forEach((key) => {
    sorted[key] = sortValue(value[key]);
  });
  return sorted;
}

function sameFingerprint(left, right) {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function fingerprintConflicts(saved, current) {
  const conflicts = [];
  if (saved.liveScript !== current.liveScript) conflicts.push({ kind: 'live-script', path: 'script.txt' });
  if (saved.previousScript !== current.previousScript) conflicts.push({ kind: 'backup', path: 'script.previous.txt' });
  if (saved.previousMeta !== current.previousMeta) conflicts.push({ kind: 'backup', path: 'script.previous.txt.meta.json' });
  if (saved.index !== current.index) conflicts.push({ kind: 'library-metadata', path: 'data/library/index.json' });
  if (JSON.stringify(saved.journal) !== JSON.stringify(current.journal)) conflicts.push({ kind: 'journal', path: 'data/live-journal' });
  const scriptIds = new Set(Object.keys(saved.scripts || {}).concat(Object.keys(current.scripts || {})));
  scriptIds.forEach((id) => {
    if (saved.scripts[id] !== current.scripts[id]) conflicts.push({ kind: 'saved-production', path: `data/library/scripts/${id}.txt` });
  });
  const imagePaths = new Set(Object.keys(saved.images || {}).concat(Object.keys(current.images || {})));
  imagePaths.forEach((imagePath) => {
    if (saved.images[imagePath] !== current.images[imagePath]) conflicts.push({ kind: 'image', path: imagePath });
  });
  const manifestIds = new Set(Object.keys(saved.manifests || {}).concat(Object.keys(current.manifests || {})));
  manifestIds.forEach((id) => {
    if (saved.manifests[id] !== current.manifests[id]) conflicts.push({ kind: 'asset-manifest', path: `data/library/assets/${id}/manifest.json` });
  });
  const assetKeys = new Set(Object.keys(saved.assets || {}).concat(Object.keys(current.assets || {})));
  assetKeys.forEach((key) => {
    if (saved.assets[key] !== current.assets[key]) conflicts.push({ kind: 'asset', path: `data/library/assets/${key}` });
  });
  return conflicts;
}

function readAttempt(rootReal) {
  const parsed = readJsonObject(attemptPath(rootReal));
  if (parsed.missing) return null;
  if (parsed.unsafe || parsed.invalid || parsed.value.schema !== 1 || !parsed.value.ids || !parsed.value.fingerprint) {
    return fail('corrupt-attempt', 'The migration attempt file could not be read.');
  }
  return { ok: true, attempt: parsed.value };
}

function allocateIds(inventory, createId) {
  const nextId = typeof createId === 'function' ? createId : () => crypto.randomUUID();
  const take = () => {
    const id = nextId();
    if (!isValidScriptId(id)) {
      throw new MigrationError('invalid-id', 'A generated migration id is not a valid UUID.');
    }
    return id.toLowerCase();
  };
  const ids = {};
  const seen = new Set();
  const claim = () => {
    const id = take();
    if (seen.has(id)) throw new MigrationError('invalid-id', 'A generated migration id was repeated.');
    seen.add(id);
    return id;
  };
  const migrationId = claim();
  inventory.productions.forEach((production) => {
    const legacyAssets = {};
    const record = {
      v1: claim(),
      v2: production.needsRewrite ? claim() : null,
      legacyAssets,
    };
    production.legacyImages.slice().sort().forEach((legacyPath) => {
      legacyAssets[legacyPath] = claim();
    });
    ids[production.id] = record;
  });
  return { migrationId, ids };
}

function attemptDocument(fields) {
  return {
    schema: 1,
    state: fields.state,
    migrationId: fields.migrationId,
    createdAt: fields.createdAt,
    fingerprint: fields.fingerprint,
    ids: fields.ids,
    pointer: fields.pointer || null,
    planHash: fields.planHash || null,
    files: fields.files || null,
  };
}

function saveAttempt(rootReal, attempt) {
  fs.mkdirSync(libraryDir(rootReal), { recursive: true });
  writeAtomic(attemptPath(rootReal), stableBytes(attempt));
}

function checkpoint(failAt, name) {
  if (failAt === name) {
    throw new MigrationError('injected-failure', `Injected failure at ${name}.`);
  }
}

function buildPlan(inventory, ids) {
  return planMigration({
    liveScript: inventory.liveText,
    liveId: inventory.libraryLiveId,
    productions: inventory.productions.map((production) => {
      const versions = { v1: ids[production.id].v1 };
      if (ids[production.id].v2) versions.v2 = ids[production.id].v2;
      return {
        id: production.id,
        text: production.text,
        versions,
        assets: ids[production.id].legacyAssets,
      };
    }),
  });
}

function sourceList(rootReal, inventory, plan) {
  const sources = [];
  plan.productions.forEach((production) => {
    const original = inventory.productions.find((entry) => entry.id === production.id);
    (production.assetMappings || []).forEach((mapping) => {
      sources.push({
        productionId: production.id,
        assetId: mapping.assetId,
        path: path.resolve(rootReal, mapping.legacyPath),
      });
    });
    (production.retainedLibraryReferences || []).forEach((reference) => {
      const asset = original.assets.find((entry) => entry.assetId === reference.assetId);
      sources.push({
        productionId: production.id,
        assetId: reference.assetId,
        path: asset.absolutePath,
      });
    });
  });
  return sources;
}

function stagingRequest(rootReal, inventory, plan) {
  return {
    root: rootReal,
    plan,
    sources: sourceList(rootReal, inventory, plan),
    titles: titleMap(inventory),
    unassigned: unassignedSources(inventory),
  };
}

function checkVersions(rootReal, inventory, ids, storeRoot) {
  const store = createVersionStore({ root: storeRoot });
  const seen = new Set();
  const summaries = [];
  inventory.productions.forEach((production) => {
    const planned = ids[production.id];
    const headId = planned.v2 || planned.v1;
    [planned.v1, planned.v2].filter(Boolean).forEach((versionId) => {
      if (seen.has(versionId)) {
        throw new MigrationError('duplicate-version-id', 'A version id is used more than once.');
      }
      seen.add(versionId);
    });
    const head = store.readHead(production.id);
    if (!head.ok || head.version.id !== headId) {
      throw new MigrationError('corrupt-staging', 'The staged head does not match the migration plan.');
    }
    const stagedProduction = store.readProduction(production.id);
    if (!stagedProduction.ok || stagedProduction.production.title !== production.title) {
      throw new MigrationError('corrupt-staging', 'The staged production title does not match the library.');
    }
    const original = store.readVersion(production.id, planned.v1);
    if (!original.ok || !original.version || original.version.contentHash !== production.contentHash) {
      throw new MigrationError('hash-mismatch', 'An original version does not match its saved script.');
    }
    const originalBytes = fs.readFileSync(path.join(storeRoot, 'productions', production.id, 'versions', planned.v1, 'script.txt'));
    if (!originalBytes.equals(production.bytes)) {
      throw new MigrationError('hash-mismatch', 'An original version changed the saved script bytes.');
    }
    if (planned.v2) {
      const migrated = store.readVersion(production.id, planned.v2);
      if (!migrated.ok || migrated.version.parentVersionId !== planned.v1) {
        throw new MigrationError('missing-parent', 'A migrated version does not point at its original version.');
      }
      if (migrated.version.legacyImagePolicy !== 'production-assets') {
        throw new MigrationError('corrupt-staging', 'A migrated version does not use production-owned images.');
      }
      imageLines(migrated.text).forEach((line) => {
        if (line.parsed.kind !== 'library' || line.parsed.scriptId !== production.id) {
          throw new MigrationError('unresolved-reference', 'A migrated image reference does not stay inside its production.');
        }
      });
    }
    summaries.push({
      id: production.id,
      headVersionId: headId,
      versions: [planned.v1].concat(planned.v2 ? [planned.v2] : []),
      unassigned: production.assets.filter((asset) => !asset.referenced).map((asset) => asset.assetId),
    });
  });
  return summaries;
}

function pointerFor(inventory, plan) {
  const live = inventory.productions.find((production) => production.id === inventory.liveProductionId);
  return {
    productionId: live.id,
    versionId: plan.pointer.versionId,
    previousActivation: null,
    contentHash: plan.pointer.contentHash,
    origin: plan.pointer.origin,
    sourceScriptHash: inventory.liveScriptHash,
  };
}

function titleMap(inventory) {
  const titles = {};
  inventory.productions.forEach((production) => {
    titles[production.id] = production.title;
  });
  return titles;
}

function unassignedSources(inventory) {
  const sources = [];
  inventory.productions.forEach((production) => {
    production.assets.filter((asset) => !asset.referenced).forEach((asset) => {
      sources.push({
        productionId: production.id,
        assetId: asset.assetId,
        path: asset.absolutePath,
        originalName: asset.originalName,
      });
    });
  });
  return sources;
}

function prepare(rootReal, inventory, options) {
  const failAt = options.failAt || '';
  checkpoint(failAt, 'inspect');
  if (!inventory.safeToPrepare) {
    return fail(inventory.errors[0].code, inventory.errors[0].message, {
      command: 'prepare',
      safeToPrepare: false,
      blockingErrors: inventory.errors.map(publicError),
      warnings: inventory.warnings.map(publicError),
    });
  }
  const loaded = readAttempt(rootReal);
  if (loaded && loaded.ok === false) return loaded;
  let attempt = loaded && loaded.attempt;
  if (attempt && !sameFingerprint(attempt.fingerprint, inventory.fingerprint)) {
    return fail('source-changed', 'The fixture changed after this migration plan was recorded.', {
      command: 'prepare',
      conflicts: fingerprintConflicts(attempt.fingerprint, inventory.fingerprint),
    });
  }
  if (attempt && attempt.state === 'committed') {
    return {
      ok: true,
      command: 'prepare',
      state: 'committed',
      alreadyCommitted: true,
      activated: false,
      migrationId: attempt.migrationId,
    };
  }
  const blocker = activationBlocker(rootReal);
  if (blocker && !attempt) {
    return fail('activation-artifact', blocker.message, { command: 'prepare', path: blocker.path });
  }
  if (!attempt) {
    const allocated = allocateIds(inventory, options.createId);
    attempt = attemptDocument({
      state: 'preparing',
      migrationId: allocated.migrationId,
      createdAt: options.now ? options.now() : new Date().toISOString(),
      fingerprint: inventory.fingerprint,
      ids: allocated.ids,
    });
    saveAttempt(rootReal, attempt);
  }
  checkpoint(failAt, 'plan');
  const plan = buildPlan(inventory, attempt.ids);
  if (!plan.ok) {
    return fail(plan.errors[0].code, plan.errors[0].message, {
      command: 'prepare',
      blockingErrors: plan.errors.map(publicError),
      warnings: (plan.warnings || []).map(publicError),
    });
  }
  const stagedBlocker = activationBlocker(rootReal);
  if (stagedBlocker) {
    return fail('activation-artifact', stagedBlocker.message, { command: 'prepare', path: stagedBlocker.path });
  }
  const staged = stageMigration(Object.assign(stagingRequest(rootReal, inventory, plan), {
    onStage(stage) {
      if ((stage === 'v1' || stage === 'v2' || stage === 'asset') && failAt === stage) {
        throw new MigrationError('injected-failure', `Injected failure at ${stage}.`);
      }
    },
  }));
  if (!staged.ok) {
    return fail(staged.code, staged.errors[0].message, { command: 'prepare', ready: false });
  }
  const verification = verifyStaging(rootReal);
  if (!verification.ready) {
    return fail(verification.code || 'not-ready', 'Staged files did not verify.', {
      command: 'prepare',
      ready: false,
    });
  }
  const summaries = checkVersions(rootReal, inventory, attempt.ids, workDir(rootReal));
  const pointer = pointerFor(inventory, plan);
  if (pointer.versionId !== (attempt.ids[pointer.productionId].v2 || attempt.ids[pointer.productionId].v1)) {
    return fail('corrupt-staging', 'The planned live version does not match the saved head.', { command: 'prepare' });
  }
  const described = describeStaging(stagingRequest(rootReal, inventory, plan));
  if (!described.ok || described.planHash !== staged.planHash) {
    return fail('corrupt-staging', 'The staged plan does not include the titles and assets that will be published.', {
      command: 'prepare',
      ready: false,
    });
  }
  const files = readyFileRecord(rootReal, described);
  if (!files) {
    return fail('not-ready', 'READY does not match the files that will be published.', {
      command: 'prepare',
      ready: false,
    });
  }
  attempt = attemptDocument({
    state: 'ready',
    migrationId: attempt.migrationId,
    createdAt: attempt.createdAt,
    fingerprint: attempt.fingerprint,
    ids: attempt.ids,
    pointer,
    planHash: staged.planHash,
    files,
  });
  saveAttempt(rootReal, attempt);
  checkpoint(failAt, 'ready');
  return {
    ok: true,
    command: 'prepare',
    state: 'ready',
    ready: true,
    resumed: Boolean(staged.resumed),
    activated: false,
    migrationId: attempt.migrationId,
    planHash: staged.planHash,
    liveProductionId: pointer.productionId,
    pointer: {
      productionId: pointer.productionId,
      versionId: pointer.versionId,
      previousActivation: null,
      contentHash: pointer.contentHash,
      origin: pointer.origin,
    },
    productions: summaries,
    warnings: inventory.warnings.map(publicError).concat((plan.warnings || []).map(publicError)),
  };
}

function verify(rootReal, inventory) {
  const loaded = readAttempt(rootReal);
  if (loaded && loaded.ok === false) return loaded;
  const attempt = loaded && loaded.attempt;
  const verification = verifyStaging(rootReal);
  const conflicts = attempt ? fingerprintConflicts(attempt.fingerprint, inventory.fingerprint) : [];
  const ready = Boolean(verification.ready && attempt && attempt.state !== 'preparing' && attempt.planHash === verification.planHash && conflicts.length === 0);
  return {
    ok: ready,
    command: 'verify',
    readOnly: true,
    ready,
    state: attempt ? attempt.state : verification.state,
    planHash: verification.planHash,
    code: ready ? null : (conflicts.length ? 'source-changed' : (verification.code || 'not-ready')),
    conflicts,
    problems: verification.problems || [],
  };
}

function markerDocument(attempt) {
  return {
    schema: 2,
    state: 'committed',
    migrationId: attempt.migrationId,
    productionId: attempt.pointer.productionId,
    versionId: attempt.pointer.versionId,
    previousActivation: null,
    sourceScriptHash: attempt.pointer.sourceScriptHash,
    contentHash: attempt.pointer.contentHash,
    mirrorInstalled: false,
  };
}

function sameMarker(filePath, expected) {
  const parsed = readJsonObject(filePath);
  if (!parsed.value) return false;
  const keys = Object.keys(expected);
  return keys.every((key) => parsed.value[key] === expected[key]) && Object.keys(parsed.value).length === keys.length;
}

function copyFileBytes(source, dest) {
  const read = readNoFollow(source);
  if (!read.bytes) throw new MigrationError('unsafe-path', 'A staged file could not be copied.');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomic(dest, read.bytes);
}

function copyProductionTree(sourceDir, destDir) {
  const stat = lstatIfExists(sourceDir);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MigrationError('corrupt-staging', 'The staged production tree is missing.');
  }
  const stack = [sourceDir];
  while (stack.length) {
    const current = stack.pop();
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const from = path.join(current, entry.name);
      const to = path.join(destDir, path.relative(sourceDir, from));
      if (entry.isSymbolicLink()) throw new MigrationError('unsafe-path', 'Refusing to copy a symlink from staging.');
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        stack.push(from);
        return;
      }
      if (entry.isFile()) copyFileBytes(from, to);
    });
  }
}

function treeFingerprint(dir) {
  const found = hashTree(dir);
  if (!found || found.unsafe) return null;
  return found;
}

function commit(rootReal, inventory, options) {
  const failAt = options.failAt || '';
  const loaded = readAttempt(rootReal);
  if (loaded && loaded.ok === false) return loaded;
  const attempt = loaded && loaded.attempt;
  if (!attempt || !attempt.pointer || attempt.pointer.previousActivation !== null || !attempt.planHash || !attempt.ids || !attempt.files) {
    return fail('not-ready', 'Commit requires a verified READY migration attempt.', { command: 'commit', activated: false });
  }
  const expectedMarker = markerDocument(attempt);
  const markerFile = markerPath(rootReal);
  if (sameMarker(markerFile, expectedMarker)) {
    if (attempt.state !== 'committed') {
      saveAttempt(rootReal, attemptDocument(Object.assign({}, attempt, { state: 'committed' })));
    }
    return {
      ok: true,
      command: 'commit',
      committed: true,
      alreadyCommitted: true,
      activated: false,
      mirrorInstalled: false,
      fixtureOnly: true,
      marker: expectedMarker,
    };
  }
  if (lstatIfExists(markerFile)) {
    return fail('marker-conflict', 'A different migration marker is already present.', { command: 'commit', activated: false });
  }
  const conflicts = fingerprintConflicts(attempt.fingerprint, inventory.fingerprint);
  if (conflicts.length) {
    return fail('source-changed', 'The fixture changed after preparation. The recorded plan was not committed.', {
      command: 'commit',
      activated: false,
      conflicts,
    });
  }
  const verification = verifyStaging(rootReal);
  const unexpected = (verification.problems || []).filter((problem) => problem.code !== 'activation-artifact');
  const complete = Array.isArray(verification.productions)
    && verification.productions.length === inventory.productions.length
    && verification.productions.every((production) => production.complete);
  if (unexpected.length || !complete || verification.planHash !== attempt.planHash || verification.planState !== 'ready') {
    return fail(unexpected[0] ? unexpected[0].code : 'not-ready', 'READY staging did not verify. Nothing was committed.', {
      command: 'commit',
      activated: false,
      ready: false,
    });
  }
  checkVersions(rootReal, inventory, attempt.ids, workDir(rootReal));
  const described = describeStaging(stagingRequest(rootReal, inventory, buildPlan(inventory, attempt.ids)));
  const recordedNow = described.ok ? readyFileRecord(rootReal, described) : null;
  if (!described.ok || described.planHash !== attempt.planHash || !recordedNow
    || JSON.stringify(sortValue(recordedNow)) !== JSON.stringify(sortValue(attempt.files))) {
    return fail('not-ready', 'READY no longer matches the recorded titles, assets, and file inventory. Nothing was committed.', {
      command: 'commit',
      activated: false,
      ready: false,
    });
  }
  checkpoint(failAt, 'before-publish');
  const stagedProductions = path.join(workDir(rootReal), 'productions');
  const incoming = path.join(libraryDir(rootReal), INCOMING_NAME);
  const published = path.join(libraryDir(rootReal), 'productions');
  if (lstatIfExists(incoming)) {
    const scratch = copyOwnership(incoming, productionFiles(attempt.files), { allowPartial: true });
    if (!scratch.ok) return fail(scratch.code, scratch.error, { command: 'commit', activated: false });
    if (scratch.present) deleteProvenDirectory(rootReal, incoming, hashMap(scratch.scan));
  }
  copyProductionTree(stagedProductions, incoming);
  verifyIncoming(incoming, inventory, attempt);
  const copied = directoryHashes(incoming);
  if (!copied || JSON.stringify(sortValue(copied)) !== JSON.stringify(sortValue(productionFiles(attempt.files)))) {
    return fail('hash-mismatch', 'The copied production tree does not match the recorded READY inventory. The marker was not written.', {
      command: 'commit',
      activated: false,
    });
  }
  const publishedStat = lstatIfExists(published);
  if (publishedStat) {
    if (publishedStat.isSymbolicLink() || !publishedStat.isDirectory()) {
      return fail('unsafe-path', 'The published production tree is not a real directory.', { command: 'commit', activated: false });
    }
    if (JSON.stringify(sortValue(treeFingerprint(published))) !== JSON.stringify(sortValue(treeFingerprint(incoming)))) {
      return fail('incompatible-tree', 'An existing production tree does not match this migration and was left unchanged.', {
        command: 'commit',
        activated: false,
      });
    }
    deleteProvenDirectory(rootReal, incoming, copied);
  } else {
    fs.renameSync(incoming, published);
    fsyncDirectory(libraryDir(rootReal));
  }
  checkpoint(failAt, 'after-publish');
  writeAtomic(markerFile, stableBytes(expectedMarker));
  fsyncDirectory(libraryDir(rootReal));
  checkpoint(failAt, 'after-marker');
  saveAttempt(rootReal, attemptDocument(Object.assign({}, attempt, { state: 'committed' })));
  return {
    ok: true,
    command: 'commit',
    committed: true,
    alreadyCommitted: false,
    activated: false,
    mirrorInstalled: false,
    fixtureOnly: true,
    marker: expectedMarker,
  };
}

function verifyIncoming(incoming, inventory, attempt) {
  inventory.productions.forEach((production) => {
    const planned = attempt.ids[production.id];
    const metadata = readJsonObject(path.join(incoming, production.id, 'metadata.json'));
    if (!metadata.value || metadata.value.title !== production.title || metadata.value.headVersionId !== (planned.v2 || planned.v1)) {
      throw new MigrationError('corrupt-staging', 'The published production metadata does not match the prepared title and head.');
    }
    const versionDir = path.join(incoming, production.id, 'versions', planned.v1);
    const read = readNoFollow(path.join(versionDir, 'script.txt'));
    if (!read.bytes || !read.bytes.equals(production.bytes)) {
      throw new MigrationError('hash-mismatch', 'The published original version does not match the saved script.');
    }
    const manifest = readJsonObject(path.join(incoming, production.id, 'assets', 'manifest.json'));
    if (!manifest.value || !Array.isArray(manifest.value.assets)) {
      throw new MigrationError('corrupt-staging', 'A published asset manifest could not be read.');
    }
    manifest.value.assets.forEach((asset) => {
      const assetRead = readNoFollow(path.join(incoming, production.id, 'assets', asset.file));
      if (!assetRead.bytes || hashBuffer(assetRead.bytes) !== asset.contentHash) {
        throw new MigrationError('hash-mismatch', 'A published asset does not match its manifest.');
      }
    });
    production.assets.forEach((asset) => {
      const listed = manifest.value.assets.some((entry) => entry.assetId === asset.assetId);
      if (!listed) throw new MigrationError('missing-asset', 'A published manifest omitted a production asset.');
    });
  });
}

const TEMP_FILE = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/i;

function scanTree(dir) {
  const stat = lstatIfExists(dir);
  if (!stat) return { missing: true, files: new Map(), dirs: new Set() };
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { unsafe: true, files: new Map(), dirs: new Set() };
  const files = new Map();
  const dirs = new Set();
  const stack = [{ full: dir, rel: '' }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.full, { withFileTypes: true });
    } catch (err) {
      return { unsafe: true, files, dirs };
    }
    entries.forEach((entry) => {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const full = path.join(current.full, entry.name);
      if (entry.isSymbolicLink()) {
        files.set(rel, { unsafe: true });
        return;
      }
      if (entry.isDirectory()) {
        dirs.add(rel);
        stack.push({ full, rel });
        return;
      }
      if (!entry.isFile()) {
        files.set(rel, { unsafe: true });
        return;
      }
      const read = readNoFollow(full);
      files.set(rel, read.bytes ? { bytes: read.bytes } : { unsafe: true });
    });
  }
  return { files, dirs };
}

function hashMap(scan) {
  if (!scan || scan.unsafe) return null;
  const out = {};
  let unsafe = false;
  scan.files.forEach((value, rel) => {
    if (!value || value.unsafe || !value.bytes) {
      unsafe = true;
      return;
    }
    out[rel] = hashBuffer(value.bytes);
  });
  return unsafe ? null : out;
}

function directoryHashes(dir) {
  const scan = scanTree(dir);
  if (scan.missing || scan.unsafe) return null;
  return hashMap(scan);
}

function productionFiles(record) {
  const out = {};
  Object.keys(record || {}).forEach((rel) => {
    if (rel.startsWith('productions/')) out[rel.slice('productions/'.length)] = record[rel];
  });
  return out;
}

function readyFileRecord(rootReal, described) {
  const scan = scanTree(workDir(rootReal));
  if (scan.missing || scan.unsafe) return null;
  const expected = new Map(described.files.map((file) => [file.relative, file.bytes]));
  const record = {};
  const seen = new Set();
  let planOk = false;
  let readyOk = false;
  for (const [rel, value] of scan.files) {
    if (!value || value.unsafe || !value.bytes) return null;
    if (rel === 'PLAN.json') {
      if (!value.bytes.equals(described.readyPlan)) return null;
      planOk = true;
      record[rel] = hashBuffer(value.bytes);
      continue;
    }
    if (rel === 'READY') {
      if (!value.bytes.equals(described.ready)) return null;
      readyOk = true;
      record[rel] = hashBuffer(value.bytes);
      continue;
    }
    if (TEMP_FILE.test(rel.split('/').pop())) continue;
    const want = expected.get(rel);
    if (!want || !want.equals(value.bytes)) return null;
    seen.add(rel);
    record[rel] = hashBuffer(value.bytes);
  }
  if (!planOk || !readyOk) return null;
  for (const rel of expected.keys()) {
    if (!seen.has(rel)) return null;
  }
  return record;
}

function workOwnership(rootReal, described) {
  const scan = scanTree(workDir(rootReal));
  if (scan.missing) return { ok: true, present: false, complete: false };
  if (scan.unsafe) {
    return { ok: false, code: 'unsafe-path', error: 'migration-work is not a real directory. Nothing was deleted.' };
  }
  const expected = new Map(described.files.map((file) => [file.relative, file.bytes]));
  const allowedDirs = new Set(['']);
  expected.forEach((bytes, rel) => {
    const parts = rel.split('/');
    parts.pop();
    let acc = '';
    parts.forEach((part) => {
      acc = acc ? `${acc}/${part}` : part;
      allowedDirs.add(acc);
    });
  });
  for (const dir of scan.dirs) {
    if (!allowedDirs.has(dir)) {
      return { ok: false, code: 'unowned-tree', error: 'migration-work contains an unrecognized directory. Nothing was deleted.' };
    }
  }
  let sawReady = false;
  let planState = null;
  for (const [rel, value] of scan.files) {
    if (!value || value.unsafe || !value.bytes) {
      return { ok: false, code: 'unsafe-path', error: 'migration-work contains a symlink or unreadable file. Nothing was deleted.' };
    }
    if (rel === 'PLAN.json') {
      if (value.bytes.equals(described.preparingPlan)) planState = 'preparing';
      else if (value.bytes.equals(described.readyPlan)) planState = 'ready';
      else return { ok: false, code: 'unowned-tree', error: 'PLAN.json does not match this migration attempt. Nothing was deleted.' };
      continue;
    }
    if (rel === 'READY') {
      if (!value.bytes.equals(described.ready)) {
        return { ok: false, code: 'unowned-tree', error: 'READY does not match this migration attempt. Nothing was deleted.' };
      }
      sawReady = true;
      continue;
    }
    if (TEMP_FILE.test(rel.split('/').pop())) continue;
    const want = expected.get(rel);
    if (!want || !want.equals(value.bytes)) {
      return { ok: false, code: 'unowned-tree', error: 'A prepared file does not match this migration attempt. Nothing was deleted.' };
    }
  }
  const missing = [];
  expected.forEach((bytes, rel) => {
    const found = scan.files.get(rel);
    if (!found || !found.bytes || !found.bytes.equals(bytes)) missing.push(rel);
  });
  const complete = Boolean(sawReady && planState === 'ready' && missing.length === 0);
  if ((sawReady || planState === 'ready') && !complete) {
    return { ok: false, code: 'unowned-tree', error: 'READY does not match a complete prepared tree. Nothing was deleted.' };
  }
  return { ok: true, present: true, complete, scan };
}

function copyOwnership(dir, expectedHashes, options) {
  const allowPartial = Boolean(options && options.allowPartial);
  const scan = scanTree(dir);
  if (scan.missing) return { ok: true, present: false };
  if (scan.unsafe) {
    return { ok: false, code: 'unsafe-path', error: 'A production directory is not a real directory. Nothing was deleted.' };
  }
  const found = {};
  for (const [rel, value] of scan.files) {
    if (!value || value.unsafe || !value.bytes) {
      return { ok: false, code: 'unsafe-path', error: 'A production directory contains a symlink or unreadable file. Nothing was deleted.' };
    }
    if (TEMP_FILE.test(rel.split('/').pop())) {
      return { ok: false, code: 'unowned-tree', error: 'A production directory contains an unrecognized temporary file. Nothing was deleted.' };
    }
    const hash = hashBuffer(value.bytes);
    if (expectedHashes[rel] !== hash) {
      return { ok: false, code: 'unowned-tree', error: 'A production file does not match this migration attempt. Nothing was deleted.' };
    }
    found[rel] = hash;
  }
  const expectedKeys = Object.keys(expectedHashes);
  if (!allowPartial && (expectedKeys.length !== Object.keys(found).length || expectedKeys.some((rel) => found[rel] !== expectedHashes[rel]))) {
    return { ok: false, code: 'unowned-tree', error: 'The production tree does not match the prepared files. Nothing was deleted.' };
  }
  return { ok: true, present: true, scan };
}

function deleteProvenDirectory(rootReal, target, expectedHashes) {
  const stat = lstatIfExists(target);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MigrationError('unsafe-path', 'Refusing to delete a path that is not a real directory.');
  }
  const real = fs.realpathSync(target);
  if (!insideStrict(real, rootReal)) {
    throw new MigrationError('unsafe-path', 'Refusing to delete a path outside the fixture.');
  }
  const scan = scanTree(target);
  const hashes = hashMap(scan);
  if (!hashes || JSON.stringify(sortValue(hashes)) !== JSON.stringify(sortValue(expectedHashes))) {
    throw new MigrationError('unowned-tree', 'The directory changed before it could be removed.');
  }
  Object.keys(hashes).sort((left, right) => right.length - left.length).forEach((rel) => {
    const full = path.join(target, ...rel.split('/'));
    const child = fs.lstatSync(full);
    if (child.isSymbolicLink() || !child.isFile()) {
      throw new MigrationError('unsafe-path', 'Refusing to delete a path that is not a regular file.');
    }
    fs.unlinkSync(full);
  });
  Array.from(scan.dirs).sort((left, right) => right.length - left.length).forEach((rel) => {
    const full = path.join(target, ...rel.split('/'));
    const child = fs.lstatSync(full);
    if (child.isSymbolicLink() || !child.isDirectory()) {
      throw new MigrationError('unsafe-path', 'Refusing to delete a path that is not a real directory.');
    }
    fs.rmdirSync(full);
  });
  const again = fs.lstatSync(target);
  if (again.isSymbolicLink() || !again.isDirectory()) {
    throw new MigrationError('unsafe-path', 'Refusing to delete a path that is not a real directory.');
  }
  fs.rmdirSync(target);
  return true;
}

function abort(rootReal, maxImageBytes) {
  if (lstatIfExists(markerPath(rootReal))) {
    return fail('abort-refused', 'A migration marker is present. Abort will not roll back a commit.', {
      command: 'abort',
      activated: false,
    });
  }
  const attemptFile = attemptPath(rootReal);
  const attemptStat = lstatIfExists(attemptFile);
  if (attemptStat && (attemptStat.isSymbolicLink() || !attemptStat.isFile())) {
    return fail('unsafe-path', 'The attempt file is not a regular file. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const loaded = readAttempt(rootReal);
  if (loaded && loaded.ok === false) return loaded;
  const attempt = loaded && loaded.attempt;
  const incoming = path.join(libraryDir(rootReal), INCOMING_NAME);
  const published = path.join(libraryDir(rootReal), 'productions');
  const work = workDir(rootReal);
  const hasTree = Boolean(lstatIfExists(incoming) || lstatIfExists(published) || lstatIfExists(work));
  if (!attempt) {
    if (hasTree || attemptStat) {
      return fail('unowned-tree', 'No migration attempt identifies these files. Nothing was deleted.', {
        command: 'abort',
        activated: false,
      });
    }
    return { ok: true, command: 'abort', removed: [], activated: false };
  }
  if (attempt.state === 'committed') {
    return fail('abort-refused', 'This attempt is already committed. Abort will not roll back a commit.', {
      command: 'abort',
      activated: false,
    });
  }
  const inventory = inspect(rootReal, maxImageBytes);
  if (!sameFingerprint(attempt.fingerprint, inventory.fingerprint)) {
    return fail('unowned-tree', 'The recorded source fingerprint no longer matches the fixture. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const attemptIds = Object.keys(attempt.ids || {}).sort();
  const productionIds = inventory.productions.map((production) => production.id).sort();
  if (!attempt.migrationId || attemptIds.join(',') !== productionIds.join(',')) {
    return fail('unowned-tree', 'The attempt does not name the same productions as the fixture. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const plan = buildPlan(inventory, attempt.ids);
  if (!plan.ok) {
    return fail('unowned-tree', 'The recorded attempt no longer describes this fixture. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const described = describeStaging(stagingRequest(rootReal, inventory, plan));
  if (!described.ok || (attempt.planHash && attempt.planHash !== described.planHash)) {
    return fail('unowned-tree', 'The recorded plan hash does not match this attempt. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const workProof = workOwnership(rootReal, described);
  if (!workProof.ok) return fail(workProof.code, workProof.error, { command: 'abort', activated: false });
  if (workProof.complete) {
    const recorded = readyFileRecord(rootReal, described);
    if (!recorded || !attempt.files || JSON.stringify(sortValue(recorded)) !== JSON.stringify(sortValue(attempt.files))) {
      return fail('unowned-tree', 'The prepared file inventory does not match the recorded attempt. Nothing was deleted.', {
        command: 'abort',
        activated: false,
      });
    }
  } else if (attempt.state === 'ready' || attempt.files) {
    return fail('unowned-tree', 'The attempt says ready, but the prepared tree is no longer complete. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const expectedProductions = workProof.complete ? productionFiles(attempt.files) : {};
  const incomingProof = lstatIfExists(incoming)
    ? copyOwnership(incoming, expectedProductions, { allowPartial: false })
    : { ok: true, present: false };
  if (!incomingProof.ok) return fail(incomingProof.code, incomingProof.error, { command: 'abort', activated: false });
  if (incomingProof.present && !workProof.complete) {
    return fail('unowned-tree', 'A production directory exists before preparation finished. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const publishedProof = lstatIfExists(published)
    ? copyOwnership(published, expectedProductions, { allowPartial: false })
    : { ok: true, present: false };
  if (!publishedProof.ok) return fail(publishedProof.code, publishedProof.error, { command: 'abort', activated: false });
  if (publishedProof.present && !workProof.complete) {
    return fail('unowned-tree', 'A production directory exists before preparation finished. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const attemptBytes = readNoFollow(attemptFile);
  if (!attemptBytes.bytes) {
    return fail('unsafe-path', 'The attempt file could not be read. Nothing was deleted.', {
      command: 'abort',
      activated: false,
    });
  }
  const removed = [];
  if (incomingProof.present) {
    deleteProvenDirectory(rootReal, incoming, hashMap(incomingProof.scan));
    removed.push(`data/library/${INCOMING_NAME}`);
  }
  if (publishedProof.present) {
    deleteProvenDirectory(rootReal, published, hashMap(publishedProof.scan));
    removed.push('data/library/productions');
  }
  if (workProof.present) {
    deleteProvenDirectory(rootReal, work, hashMap(workProof.scan));
    removed.push('data/library/migration-work');
  }
  const again = readNoFollow(attemptFile);
  if (!again.bytes || !again.bytes.equals(attemptBytes.bytes)) {
    return fail('unowned-tree', 'The attempt file changed before it could be removed.', {
      command: 'abort',
      activated: false,
      removed,
    });
  }
  const finalStat = fs.lstatSync(attemptFile);
  if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
    return fail('unsafe-path', 'The attempt file is not a regular file.', { command: 'abort', activated: false, removed });
  }
  fs.unlinkSync(attemptFile);
  removed.push(`data/library/${ATTEMPT_NAME}`);
  return { ok: true, command: 'abort', removed, activated: false };
}

function activationBlocker(rootReal) {
  const paths = [
    ['data/library/migration.json', 'A migration marker is already present.'],
    ['data/library/live-state.json', 'A live pointer is already present.'],
    ['data/library/productions', 'A production tree is already present.'],
    ['data/live-journal', 'A live journal is present. Staging will not run beside it.'],
  ];
  for (let index = 0; index < paths.length; index += 1) {
    const relative = paths[index][0];
    if (lstatIfExists(path.join(rootReal, ...relative.split('/')))) {
      return { path: relative, message: paths[index][1] };
    }
  }
  return null;
}

function runMigration(options) {
  try {
    return dispatchMigration(options || {});
  } catch (err) {
    if (err instanceof MigrationError && err.code === 'injected-failure') throw err;
    if (err instanceof MigrationError) return fail(err.code, err.message, { activated: false });
    throw err;
  }
}

function dispatchMigration(settings) {
  const command = settings.command;
  if (!COMMANDS.includes(command)) return fail('invalid-command', 'Choose one of --dry-run, --prepare, --verify, --abort, or --commit.');
  const auth = authorizeRoot(settings.root);
  if (!auth.ok) return auth;
  const maxImageBytes = Number.isInteger(settings.maxImageBytes) && settings.maxImageBytes > 0
    ? settings.maxImageBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  if (command === 'abort') return withLibraryLock(auth.rootReal, () => abort(auth.rootReal, maxImageBytes));
  const inventory = inspect(auth.rootReal, maxImageBytes);
  if (command === 'dry-run') {
    checkpoint(settings.failAt || '', 'inspect');
    return reportOf(inventory);
  }
  if (command === 'verify') return verify(auth.rootReal, inventory);
  if (command === 'prepare') return withLibraryLock(auth.rootReal, () => prepare(auth.rootReal, inventory, settings));
  if (command === 'commit') return withLibraryLock(auth.rootReal, () => commit(auth.rootReal, inventory, settings));
  return fail('invalid-command', 'Choose one of --dry-run, --prepare, --verify, --abort, or --commit.');
}

function withLibraryLock(rootReal, work) {
  const libraryDir = path.join(rootReal, 'data', 'library');
  const stat = lstatIfExists(libraryDir);
  if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) {
    return fail('unsafe-lock', 'Migration writes need a real library directory before they can take the writer lock.', { activated: false });
  }
  const result = lockAround(libraryDir, work);
  if (result && result.ok === false && (result.code === 'writer-locked' || result.code === 'writer-lock-lost' || result.code === 'lock-unsupported' || result.code === 'unsafe-lock')) {
    return fail(result.code, result.error, { activated: false });
  }
  return result;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let command = null;
  let root = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      root = args[index + 1];
      index += 1;
      if (root === undefined) return fail('root-required', 'An explicit absolute --root is required.');
      continue;
    }
    if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!COMMANDS.includes(name) || command) return fail('invalid-command', 'Choose one migration command and an explicit --root.');
    command = name;
  }
  if (!command) return fail('invalid-command', 'Choose one of --dry-run, --prepare, --verify, --abort, or --commit.');
  if (!root) return fail('root-required', 'An explicit absolute --root is required. The working directory is not used.');
  return { ok: true, command, root };
}

function runCli(argv, io) {
  const stdout = io && io.stdout ? io.stdout : process.stdout;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stdout.write(`${JSON.stringify({ ok: false, code: parsed.code, error: parsed.error })}\n`);
    return 1;
  }
  try {
    const result = runMigration({ command: parsed.command, root: parsed.root });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    stdout.write(`${JSON.stringify({
      ok: false,
      code: err.code || 'failed',
      error: err instanceof MigrationError ? err.message : 'The migration command failed.',
    })}\n`);
    return 1;
  }
}

module.exports = {
  ATTEMPT_NAME,
  COMMANDS,
  MigrationError,
  parseArgs,
  runCli,
  runMigration,
};
