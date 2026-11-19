'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { detectStorageMode } = require('../server/storage-mode');
const { authorizeVersionedPersistentRoot } = require('../server/persistent-authorization');

// Installs the Versioned Library that already lives in this checkout.
// The checkout has productions and a seed catalog. It does not have a
// migration marker, so it stays a Legacy checkout for the old server.
// The first start copies the catalog into an empty directory outside Git,
// writes the marker there, and writes a local authorization file.
// A later start reuses that directory. This file does not migrate Legacy
// text and it does not delete a directory that already has files.

const WELCOME_ID = '2d0f0937-fc36-4d27-a31e-d047c2fd5623';
const IMAGE_HASHES = {
  'images/Title_Card.jpeg': 'da924c3aaf284c9e5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e',
  'images/Cap_Back2.jpeg': 'ecf446be1bdc76be16dea4c24ba5188fa42c360c626927d247175820818bec1b',
  'images/Cap_Back3.jpeg': '11a6309fd758a094d8e5b4c82af9001163d8253ab2b173b5cad907068a8a41f5',
  'images/Cap_Back4.jpeg': '6d786f25b3ee1e49f5cb8a40625f4c152e58e416645059eef5578a4b21419410',
};
const CHECKOUT_RUNTIME = [
  'data/library/migration.json',
  'data/library/migration-attempt.json',
  'data/library/live-state.json',
  'data/library/.writer.lock',
  'data/library/migration-work',
  'data/live-journal',
];

function fail(code, error) {
  return { ok: false, code, error };
}

function lstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function hashFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\')) return false;
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  return true;
}

function directoryState(dir) {
  const stat = lstat(dir);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isDirectory()) return 'file';
  return fs.readdirSync(dir).length ? 'filled' : 'empty';
}

function ensureDirectory(dir) {
  const state = directoryState(dir);
  if (state === 'symlink' || state === 'file') return fail('unsafe-path', `${dir} is not a real directory.`);
  if (state === 'missing') fs.mkdirSync(dir, { recursive: true });
  return { ok: true };
}

function listFiles(dir, prefix) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return fail('seed-invalid', 'The Versioned seed could not be read.');
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return fail('seed-invalid', `${relative} is a symlink.`);
    if (entry.isDirectory()) {
      const nested = listFiles(path.join(dir, entry.name), relative);
      if (!nested.ok) return nested;
      files.push(...nested.files);
      continue;
    }
    if (!entry.isFile()) return fail('seed-invalid', `${relative} is not a regular file.`);
    files.push(relative);
  }
  return { ok: true, files };
}

function sameIdentity(marker, live) {
  return marker
    && marker.schema === 2
    && marker.state === 'committed'
    && marker.migrationId === live.migrationId
    && marker.productionId === live.productionId
    && marker.versionId === live.versionId
    && marker.contentHash === live.contentHash
    && marker.sourceScriptHash === live.sourceScriptHash
    && marker.previousActivation === null
    && (marker.mirrorInstalled === false || marker.mirrorInstalled === true);
}

