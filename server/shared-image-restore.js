const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { detectImage } = require('../script-library');
const { parseImageReference, imageReference } = require('../script-library-model');

// Shared images/ files are not part of a historical version's bytes.
// A stored-copy match means the current file's hash equals a content hash
// already stored on a production-owned asset for that same images/ name,
// and that owned file still matches its recorded hash. The historical
// version itself does not record image bytes, so the match is not proof
// that the file is the image from the original save.
// A readable image with no such match is available, not a stored copy.

const LEGACY_PATH = /^images\/([A-Za-z0-9._-]+)$/;
const CURRENT_SHARED_CONFIRMATION = 'This older version uses shared images. The images are still available, but we cannot verify that they are identical to the originals. You can restore the script using the images currently available. This will create a new saved version without changing the original historical version.';
const STORED_COPY_DESCRIPTION = 'The shared images match a copy stored with this production. That match does not prove they are the images from the original save. Restore will keep those stored copies with this production. The original version stays unchanged.';

function hashBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readNoFollow(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EPERM') {
      const error = new Error('Refusing to follow a symlink.');
      error.code = 'unsafe-path';
      throw error;
    }
    throw err;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function imageName(legacyPath) {
  const match = typeof legacyPath === 'string' ? legacyPath.match(LEGACY_PATH) : null;
  return match ? match[1] : 'An image reference';
}

function refused(code, legacyPath) {
  return {
    ok: false,
    code,
    name: imageName(legacyPath),
    legacyPath: LEGACY_PATH.test(legacyPath || '') ? legacyPath : null,
  };
}

function readSharedImage(scriptFile, legacyPath, maxImageBytes) {
  if (!LEGACY_PATH.test(legacyPath || '')) return refused('unsafe-image', legacyPath);
  if (typeof scriptFile !== 'string' || !path.isAbsolute(scriptFile)) return refused('unsafe-image', legacyPath);
  const name = imageName(legacyPath);
  const imagesDir = path.join(path.dirname(scriptFile), 'images');
  const dirStat = lstatIfExists(imagesDir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return refused('missing-image', legacyPath);
  const filePath = path.join(imagesDir, name);
  const stat = lstatIfExists(filePath);
  if (!stat) return refused('missing-image', legacyPath);
  if (stat.isSymbolicLink() || !stat.isFile()) return refused('unsafe-image', legacyPath);
  if (stat.size > maxImageBytes) return refused('invalid-image', legacyPath);
  let imagesReal;
  let fileReal;
  try {
    imagesReal = fs.realpathSync(imagesDir);
    fileReal = fs.realpathSync(filePath);
  } catch (err) {
    return refused('unsafe-image', legacyPath);
  }
  if (!contained(imagesReal, fileReal) || path.basename(fileReal) !== name) {
    return refused('unsafe-image', legacyPath);
  }
  let bytes;
  try {
    bytes = readNoFollow(filePath);
  } catch (err) {
    if (err.code === 'unsafe-path') return refused('unsafe-image', legacyPath);
    throw err;
  }
  if (bytes.length > maxImageBytes) return refused('invalid-image', legacyPath);
  const detected = detectImage(bytes);
  if (!detected || detected.incomplete || !detected.ext) return refused('invalid-image', legacyPath);
  return {
    ok: true,
    legacyPath,
    name,
    bytes,
    contentHash: hashBuffer(bytes),
    ext: detected.ext,
    mime: detected.mime,
  };
}

function legacyPaths(text) {
  const found = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*@image:\s*(.*?)\s*$/);
    if (!match) return;
    const parsed = parseImageReference(match[1]);
    if (parsed.kind !== 'legacy' || seen.has(parsed.path)) return;
    seen.add(parsed.path);
    found.push(parsed.path);
  });
  return found;
}

function blockingCode(images) {
  if (images.some((image) => image.code === 'unsafe-image')) return 'unsafe-image';
  if (images.some((image) => image.code === 'invalid-image')) return 'invalid-image';
  if (images.some((image) => image.code === 'missing-image')) return 'missing-image';
  return 'missing-image';
}

