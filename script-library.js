const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validate } = require('./script-editor-model');
const { parseScript } = require('./script-format');
const { imageReference, parseImageReference } = require('./script-library-model');

const SCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TITLE_MAX = 120;

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isValidScriptId(id) {
  return typeof id === 'string' && SCRIPT_ID.test(id);
}

function titleFromScript(text) {
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#\s+(.+?)\s*$/);
    if (!match) continue;
    const title = match[1].replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, TITLE_MAX);
  }
  return '';
}

function normalizeTitle(title) {
  if (typeof title !== 'string') {
    return { ok: false, status: 400, error: 'Enter a title for this script.' };
  }
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return { ok: false, status: 400, error: 'Enter a title that includes a name for this script.' };
  }
  if (trimmed.length > TITLE_MAX) {
    return { ok: false, status: 400, error: 'That title is too long. Use 120 characters or fewer.' };
  }
  if (/[\u0000-\u001F]/.test(trimmed)) {
    return { ok: false, status: 400, error: 'That title contains characters that cannot be saved.' };
  }
  return { ok: true, title: trimmed };
}

function writeAtomic(filePath, data) {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    if (Buffer.isBuffer(data)) fs.writeFileSync(tmp, data);
    else fs.writeFileSync(tmp, data, 'utf8');
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* The temp file may already be gone. */ }
    throw err;
  }
}

const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    const complete = buffer[buffer.length - 2] === 0xFF && buffer[buffer.length - 1] === 0xD9;
    return complete ? { ext: 'jpg', mime: IMAGE_TYPES.jpg } : { incomplete: true };
  }
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  if (buffer.subarray(0, 8).equals(png)) {
    const marker = buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii');
    return marker === 'IEND' ? { ext: 'png', mime: IMAGE_TYPES.png } : { incomplete: true };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const size = buffer.readUInt32LE(4);
    const expected = size + 8;
    const padded = size % 2 === 1 && buffer.length === expected + 1;
    return buffer.length === expected || padded
      ? { ext: 'webp', mime: IMAGE_TYPES.webp }
      : { incomplete: true };
  }
  return null;
}

function displayAssetName(originalName) {
  const base = path.basename(String(originalName || 'Image')).replace(/[\u0000-\u001F]/g, '');
  const cleaned = base.replace(/[\\/]/g, '').trim().slice(0, 120);
  return cleaned || 'Image';
}

function createPrivatePathGuard(libraryDir, staticRoot, extraPrivateDirs = []) {
  const root = path.resolve(staticRoot);
  const directories = [libraryDir].concat(extraPrivateDirs).filter(Boolean).map((dirPath) => {
    const resolvedDir = path.resolve(dirPath);
    const relative = path.relative(root, resolvedDir);
    const insideRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    const urlPrefix = insideRoot && relative
      ? `/${relative.split(path.sep).filter(Boolean).join('/')}`
      : null;
    return { resolvedDir, urlPrefix };
  });

  return function privatePathGuard(req, res, next) {
    let pathname = req.path || '';
    try {
      pathname = decodeURIComponent(pathname);
    } catch (err) {
      res.status(400).type('text/plain').send('Bad request');
      return;
    }
    if (pathname.includes('\0')) {
      res.status(400).type('text/plain').send('Bad request');
      return;
    }
    const resolved = path.resolve(root, `.${pathname}`);
    const blocked = directories.some((dir) => {
      const blockedPrefix = dir.urlPrefix && (
        pathname === dir.urlPrefix || pathname.startsWith(`${dir.urlPrefix}/`)
      );
      const insideDir = resolved === dir.resolvedDir
        || resolved.startsWith(`${dir.resolvedDir}${path.sep}`);
      return blockedPrefix || insideDir;
    });
    if (blocked) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    next();
  };
}