function verifyProduction(repoRoot, production, imageHashes) {
  const base = path.join(repoRoot, 'data', 'library', 'productions', production.id);
  let metadata;
  try {
    metadata = readJson(path.join(base, 'metadata.json'));
  } catch (err) {
    return fail('seed-invalid', `Production ${production.id} has no readable metadata.`);
  }
  if (metadata.id !== production.id || metadata.title !== production.title) {
    return fail('seed-invalid', `Production ${production.id} does not match the seed catalog.`);
  }
  if (metadata.headVersionId !== production.headVersionId) {
    return fail('seed-invalid', `Production ${production.id} has a different current version.`);
  }
  if (!metadata.historicalPreview || metadata.historicalPreview.usesAssetSnapshots !== false) {
    return fail('seed-invalid', `Production ${production.id} does not keep the shared-image history rule.`);
  }
  if (!Array.isArray(metadata.versions) || metadata.versions.length !== 2) {
    return fail('seed-invalid', `Production ${production.id} does not have its two saved versions.`);
  }
  const original = metadata.versions.find((entry) => entry.origin === 'original' && entry.parentVersionId === null);
  if (!original) return fail('seed-invalid', `Production ${production.id} has no original version.`);
  for (let index = 0; index < metadata.versions.length; index += 1) {
    const entry = metadata.versions[index];
    const versionPath = path.join(base, 'versions', entry.id, 'version.json');
    const scriptPath = path.join(base, 'versions', entry.id, 'script.txt');
    const version = readJson(versionPath);
    if (version.id !== entry.id || version.productionId !== production.id) {
      return fail('seed-invalid', `Production ${production.id} has a version that does not belong to it.`);
    }
    if (version.parentVersionId !== entry.parentVersionId || version.contentHash !== entry.contentHash) {
      return fail('seed-invalid', `Production ${production.id} has a broken version relationship.`);
    }
    if (hashFile(scriptPath) !== version.contentHash) {
      return fail('seed-invalid', `Production ${production.id} has version text that does not match its hash.`);
    }
    if (entry.origin === 'migrated' && entry.parentVersionId !== original.id) {
      return fail('seed-invalid', `Production ${production.id} has a version whose parent is not the original.`);
    }
    if (entry.origin === 'original' && version.legacyImagePolicy !== 'shared-images') {
      return fail('seed-invalid', `Production ${production.id} original version does not use shared images.`);
    }
    if (entry.origin === 'migrated' && version.legacyImagePolicy !== 'production-assets') {
      return fail('seed-invalid', `Production ${production.id} current version does not use its own images.`);
    }
    const assetIds = Array.isArray(version.assetIds) ? version.assetIds : [];
    for (let assetIndex = 0; assetIndex < assetIds.length; assetIndex += 1) {
      const assetId = assetIds[assetIndex];
      const assetName = fs.readdirSync(path.join(base, 'assets')).find((name) => name.startsWith(`${assetId}.`));
      if (!assetName) return fail('seed-invalid', `Production ${production.id} is missing an owned image.`);
      if (!imageHashes.includes(hashFile(path.join(base, 'assets', assetName)))) {
        return fail('seed-invalid', `Production ${production.id} contains an image that is not part of the seed.`);
      }
    }
  }
  return { ok: true, metadata };
}