function assessSharedImages(options) {
  const settings = options || {};
  const maxImageBytes = Number.isInteger(settings.maxImageBytes) && settings.maxImageBytes > 0
    ? settings.maxImageBytes
    : 10 * 1024 * 1024;
  const paths = legacyPaths(settings.text);
  if (!paths.length) return { ok: true, status: 'none', integrity: null, images: [] };
  const snapshots = Array.isArray(settings.snapshots) ? settings.snapshots : [];
  const images = [];
  for (let index = 0; index < paths.length; index += 1) {
    const legacyPath = paths[index];
    let read;
    try {
      read = readSharedImage(settings.scriptFile, legacyPath, maxImageBytes);
    } catch (err) {
      images.push({
        ok: false,
        code: 'unsafe-image',
        name: imageName(legacyPath),
        legacyPath: LEGACY_PATH.test(legacyPath) ? legacyPath : null,
        integrity: 'unsafe-image',
      });
      continue;
    }
    if (!read.ok) {
      images.push({
        ok: false,
        code: read.code,
        name: read.name,
        legacyPath: read.legacyPath,
        integrity: read.code,
      });
      continue;
    }
    const match = snapshots.find((snapshot) => snapshot
      && snapshot.legacyPath === legacyPath
      && snapshot.contentHash === read.contentHash
      && snapshot.assetId);
    images.push({
      ok: true,
      legacyPath,
      name: read.name,
      bytes: read.bytes,
      contentHash: read.contentHash,
      ext: read.ext,
      mime: read.mime,
      integrity: match ? 'verified' : 'current-shared',
      assetId: match ? match.assetId : null,
      code: null,
    });
  }
  if (images.some((image) => !image.ok)) {
    return {
      ok: false,
      status: 'blocked',
      code: blockingCode(images),
      integrity: null,
      images,
    };
  }
  const integrity = images.every((image) => image.integrity === 'verified') ? 'verified' : 'current-shared';
  return { ok: true, status: integrity, integrity, images };
}

function rewriteSharedImageLines(text, productionId, assignments) {
  let missed = false;
  const rewritten = String(text).split(/(\r\n|\n|\r)/).map((part) => {
    if (part === '\n' || part === '\r\n' || part === '\r') return part;
    const match = part.match(/^(\s*@image:\s*)(\S.*?)(\s*)$/);
    if (!match) return part;
    const parsed = parseImageReference(match[2].trim());
    if (parsed.kind !== 'legacy') return part;
    const assetId = assignments.get(parsed.path);
    if (!assetId) {
      missed = true;
      return part;
    }
    return `${match[1]}${imageReference(productionId, assetId)}${match[3]}`;
  }).join('');
  if (missed || legacyPaths(rewritten).length) {
    return {
      ok: false,
      code: 'unsafe-image',
      error: 'An image reference could not be moved into this production. Nothing was saved.',
    };
  }
  return { ok: true, text: rewritten };
}

function publicSharedImages(images) {
  return (images || []).map((image) => ({
    name: image && image.name ? image.name : 'An image reference',
    integrity: image && image.integrity ? image.integrity : null,
    code: image && image.code ? image.code : null,
  }));
}

function loggedImageIntegrity(value) {
  if (value === 'verified') return 'stored-copy';
  if (typeof value === 'string' && value) return value;
  return '-';
}

function sharedBlockMessage(images) {
  const parts = publicSharedImages(images).filter((image) => image.code).map((image) => {
    if (image.code === 'unsafe-image') return `${image.name} is not a safe image file.`;
    if (image.code === 'missing-image') return `${image.name} is missing.`;
    return `${image.name} is not a usable image.`;
  });
  const detail = parts.length ? parts.join(' ') : 'An image in that version cannot be restored.';
  return `${detail} Nothing was saved. The original version and the live show were not changed.`;
}

module.exports = {
  CURRENT_SHARED_CONFIRMATION,
  STORED_COPY_DESCRIPTION,
  assessSharedImages,
  loggedImageIntegrity,
  publicSharedImages,
  rewriteSharedImageLines,
  sharedBlockMessage,
};
