const express = require('express');
const path = require('path');
const { timingSafeEqual } = require('crypto');
const {
  createPrivatePathGuard,
  hashText,
  isValidScriptId,
} = require('../script-library');

// HTTP routes only. Live state, the journal, and WebSocket clients stay in
// server.js. Staff-token coverage is unchanged: it still applies only where
// these routes already passed requireStaff. This is not a hosting lockdown.

function imageLimitMessage(limit) {
  const amount = limit >= 1024 * 1024 && limit % (1024 * 1024) === 0
    ? `${limit / (1024 * 1024)} MB`
    : `${limit} bytes`;
  return `That image is too large. Use a file of ${amount} or smaller.`;
}

function readLimitedBody(limit) {
  return function readLimitedBodyMiddleware(req, res, next) {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limit) {
        rejected = true;
        res.status(413).json({ ok: false, error: imageLimitMessage(limit) });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.headersSent) return;
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on('error', () => {
      if (rejected || res.headersSent) return;
      res.status(400).json({ ok: false, error: 'That image could not be read.' });
    });
  };
}

function assetNameFromRequest(req) {
  const raw = req.get('X-Asset-Name') || '';
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch (err) {
    return '';
  }
}

function staffTokensMatch(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function registerHttpRoutes(deps) {
  const app = deps.app;
  const staticRoot = deps.staticRoot;
  const library = deps.library;
  const staffToken = deps.staffToken;
  const imageMaxBytes = deps.imageMaxBytes;
  const writeLiveScript = deps.writeLiveScript;
  const broadcast = deps.broadcast;
  const rememberLiveScript = deps.rememberLiveScript;

  function requireStaff(req, res, next) {
    if (!staffToken) return next();
    if (staffTokensMatch(req.get('X-Staff-Token') || '', staffToken)) return next();
    return res.status(401).json({
      ok: false,
      error: 'The staff access code was not accepted.',
    });
  }

  function sendAsset(res, asset) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(asset.mime);
    return res.send(asset.body);
  }

  function referencedTexts() {
    const texts = [];
    try { texts.push(deps.readLiveScript()); } catch (err) { /* The live file may not exist yet. */ }
    try { texts.push(deps.readPreviousScript()); } catch (err) { /* There may be no previous script. */ }
    return texts;
  }

  function libraryScript(result) {
    return {
      id: result.id,
      title: result.title,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      revision: result.revision,
      live: result.id === library.getLiveId(),
    };
  }

  // The controller page is not server-side authorization. ?role=controller
  // only changes the browser. Script upload stays reachable by anyone who
  // can reach the server, matching the previous Replace Script behavior.
  // Library routes use PROMPTER_STAFF_TOKEN when that variable is set.
  app.use(express.text({ type: 'text/plain', limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(createPrivatePathGuard(deps.libraryDir, staticRoot, [deps.journalDir]));
  app.use(express.static(staticRoot, { index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(staticRoot, 'client.html'));
  });

  app.get('/api/library/access', (req, res) => {
    res.json({ ok: true, required: Boolean(staffToken) });
  });

  app.get('/api/library', requireStaff, (req, res) => {
    const listed = library.list();
    res.json({
      ok: true,
      liveId: listed.liveId,
      scripts: listed.scripts.map((entry) => ({
        ...entry,
        live: entry.id === listed.liveId,
      })),
    });
  });

  app.post('/api/library', requireStaff, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const created = library.create({ title: body.title, text: body.text });
    if (!created.ok) {
      return res.status(created.status || 400).json({ ok: false, error: created.error, code: created.code });
    }
    if (body.trackIfCurrent === true && hashText(body.text) === deps.getScriptRevision()) {
      const currentId = library.getLiveId();
      const current = currentId ? library.read(currentId) : null;
      if (!current || !current.ok || current.revision !== deps.getScriptRevision()) {
        library.setLiveId(created.id);
      }
    }
    return res.status(201).json({ ok: true, script: libraryScript(created), liveId: library.getLiveId() });
  });

  app.get('/api/library/:id', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'That script id is not valid.' });
    }
    const record = library.read(req.params.id);
    if (!record.ok) {
      return res.status(record.status || 404).json({ ok: false, error: record.error });
    }
    return res.json({
      ok: true,
      script: { ...libraryScript(record), text: record.text },
    });
  });

  app.put('/api/library/:id', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'That script id is not valid.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const changes = { expectedRevision: body.expectedRevision };
    if (Object.prototype.hasOwnProperty.call(body, 'title')) changes.title = body.title;
    if (Object.prototype.hasOwnProperty.call(body, 'text')) changes.text = body.text;
    const updated = library.update(req.params.id, changes);
    if (!updated.ok) {
      return res.status(updated.status || 400).json({
        ok: false,
        error: updated.error,
        code: updated.code,
      });
    }
    return res.json({
      ok: true,
      unchanged: Boolean(updated.unchanged),
      script: libraryScript(updated),
      liveId: library.getLiveId(),
    });
  });

  app.get('/api/library/:id/assets', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'That script id is not valid.' });
    }
    const listed = library.listAssets(req.params.id);
    if (!listed.ok) {
      return res.status(listed.status || 404).json({ ok: false, error: listed.error });
    }
    return res.json({ ok: true, assets: listed.assets });
  });

  app.post('/api/library/:id/assets', requireStaff, readLimitedBody(imageMaxBytes), (req, res) => {
    if (!isValidScriptId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'That script id is not valid.' });
    }
    const saved = library.addAsset(req.params.id, {
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      name: assetNameFromRequest(req),
    });
    if (!saved.ok) {
      return res.status(saved.status || 400).json({ ok: false, error: saved.error, code: saved.code });
    }
    return res.status(201).json({ ok: true, asset: saved.asset });
  });

  app.get('/api/library/:id/assets/:assetId', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id) || !isValidScriptId(req.params.assetId)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const asset = library.readAsset(req.params.id, req.params.assetId);
    if (!asset.ok) return res.status(404).type('text/plain').send('Not found');
    return sendAsset(res, asset);
  });

  app.delete('/api/library/:id/assets/:assetId', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id) || !isValidScriptId(req.params.assetId)) {
      return res.status(400).json({ ok: false, error: 'That image could not be found.' });
    }
    const removed = library.removeAsset(req.params.id, req.params.assetId, referencedTexts());
    if (!removed.ok) {
      return res.status(removed.status || 400).json({ ok: false, error: removed.error, code: removed.code });
    }
    return res.json({ ok: true });
  });

  app.get('/api/live/assets/:scriptId/:assetId', (req, res) => {
    const scriptId = String(req.params.scriptId || '').toLowerCase();
    const assetId = String(req.params.assetId || '').toLowerCase();
    if (!isValidScriptId(scriptId) || !isValidScriptId(assetId)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    if (!deps.getLiveRaw().toLowerCase().includes(`library:${scriptId}/${assetId}`)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const asset = library.readAsset(scriptId, assetId);
    if (!asset.ok) return res.status(404).type('text/plain').send('Not found');
    return sendAsset(res, asset);
  });

  app.post('/api/library/:id/live', requireStaff, (req, res) => {
    if (!isValidScriptId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'That script id is not valid.' });
    }
    const record = library.read(req.params.id);
    if (!record.ok) {
      return res.status(record.status || 404).json({ ok: false, error: record.error });
    }
    const requestBody = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : {};
    const expectedRevision = typeof requestBody.expectedRevision === 'string'
      ? requestBody.expectedRevision
      : '';
    // Missing and stale revisions are rejected before the live file is touched.
    // A rename does not change the revision, because the revision is the script text.
    if (!expectedRevision) {
      return res.status(400).json({
        ok: false,
        code: 'revision-required',
        error: 'The script revision was missing, so this script was not set live. Open the library again and review the script before setting it live.',
      });
    }
    if (record.revision !== expectedRevision) {
      return res.status(409).json({
        ok: false,
        code: 'conflict',
        error: 'This saved script changed after you reviewed it. It was not set live. Review the latest version, then set it live again.',
      });
    }
    const previousId = library.getLiveId();
    const differentProduction = previousId !== record.id;
    let previousTitle = '';
    if (previousId) {
      const previous = library.read(previousId);
      if (previous.ok) previousTitle = previous.title;
    }
    const missingImages = library.countMissingImages(record.text);
    const written = writeLiveScript(record.text, !differentProduction);
    if (!written.ok) {
      return res.status(written.status || 500).json({ ok: false, error: written.error });
    }
    library.setLiveId(record.id);
    try {
      broadcast({
        type: 'script',
        slides: deps.getSlides(),
        revision: deps.getScriptRevision(),
        liveScriptId: library.getLiveId(),
      });
    } catch (err) {
      console.error(err);
    }
    return res.json({
      ok: true,
      unchanged: !written.changed && !differentProduction,
      resetPosition: differentProduction,
      revision: deps.getScriptRevision(),
      liveId: record.id,
      title: record.title,
      previousTitle: previousTitle || 'Unsaved live script',
      slides: deps.getSlides().length,
      missingImages,
    });
  });

  app.post('/script', (req, res) => {
    const libraryId = req.get('X-Library-Id') || '';
    const expectedRevision = req.get('X-Library-Revision') || '';
    const resetPosition = req.get('X-Reset-Position') === '1';
    const restoreRequested = req.get('X-Restore-Previous') === '1';
    if (restoreRequested) {
      let previousText = '';
      try {
        previousText = deps.readPreviousText();
      } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'Could not read the script' });
      }
      if (!previousText || req.body !== previousText) {
        return res.status(400).json({
          ok: false,
          error: 'The previous script could not be restored. The live show was not changed.',
        });
      }
    }
    const written = writeLiveScript(req.body, !resetPosition);
    if (!written.ok) {
      return res.status(written.status || 500).json({ ok: false, error: written.error });
    }

    let libraryUpdated = false;
    let libraryConflict = false;
    // A restore swaps the live file only. Library rows keep the text
    // each production was saved with, including when this request also
    // carries the id of the production that is live right now.
    if ((libraryId || expectedRevision) && !written.restoredFromPrevious) {
      const currentLiveId = library.getLiveId();
      if (
        libraryId
        && expectedRevision
        && currentLiveId
        && libraryId === currentLiveId
        && !resetPosition
      ) {
        const updated = library.update(libraryId, {
          text: written.text,
          expectedRevision,
        });
        libraryUpdated = Boolean(updated.ok);
        libraryConflict = updated.code === 'conflict';
      }
    }
    const liveScriptId = rememberLiveScript(written.restoredLiveId, written.text);
    try {
      broadcast({
        type: 'script',
        slides: deps.getSlides(),
        revision: deps.getScriptRevision(),
        liveScriptId,
      });
    } catch (err) {
      console.error(err);
    }

    return res.json({
      ok: true,
      slides: deps.getSlides().length,
      revision: deps.getScriptRevision(),
      unchanged: !written.changed,
      liveScriptId,
      libraryUpdated,
      libraryConflict,
    });
  });

  app.get('/script/previous', (req, res) => {
    if (!deps.previousScriptExists()) {
      return res.status(404).json({ error: 'No previous script' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(deps.readPreviousScript());
  });

  app.get('/script', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(deps.readLiveScript());
  });
}

module.exports = { registerHttpRoutes };
