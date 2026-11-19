'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Durable installation paths. Nothing here reads or writes a directory.
// The development-machine directories under the home folder are refused
// by name so setup cannot select them. They are not the default.

const REPO_ROOT = path.resolve(__dirname, '..');
const PROTECTED_NAMES = [
  'ADAPT-stage-prompter-data',
  'ADAPT-stage-prompter-config',
  'ADAPT-stage-prompter-backups',
];

function envValue(env, key) {
  const value = env && env[key];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function defaultHome(env) {
  const override = envValue(env, 'ADAPT_PROMPTER_HOME');
  if (override) return path.resolve(override);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ADAPT Stage Prompter');
  }
  if (process.platform === 'win32') {
    const base = envValue(env, 'LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ADAPT Stage Prompter');
  }
  const base = envValue(env, 'XDG_DATA_HOME') || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'adapt-stage-prompter');
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function protectedRoots() {
  return PROTECTED_NAMES.map((name) => path.resolve(os.homedir(), name));
}

function protectedHit(candidate) {
  const resolved = path.resolve(candidate);
  return protectedRoots().find((root) => inside(resolved, root) || inside(root, resolved)) || null;
}

function canonicalDestination(target) {
  const resolved = path.resolve(target);
  if (resolved.includes('\0')) {
    return { ok: false, code: 'unsafe-path', error: 'The installation path contains a null byte.' };
  }
  const blocked = protectedHit(resolved);
  if (blocked) {
    return {
      ok: false,
      code: 'protected-path',
      error: `Setup will not read or write ${blocked}. Choose a different directory.`,
    };
  }
  let cursor = resolved;
  const pending = [];
  while (true) {
    let stat = null;
    try {
      stat = fs.lstatSync(cursor);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { ok: false, code: 'unsafe-path', error: 'The installation path could not be read.' };
      }
    }
    if (stat) {
      if (stat.isSymbolicLink()) {
        return { ok: false, code: 'unsafe-path', error: 'The installation path must not contain a symlink.' };
      }
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return { ok: false, code: 'unsafe-path', error: 'The installation path could not be resolved.' };
    }
    pending.push(path.basename(cursor));
    cursor = parent;
  }
  let realParent;
  try {
    realParent = fs.realpathSync(cursor);
  } catch (err) {
    return { ok: false, code: 'unsafe-path', error: 'The installation path could not be resolved.' };
  }
  const canonical = pending.length ? path.join(realParent, ...pending.reverse()) : realParent;
  const canonicalBlocked = protectedHit(canonical);
  if (canonicalBlocked) {
    return {
      ok: false,
      code: 'protected-path',
      error: `Setup will not read or write ${canonicalBlocked}. Choose a different directory.`,
    };
  }
  return { ok: true, path: canonical };
}

function rejectRepository(candidate, repoRoot) {
  let repo;
  try {
    repo = fs.realpathSync(path.resolve(repoRoot));
  } catch (err) {
    return { ok: false, code: 'unsafe-path', error: 'The repository path could not be resolved.' };
  }
  if (inside(candidate, repo) || inside(repo, candidate)) {
    return {
      ok: false,
      code: 'repository-root',
      error: 'The installation directory must stay outside this Git checkout.',
    };
  }
  return { ok: true, repo };
}

function resolveInstallPaths(options) {
  const settings = options || {};
  const env = settings.env || process.env;
  const repoRoot = path.resolve(settings.repoRoot || REPO_ROOT);
  const home = settings.home ? path.resolve(settings.home) : defaultHome(env);
  const dataRootInput = settings.dataRoot || envValue(env, 'ADAPT_PROMPTER_DATA') || path.join(home, 'library');
  const configDirInput = settings.configDir || envValue(env, 'ADAPT_PROMPTER_CONFIG') || path.join(home, 'config');
  const backupDirInput = settings.backupDir
    || envValue(env, 'ADAPT_PROMPTER_BACKUP')
    || path.join(home, 'backups', 'legacy-before-migration');
  const data = canonicalDestination(dataRootInput);
  if (!data.ok) return data;
  const config = canonicalDestination(configDirInput);
  if (!config.ok) return config;
  const backup = canonicalDestination(backupDirInput);
  if (!backup.ok) return backup;
  const repo = rejectRepository(data.path, REPO_ROOT);
  if (!repo.ok) return repo;
  const sourceRepo = rejectRepository(data.path, repoRoot);
  if (!sourceRepo.ok) return sourceRepo;
  const configRepo = rejectRepository(config.path, REPO_ROOT);
  if (!configRepo.ok) return configRepo;
  const configSource = rejectRepository(config.path, repoRoot);
  if (!configSource.ok) return configSource;
  const backupRepo = rejectRepository(backup.path, REPO_ROOT);
  if (!backupRepo.ok) return backupRepo;
  const backupSource = rejectRepository(backup.path, repoRoot);
  if (!backupSource.ok) return backupSource;
  if (inside(config.path, data.path) || inside(data.path, config.path)) {
    return {
      ok: false,
      code: 'unsafe-path',
      error: 'The authorization directory must stay outside the library directory.',
    };
  }
  if (inside(backup.path, data.path) || inside(data.path, backup.path)) {
    return {
      ok: false,
      code: 'unsafe-path',
      error: 'The backup directory must stay outside the library directory.',
    };
  }
  if (inside(backup.path, config.path) || inside(config.path, backup.path)) {
    return {
      ok: false,
      code: 'unsafe-path',
      error: 'The backup directory must stay outside the authorization directory.',
    };
  }
  const restoreDir = path.join(path.dirname(backup.path), '.adapt-restore-check');
  const restore = canonicalDestination(restoreDir);
  if (!restore.ok) return restore;
  const restoreRepo = rejectRepository(restore.path, REPO_ROOT);
  if (!restoreRepo.ok) return restoreRepo;
  const restoreSource = rejectRepository(restore.path, repoRoot);
  if (!restoreSource.ok) return restoreSource;
  if (inside(restore.path, data.path) || inside(restore.path, backup.path)) {
    return {
      ok: false,
      code: 'unsafe-path',
      error: 'The restore check must stay outside the library and the backup.',
    };
  }
  return {
    ok: true,
    repoRoot: sourceRepo.repo,
    dataRoot: data.path,
    configDir: config.path,
    backupDir: backup.path,
    restoreDir: restore.path,
    runtimeConfigPath: path.join(config.path, 'runtime-authorization.json'),
    migrationConfigPath: path.join(config.path, 'migration-authorization.json'),
    libraryDir: path.join(data.path, 'data', 'library'),
    scriptFile: path.join(data.path, 'script.txt'),
    previousFile: path.join(data.path, 'script.previous.txt'),
    journalDir: path.join(data.path, 'data', 'live-journal'),
  };
}

module.exports = {
  PROTECTED_NAMES,
  REPO_ROOT,
  canonicalDestination,
  defaultHome,
  protectedRoots,
  resolveInstallPaths,
};
