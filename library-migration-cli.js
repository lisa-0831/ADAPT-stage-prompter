const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMigration } = require('./library-migration-plan');
const { stageMigration, verifyStaging } = require('./library-migration-staging');
const { createVersionStore } = require('./library-version-store');
const { parseImageReference } = require('./script-library-model');
const {
  detectImage,
  displayAssetName,
  hashText,
  isValidScriptId,
  titleFromScript,
} = require('./script-library');

// Fixture-only migration commands. Every root must be an explicit temporary
// directory. M6 does not migrate this repository, and it does not install the
// live-script mirror. M7 has to add a trusted production root before a real
// library can be committed. A committed fixture marker makes M3 refuse startup.

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
    return fail('unsafe-root', 'M6 cannot inspect or migrate this repository. A trusted production root arrives in M7.');
  }
  const tmpReal = fs.realpathSync(os.tmpdir());
  if (rootReal === tmpReal || !insideStrict(rootReal, tmpReal)) {
    return fail('unsafe-root', 'M6 only accepts an explicit temporary fixture. A trusted production root arrives in M7.');
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
    const title = entry && typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim().slice(0, 120)
      : (titleFromScript(text) || 'Untitled script');
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

function copyUnassigned(rootReal, inventory) {
  inventory.productions.forEach((production) => {
    production.assets.filter((asset) => !asset.referenced).forEach((asset) => {
      const dest = path.join(workDir(rootReal), 'productions', production.id, 'assets', `${asset.assetId}.${asset.ext}`);
      const existing = readNoFollow(dest);
      if (existing.bytes) {
        if (hashBuffer(existing.bytes) !== asset.contentHash) {
          throw new MigrationError('asset-conflict', 'An unassigned asset copy already has different bytes.');
        }
        return;
      }
      if (existing.unsafe) throw new MigrationError('unsafe-path', 'An unassigned asset path is not a regular file.');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const source = readNoFollow(asset.absolutePath);
      if (!source.bytes || hashBuffer(source.bytes) !== asset.contentHash) {
        throw new MigrationError('missing-asset', 'An unassigned asset changed before it could be copied.');
      }
      writeAtomic(dest, source.bytes);
    });
  });
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

function pointerFor(inventory, ids, plan) {
  const live = inventory.productions.find((production) => production.id === inventory.liveProductionId);
  const planned = ids[live.id];
  return {
    productionId: live.id,
    versionId: plan.pointer.versionId,
    previousVersionId: planned.v1,
    contentHash: plan.pointer.contentHash,
    origin: plan.pointer.origin,
    sourceScriptHash: inventory.liveScriptHash,
  };
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
  const staged = stageMigration({
    root: rootReal,
    plan,
    sources: sourceList(rootReal, inventory, plan),
    onStage(stage) {
      if ((stage === 'v1' || stage === 'v2' || stage === 'asset') && failAt === stage) {
        throw new MigrationError('injected-failure', `Injected failure at ${stage}.`);
      }
    },
  });
  if (!staged.ok) {
    return fail(staged.code, staged.errors[0].message, { command: 'prepare', ready: false });
  }
  copyUnassigned(rootReal, inventory);
  const verification = verifyStaging(rootReal);
  if (!verification.ready) {
    return fail(verification.code || 'not-ready', 'Staged files did not verify.', {
      command: 'prepare',
      ready: false,
    });
  }
  const summaries = checkVersions(rootReal, inventory, attempt.ids, workDir(rootReal));
  const pointer = pointerFor(inventory, attempt.ids, plan);
  if (pointer.versionId !== (attempt.ids[pointer.productionId].v2 || attempt.ids[pointer.productionId].v1)) {
    return fail('corrupt-staging', 'The planned live version does not match the saved head.', { command: 'prepare' });
  }
  attempt = attemptDocument({
    state: 'ready',
    migrationId: attempt.migrationId,
    createdAt: attempt.createdAt,
    fingerprint: attempt.fingerprint,
    ids: attempt.ids,
    pointer,
    planHash: staged.planHash,
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
      previousVersionId: pointer.previousVersionId,
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
    schema: 1,
    state: 'committed',
    migrationId: attempt.migrationId,
    productionId: attempt.pointer.productionId,
    versionId: attempt.pointer.versionId,
    previousVersionId: attempt.pointer.previousVersionId,
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

function mergeUnassignedManifests(destDir, inventory) {
  inventory.productions.forEach((production) => {
    const manifestFile = path.join(destDir, production.id, 'assets', 'manifest.json');
    const parsed = readJsonObject(manifestFile);
    if (!parsed.value || !Array.isArray(parsed.value.assets)) {
      throw new MigrationError('corrupt-staging', 'A published asset manifest could not be read.');
    }
    const present = new Set(parsed.value.assets.map((asset) => asset.assetId));
    production.assets.filter((asset) => !asset.referenced).forEach((asset) => {
      if (present.has(asset.assetId)) return;
      parsed.value.assets.push({
        assetId: asset.assetId,
        file: `${asset.assetId}.${asset.ext}`,
        originalName: asset.originalName,
        legacyPath: null,
        contentHash: asset.contentHash,
        ext: asset.ext,
        mime: asset.mime,
        byteLength: asset.byteLength,
        referenced: false,
      });
    });
    writeAtomic(manifestFile, stableBytes(parsed.value));
  });
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
  if (!attempt || !attempt.pointer || !attempt.planHash || !attempt.ids) {
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
  checkpoint(failAt, 'before-publish');
  const stagedProductions = path.join(workDir(rootReal), 'productions');
  const incoming = path.join(libraryDir(rootReal), INCOMING_NAME);
  const published = path.join(libraryDir(rootReal), 'productions');
  if (lstatIfExists(incoming)) removeOwnedDirectory(rootReal, incoming);
  copyProductionTree(stagedProductions, incoming);
  mergeUnassignedManifests(incoming, inventory);
  verifyIncoming(incoming, inventory, attempt);
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
    removeOwnedDirectory(rootReal, incoming);
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

function removeOwnedDirectory(rootReal, target) {
  const stat = lstatIfExists(target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new MigrationError('unsafe-path', 'Refusing to delete a symlink.');
  const real = fs.realpathSync(target);
  if (!insideStrict(real, rootReal)) throw new MigrationError('unsafe-path', 'Refusing to delete a path outside the fixture.');
  fs.rmSync(real, { recursive: true, force: false });
  return true;
}

function abort(rootReal) {
  if (lstatIfExists(markerPath(rootReal))) {
    return fail('abort-refused', 'A migration marker is present. Abort will not roll back a commit.', {
      command: 'abort',
      activated: false,
    });
  }
  const loaded = readAttempt(rootReal);
  if (loaded && loaded.ok === false) return loaded;
  const attempt = loaded && loaded.attempt;
  const removed = [];
  const incoming = path.join(libraryDir(rootReal), INCOMING_NAME);
  if (lstatIfExists(incoming)) {
    removeOwnedDirectory(rootReal, incoming);
    removed.push(`data/library/${INCOMING_NAME}`);
  }
  const published = path.join(libraryDir(rootReal), 'productions');
  const publishedStat = lstatIfExists(published);
  if (publishedStat) {
    if (publishedStat.isSymbolicLink() || !publishedStat.isDirectory()) {
      return fail('unsafe-path', 'The production tree is not a real directory.', { command: 'abort' });
    }
    const names = fs.readdirSync(published);
    const owned = attempt && attempt.ids ? attempt.ids : {};
    const foreign = names.filter((name) => !Object.prototype.hasOwnProperty.call(owned, name));
    if (foreign.length || !attempt) {
      return fail('unowned-tree', 'The production tree is not owned by this migration attempt and was left in place.', {
        command: 'abort',
      });
    }
    removeOwnedDirectory(rootReal, published);
    removed.push('data/library/productions');
  }
  const work = workDir(rootReal);
  if (lstatIfExists(work)) {
    removeOwnedDirectory(rootReal, work);
    removed.push('data/library/migration-work');
  }
  if (lstatIfExists(attemptPath(rootReal))) {
    const stat = lstatIfExists(attemptPath(rootReal));
    if (stat.isSymbolicLink()) throw new MigrationError('unsafe-path', 'The attempt file is a symlink.');
    fs.unlinkSync(attemptPath(rootReal));
    removed.push(`data/library/${ATTEMPT_NAME}`);
  }
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
  if (command === 'abort') return abort(auth.rootReal);
  const inventory = inspect(auth.rootReal, maxImageBytes);
  if (command === 'dry-run') {
    checkpoint(settings.failAt || '', 'inspect');
    return reportOf(inventory);
  }
  if (command === 'verify') return verify(auth.rootReal, inventory);
  if (command === 'prepare') return prepare(auth.rootReal, inventory, settings);
  if (command === 'commit') return commit(auth.rootReal, inventory, settings);
  return fail('invalid-command', 'Choose one of --dry-run, --prepare, --verify, --abort, or --commit.');
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
