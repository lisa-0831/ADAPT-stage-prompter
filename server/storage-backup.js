'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { acquireStorageWriter, StorageWriterLockError } = require('./storage-writer-lock');

// A backup is a stopped-writer copy of one storage root. It does not migrate
// that root and it does not authorize the checkout. The manifest is SHA-256
// of the copied files. .writer.lock is ownership state and is not copied.

const MANIFEST_NAME = 'backup-manifest.json';
const REPO_ROOT = path.resolve(__dirname, '..');

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new BackupError(code, message);
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

function requireRealDirectory(filePath, kind) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    fail('unsafe-path', `The ${kind} path must be an absolute path.`);
  }
  const lexical = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(lexical);
  } catch (err) {
    fail('missing-path', `The ${kind} path does not exist.`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('unsafe-path', `The ${kind} path must be a real directory.`);
  }
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    fail('unsafe-path', `The ${kind} path could not be resolved.`);
  }
  if (real !== lexical) fail('unsafe-path', `The ${kind} path must not contain a symlink.`);
  if (rejectsRepository(real)) fail('repository-root', 'This checkout cannot be a backup source or destination.');
  return real;
}

function hashFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function relativePosix(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walkFiles(root, directory) {
  const found = [];
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path', 'A backup directory is not a real directory.');
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail('unsafe-path', 'A backup refuses to copy a symlink.');
      if (entry.isDirectory()) {
        stack.push(full);
        return;
      }
      if (!entry.isFile()) fail('unsafe-path', 'A backup only copies regular files.');
      if (entry.name === '.writer.lock') return;
      const relative = relativePosix(root, full);
      if (relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe-path', 'A backup path escapes the source.');
      found.push(relative);
    });
  }
  return found;
}

function sourceFiles(root) {
  const files = [];
  const script = path.join(root, 'script.txt');
  let scriptStat;
  try {
    scriptStat = fs.lstatSync(script);
  } catch (err) {
    fail('missing-path', 'script.txt is missing.');
  }
  if (scriptStat.isSymbolicLink() || !scriptStat.isFile()) fail('unsafe-path', 'script.txt must be a regular file.');
  files.push('script.txt');
  ['script.previous.txt', 'script.previous.txt.meta.json'].forEach((name) => {
    const filePath = path.join(root, name);
    let stat = null;
    try {
      stat = fs.lstatSync(filePath);
    } catch (err) {
      stat = null;
    }
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path', `${name} must be a regular file.`);
    files.push(name);
  });
  ['data/library', 'images', 'data/live-journal'].forEach((relative) => {
    const directory = path.join(root, ...relative.split('/'));
    let stat = null;
    try {
      stat = fs.lstatSync(directory);
    } catch (err) {
      stat = null;
    }
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path', `${relative} must be a real directory.`);
    walkFiles(root, directory).forEach((file) => files.push(file));
  });
  return Array.from(new Set(files)).sort();
}

function copyRegularFile(source, dest) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path', 'A backup only copies regular files.');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    fs.writeFileSync(dest, fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

function readManifest(backupDir) {
  const filePath = path.join(backupDir, MANIFEST_NAME);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    fail('missing-manifest', 'The backup manifest is missing.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path', 'The backup manifest must be a regular file.');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (err) {
    fail('corrupt-manifest', 'The backup manifest could not be read.');
  } finally {
    fs.closeSync(fd);
  }
  if (!parsed || parsed.schema !== 1 || parsed.kind !== 'adapt-storage-backup' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    fail('corrupt-manifest', 'The backup manifest is not a storage backup.');
  }
  return parsed.files;
}

function createStorageBackup(options) {
  const settings = options || {};
  let hold = null;
  try {
    const source = requireRealDirectory(settings.sourceRoot, 'source');
    const dest = requireRealDirectory(settings.backupDir, 'backup');
    if (source === dest || inside(dest, source) || inside(source, dest)) {
      fail('unsafe-path', 'The backup destination must be outside the source.');
    }
    if (fs.readdirSync(dest).length) fail('unsafe-path', 'The backup destination must be empty.');
    const library = path.join(source, 'data', 'library');
    let libraryStat = null;
    try {
      libraryStat = fs.lstatSync(library);
    } catch (err) {
      libraryStat = null;
    }
    if (!libraryStat || libraryStat.isSymbolicLink() || !libraryStat.isDirectory()) {
      fail('unsafe-lock', 'A consistent backup needs a real library directory before it can take the writer lock.');
    }
    try {
      hold = acquireStorageWriter(library, { exclusiveClaim: true });
    } catch (err) {
      if (err instanceof StorageWriterLockError) fail(err.code, err.message);
      throw err;
    }
    const files = sourceFiles(source);
    const hashes = {};
    files.forEach((relative) => {
      const from = path.join(source, ...relative.split('/'));
      const to = path.join(dest, ...relative.split('/'));
      copyRegularFile(from, to);
      hashes[relative] = hashFile(to);
    });
    const manifest = { schema: 1, kind: 'adapt-storage-backup', files: hashes };
    fs.writeFileSync(path.join(dest, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, fileCount: files.length, manifest: hashes };
  } catch (err) {
    if (err instanceof BackupError) return { ok: false, code: err.code, error: err.message };
    throw err;
  } finally {
    if (hold) hold.release();
  }
}

function hashesMatch(root, files) {
  const present = walkFiles(root, root).filter((relative) => relative !== MANIFEST_NAME).sort();
  const expected = Object.keys(files).sort();
  if (present.length !== expected.length || expected.some((relative, index) => present[index] !== relative)) {
    fail('manifest-mismatch', 'The backup files do not match the manifest.');
  }
  expected.forEach((relative) => {
    if (typeof files[relative] !== 'string' || !/^[0-9a-f]{64}$/i.test(files[relative])) {
      fail('corrupt-manifest', 'A backup hash is not a SHA-256 value.');
    }
    const actual = hashFile(path.join(root, ...relative.split('/')));
    if (actual.toLowerCase() !== files[relative].toLowerCase()) {
      fail('manifest-mismatch', 'A backup file does not match its recorded hash.');
    }
  });
  return expected.length;
}

function verifyStorageBackup(options) {
  try {
    const dest = requireRealDirectory(options && options.backupDir, 'backup');
    return { ok: true, fileCount: hashesMatch(dest, readManifest(dest)) };
  } catch (err) {
    if (err instanceof BackupError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

function restoreStorageBackup(options) {
  try {
    const settings = options || {};
    const checked = verifyStorageBackup({ backupDir: settings.backupDir });
    if (!checked.ok) return checked;
    const backupDir = requireRealDirectory(settings.backupDir, 'backup');
    const destination = requireRealDirectory(settings.destinationRoot, 'restore');
    if (backupDir === destination || inside(destination, backupDir) || inside(backupDir, destination)) {
      fail('unsafe-path', 'The restore destination must be outside the backup.');
    }
    if (fs.readdirSync(destination).length) fail('unsafe-path', 'The restore destination must be empty.');
    const files = readManifest(backupDir);
    Object.keys(files).sort().forEach((relative) => {
      copyRegularFile(path.join(backupDir, ...relative.split('/')), path.join(destination, ...relative.split('/')));
    });
    return { ok: true, fileCount: hashesMatch(destination, files) };
  } catch (err) {
    if (err instanceof BackupError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

module.exports = {
  MANIFEST_NAME,
  BackupError,
  createStorageBackup,
  verifyStorageBackup,
  restoreStorageBackup,
};
