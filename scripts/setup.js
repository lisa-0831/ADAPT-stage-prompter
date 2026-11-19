#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runPersistentMigration } = require('../library-migration-cli');
const { detectStorageMode } = require('../server/storage-mode');
const { authorizeVersionedPersistentRoot } = require('../server/persistent-authorization');
const {
  createStorageBackup,
  verifyStorageBackup,
  restoreStorageBackup,
} = require('../server/storage-backup');
const { resolveInstallPaths } = require('./install-paths');

// Optional Legacy migration. Normal startup does not use this command.
// It copies the Legacy script files, not the committed productions, into an
// empty directory, backs that copy up, and runs the existing migration.
// A second run leaves an installed library where it is.

const REQUIRED = [
  'script.txt',
  'script.previous.txt',
  'script.previous.txt.meta.json',
  'data/library/index.json',
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

function listLegacyFiles(root) {
  const files = [];
  function add(relative) {
    const full = path.join(root, ...relative.split('/'));
    const stat = lstat(full);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return fail('unsafe-path', `${relative} is not a regular file.`);
    }
    files.push(relative);
    return null;
  }
  function walk(relativeDir) {
    const full = path.join(root, ...relativeDir.split('/'));
    const stat = lstat(full);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe-path', `${relativeDir} is not a real directory.`);
    }
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.name === '.writer.lock') continue;
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) return fail('unsafe-path', `${relative} is a symlink.`);
      if (entry.isDirectory()) {
        const nested = walk(relative);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) return fail('unsafe-path', `${relative} is not a regular file.`);
      files.push(relative);
    }
    return null;
  }
  for (let index = 0; index < REQUIRED.length; index += 1) {
    const missing = add(REQUIRED[index]);
    if (missing) return missing;
  }
  const walked = walk('data/library/scripts')
    || walk('data/library/assets')
    || walk('images');
  if (walked) return walked;
  for (let index = 0; index < REQUIRED.length; index += 1) {
    if (!files.includes(REQUIRED[index])) {
      return fail('missing-legacy', `The Legacy Library is missing ${REQUIRED[index]}.`);
    }
  }
  if (!files.some((relative) => relative.startsWith('data/library/scripts/'))) {
    return fail('missing-legacy', 'The Legacy Library has no saved scripts.');
  }
  return { ok: true, files: files.sort() };
}

function sourceManifest(root, files) {
  const manifest = {};
  files.forEach((relative) => {
    manifest[relative] = hashFile(path.join(root, ...relative.split('/')));
  });
  return manifest;
}

function liveProductionId(root, files) {
  const livePath = path.join(root, 'script.txt');
  const live = fs.readFileSync(livePath);
  const scripts = files.filter((relative) => /^data\/library\/scripts\/[0-9a-f-]{36}\.txt$/i.test(relative));
  const matches = scripts.filter((relative) => {
    const bytes = fs.readFileSync(path.join(root, ...relative.split('/')));
    return bytes.equals(live);
  });
  if (matches.length === 0) {
    return fail('no-live-match', 'No saved production matches script.txt. The library index was not used.');
  }
  if (matches.length > 1) {
    return fail('ambiguous-live-match', 'More than one saved production matches script.txt. Nothing was migrated.');
  }
  return { ok: true, id: path.basename(matches[0], '.txt').toLowerCase() };
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
  if (state === 'symlink' || state === 'file') {
    return fail('unsafe-path', `${dir} is not a real directory.`);
  }
  if (state === 'missing') fs.mkdirSync(dir, { recursive: true });
  return { ok: true, created: state === 'missing' };
}

