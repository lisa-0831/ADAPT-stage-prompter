// Append-only production versions. This module is not used by the running server.
// M2 metadata is accepted as written: headVersionId, a versions array, and
// version.json without schema or createdAt. A later save adds schema,
// currentVersionId, updatedAt, and generation without rewriting old version
// files. A missing generation counts as 1, because staging already wrote the
// metadata once. This process serializes its own saves. It does not lock out
// another process.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validate } = require('./script-editor-model');
const { parseImageReference } = require('./script-library-model');
const { detectImage, hashText, isValidScriptId } = require('./script-library');

const SCHEMA = 1;
const REPO_ROOT = path.resolve(__dirname);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class VersionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VersionStoreError';
    this.code = code;
  }
}

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalId(value) {
  if (!isValidScriptId(value)) return null;
  return value.toLowerCase();
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, error: message }, extra || {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EEXIST') {
      throw new VersionStoreError('unsafe-path', 'A version file is a symlink.');
    }
    throw err;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertInside(rootReal, candidate) {
  const resolved = path.resolve(candidate);
  if (!contained(rootReal, resolved)) {
    throw new VersionStoreError('unsafe-path', 'A version path escapes the store.');
  }
  return resolved;
}

function createVersionStore(options) {
  return openVersionStore(options, false);
}

function openReadOnlyVersionStore(options) {
  return openVersionStore(options, true);
}

