'use strict';

const fs = require('fs');
const path = require('path');
const { detectStorageMode, StorageModeError } = require('./storage-mode');
const { acquireStorageWriter, StorageWriterLockError } = require('./storage-writer-lock');

// Runtime authorization and migration authorization are different files.
// Neither is read from an HTTP header, a WebSocket message, a query
// parameter, or a generic writable-root environment variable. node server.js
// does not load either file. A future supervisor passes the token returned
// by authorizeVersionedPersistentRoot into createPrompterServer.

const PERSISTENT_AUTH = Symbol('adapt.versionedPersistentRoot');
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_PURPOSE = 'adapt-persistent-runtime';
const MIGRATION_PURPOSE = 'adapt-persistent-migration';
const retainedRoots = new Set();

class PersistentAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersistentAuthorizationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PersistentAuthorizationError(code, message);
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function repoReal() {
  return fs.realpathSync(REPO_ROOT);
}

function rejectsRepository(candidate) {
  const repo = repoReal();
  return candidate === repo || inside(candidate, repo) || inside(repo, candidate);
}

function readConfigFile(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0') || !path.isAbsolute(configPath)) {
    fail('unsafe-authorization', 'The authorization file must be an absolute path outside this checkout.');
  }
  const lexical = path.resolve(configPath);
  let stat;
  try {
    stat = fs.lstatSync(lexical);
  } catch (err) {
    fail('missing-authorization', 'The authorization file could not be read.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('unsafe-authorization', 'The authorization file must be a regular file, not a symlink.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('unsafe-authorization', 'The authorization file must be owned by the account that starts the process.');
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    fail('unsafe-authorization', 'The authorization file must be mode 0600 or 0400.');
  }
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    fail('unsafe-authorization', 'The authorization file could not be resolved.');
  }
  if (rejectsRepository(real)) {
    fail('unsafe-authorization', 'An authorization file inside this checkout cannot authorize storage.');
  }
  let fd;
  try {
    fd = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    fail('unsafe-authorization', 'The authorization file must be a regular file, not a symlink.');
  }
  let raw;
  try {
    raw = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (raw.length > 1024 * 1024) fail('malformed-authorization', 'The authorization file is too large.');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('malformed-authorization', 'The authorization file is not valid JSON.');
  }
  return { parsed, configReal: real };
}

function walkReal(filePath, kind) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    fail('unsafe-path', `The ${kind} path must be an absolute path inside the authorized root.`);
  }
  const lexical = path.resolve(filePath);
  const parts = lexical.split(path.sep).filter(Boolean);
  let current = path.parse(lexical).root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && err.code === 'ENOENT' && index === parts.length - 1) {
        return { lexical, missing: true };
      }
      fail('unsafe-path', `The ${kind} path could not be read.`);
    }
    if (stat.isSymbolicLink()) fail('unsafe-path', `The ${kind} path must not contain a symlink.`);
  }
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    fail('unsafe-path', `The ${kind} path could not be resolved.`);
  }
  if (real !== lexical) fail('unsafe-path', `The ${kind} path must not contain a symlink.`);
  return { lexical: real, missing: false };
}

function requireDirectory(filePath, kind) {
  const walked = walkReal(filePath, kind);
  if (walked.missing) fail('unsafe-path', `The ${kind} path must be a real directory.`);
  const stat = fs.lstatSync(walked.lexical);
  if (!stat.isDirectory()) fail('unsafe-path', `The ${kind} path must be a real directory.`);
  return walked.lexical;
}

function requireFile(filePath, kind) {
  const walked = walkReal(filePath, kind);
  if (walked.missing) fail('unsafe-path', `The ${kind} path must be a real file.`);
  const stat = fs.lstatSync(walked.lexical);
  if (!stat.isFile()) fail('unsafe-path', `The ${kind} path must be a real file.`);
  return walked.lexical;
}

function allowJournal(filePath) {
  const walked = walkReal(filePath, 'journal');
  if (walked.missing) return walked.lexical;
  const stat = fs.lstatSync(walked.lexical);
  if (!stat.isDirectory()) fail('unsafe-path', 'The journal path must be a real directory.');
  return walked.lexical;
}

function containedPaths(root, paths) {
  Object.keys(paths).forEach((kind) => {
    const candidate = paths[kind];
    if (candidate !== root && !inside(candidate, root)) {
      fail('unsafe-path', `The ${kind} path is outside the authorized root.`);
    }
  });
}