function verifyVersionedSeed(repoRoot) {
  const root = path.resolve(repoRoot);
  const seedPath = path.join(root, 'data', 'library', 'seed.json');
  const seedStat = lstat(seedPath);
  if (!seedStat || !seedStat.isFile() || seedStat.isSymbolicLink()) {
    return fail('seed-missing', 'This checkout has no Versioned Library seed.');
  }
  let seed;
  try {
    seed = readJson(seedPath);
  } catch (err) {
    return fail('seed-invalid', 'data/library/seed.json is not valid JSON.');
  }
  const keys = Object.keys(seed).sort();
  if (seed.schema !== 1 || seed.kind !== 'adapt-versioned-seed' || keys.join(',') !== 'checkoutFiles,files,kind,live,productions,schema') {
    return fail('seed-invalid', 'data/library/seed.json is not a Versioned Library catalog.');
  }
  if (!Array.isArray(seed.productions) || seed.productions.length !== 1) {
    return fail('seed-invalid', 'The Versioned seed must contain WELCOME.');
  }
  const welcome = seed.productions.find((entry) => entry.id === WELCOME_ID);
  if (!welcome || welcome.title !== 'WELCOME TO ADAPT COMMUNITY NETWORK’S') {
    return fail('seed-invalid', 'The Versioned seed must contain WELCOME.');
  }
  if (!seed.live || seed.live.productionId !== WELCOME_ID || seed.live.versionId !== welcome.headVersionId) {
    return fail('seed-invalid', 'WELCOME is not the initial live production in the seed catalog.');
  }
  if (seed.live.state !== 'committed' || seed.live.schema !== 2) {
    return fail('seed-invalid', 'The seed catalog does not name a committed Versioned Library.');
  }
  for (let index = 0; index < CHECKOUT_RUNTIME.length; index += 1) {
    if (lstat(path.join(root, ...CHECKOUT_RUNTIME[index].split('/')))) {
      return fail('seed-runtime', 'The checkout contains runtime files. They were not copied.');
    }
  }
  const listed = listFiles(path.join(root, 'data', 'library', 'productions'), 'productions');
  if (!listed.ok) return listed;
  const expected = Object.keys(seed.files).sort();
  if (listed.files.join('\n') !== expected.join('\n')) {
    return fail('seed-invalid', 'The production files do not match the seed catalog.');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const relative = expected[index];
    if (!safeRelative(relative) || !relative.startsWith('productions/')) {
      return fail('seed-invalid', 'The seed catalog names a file outside the productions directory.');
    }
    const full = path.join(root, 'data', 'library', ...relative.split('/'));
    if (hashFile(full) !== seed.files[relative]) {
      return fail('seed-invalid', `${relative} does not match the seed catalog.`);
    }
  }
  const checkoutNames = Object.keys(seed.checkoutFiles).sort();
  const requiredCheckout = [
    'script.txt',
    'script.previous.txt',
    'script.previous.txt.meta.json',
    'images/Title_Card.jpeg',
    'images/Cap_Back2.jpeg',
    'images/Cap_Back3.jpeg',
    'images/Cap_Back4.jpeg',
  ].sort();
  if (checkoutNames.join('\n') !== requiredCheckout.join('\n')) {
    return fail('seed-invalid', 'The seed catalog does not name the shared script and image files.');
  }
  for (let index = 0; index < checkoutNames.length; index += 1) {
    const relative = checkoutNames[index];
    if (!safeRelative(relative) || hashFile(path.join(root, ...relative.split('/'))) !== seed.checkoutFiles[relative]) {
      return fail('seed-invalid', `${relative} does not match the seed catalog.`);
    }
  }
  if (seed.checkoutFiles['script.txt'] !== seed.live.sourceScriptHash) {
    return fail('seed-invalid', 'script.txt does not match the seed live source.');
  }
  const imageNames = Object.keys(IMAGE_HASHES);
  for (let index = 0; index < imageNames.length; index += 1) {
    if (seed.checkoutFiles[imageNames[index]] !== IMAGE_HASHES[imageNames[index]]) {
      return fail('seed-invalid', `${imageNames[index]} is not the picture that belongs in this seed.`);
    }
  }
  const imageHashes = Object.values(IMAGE_HASHES);
  for (let index = 0; index < seed.productions.length; index += 1) {
    const checked = verifyProduction(root, seed.productions[index], imageHashes);
    if (!checked.ok) return checked;
  }
  const liveScript = path.join(
    root,
    'data',
    'library',
    'productions',
    WELCOME_ID,
    'versions',
    seed.live.versionId,
    'script.txt',
  );
  if (hashFile(liveScript) !== seed.live.contentHash) {
    return fail('seed-invalid', 'The WELCOME live version does not match the seed catalog.');
  }
  return { ok: true, seed };
}

function readMarker(libraryDir) {
  const markerPath = path.join(libraryDir, 'migration.json');
  const stat = lstat(markerPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return fail('installation-invalid', 'migration.json is not a regular file. It was not replaced.');
  }
  try {
    return readJson(markerPath);
  } catch (err) {
    return fail('installation-invalid', 'migration.json could not be read. It was not replaced.');
  }
}