function openVersionStore(options, readOnly) {
  const settings = options || {};
  if (!settings.root || typeof settings.root !== 'string') {
    throw new VersionStoreError('unsafe-path', 'A version store needs an explicit root directory.');
  }
  const rootStat = lstatIfExists(settings.root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new VersionStoreError('unsafe-path', 'The version store root must be a real directory.');
  }
  const rootReal = fs.realpathSync(settings.root);
  const repoReal = fs.realpathSync(REPO_ROOT);
  if (!readOnly && contained(repoReal, rootReal)) {
    throw new VersionStoreError('unsafe-path', 'The version store root must be outside this repository.');
  }
  const failAt = settings.failAt || '';
  let queue = Promise.resolve();

  function checkpoint(name) {
    if (failAt === name) {
      throw new VersionStoreError('injected-failure', `Injected failure at ${name}.`);
    }
  }

  function productionDir(productionId) {
    return assertInside(rootReal, path.join(rootReal, 'productions', productionId));
  }

  function exclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function readJson(filePath) {
    const stat = lstatIfExists(filePath);
    if (!stat) return { missing: true };
    if (stat.isSymbolicLink() || !stat.isFile()) return { unsafe: true };
    let bytes;
    try {
      bytes = readNoFollow(filePath);
    } catch (err) {
      if (err instanceof VersionStoreError) return { unsafe: true };
      throw err;
    }
    try {
      return { value: JSON.parse(bytes.toString('utf8')), bytes };
    } catch (err) {
      return { invalid: true, bytes };
    }
  }

  function loadMetadata(productionId) {
    const id = canonicalId(productionId);
    if (!id) return fail('invalid-id', 'That production id is not valid.');
    const dir = productionDir(id);
    const stat = lstatIfExists(dir);
    if (!stat) return fail('missing-production', 'That production could not be found.');
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe-path', 'That production path is not a real directory.');
    }
    const parsed = readJson(path.join(dir, 'metadata.json'));
    if (parsed.missing || parsed.invalid) {
      return fail('corrupt-metadata', 'The production metadata could not be read.');
    }
    if (parsed.unsafe) return fail('unsafe-path', 'The production metadata is not a regular file.');
    const metadata = parsed.value;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return fail('corrupt-metadata', 'The production metadata could not be read.');
    }
    if (metadata.schema != null && metadata.schema !== SCHEMA) {
      return fail('unsupported-schema', 'The production metadata uses a schema this store does not recognize.');
    }
    if (metadata.id !== id) return fail('corrupt-metadata', 'The production metadata names a different production.');
    if (!Array.isArray(metadata.versions) || !metadata.versions.length) {
      return fail('corrupt-metadata', 'The production metadata has no versions.');
    }
    const headId = canonicalId(metadata.currentVersionId || metadata.headVersionId);
    if (!headId) return fail('corrupt-metadata', 'The production metadata has no saved head.');
    const listed = metadata.versions.some((entry) => entry && canonicalId(entry.id) === headId);
    if (!listed) return fail('corrupt-metadata', 'The saved head is not one of the recorded versions.');
    return { ok: true, id, dir, metadata, headId, metadataBytes: parsed.bytes };
  }

  function versionDir(prodDir, versionId) {
    return assertInside(rootReal, path.join(prodDir, 'versions', versionId));
  }

  function loadVersion(prodDir, productionId, versionId) {
    const id = canonicalId(versionId);
    if (!id) return fail('invalid-id', 'That version id is not valid.');
    const dir = versionDir(prodDir, id);
    const stat = lstatIfExists(dir);
    if (!stat) return fail('missing-parent', 'That version could not be found.');
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe-path', 'That version path is not a real directory.');
    }
    const scriptPath = path.join(dir, 'script.txt');
    const metaPath = path.join(dir, 'version.json');
    const scriptStat = lstatIfExists(scriptPath);
    const metaParsed = readJson(metaPath);
    if ((scriptStat && scriptStat.isSymbolicLink()) || metaParsed.unsafe) {
      return fail('unsafe-path', 'That version file is a symlink.');
    }
    if (!scriptStat || !scriptStat.isFile() || metaParsed.missing || metaParsed.invalid) {
      return fail('corrupt-version', 'That version could not be read.', { dir, id });
    }
    let scriptBytes;
    try {
      scriptBytes = readNoFollow(scriptPath);
    } catch (err) {
      if (err instanceof VersionStoreError) return fail('unsafe-path', 'That version file is a symlink.');
      throw err;
    }
    const doc = metaParsed.value;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return fail('corrupt-version', 'That version could not be read.', { dir, id });
    }
    if (doc.schema != null && doc.schema !== SCHEMA) {
      return fail('unsupported-schema', 'That version uses a schema this store does not recognize.');
    }
    if (canonicalId(doc.id) !== id || canonicalId(doc.productionId) !== productionId) {
      return fail('corrupt-version', 'That version names a different production or version.', { dir, id });
    }
    const hash = hashBuffer(scriptBytes);
    if (doc.contentHash !== hash || doc.contentHash !== hashText(scriptBytes.toString('utf8'))) {
      return fail('corrupt-version', 'That version does not match its script bytes.', { dir, id });
    }
    return {
      ok: true,
      id,
      dir,
      doc,
      scriptBytes,
      text: scriptBytes.toString('utf8'),
      metaBytes: metaParsed.bytes,
    };
  }

  function publicVersion(loaded) {
    const doc = loaded.doc;
    return {
      schema: doc.schema == null ? null : doc.schema,
      id: loaded.id,
      productionId: doc.productionId,
      createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : null,
      parentVersionId: doc.parentVersionId == null ? null : doc.parentVersionId,
      origin: doc.origin || null,
      legacyImagePolicy: doc.legacyImagePolicy || doc.imagePolicy || null,
      contentHash: doc.contentHash,
      assetIds: Array.isArray(doc.assetIds) ? doc.assetIds.slice() : [],
      role: doc.role || null,
    };
  }

  function generationOf(metadata) {
    return Number.isInteger(metadata.generation) && metadata.generation >= 0
      ? metadata.generation
      : 1;
  }

  function readProduction(productionId) {
    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      production: {
        id: loaded.id,
        schema: loaded.metadata.schema == null ? null : loaded.metadata.schema,
        title: typeof loaded.metadata.title === 'string' ? loaded.metadata.title : null,
        createdAt: loaded.metadata.createdAt || null,
        updatedAt: loaded.metadata.updatedAt || null,
        currentVersionId: loaded.headId,
        headVersionId: loaded.headId,
        generation: generationOf(loaded.metadata),
        versions: loaded.metadata.versions.map((entry) => clone(entry)),
      },
    };
  }

  function readVersion(productionId, versionId) {
    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    const version = loadVersion(loaded.dir, loaded.id, versionId);
    if (!version.ok) return version;
    return { ok: true, version: publicVersion(version), text: version.text };
  }

  function readHead(productionId) {
    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    return readVersion(loaded.id, loaded.headId);
  }

  function listVersions(productionId) {
    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    const versions = [];
    for (let index = 0; index < loaded.metadata.versions.length; index += 1) {
      const entry = loaded.metadata.versions[index];
      const versionId = entry && canonicalId(entry.id);
      if (!versionId) return fail('corrupt-metadata', 'A recorded version id is not valid.');
      const version = loadVersion(loaded.dir, loaded.id, versionId);
      if (!version.ok) return version;
      versions.push({
        id: version.id,
        parentVersionId: version.doc.parentVersionId == null ? null : version.doc.parentVersionId,
        origin: version.doc.origin || null,
        role: version.doc.role || null,
        contentHash: version.doc.contentHash,
        createdAt: typeof version.doc.createdAt === 'string' ? version.doc.createdAt : null,
        legacyImagePolicy: version.doc.legacyImagePolicy || version.doc.imagePolicy || null,
        current: version.id === loaded.headId,
      });
    }
    return { ok: true, currentVersionId: loaded.headId, versions };
  }

  function listOrphans(productionId) {
    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    const versionsDir = path.join(loaded.dir, 'versions');
    const stat = lstatIfExists(versionsDir);
    if (!stat) return { ok: true, orphans: [] };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe-path', 'The versions directory is not a real directory.');
    }
    const recorded = new Set(loaded.metadata.versions.map((entry) => canonicalId(entry && entry.id)).filter(Boolean));
    recorded.add(loaded.headId);
    const names = fs.readdirSync(versionsDir);
    const orphans = [];
    names.forEach((name) => {
      if (!UUID.test(name) || recorded.has(name)) return;
      const dir = path.join(versionsDir, name);
      const dirStat = lstatIfExists(dir);
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
      const version = loadVersion(loaded.dir, loaded.id, name);
      orphans.push({
        id: name,
        complete: Boolean(version.ok),
        current: false,
      });
    });
    return { ok: true, orphans };
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

  function loadManifest(prodDir, productionId) {
    const manifestPath = path.join(prodDir, 'assets', 'manifest.json');
    const parsed = readJson(manifestPath);
    if (parsed.missing) return { ok: true, assets: [] };
    if (parsed.unsafe) return fail('unsafe-path', 'The asset manifest is not a regular file.');
    if (parsed.invalid || !parsed.value || !Array.isArray(parsed.value.assets)) {
      return fail('corrupt-asset', 'The asset manifest could not be read.');
    }
    if (parsed.value.productionId && canonicalId(parsed.value.productionId) !== productionId) {
      return fail('corrupt-asset', 'The asset manifest names a different production.');
    }
    return { ok: true, assets: parsed.value.assets };
  }

  function verifyAsset(prodDir, productionId, assetId, assets) {
    const entry = assets.find((asset) => canonicalId(asset && (asset.assetId || asset.id)) === assetId);
    if (!entry) return fail('missing-asset', 'That image is not part of this production.');
    const ext = entry.ext;
    const fileName = typeof entry.file === 'string' && entry.file
      ? entry.file
      : `${assetId}.${ext}`;
    if (fileName !== path.basename(fileName) || fileName.includes('..')) {
      return fail('corrupt-asset', 'That image path is not valid.');
    }
    const assetsDir = path.join(prodDir, 'assets');
    const filePath = assertInside(rootReal, path.join(assetsDir, fileName));
    if (!contained(assetsDir, filePath)) return fail('corrupt-asset', 'That image path is not valid.');
    const stat = lstatIfExists(filePath);
    if (stat && stat.isSymbolicLink()) return fail('unsafe-path', 'That image file is a symlink.');
    if (!stat || !stat.isFile()) {
      return fail('missing-asset', 'That image is not part of this production.');
    }
    let bytes;
    try {
      bytes = readNoFollow(filePath);
    } catch (err) {
      if (err instanceof VersionStoreError) return fail('unsafe-path', 'That image file is a symlink.');
      throw err;
    }
    const detected = detectImage(bytes);
    if (!detected || detected.incomplete || !detected.ext) {
      return fail('corrupt-asset', 'That image file is not a complete JPEG, PNG, or WebP file.');
    }
    if (ext && detected.ext !== ext) return fail('corrupt-asset', 'That image file does not match its manifest.');
    const digest = hashBuffer(bytes);
    const expected = entry.contentHash || entry.sha256;
    if (expected && expected !== digest) return fail('corrupt-asset', 'That image file does not match its manifest.');
    if (Number.isInteger(entry.byteLength) && entry.byteLength !== bytes.length) {
      return fail('corrupt-asset', 'That image file does not match its manifest.');
    }
    return {
      ok: true,
      assetId,
      productionId,
      ext: detected.ext,
      byteLength: bytes.length,
      contentHash: digest,
    };
  }

  function describeImages(productionId, text) {
    const id = canonicalId(productionId);
    if (!id) return fail('invalid-id', 'That production id is not valid.');
    const loaded = loadMetadata(id);
    if (!loaded.ok) return loaded;
    const manifest = loadManifest(loaded.dir, id);
    if (!manifest.ok) return manifest;
    const assets = [];
    const legacyImages = [];
    const directives = imageDirectives(text);
    for (let index = 0; index < directives.length; index += 1) {
      const parsed = directives[index];
      if (parsed.kind === 'empty') continue;
      if (parsed.kind === 'legacy') {
        legacyImages.push({
          path: parsed.path,
          shared: true,
          immutable: false,
        });
        continue;
      }
      if (parsed.kind !== 'library') {
        return fail('invalid-image-reference', 'An image line is not a supported reference.');
      }
      if (parsed.scriptId !== id) {
        return fail('foreign-asset', 'An image belongs to a different production.');
      }
      const verified = verifyAsset(loaded.dir, id, parsed.assetId, manifest.assets);
      if (!verified.ok) return verified;
      if (!assets.some((asset) => asset.assetId === verified.assetId)) assets.push(verified);
    }
    let legacyImagePolicy = 'none';
    if (legacyImages.length) legacyImagePolicy = 'shared-images';
    else if (assets.length) legacyImagePolicy = 'production-assets';
    return { ok: true, assets, legacyImages, legacyImagePolicy };
  }

  function referencesFor(text, prodDir, productionId) {
    const directives = imageDirectives(text);
    const assetIds = [];
    if (!directives.length) return { ok: true, assetIds, legacyImagePolicy: 'none' };
    const manifest = loadManifest(prodDir, productionId);
    if (!manifest.ok) return manifest;
    for (let index = 0; index < directives.length; index += 1) {
      const parsed = directives[index];
      if (parsed.kind === 'legacy') {
        return fail('legacy-image', 'A new version cannot keep a shared images/ reference.');
      }
      if (parsed.kind !== 'library') {
        return fail('invalid-image-reference', 'An image line is not a production asset reference.');
      }
      if (parsed.scriptId !== productionId) {
        return fail('foreign-asset', 'An image belongs to a different production.');
      }
      const verified = verifyAsset(prodDir, productionId, parsed.assetId, manifest.assets);
      if (!verified.ok) return verified;
      if (assetIds.indexOf(parsed.assetId) === -1) assetIds.push(parsed.assetId);
    }
    return { ok: true, assetIds, legacyImagePolicy: 'production-assets' };
  }

  function commitNewFile(filePath, bytes) {
    const tmp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    assertInside(rootReal, tmp);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx');
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* The temp file may already be gone. */ }
      throw err;
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* The temp file may already be gone. */ }
      throw err;
    }
  }

  function versionDocument(productionId, versionId, parentVersionId, createdAt, contentHash, assetIds, legacyImagePolicy) {
    return {
      schema: SCHEMA,
      id: versionId,
      productionId,
      role: 'edited',
      createdAt,
      parentVersionId,
      origin: 'edited',
      legacyImagePolicy,
      contentHash,
      assetIds,
    };
  }

  function sameDocument(existing, expected) {
    return existing
      && existing.schema === expected.schema
      && existing.id === expected.id
      && existing.productionId === expected.productionId
      && existing.role === expected.role
      && existing.createdAt === expected.createdAt
      && existing.parentVersionId === expected.parentVersionId
      && existing.origin === expected.origin
      && existing.legacyImagePolicy === expected.legacyImagePolicy
      && existing.contentHash === expected.contentHash
      && Array.isArray(existing.assetIds)
      && existing.assetIds.length === expected.assetIds.length
      && existing.assetIds.every((id, index) => id === expected.assetIds[index]);
  }

  function nextMetadata(metadata, summary, createdAt) {
    return Object.assign({}, metadata, {
      schema: SCHEMA,
      currentVersionId: summary.id,
      headVersionId: summary.id,
      generation: generationOf(metadata) + 1,
      updatedAt: createdAt,
      versions: metadata.versions.concat([summary]),
    });
  }

  function replaceMetadata(prodDir, document) {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const target = path.join(prodDir, 'metadata.json');
    checkpoint('metadata-rename');
    commitNewFile(target, bytes);
    checkpoint('after-metadata');
    fsyncDirectory(prodDir);
    return bytes;
  }

  function rereadHead(productionId, versionId) {
    try {
      const loaded = loadMetadata(productionId);
      if (!loaded.ok) {
        return fail('unconfirmed-head', 'The saved head could not be read after the metadata update.');
      }
      if (loaded.headId === versionId) {
        const version = loadVersion(loaded.dir, loaded.id, versionId);
        if (!version.ok) {
          return fail('unconfirmed-head', 'The saved head could not be read after the metadata update.');
        }
        return {
          ok: true,
          unchanged: false,
          syncWarning: true,
          currentVersionId: versionId,
          generation: generationOf(loaded.metadata),
          version: publicVersion(version),
        };
      }
      return fail('unconfirmed-head', 'The saved head could not be confirmed after the metadata update.', {
        currentVersionId: loaded.headId,
      });
    } catch (err) {
      return fail('unconfirmed-head', 'The saved head could not be read after the metadata update.');
    }
  }

  function saveVersionLocked(input) {
    const body = input || {};
    const productionId = canonicalId(body.productionId);
    const expectedVersionId = canonicalId(body.expectedVersionId);
    const newVersionId = canonicalId(body.newVersionId);
    if (!productionId || !expectedVersionId || !newVersionId) {
      return fail('invalid-id', 'The production and version ids are not valid.');
    }
    if (newVersionId === expectedVersionId) {
      return fail('invalid-id', 'A new version needs its own id.');
    }
    if (typeof body.createdAt !== 'string' || Number.isNaN(Date.parse(body.createdAt))) {
      return fail('invalid-script', 'A version needs a creation time.');
    }
    if (typeof body.text !== 'string') return fail('invalid-script', 'The script text is not valid.');

    const loaded = loadMetadata(productionId);
    if (!loaded.ok) return loaded;
    const head = loadVersion(loaded.dir, loaded.id, loaded.headId);
    if (!head.ok) return head;
    const textBytes = Buffer.from(body.text, 'utf8');
    if (textBytes.equals(head.scriptBytes)) {
      return {
        ok: true,
        unchanged: true,
        currentVersionId: loaded.headId,
        generation: generationOf(loaded.metadata),
        version: publicVersion(head),
      };
    }
    if (expectedVersionId !== loaded.headId) {
      return fail('conflict', 'The production changed after this version was opened.', {
        currentVersionId: loaded.headId,
        generation: generationOf(loaded.metadata),
      });
    }
    const checked = validate(body.text);
    if (!checked.ok) {
      const message = checked.errors[0] && checked.errors[0].message
        ? checked.errors[0].message
        : 'This script could not be saved.';
      return fail('invalid-script', message);
    }
    const references = referencesFor(body.text, loaded.dir, loaded.id);
    if (!references.ok) return references;
    const contentHash = hashBuffer(textBytes);
    const document = versionDocument(
      loaded.id,
      newVersionId,
      loaded.headId,
      body.createdAt,
      contentHash,
      references.assetIds,
      references.legacyImagePolicy,
    );

    const again = loadMetadata(productionId);
    if (!again.ok) return again;
    if (again.headId !== expectedVersionId) {
      return fail('conflict', 'The production changed after this version was opened.', {
        currentVersionId: again.headId,
        generation: generationOf(again.metadata),
      });
    }

    const targetDir = versionDir(again.dir, newVersionId);
    const existing = lstatIfExists(targetDir);
    let alreadyWritten = false;
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        return fail('version-exists', 'That version id already exists and was not overwritten.');
      }
      const prior = loadVersion(again.dir, again.id, newVersionId);
      if (!prior.ok || !prior.scriptBytes.equals(textBytes) || !sameDocument(prior.doc, document)) {
        return fail('version-exists', 'That version id already exists and was not overwritten.');
      }
      alreadyWritten = true;
    }

    try {
      if (!alreadyWritten) {
        fs.mkdirSync(targetDir, { recursive: true });
        commitNewFile(path.join(targetDir, 'script.txt'), textBytes);
        checkpoint('version-script');
        commitNewFile(
          path.join(targetDir, 'version.json'),
          Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
        );
        checkpoint('version-json');
        fsyncDirectory(targetDir);
        const verified = loadVersion(again.dir, again.id, newVersionId);
        if (!verified.ok || !verified.scriptBytes.equals(textBytes) || verified.doc.contentHash !== contentHash) {
          return fail('corrupt-version', 'The new version did not match the bytes just written.', {
            currentVersionId: again.headId,
          });
        }
      }
      checkpoint('before-metadata');
      const summary = {
        id: newVersionId,
        role: 'edited',
        origin: 'edited',
        parentVersionId: again.headId,
        contentHash,
        createdAt: body.createdAt,
      };
      const metadata = nextMetadata(again.metadata, summary, body.createdAt);
      replaceMetadata(again.dir, metadata);
      const committed = loadMetadata(productionId);
      if (!committed.ok || committed.headId !== newVersionId) {
        return fail('unconfirmed-head', 'The saved head could not be confirmed after the metadata update.');
      }
      const saved = loadVersion(committed.dir, committed.id, newVersionId);
      if (!saved.ok) {
        return fail('unconfirmed-head', 'The saved head could not be confirmed after the metadata update.');
      }
      return {
        ok: true,
        unchanged: false,
        currentVersionId: newVersionId,
        generation: generationOf(committed.metadata),
        version: publicVersion(saved),
      };
    } catch (err) {
      if (err instanceof VersionStoreError && err.code === 'injected-failure' && failAt === 'after-metadata') {
        return rereadHead(productionId, newVersionId);
      }
      if (err instanceof VersionStoreError && err.code === 'injected-failure') {
        const current = loadMetadata(productionId);
        return fail('incomplete', 'The new version was not saved as the head.', {
          currentVersionId: current.ok ? current.headId : null,
        });
      }
      throw err;
    }
  }

  function saveVersion(input) {
    return exclusive(() => saveVersionLocked(input));
  }

  const api = {
    root: rootReal,
    readOnly: Boolean(readOnly),
    readProduction,
    readVersion,
    readHead,
    listVersions,
    listOrphans,
    describeImages,
  };
  if (!readOnly) api.saveVersion = saveVersion;
  return api;
}

module.exports = {
  SCHEMA,
  VersionStoreError,
  createVersionStore,
  openReadOnlyVersionStore,
};