function sameId(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function installationMatches(expected, marker) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  if (expected.schema !== marker.schema || expected.state !== 'committed' || marker.state !== 'committed') return false;
  if (marker.schema === 3) {
    return expected.kind === 'fresh' && marker.kind === 'fresh' && sameId(expected.installationId, marker.installationId);
  }
  if (marker.schema !== 2) return false;
  return sameId(expected.migrationId, marker.migrationId)
    && sameId(expected.productionId, marker.productionId)
    && sameId(expected.versionId, marker.versionId)
    && sameId(expected.contentHash, marker.contentHash);
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}

function readRuntimeDocument(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('malformed-authorization', 'The authorization file is not a runtime authorization.');
  }
  if (parsed.schema !== 1 || parsed.purpose !== RUNTIME_PURPOSE) {
    fail('malformed-authorization', 'The authorization file is not a runtime authorization.');
  }
  if (!exactKeys(parsed, ['schema', 'purpose', 'root', 'libraryDir', 'scriptFile', 'previousFile', 'journalDir', 'installation'])) {
    fail('malformed-authorization', 'The authorization file has an unexpected field.');
  }
  const installation = parsed.installation;
  if (!installation || typeof installation !== 'object' || Array.isArray(installation)) {
    fail('malformed-authorization', 'The authorization file has no installation identity.');
  }
  const schema2 = ['schema', 'state', 'migrationId', 'productionId', 'versionId', 'contentHash'];
  const schema3 = ['schema', 'state', 'kind', 'installationId'];
  const allowed = installation.schema === 3 ? schema3 : schema2;
  if (!exactKeys(installation, allowed)) {
    fail('malformed-authorization', 'The installation identity has an unexpected field.');
  }
  if (installation.schema === 2 && installation.state !== 'committed') {
    fail('installation-mismatch', 'The authorization does not name a committed installation.');
  }
  if (installation.schema === 3 && (installation.state !== 'committed' || installation.kind !== 'fresh')) {
    fail('installation-mismatch', 'The authorization does not name a fresh installation.');
  }
  if (installation.schema !== 2 && installation.schema !== 3) {
    fail('malformed-authorization', 'The installation identity uses an unsupported schema.');
  }
  const root = requireDirectory(parsed.root, 'root');
  if (rejectsRepository(root)) fail('repository-root', 'This checkout cannot be a writable versioned root.');
  const libraryDir = requireDirectory(parsed.libraryDir, 'library');
  const scriptFile = requireFile(parsed.scriptFile, 'script mirror');
  const previousFile = requireFile(parsed.previousFile, 'previous script');
  const metaFile = requireFile(`${previousFile}.meta.json`, 'previous metadata');
  const journalDir = allowJournal(parsed.journalDir);
  containedPaths(root, { library: libraryDir, script: scriptFile, previous: previousFile, metadata: metaFile, journal: journalDir });
  let detected;
  try {
    detected = detectStorageMode({ libraryDir });
  } catch (err) {
    if (err instanceof StorageModeError) fail('installation-mismatch', 'The committed marker does not match this authorization.');
    throw err;
  }
  if (!detected || detected.mode !== 'versioned' || !detected.marker) {
    fail('installation-mismatch', 'The committed marker does not match this authorization.');
  }
  if (!installationMatches(installation, detected.marker)) {
    fail('installation-mismatch', 'The committed marker does not match this authorization.');
  }
  return {
    root,
    libraryDir,
    scriptFile,
    previousFile,
    metaFile,
    journalDir,
    installation: {
      schema: detected.marker.schema,
      state: 'committed',
      migrationId: detected.marker.migrationId || null,
      installationId: detected.marker.installationId || null,
      productionId: detected.marker.productionId || null,
      versionId: detected.marker.versionId || null,
      contentHash: detected.marker.contentHash || null,
      kind: detected.marker.kind || null,
    },
  };
}

function authorizeVersionedPersistentRoot(spec) {
  const configPath = spec && spec.configPath;
  const loaded = readConfigFile(configPath);
  const checked = readRuntimeDocument(loaded.parsed);
  return Object.freeze({
    [PERSISTENT_AUTH]: true,
    purpose: RUNTIME_PURPOSE,
    configPath: loaded.configReal,
    root: checked.root,
    libraryDir: checked.libraryDir,
    scriptFile: checked.scriptFile,
    previousFile: checked.previousFile,
    metaFile: checked.metaFile,
    journalDir: checked.journalDir,
    installation: Object.freeze({ ...checked.installation }),
  });
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    return fs.realpathSync(path.resolve(left)) === fs.realpathSync(path.resolve(right));
  } catch (err) {
    return path.resolve(left) === path.resolve(right);
  }
}

