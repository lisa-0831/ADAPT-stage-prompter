const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validate } = require('./script-editor-model');

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
    fs.writeFileSync(tmp, data, 'utf8');
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

function createPrivatePathGuard(libraryDir, staticRoot) {
  const resolvedLibrary = path.resolve(libraryDir);
  const root = path.resolve(staticRoot);
  const relative = path.relative(root, resolvedLibrary);
  const insideRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  const urlPrefix = insideRoot && relative
    ? `/${relative.split(path.sep).filter(Boolean).join('/')}`
    : null;

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
    const blockedPrefix = urlPrefix && (
      pathname === urlPrefix || pathname.startsWith(`${urlPrefix}/`)
    );
    const resolved = path.resolve(root, `.${pathname}`);
    const insideLibrary = resolved === resolvedLibrary
      || resolved.startsWith(`${resolvedLibrary}${path.sep}`);
    if (blockedPrefix || insideLibrary) {
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
  const indexPath = path.join(dir, 'index.json');
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
    loadIndex();
    reconcile();
    return list();
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
};
