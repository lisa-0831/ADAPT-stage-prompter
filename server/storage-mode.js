const fs = require('fs');
const path = require('path');

// Read-only boot check. A missing marker keeps today's script.txt startup.
// Any committed marker means versioned storage, which this server cannot run yet.
// This module does not create directories or rewrite the marker.

const MARKER_NAME = 'migration.json';
const SCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const MAX_MARKER_BYTES = 1024 * 1024;

class StorageModeError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'StorageModeError';
    this.code = code;
    if (field) this.field = field;
  }
}

function markerMessage(code, field) {
  const suffix = 'Startup was refused and the marker was left unchanged.';
  const messages = {
    'invalid-json': `migration.json is not valid JSON. ${suffix}`,
    'unsupported-schema': `migration.json uses a schema this server does not recognize. ${suffix}`,
    'missing-field': `migration.json is missing ${field}. ${suffix}`,
    'invalid-production-id': `migration.json has an invalid production id. ${suffix}`,
    'invalid-version-id': `migration.json has an invalid version id. ${suffix}`,
    'invalid-migration-id': `migration.json has an invalid migration id. ${suffix}`,
    'invalid-content-hash': `migration.json has an invalid content hash. ${suffix}`,
    'unsupported-marker-state': `migration.json is not a committed migration marker. ${suffix}`,
    'invalid-field': `migration.json has an invalid ${field}. ${suffix}`,
    'unsafe-marker': `migration.json is not a regular file inside the configured library directory. ${suffix}`,
  };
  return messages[code] || `migration.json cannot be used. ${suffix}`;
}

function fail(code, field) {
  throw new StorageModeError(code, markerMessage(code, field), field);
}

function contained(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalId(value) {
  if (typeof value !== 'string') return null;
  const id = value.toLowerCase();
  return SCRIPT_ID.test(id) ? id : null;
}

function canonicalHash(value) {
  if (typeof value !== 'string') return null;
  const hash = value.toLowerCase();
  return CONTENT_HASH.test(hash) ? hash : null;
}

function requireMarkerField(marker, field) {
  if (!Object.prototype.hasOwnProperty.call(marker, field) || marker[field] === undefined || marker[field] === null) {
    fail('missing-field', field);
  }
}

function sharedMarker(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) fail('invalid-json');
  requireMarkerField(marker, 'schema');
  requireMarkerField(marker, 'state');
  if (marker.state !== 'committed') fail('unsupported-marker-state', 'state');
  requireMarkerField(marker, 'migrationId');
  const migrationId = canonicalId(marker.migrationId);
  if (!migrationId) fail('invalid-migration-id', 'migrationId');
  requireMarkerField(marker, 'productionId');
  const productionId = canonicalId(marker.productionId);
  if (!productionId) fail('invalid-production-id', 'productionId');
  requireMarkerField(marker, 'versionId');
  const versionId = canonicalId(marker.versionId);
  if (!versionId) fail('invalid-version-id', 'versionId');
  requireMarkerField(marker, 'sourceScriptHash');
  const sourceScriptHash = canonicalHash(marker.sourceScriptHash);
  if (!sourceScriptHash) fail('invalid-content-hash', 'sourceScriptHash');
  requireMarkerField(marker, 'contentHash');
  const contentHash = canonicalHash(marker.contentHash);
  if (!contentHash) fail('invalid-content-hash', 'contentHash');
  requireMarkerField(marker, 'mirrorInstalled');
  if (typeof marker.mirrorInstalled !== 'boolean') fail('invalid-field', 'mirrorInstalled');
  return {
    state: 'committed',
    migrationId,
    productionId,
    versionId,
    previousActivation: null,
    sourceScriptHash,
    contentHash,
    mirrorInstalled: marker.mirrorInstalled,
  };
}

function validateMarker(marker) {
  const shared = sharedMarker(marker);
  if (marker.schema === 1) {
    requireMarkerField(marker, 'previousVersionId');
    if (!canonicalId(marker.previousVersionId)) fail('invalid-version-id', 'previousVersionId');
    return { schema: 1, ...shared };
  }
  if (marker.schema === 2) {
    if (!Object.prototype.hasOwnProperty.call(marker, 'previousActivation')) {
      fail('missing-field', 'previousActivation');
    }
    if (marker.previousActivation !== null) fail('invalid-field', 'previousActivation');
    if (Object.prototype.hasOwnProperty.call(marker, 'previousVersionId')) {
      fail('invalid-field', 'previousVersionId');
    }
    return { schema: 2, ...shared };
  }
  fail('unsupported-schema', 'schema');
  return null;
}

function readMarker(markerPath) {
  let stat;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink() || stat.isDirectory() || !stat.isFile()) fail('unsafe-marker');
  if (stat.size > MAX_MARKER_BYTES) fail('invalid-json');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(markerPath, flags);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EPERM') fail('unsafe-marker');
    fail('invalid-json');
  }
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function detectStorageMode({ libraryDir } = {}) {
  if (typeof libraryDir !== 'string' || libraryDir.length === 0 || libraryDir.includes('\0')) {
    fail('unsafe-marker');
  }
  const root = path.resolve(libraryDir);
  const markerPath = path.join(root, MARKER_NAME);
  if (!contained(markerPath, root)) fail('unsafe-marker');

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { mode: 'legacy', libraryDir: root, markerPath };
    }
    throw err;
  }
  if (rootStat.isSymbolicLink()) fail('unsafe-marker');
  if (!rootStat.isDirectory()) fail('unsafe-marker');

  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (err) {
    fail('unsafe-marker');
  }

  const raw = readMarker(markerPath);
  if (raw === null) return { mode: 'legacy', libraryDir: root, markerPath };

  let markerReal;
  try {
    markerReal = fs.realpathSync(markerPath);
  } catch (err) {
    fail('unsafe-marker');
  }
  if (!contained(markerReal, rootReal)) fail('unsafe-marker');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('invalid-json');
  }
  const marker = validateMarker(parsed);
  return {
    mode: 'versioned',
    supported: false,
    libraryDir: root,
    markerPath,
    marker,
  };
}

module.exports = {
  MARKER_NAME,
  MAX_MARKER_BYTES,
  StorageModeError,
  detectStorageMode,
};