function copyRelative(fromRoot, toRoot, relative) {
  const from = path.join(fromRoot, ...relative.split('/'));
  const to = path.join(toRoot, ...relative.split('/'));
  const made = ensureDirectory(path.dirname(to));
  if (!made.ok) return made;
  const input = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output;
  try {
    const bytes = fs.readFileSync(input);
    output = fs.openSync(to, 'wx');
    fs.writeSync(output, bytes);
    fs.fsyncSync(output);
  } catch (err) {
    return fail('copy-failed', `Could not copy ${relative}. Existing files were not deleted.`);
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
  if (hashFile(to) !== hashFile(from)) {
    return fail('manifest-mismatch', `${relative} changed while it was being copied. Existing files were not deleted.`);
  }
  return { ok: true };
}

function writePrivateJson(filePath, value) {
  if (lstat(filePath)) return fail('config-exists', `Refusing to overwrite ${filePath}.`);
  const made = ensureDirectory(path.dirname(filePath));
  if (!made.ok) return made;
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
  return { ok: true };
}

function runtimeDocument(paths, live) {
  return {
    schema: 1,
    purpose: 'adapt-persistent-runtime',
    root: paths.dataRoot,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    journalDir: paths.journalDir,
    installation: {
      schema: 2,
      state: 'committed',
      migrationId: live.migrationId,
      productionId: live.productionId,
      versionId: live.versionId,
      contentHash: live.contentHash,
    },
  };
}

function markerDocument(live) {
  return {
    schema: 2,
    state: 'committed',
    migrationId: live.migrationId,
    productionId: live.productionId,
    versionId: live.versionId,
    previousActivation: null,
    sourceScriptHash: live.sourceScriptHash,
    contentHash: live.contentHash,
    mirrorInstalled: false,
  };
}

function authorizeInstalled(paths) {
  try {
    const token = authorizeVersionedPersistentRoot({ configPath: paths.runtimeConfigPath });
    if (token.root !== paths.dataRoot) {
      return fail(
        'config-conflict',
        `The runtime authorization already points at ${token.root}. The installed library was not replaced.`,
      );
    }
    return {
      ok: true,
      installed: true,
      alreadyInstalled: true,
      seeded: false,
      dataRoot: paths.dataRoot,
      configPath: paths.runtimeConfigPath,
      migrationId: token.installation.migrationId,
      productionId: token.installation.productionId,
      versionId: token.installation.versionId,
    };
  } catch (err) {
    return fail(
      err && err.code ? err.code : 'config-invalid',
      'The runtime authorization does not match the installed library. Nothing was replaced.',
    );
  }
}

function writeAuthorization(paths, live, alreadyInstalled) {
  const written = writePrivateJson(paths.runtimeConfigPath, runtimeDocument(paths, live));
  if (!written.ok) return written;
  const authorized = authorizeInstalled(paths);
  if (!authorized.ok) return authorized;
  return Object.assign({}, authorized, { alreadyInstalled, seeded: !alreadyInstalled });
}

function ensureVersionedInstall(paths) {
  const verified = verifyVersionedSeed(paths.repoRoot);
  if (!verified.ok) return verified;
  const live = verified.seed.live;
  if (lstat(paths.runtimeConfigPath)) return authorizeInstalled(paths);

  const marker = readMarker(paths.libraryDir);
  if (marker && marker.ok === false) return marker;
  if (marker) {
    if (!sameIdentity(marker, live)) {
      return fail(
        'installation-conflict',
        `The data directory already has a different Versioned Library: ${paths.dataRoot}. It was not replaced.`,
      );
    }
    return writeAuthorization(paths, live, true);
  }

  const dataState = directoryState(paths.dataRoot);
  if (dataState === 'symlink' || dataState === 'file') {
    return fail('unsafe-path', 'The data directory is not a real directory. Nothing was deleted.');
  }
  if (dataState === 'filled') {
    return fail(
      'destination-not-empty',
      `The data directory already has files and is not this Versioned seed: ${paths.dataRoot}. Nothing was deleted.`,
    );
  }
  if (lstat(paths.migrationConfigPath)) {
    return fail('config-exists', 'A migration authorization file is already present. Nothing was copied.');
  }

  const dataDir = ensureDirectory(paths.dataRoot);
  if (!dataDir.ok) return dataDir;
  const configDir = ensureDirectory(paths.configDir);
  if (!configDir.ok) return configDir;
  const relatives = Object.keys(verified.seed.checkoutFiles).concat(Object.keys(verified.seed.files).map((relative) => `data/library/${relative}`));
  for (let index = 0; index < relatives.length; index += 1) {
    const copied = copyRelative(paths.repoRoot, paths.dataRoot, relatives[index]);
    if (!copied.ok) return copied;
  }
  const markerFile = writePrivateJson(path.join(paths.libraryDir, 'migration.json'), markerDocument(live));
  if (!markerFile.ok) return markerFile;
  let detected;
  try {
    detected = detectStorageMode({ libraryDir: paths.libraryDir });
  } catch (err) {
    return fail('installation-invalid', 'The installed marker could not be checked. It was not rewritten.');
  }
  if (!detected || detected.mode !== 'versioned' || !sameIdentity(detected.marker, live)) {
    return fail('installation-invalid', 'The installed marker does not match the seed. It was not rewritten.');
  }
  return writeAuthorization(paths, live, false);
}

module.exports = {
  WELCOME_ID,
  ensureVersionedInstall,
  verifyVersionedSeed,
};