function createScriptLibrary(options = {}) {
  if (!options.dir) throw new Error('A library directory is required');
  const dir = path.resolve(options.dir);
  const scriptsDir = path.join(dir, 'scripts');
  const assetsRoot = path.join(dir, 'assets');
  const indexPath = path.join(dir, 'index.json');
  const maxImageBytes = Number.isInteger(options.maxImageBytes) && options.maxImageBytes > 0
    ? options.maxImageBytes
    : 10 * 1024 * 1024;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  let index = { version: 1, liveId: null, scripts: [] };

  function timestamp() {
    return now().toISOString();
  }

  function scriptFile(id) {
    if (!isValidScriptId(id)) {
      const error = new Error('Invalid script id');
      error.code = 'invalid-id';
      throw error;
    }
    const filePath = path.resolve(scriptsDir, `${id}.txt`);
    if (!filePath.startsWith(`${path.resolve(scriptsDir)}${path.sep}`)) {
      const error = new Error('Invalid script id');
      error.code = 'invalid-id';
      throw error;
    }
    return filePath;
  }

  function cloneMeta(entry) {
    return {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      revision: entry.revision,
    };
  }

  function persistIndex() {
    writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  function quarantineIndex() {
    const dest = path.join(dir, `index.corrupt-${Date.now()}.json`);
    try {
      fs.renameSync(indexPath, dest);
    } catch (err) {
      try { fs.unlinkSync(indexPath); } catch (_) { /* Already unreadable. */ }
    }
    console.warn('[library] Rebuilt library metadata after an unreadable index');
  }

  function metaFromFile(id) {
    const filePath = scriptFile(id);
    const text = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    const when = stat.mtime.toISOString();
    return {
      id,
      title: titleFromScript(text) || 'Recovered script',
      createdAt: when,
      updatedAt: when,
      revision: hashText(text),
    };
  }

  function readStoredIds() {
    let names = [];
    try {
      names = fs.readdirSync(scriptsDir);
    } catch (err) {
      return [];
    }
    const ids = [];
    names.forEach((name) => {
      const match = name.match(/^([0-9a-f-]{36})\.txt$/i);
      if (!match) return;
      const id = match[1].toLowerCase();
      if (isValidScriptId(id)) ids.push(id);
    });
    return ids;
  }

  function loadIndex() {
    if (!fs.existsSync(indexPath)) {
      index = { version: 1, liveId: null, scripts: [] };
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.scripts)) {
        throw new Error('invalid library index');
      }
      const seen = new Set();
      const scripts = [];
      parsed.scripts.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : '';
        if (!isValidScriptId(id) || seen.has(id)) return;
        seen.add(id);
        const titled = normalizeTitle(entry.title);
        scripts.push({
          id,
          title: titled.ok ? titled.title : (titleFromScript('') || 'Recovered script'),
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : timestamp(),
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : timestamp(),
          revision: typeof entry.revision === 'string' ? entry.revision : '',
        });
      });
      index = {
        version: 1,
        liveId: isValidScriptId(parsed.liveId) ? parsed.liveId.toLowerCase() : null,
        scripts,
      };
    } catch (err) {
      quarantineIndex();
      index = { version: 1, liveId: null, scripts: [] };
    }
  }

  function reconcile() {
    const onDisk = readStoredIds();
    const known = new Set(index.scripts.map((entry) => entry.id));
    let changed = false;
    const kept = [];
    index.scripts.forEach((entry) => {
      const filePath = scriptFile(entry.id);
      if (!fs.existsSync(filePath)) {
        changed = true;
        console.warn('[library] Skipped a library entry with a missing file');
        return;
      }
      let text = '';
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        changed = true;
        console.warn('[library] Skipped a library entry that could not be read');
        return;
      }
      const revision = hashText(text);
      if (entry.revision !== revision) {
        entry.revision = revision;
        entry.updatedAt = timestamp();
        changed = true;
      }
      if (!entry.title) {
        entry.title = titleFromScript(text) || 'Recovered script';
        changed = true;
      }
      kept.push(entry);
    });
    index.scripts = kept;
    onDisk.forEach((id) => {
      if (known.has(id)) return;
      try {
        index.scripts.push(metaFromFile(id));
        changed = true;
      } catch (err) {
        console.warn('[library] Skipped a library file that could not be read');
      }
    });
    if (index.liveId && !index.scripts.some((entry) => entry.id === index.liveId)) {
      index.liveId = null;
      changed = true;
    }
    if (changed || !fs.existsSync(indexPath)) persistIndex();
  }

  function open() {
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(assetsRoot, { recursive: true });
    loadIndex();
    reconcile();
    return list();
  }

  function assetsDir(scriptId) {
    if (!isValidScriptId(scriptId)) {
      const error = new Error('Invalid script id');
      error.code = 'invalid-id';
      throw error;
    }
    const folder = path.resolve(assetsRoot, scriptId.toLowerCase());
    const root = path.resolve(assetsRoot);
    if (folder !== path.join(root, scriptId.toLowerCase())) {
      const error = new Error('Invalid script id');
      error.code = 'invalid-id';
      throw error;
    }
    return folder;
  }

  function manifestPath(scriptId) {
    return path.join(assetsDir(scriptId), 'manifest.json');
  }

  function assetPath(scriptId, assetId, ext) {
    if (!isValidScriptId(assetId) || !IMAGE_TYPES[ext]) {
      const error = new Error('Invalid asset id');
      error.code = 'invalid-id';
      throw error;
    }
    const folder = assetsDir(scriptId);
    const filePath = path.resolve(folder, `${assetId.toLowerCase()}.${ext}`);
    if (!filePath.startsWith(`${folder}${path.sep}`)) {
      const error = new Error('Invalid asset id');
      error.code = 'invalid-id';
      throw error;
    }
    return filePath;
  }

  function emptyManifest() {
    return { version: 1, assets: [] };
  }

  function cloneAsset(scriptId, asset) {
    return {
      id: asset.id,
      scriptId,
      name: asset.name,
      mime: asset.mime,
      bytes: asset.bytes,
      createdAt: asset.createdAt,
    };
  }

  function rebuildManifest(scriptId) {
    const folder = assetsDir(scriptId);
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch (err) {
      return emptyManifest();
    }
    const assets = [];
    names.forEach((name) => {
      const match = name.match(/^([0-9a-f-]{36})\.(jpg|png|webp)$/i);
      if (!match || !isValidScriptId(match[1].toLowerCase())) return;
      const ext = match[2].toLowerCase();
      const id = match[1].toLowerCase();
      let buffer;
      try {
        buffer = fs.readFileSync(assetPath(scriptId, id, ext));
      } catch (err) {
        return;
      }
      const detected = detectImage(buffer);
      if (!detected || detected.incomplete || detected.ext !== ext) return;
      const stat = fs.statSync(assetPath(scriptId, id, ext));
      assets.push({
        id,
        name: 'Recovered image',
        ext,
        mime: detected.mime,
        bytes: buffer.length,
        createdAt: stat.mtime.toISOString(),
      });
    });
    const manifest = { version: 1, assets };
    fs.mkdirSync(folder, { recursive: true });
    writeAtomic(manifestPath(scriptId), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  function loadManifest(scriptId) {
    const filePath = manifestPath(scriptId);
    if (!fs.existsSync(filePath)) return emptyManifest();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.assets)) {
        throw new Error('invalid asset manifest');
      }
      const seen = new Set();
      const assets = [];
      parsed.assets.forEach((asset) => {
        if (!asset || typeof asset !== 'object') return;
        const id = typeof asset.id === 'string' ? asset.id.toLowerCase() : '';
        const ext = asset.ext;
        if (!isValidScriptId(id) || !IMAGE_TYPES[ext] || seen.has(id)) return;
        if (!fs.existsSync(assetPath(scriptId, id, ext))) return;
        seen.add(id);
        assets.push({
          id,
          name: displayAssetName(asset.name),
          ext,
          mime: IMAGE_TYPES[ext],
          bytes: Number.isInteger(asset.bytes) ? asset.bytes : 0,
          createdAt: typeof asset.createdAt === 'string' ? asset.createdAt : timestamp(),
        });
      });
      return { version: 1, assets };
    } catch (err) {
      const dest = path.join(assetsDir(scriptId), `manifest.corrupt-${Date.now()}.json`);
      try { fs.renameSync(filePath, dest); } catch (_) { /* Already unreadable. */ }
      console.warn('[library] Rebuilt an image list after an unreadable manifest');
      return rebuildManifest(scriptId);
    }
  }

  function saveManifest(scriptId, manifest) {
    fs.mkdirSync(assetsDir(scriptId), { recursive: true });
    writeAtomic(manifestPath(scriptId), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  function listAssets(scriptId) {
    if (!isValidScriptId(scriptId)) return invalidId();
    if (!find(scriptId)) return missing();
    const manifest = loadManifest(scriptId);
    return {
      ok: true,
      assets: manifest.assets.map((asset) => cloneAsset(scriptId, asset)),
    };
  }

  function readAsset(scriptId, assetId) {
    if (!isValidScriptId(scriptId) || !isValidScriptId(assetId)) return invalidId();
    const manifest = loadManifest(scriptId);
    const asset = manifest.assets.find((entry) => entry.id === assetId.toLowerCase());
    if (!asset) return { ok: false, status: 404, code: 'missing', error: 'That image could not be found.' };
    try {
      const filePath = assetPath(scriptId, asset.id, asset.ext);
      const body = fs.readFileSync(filePath);
      return { ok: true, ...cloneAsset(scriptId, asset), body };
    } catch (err) {
      return { ok: false, status: 404, code: 'missing', error: 'That image could not be found.' };
    }
  }

  function imageTooLarge() {
    const limit = maxImageBytes >= 1024 * 1024 && maxImageBytes % (1024 * 1024) === 0
      ? `${maxImageBytes / (1024 * 1024)} MB`
      : `${maxImageBytes} bytes`;
    return {
      ok: false,
      status: 413,
      code: 'too-large',
      error: `That image is too large. Use a file of ${limit} or smaller.`,
    };
  }

  function addAsset(scriptId, input) {
    if (!isValidScriptId(scriptId)) return invalidId();
    if (!find(scriptId)) return missing();
    const body = input && input.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return { ok: false, status: 400, code: 'invalid-image', error: 'That file is not a JPEG, PNG, or WebP image.' };
    }
    if (body.length > maxImageBytes) return imageTooLarge();
    const detected = detectImage(body);
    if (!detected) {
      return { ok: false, status: 400, code: 'invalid-image', error: 'That file is not a JPEG, PNG, or WebP image.' };
    }
    if (detected.incomplete) {
      return { ok: false, status: 400, code: 'incomplete-image', error: 'That image file is incomplete. Try exporting it again.' };
    }
    const id = crypto.randomUUID();
    const asset = {
      id,
      name: displayAssetName(input && input.name),
      ext: detected.ext,
      mime: detected.mime,
      bytes: body.length,
      createdAt: timestamp(),
    };
    const manifest = loadManifest(scriptId);
    fs.mkdirSync(assetsDir(scriptId), { recursive: true });
    writeAtomic(assetPath(scriptId, id, detected.ext), body);
    manifest.assets.push(asset);
    try {
      saveManifest(scriptId, manifest);
    } catch (err) {
      try { fs.unlinkSync(assetPath(scriptId, id, detected.ext)); } catch (_) { /* The file may already be gone. */ }
      return { ok: false, status: 500, code: 'unreadable', error: 'That image could not be saved.' };
    }
    return { ok: true, asset: cloneAsset(scriptId, asset) };
  }

  function assetReferenced(scriptId, assetId, extraTexts) {
    const needle = imageReference(scriptId, assetId).toLowerCase();
    const texts = [];
    index.scripts.forEach((entry) => {
      try { texts.push(fs.readFileSync(scriptFile(entry.id), 'utf8')); } catch (err) { /* Skip an unreadable script. */ }
    });
    (extraTexts || []).forEach((text) => {
      if (typeof text === 'string') texts.push(text);
    });
    return texts.some((text) => text.toLowerCase().includes(needle));
  }

  function removeAsset(scriptId, assetId, extraTexts) {
    if (!isValidScriptId(scriptId) || !isValidScriptId(assetId)) return invalidId();
    if (!find(scriptId)) return missing();
    const manifest = loadManifest(scriptId);
    const asset = manifest.assets.find((entry) => entry.id === assetId.toLowerCase());
    if (!asset) return { ok: false, status: 404, code: 'missing', error: 'That image could not be found.' };
    if (assetReferenced(scriptId, asset.id, extraTexts)) {
      return {
        ok: false,
        status: 409,
        code: 'in-use',
        error: 'This image is still used by a script. Remove it from the scene and save before deleting it.',
      };
    }
    try {
      fs.unlinkSync(assetPath(scriptId, asset.id, asset.ext));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { ok: false, status: 500, code: 'unreadable', error: 'That image could not be removed.' };
      }
    }
    manifest.assets = manifest.assets.filter((entry) => entry.id !== asset.id);
    saveManifest(scriptId, manifest);
    return { ok: true };
  }

  function countMissingImages(text) {
    let slides = [];
    try {
      slides = parseScript(text);
    } catch (err) {
      return 0;
    }
    const seen = new Set();
    let missing = 0;
    slides.forEach((slide) => {
      const parsed = parseImageReference(slide && slide.titleImage);
      if (parsed.kind !== 'library') return;
      const key = `${parsed.scriptId}/${parsed.assetId}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!readAsset(parsed.scriptId, parsed.assetId).ok) missing += 1;
    });
    return missing;
  }

  function find(id) {
    if (!isValidScriptId(id)) return null;
    return index.scripts.find((entry) => entry.id === id.toLowerCase()) || null;
  }

  function invalidId() {
    return { ok: false, status: 400, code: 'invalid-id', error: 'That script id is not valid.' };
  }

  function missing() {
    return { ok: false, status: 404, code: 'missing', error: 'That saved script could not be found.' };
  }

  function validationError(result) {
    const message = result.errors[0] && result.errors[0].message
      ? result.errors[0].message
      : 'This script could not be saved.';
    return { ok: false, status: 400, code: 'invalid-script', error: message };
  }

  function list() {
    const scripts = index.scripts.map(cloneMeta).sort((a, b) => {
      if (a.id === index.liveId) return -1;
      if (b.id === index.liveId) return 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    return { liveId: index.liveId, scripts };
  }

  function read(id) {
    if (!isValidScriptId(id)) return invalidId();
    const entry = find(id);
    if (!entry) return missing();
    try {
      const text = fs.readFileSync(scriptFile(entry.id), 'utf8');
      return { ok: true, ...cloneMeta(entry), text };
    } catch (err) {
      return { ok: false, status: 500, code: 'unreadable', error: 'That saved script could not be read.' };
    }
  }

  function create(input) {
    const titled = normalizeTitle(input && input.title);
    if (!titled.ok) return titled;
    if (!input || typeof input.text !== 'string') {
      return { ok: false, status: 400, code: 'invalid-script', error: 'The script could not be read.' };
    }
    const checked = validate(input.text);
    if (!checked.ok) return validationError(checked);
    const id = crypto.randomUUID();
    const when = timestamp();
    const entry = {
      id,
      title: titled.title,
      createdAt: when,
      updatedAt: when,
      revision: hashText(input.text),
    };
    writeAtomic(scriptFile(id), input.text);
    index.scripts.push(entry);
    persistIndex();
    return { ok: true, ...cloneMeta(entry) };
  }

  function update(id, input) {
    if (!isValidScriptId(id)) return invalidId();
    const entry = find(id);
    if (!entry) return missing();
    const changes = input || {};
    if (typeof changes.expectedRevision !== 'string' || changes.expectedRevision === '') {
      return {
        ok: false,
        status: 400,
        code: 'revision-required',
        error: 'The script revision was missing, so nothing was saved.',
      };
    }
    if (entry.revision !== changes.expectedRevision) {
      return {
        ok: false,
        status: 409,
        code: 'conflict',
        error: 'This saved script was changed after you opened it. Your edits were not saved over that newer copy.',
      };
    }
    let nextTitle = entry.title;
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
      const titled = normalizeTitle(changes.title);
      if (!titled.ok) return titled;
      nextTitle = titled.title;
    }
    let nextText = null;
    if (Object.prototype.hasOwnProperty.call(changes, 'text')) {
      if (typeof changes.text !== 'string') {
        return { ok: false, status: 400, code: 'invalid-script', error: 'The script could not be read.' };
      }
      const checked = validate(changes.text);
      if (!checked.ok) return validationError(checked);
      nextText = changes.text;
    }
    const nextRevision = nextText === null ? entry.revision : hashText(nextText);
    if (nextRevision === entry.revision && nextTitle === entry.title) {
      return { ok: true, unchanged: true, ...cloneMeta(entry) };
    }
    if (nextText !== null && nextRevision !== entry.revision) {
      writeAtomic(scriptFile(entry.id), nextText);
    }
    entry.title = nextTitle;
    entry.revision = nextRevision;
    entry.updatedAt = timestamp();
    persistIndex();
    return { ok: true, unchanged: false, ...cloneMeta(entry) };
  }

  function setLiveId(id) {
    if (id === null) {
      index.liveId = null;
      persistIndex();
      return { ok: true, liveId: null };
    }
    if (!isValidScriptId(id)) return invalidId();
    const entry = find(id);
    if (!entry) return missing();
    index.liveId = entry.id;
    persistIndex();
    return { ok: true, liveId: entry.id };
  }

  function getLiveId() {
    return index.liveId;
  }

  function findByRevision(revision) {
    const matches = index.scripts.filter((entry) => entry.revision === revision);
    if (!matches.length) return null;
    return matches.find((entry) => entry.id === index.liveId)
      || matches.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  }

  function adoptLiveText(text) {
    if (typeof text !== 'string') {
      return { ok: false, status: 400, code: 'invalid-script', adopted: false };
    }
    const checked = validate(text);
    if (!checked.ok) {
      return { ok: false, status: 400, code: 'invalid-script', adopted: false };
    }
    const revision = hashText(text);
    const existing = findByRevision(revision);
    if (existing) {
      if (index.liveId !== existing.id) {
        index.liveId = existing.id;
        persistIndex();
      }
      return { ok: true, adopted: false, created: false, ...cloneMeta(existing) };
    }
    const created = create({
      title: titleFromScript(text) || 'Current live script',
      text,
    });
    if (!created.ok) return { ...created, adopted: false };
    index.liveId = created.id;
    persistIndex();
    return { ok: true, adopted: true, created: true, ...created };
  }

  return {
    dir,
    open,
    list,
    read,
    create,
    update,
    setLiveId,
    getLiveId,
    findByRevision,
    adoptLiveText,
    listAssets,
    readAsset,
    addAsset,
    removeAsset,
    countMissingImages,
    maxImageBytes,
  };
}

module.exports = {
  TITLE_MAX,
  hashText,
  isValidScriptId,
  titleFromScript,
  normalizeTitle,
  writeAtomic,
  createPrivatePathGuard,
  createScriptLibrary,
  detectImage,
  displayAssetName,
};