function persistentAuthorizationAccepted(token, paths) {
  if (!token || token[PERSISTENT_AUTH] !== true || token.purpose !== RUNTIME_PURPOSE) return false;
  let fresh;
  try {
    fresh = authorizeVersionedPersistentRoot({ configPath: token.configPath });
  } catch (err) {
    return false;
  }
  const settings = paths || {};
  const pathsMatch = fresh.root === token.root
    && fresh.libraryDir === token.libraryDir
    && fresh.scriptFile === token.scriptFile
    && fresh.previousFile === token.previousFile
    && fresh.journalDir === token.journalDir
    && samePath(settings.libraryDir, fresh.libraryDir)
    && samePath(settings.scriptFile, fresh.scriptFile)
    && samePath(settings.previousFile, fresh.previousFile)
    && samePath(settings.journalDir, fresh.journalDir);
  if (!pathsMatch) return false;
  if (!installationMatches(fresh.installation, token.installation)) return false;
  return true;
}

function retainPersistentRoot(root) {
  retainedRoots.add(root);
}

function releasePersistentRoot(root) {
  retainedRoots.delete(root);
}

function isPersistentRootRetained(candidate) {
  if (retainedRoots.has(candidate)) return true;
  for (const root of retainedRoots) {
    if (inside(candidate, root)) return true;
  }
  return false;
}

function hashFile(filePath) {
  const crypto = require('crypto');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function checkManifest(root, manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('malformed-authorization', 'The migration authorization needs a source manifest.');
  }
  const entries = Object.keys(manifest);
  if (!entries.length) fail('malformed-authorization', 'The migration authorization needs a source manifest.');
  entries.forEach((relative) => {
    if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').includes('..')) {
      fail('unsafe-path', 'A manifest path escapes the authorized root.');
    }
    const expected = manifest[relative];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
      fail('malformed-authorization', 'A manifest hash is not a SHA-256 value.');
    }
    const absolute = path.resolve(root, relative);
    if (!inside(absolute, root) && absolute !== root) fail('unsafe-path', 'A manifest path escapes the authorized root.');
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (err) {
      fail('manifest-mismatch', 'The source manifest does not match this root.');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('manifest-mismatch', 'The source manifest does not match this root.');
    const actual = hashFile(absolute);
    if (actual.toLowerCase() !== expected.toLowerCase()) fail('manifest-mismatch', 'The source manifest does not match this root.');
  });
}

function beginPersistentMigration(spec) {
  const loaded = readConfigFile(spec && spec.configPath);
  const parsed = loaded.parsed;
  if (!parsed || parsed.schema !== 1 || parsed.purpose !== MIGRATION_PURPOSE) {
    fail('malformed-authorization', 'The authorization file is not a migration authorization.');
  }
  if (!exactKeys(parsed, ['schema', 'purpose', 'root', 'libraryDir', 'scriptFile', 'previousFile', 'journalDir', 'expectedLiveProductionId', 'sourceManifest'])) {
    fail('malformed-authorization', 'The migration authorization has an unexpected field.');
  }
  const root = requireDirectory(parsed.root, 'root');
  if (rejectsRepository(root)) fail('repository-root', 'This checkout cannot be a writable versioned root.');
  const libraryDir = requireDirectory(parsed.libraryDir, 'library');
  const scriptFile = requireFile(parsed.scriptFile, 'script mirror');
  const previousFile = requireFile(parsed.previousFile, 'previous script');
  containedPaths(root, {
    library: libraryDir,
    script: scriptFile,
    previous: previousFile,
    journal: allowJournal(parsed.journalDir),
  });
  if (typeof parsed.expectedLiveProductionId !== 'string' || parsed.expectedLiveProductionId.length === 0) {
    fail('malformed-authorization', 'The migration authorization needs the expected live production.');
  }
  checkManifest(root, parsed.sourceManifest);
  let hold;
  try {
    hold = acquireStorageWriter(libraryDir);
  } catch (err) {
    if (err instanceof StorageWriterLockError) {
      return { ok: false, code: err.code, error: err.message };
    }
    throw err;
  }
  try {
    checkManifest(root, parsed.sourceManifest);
  } catch (err) {
    hold.release();
    throw err;
  }
  let released = false;
  return {
    ok: true,
    code: 'migration-owned',
    root,
    libraryDir,
    release() {
      if (released) return;
      released = true;
      hold.release();
    },
  };
}

module.exports = {
  PERSISTENT_AUTH,
  RUNTIME_PURPOSE,
  MIGRATION_PURPOSE,
  PersistentAuthorizationError,
  authorizeVersionedPersistentRoot,
  persistentAuthorizationAccepted,
  retainPersistentRoot,
  releasePersistentRoot,
  isPersistentRootRetained,
  beginPersistentMigration,
};