function copySeed(repoRoot, dataRoot, files) {
  files.forEach((relative) => {
    const from = path.join(repoRoot, ...relative.split('/'));
    const to = path.join(dataRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const fd = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let out;
    try {
      const bytes = fs.readFileSync(fd);
      out = fs.openSync(to, 'wx');
      fs.writeSync(out, bytes);
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(fd);
      if (out !== undefined) fs.closeSync(out);
    }
  });
}

function sameManifest(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function writePrivateJson(filePath, value) {
  if (lstat(filePath)) return fail('config-exists', `Refusing to overwrite ${filePath}.`);
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

function runtimeDocument(paths, marker) {
  const installation = marker.schema === 3
    ? {
      schema: 3,
      state: 'committed',
      kind: 'fresh',
      installationId: marker.installationId,
    }
    : {
      schema: 2,
      state: 'committed',
      migrationId: marker.migrationId,
      productionId: marker.productionId,
      versionId: marker.versionId,
      contentHash: marker.contentHash,
    };
  return {
    schema: 1,
    purpose: 'adapt-persistent-runtime',
    root: paths.dataRoot,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    journalDir: paths.journalDir,
    installation,
  };
}

function installedMarker(paths) {
  let detected;
  try {
    detected = detectStorageMode({ libraryDir: paths.libraryDir });
  } catch (err) {
    return fail('installation-mismatch', 'The data directory has a migration marker that cannot be used. It was left unchanged.');
  }
  if (!detected || detected.mode !== 'versioned' || !detected.marker) return null;
  return detected.marker;
}

function finishInstalled(paths, marker, configWritten) {
  return {
    ok: true,
    installed: true,
    alreadyInstalled: true,
    configWritten: Boolean(configWritten),
    dataRoot: paths.dataRoot,
    configPath: paths.runtimeConfigPath,
    migrationId: marker.migrationId || null,
    installationId: marker.installationId || null,
    productionId: marker.productionId || null,
    versionId: marker.versionId || null,
  };
}

function readInstalled(paths) {
  const runtimeStat = lstat(paths.runtimeConfigPath);
  if (runtimeStat && (runtimeStat.isSymbolicLink() || !runtimeStat.isFile())) {
    return fail('config-invalid', 'The runtime authorization must be a regular file. It was not replaced.');
  }
  if (runtimeStat) {
    let token;
    try {
      token = authorizeVersionedPersistentRoot({ configPath: paths.runtimeConfigPath });
    } catch (err) {
      return fail(
        err && err.code ? err.code : 'config-invalid',
        'The existing runtime authorization does not match this library. It was not replaced.',
      );
    }
    if (token.root !== paths.dataRoot) {
      return fail(
        'config-conflict',
        `The runtime authorization already points at ${token.root}. Setup did not copy or migrate another library.`,
      );
    }
    return finishInstalled(paths, token.installation, false);
  }
  const marker = installedMarker(paths);
  if (marker && marker.ok === false) return marker;
  if (marker) {
    const ensured = ensureDirectory(paths.configDir);
    if (!ensured.ok) return ensured;
    const written = writePrivateJson(paths.runtimeConfigPath, runtimeDocument(paths, marker));
    if (!written.ok) return written;
    try {
      authorizeVersionedPersistentRoot({ configPath: paths.runtimeConfigPath });
    } catch (err) {
      return fail(
        err && err.code ? err.code : 'config-invalid',
        'The runtime authorization could not be checked after it was written. The library was not migrated again.',
      );
    }
    return finishInstalled(paths, marker, true);
  }
  return null;
}

function removeRestoreCheck(dir) {
  if (path.basename(dir) !== '.adapt-restore-check') {
    return fail('unsafe-path', 'Refusing to remove a directory that is not the restore check.');
  }
  fs.rmSync(dir, { recursive: true, force: false });
  return { ok: true };
}

function runSetup(options) {
  const paths = resolveInstallPaths(options);
  if (!paths.ok) return paths;
  const existing = readInstalled(paths);
  if (existing) return existing;

  const dataState = directoryState(paths.dataRoot);
  if (dataState === 'symlink' || dataState === 'file') {
    return fail('unsafe-path', 'The data directory is not a real directory. Nothing was deleted.');
  }
  if (dataState === 'filled') {
    return fail(
      'destination-not-empty',
      `The data directory already has files and is not an installed Versioned Library: ${paths.dataRoot}. Setup did not delete or migrate them.`,
    );
  }
  if (lstat(paths.migrationConfigPath) || lstat(paths.runtimeConfigPath)) {
    return fail(
      'config-exists',
      'An authorization file is already present. Setup did not overwrite it or migrate again.',
    );
  }
  const backupState = directoryState(paths.backupDir);
  if (backupState === 'filled' || backupState === 'symlink' || backupState === 'file') {
    return fail(
      'backup-exists',
      `The backup directory is not an empty directory: ${paths.backupDir}. Setup did not overwrite it.`,
    );
  }
  if (directoryState(paths.restoreDir) !== 'missing') {
    return fail(
      'backup-exists',
      `The restore check already exists: ${paths.restoreDir}. Setup did not overwrite it.`,
    );
  }

  const listed = listLegacyFiles(paths.repoRoot);
  if (!listed.ok) return listed;
  const live = liveProductionId(paths.repoRoot, listed.files);
  if (!live.ok) return live;
  const seedManifest = sourceManifest(paths.repoRoot, listed.files);

  const dataDir = ensureDirectory(paths.dataRoot);
  if (!dataDir.ok) return dataDir;
  const configDir = ensureDirectory(paths.configDir);
  if (!configDir.ok) return configDir;
  const backupDir = ensureDirectory(paths.backupDir);
  if (!backupDir.ok) return backupDir;
  try {
    copySeed(paths.repoRoot, paths.dataRoot, listed.files);
  } catch (err) {
    return fail(
      'copy-failed',
      'The Legacy Library could not be copied. The data directory was left in place and was not migrated.',
    );
  }
  const copiedManifest = sourceManifest(paths.dataRoot, listed.files);
  if (!sameManifest(seedManifest, copiedManifest)) {
    return fail('manifest-mismatch', 'The copied library does not match the repository seed. Migration did not start.');
  }

  const backup = createStorageBackup({ sourceRoot: paths.dataRoot, backupDir: paths.backupDir });
  if (!backup.ok) return fail(backup.code || 'backup-failed', backup.error || 'The backup could not be created.');
  if (!sameManifest(seedManifest, backup.manifest)) {
    return fail('manifest-mismatch', 'The backup does not match the repository seed. Migration did not start.');
  }
  const verified = verifyStorageBackup({ backupDir: paths.backupDir });
  if (!verified.ok) return fail(verified.code || 'backup-failed', verified.error || 'The backup could not be verified.');
  const restoreDir = ensureDirectory(paths.restoreDir);
  if (!restoreDir.ok) return restoreDir;
  const restored = restoreStorageBackup({ backupDir: paths.backupDir, destinationRoot: paths.restoreDir });
  if (!restored.ok) {
    return fail(restored.code || 'backup-failed', restored.error || 'The backup could not be restored for checking.');
  }
  const restoredManifest = sourceManifest(paths.restoreDir, listed.files);
  if (!sameManifest(seedManifest, restoredManifest)) {
    return fail('manifest-mismatch', 'The restored backup does not match the repository seed. Migration did not start.');
  }
  const removed = removeRestoreCheck(paths.restoreDir);
  if (!removed.ok) return removed;

  const migrationFile = writePrivateJson(paths.migrationConfigPath, {
    schema: 1,
    purpose: 'adapt-persistent-migration',
    root: paths.dataRoot,
    libraryDir: paths.libraryDir,
    scriptFile: paths.scriptFile,
    previousFile: paths.previousFile,
    journalDir: paths.journalDir,
    expectedLiveProductionId: live.id,
    sourceManifest: seedManifest,
  });
  if (!migrationFile.ok) return migrationFile;

  const preflight = runPersistentMigration({ command: 'preflight', configPath: paths.migrationConfigPath });
  if (!preflight.ok || preflight.liveProductionId !== live.id) {
    return fail(
      preflight.code || 'preflight-failed',
      preflight.error || 'Preflight did not accept this library. Nothing was committed.',
    );
  }
  const prepared = runPersistentMigration({ command: 'prepare', configPath: paths.migrationConfigPath });
  if (!prepared.ok || typeof prepared.planHash !== 'string') {
    return fail(prepared.code || 'prepare-failed', prepared.error || 'Prepare did not finish. Nothing was committed.');
  }
  const committed = runPersistentMigration({
    command: 'commit',
    configPath: paths.migrationConfigPath,
    planHash: prepared.planHash,
  });
  if (!committed.ok || !committed.marker) {
    return fail(committed.code || 'commit-failed', committed.error || 'Commit did not finish. The marker was not rewritten.');
  }
  const marker = installedMarker(paths);
  if (!marker || marker.ok === false || marker.migrationId !== committed.marker.migrationId) {
    return fail('corrupt-marker', 'The committed marker could not be read back. Setup did not write a runtime authorization.');
  }
  const runtimeFile = writePrivateJson(paths.runtimeConfigPath, runtimeDocument(paths, marker));
  if (!runtimeFile.ok) return runtimeFile;
  try {
    authorizeVersionedPersistentRoot({ configPath: paths.runtimeConfigPath });
  } catch (err) {
    return fail(
      err && err.code ? err.code : 'config-invalid',
      'The runtime authorization was written but did not validate. The library was not migrated again.',
    );
  }
  return {
    ok: true,
    installed: true,
    alreadyInstalled: false,
    dataRoot: paths.dataRoot,
    configPath: paths.runtimeConfigPath,
    backupDir: paths.backupDir,
    migrationId: marker.migrationId,
    productionId: marker.productionId,
    versionId: marker.versionId,
    fileCount: listed.files.length,
    warnings: Array.isArray(preflight.warnings) ? preflight.warnings : [],
  };
}

function main() {
  try {
    const result = runSetup();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exit(1);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: err && err.code ? err.code : 'setup-failed',
      error: err && err.message ? err.message : 'Setup failed.',
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  listLegacyFiles,
  runSetup,
};
