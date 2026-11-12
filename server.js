const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { timingSafeEqual } = require('crypto');
const { parseScript, positionAfterScriptReplace } = require('./script-format');
const { stagePublishedScript } = require('./script-editor-model');
const {
  createScriptLibrary,
  writeAtomic,
  createPrivatePathGuard,
  hashText,
  isValidScriptId,
} = require('./script-library');

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

function defaultScript() {
  return `# Scene 1 | Kansas Place in Brooklyn, New York
{DOROTHY Enters. TOTO, her service dog, is with her, played by an actor, wheelchair decorated like a basket.}
## SOMEWHERE OVER THE RAINBOW, WAY UP HIGH,
THERE'S A LAND THAT I HEARD OF ONCE IN A LULLABY.
SOMEWHERE OVER THE RAINBOW, SKIES ARE BLUE,
AND THE DREAMS THAT YOU DARE TO DREAM REALLY DO COME TRUE. ##
[DOROTHY]
Oh Toto, sometimes I fear I will never leave home.
I will just stay here on Kansas Place forever. Me. You. And My Chair.
{MS. GULCH enters furiously.}
[GULCH]
Where is that pest?!
[DOROTHY]
What do you want with Toto? He never did anything to you.
[GULCH]
He bit my leg. He belongs in the pound.
{AUNT EM & UNCLE HENRY enter from behind the house.}
[AUNT EM]
What are you doing here? Get the ffffunk out of here.
[GULCH]
I'll get you. And your little dog too.
{She drives away.}
[AUNT EM]
Don't be sad, Dorothy. Be happy. Don't worry about that old bat.
[DOROTHY]
I don't know why she is so mean. Maybe if we got to know her? Or brought her some flowers.`;
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

function createPrompterServer(options = {}) {
  const scriptFile = options.scriptFile || process.env.SCRIPT_FILE || path.join(__dirname, 'script.txt');
  const previousFile = options.previousFile
    || process.env.PREVIOUS_SCRIPT_FILE
    || path.join(__dirname, 'script.previous.txt');
  const libraryDir = options.libraryDir
    || process.env.SCRIPT_LIBRARY_DIR
    || path.join(path.dirname(scriptFile), 'data', 'library');
  const staffToken = options.staffToken !== undefined
    ? options.staffToken
    : (process.env.PROMPTER_STAFF_TOKEN || '');
  const configuredLimit = Number(process.env.PROMPTER_IMAGE_MAX_BYTES);
  const imageMaxBytes = Number.isInteger(options.imageMaxBytes) && options.imageMaxBytes > 0
    ? options.imageMaxBytes
    : (Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 10 * 1024 * 1024);
  const library = createScriptLibrary({ dir: libraryDir, maxImageBytes: imageMaxBytes });
  const previousMetaFile = `${previousFile}.meta.json`;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  let slides = [];
  let scriptRevision = '';
  let liveRaw = '';
  let state = {
    slideIndex: 0,
    lineIndex: 0,
    showLine: true,
    showTitleImage: false,
  };

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function currentSlide() {
    return slides[state.slideIndex] || { title: '', lines: [] };
  }

  function broadcast(msg) {
    let data;
    try {
      data = JSON.stringify(msg);
    } catch (err) {
      console.error(err);
      return;
    }
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(data);
      } catch (err) {
        console.error(err);
      }
    });
  }

  function loadScript(preservePosition = false) {
    if (!fs.existsSync(scriptFile)) {
      fs.writeFileSync(scriptFile, defaultScript());
      console.log('[server] Created default script.txt');
    }
    const raw = fs.readFileSync(scriptFile, 'utf8');
    liveRaw = raw;
    slides = parseScript(raw);
    scriptRevision = hashText(raw);

    if (preservePosition) {
      // Keep the scene and line numbers when they still exist. The words
      // at those numbers may be different after a publish.
      const next = positionAfterScriptReplace(state, slides);
      state.slideIndex = next.slideIndex;
      state.lineIndex = next.lineIndex;
    } else {
      state.slideIndex = 0;
      state.lineIndex = 0;
      state.showTitleImage = !!(slides[0] && slides[0].titleImage);
    }

    console.log(`[server] Loaded ${slides.length} slide(s)`);
    broadcast({
      type: 'script',
      slides,
      revision: scriptRevision,
      liveScriptId: library.getLiveId(),
    });
    broadcast({ type: 'state', state });
  }

  function readTextFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  function readPreviousMeta() {
    try {
      if (!fs.existsSync(previousMetaFile)) return { liveId: null };
      const parsed = JSON.parse(fs.readFileSync(previousMetaFile, 'utf8'));
      const liveId = parsed && typeof parsed.liveId === 'string' ? parsed.liveId : null;
      return { liveId: isValidScriptId(liveId) ? liveId.toLowerCase() : null };
    } catch (err) {
      return { liveId: null };
    }
  }

  function writeLiveScript(nextText, preservePosition) {
    let currentText = '';
    let previousText = '';
    try {
      currentText = readTextFile(scriptFile);
      previousText = readTextFile(previousFile);
    } catch (err) {
      console.error(err);
      return { ok: false, status: 500, error: 'Could not read the script' };
    }

    const staged = stagePublishedScript(currentText, nextText, previousText);
    if (!staged.ok) {
      return { ok: false, status: 400, error: staged.error };
    }
    const priorMeta = readPreviousMeta();
    // Putting the previous live file back is a restore, even when the
    // caller also sends the library id of the show that is live now.
    const restoredFromPrevious = Boolean(previousText) && nextText === previousText;
    const restoredLiveId = staged.changed && restoredFromPrevious
      ? priorMeta.liveId
      : null;

    try {
      if (staged.changed) {
        if (staged.previousText) {
          writeAtomic(previousFile, staged.previousText);
          writeAtomic(previousMetaFile, `${JSON.stringify({ liveId: library.getLiveId() })}\n`);
        }
        writeAtomic(scriptFile, staged.text);
      }
    } catch (err) {
      console.error(err);
      return { ok: false, status: 500, error: 'Could not save the script' };
    }

    if (staged.changed) {
      try {
        loadScript(preservePosition);
      } catch (err) {
        // The file is already saved. A broadcast problem must not turn that into a failed publish.
        console.error(err);
      }
    } else if (!preservePosition) {
      state.slideIndex = 0;
      state.lineIndex = 0;
      state.showTitleImage = !!(slides[0] && slides[0].titleImage);
      broadcast({ type: 'state', state });
    }

    return {
      ok: true,
      changed: staged.changed,
      text: staged.text,
      restoredLiveId,
      restoredFromPrevious,
    };
  }

  function rememberLiveScript(preferredId, text) {
    if (preferredId && isValidScriptId(preferredId) && library.read(preferredId).ok) {
      library.setLiveId(preferredId);
      return preferredId;
    }
    return reconcileLivePointer(text);
  }

  function reconcileLivePointer(text) {
    const match = library.findByRevision(hashText(text));
    if (match) {
      if (library.getLiveId() !== match.id) library.setLiveId(match.id);
      return match.id;
    }
    if (library.getLiveId()) library.setLiveId(null);
    return null;
  }

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
    try { texts.push(fs.readFileSync(scriptFile, 'utf8')); } catch (err) { /* The live file may not exist yet. */ }
    try { texts.push(fs.readFileSync(previousFile, 'utf8')); } catch (err) { /* There may be no previous script. */ }
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

  function handleNavigate(dir) {
    const slide = currentSlide();
    const maxLine = slide.lines.length - 1;

    if (dir === 'next') {
      if (state.showTitleImage) {
        state.showTitleImage = false;
      } else if (state.lineIndex < maxLine) {
        state.lineIndex++;
      } else if (state.slideIndex < slides.length - 1) {
        state.slideIndex++;
        state.lineIndex = 0;
        state.showTitleImage = !!(slides[state.slideIndex].titleImage);
      }
    } else if (dir === 'prev') {
      if (state.showTitleImage) {
        if (state.slideIndex > 0) {
          state.slideIndex--;
          state.lineIndex = slides[state.slideIndex].lines.length - 1;
          state.showTitleImage = false;
        }
      } else if (state.lineIndex === 0 && slide.titleImage) {
        state.showTitleImage = true;
      } else if (state.lineIndex > 0) {
        state.lineIndex--;
      } else if (state.slideIndex > 0) {
        state.slideIndex--;
        state.lineIndex = slides[state.slideIndex].lines.length - 1;
        state.showTitleImage = false;
      }
    } else if (dir === 'nextSlide') {
      if (state.slideIndex < slides.length - 1) {
        state.slideIndex++;
        state.lineIndex = 0;
        state.showTitleImage = !!(slides[state.slideIndex].titleImage);
      }
    } else if (dir === 'prevSlide') {
      if (state.slideIndex > 0) {
        state.slideIndex--;
        state.lineIndex = 0;
        state.showTitleImage = !!(slides[state.slideIndex].titleImage);
      }
    }

    broadcast({ type: 'state', state });
  }

  wss.on('connection', (ws) => {
    console.log('[ws] Client connected');
    ws.send(JSON.stringify({
      type: 'script',
      slides,
      revision: scriptRevision,
      liveScriptId: library.getLiveId(),
    }));
    ws.send(JSON.stringify({ type: 'state', state }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'navigate':
          handleNavigate(msg.direction);
          break;
        case 'goto':
          if (msg.slideIndex !== undefined) state.slideIndex = clamp(msg.slideIndex, 0, slides.length - 1);
          if (msg.lineIndex !== undefined) state.lineIndex = clamp(msg.lineIndex, 0, currentSlide().lines.length - 1);
          state.showTitleImage = !!(currentSlide().titleImage && state.lineIndex === 0);
          broadcast({ type: 'state', state });
          break;
        case 'reloadScript':
          loadScript();
          break;
        default:
          break;
      }
    });

    ws.on('close', () => console.log('[ws] Client disconnected'));
  });

  // The controller page is not server-side authorization. ?role=controller
  // only changes the browser. Script upload stays reachable by anyone who
  // can reach the server, matching the previous Replace Script behavior.
  // Library routes use PROMPTER_STAFF_TOKEN when that variable is set.
  app.use(express.text({ type: 'text/plain', limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(createPrivatePathGuard(libraryDir, __dirname));
  app.use(express.static(__dirname, { index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
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
    if (body.trackIfCurrent === true && hashText(body.text) === scriptRevision) {
      const currentId = library.getLiveId();
      const current = currentId ? library.read(currentId) : null;
      if (!current || !current.ok || current.revision !== scriptRevision) {
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
    if (!liveRaw.toLowerCase().includes(`library:${scriptId}/${assetId}`)) {
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
        slides,
        revision: scriptRevision,
        liveScriptId: library.getLiveId(),
      });
    } catch (err) {
      console.error(err);
    }
    return res.json({
      ok: true,
      unchanged: !written.changed && !differentProduction,
      resetPosition: differentProduction,
      revision: scriptRevision,
      liveId: record.id,
      title: record.title,
      previousTitle: previousTitle || 'Unsaved live script',
      slides: slides.length,
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
        previousText = readTextFile(previousFile);
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
        slides,
        revision: scriptRevision,
        liveScriptId,
      });
    } catch (err) {
      console.error(err);
    }

    return res.json({
      ok: true,
      slides: slides.length,
      revision: scriptRevision,
      unchanged: !written.changed,
      liveScriptId,
      libraryUpdated,
      libraryConflict,
    });
  });

  app.get('/script/previous', (req, res) => {
    if (!fs.existsSync(previousFile)) {
      return res.status(404).json({ error: 'No previous script' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(fs.readFileSync(previousFile, 'utf8'));
  });

  app.get('/script', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(fs.readFileSync(scriptFile, 'utf8'));
  });

  try {
    library.open();
    if (!fs.existsSync(scriptFile)) {
      fs.writeFileSync(scriptFile, defaultScript(), 'utf8');
      console.log('[server] Created default script.txt');
    }
    library.adoptLiveText(fs.readFileSync(scriptFile, 'utf8'));
  } catch (err) {
    console.error('[library] The current script could not be added to the library');
  }

  loadScript();
  return { app, server, wss, loadScript, library };
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const { server } = createPrompterServer();
  server.listen(PORT, '0.0.0.0', () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    console.log(`\n🎭  Stage Prompter running on port ${PORT}`);
    console.log(`   Local:   http://localhost:${PORT}`);
    Object.values(nets).flat().filter(n => n.family === 'IPv4' && !n.internal).forEach(n => {
      console.log(`   Network: http://${n.address}:${PORT}`);
    });
    console.log('\n   Controller: ?role=controller');
    console.log('   Actor:     ?role=actor');
    console.log('   Audience:  ?role=audience (default)');
    if (!process.env.PROMPTER_STAFF_TOKEN) {
      console.warn('\n   Staff token is not set. Script upload and the script library are open');
      console.warn('   to anyone who can reach this server. Do not put it on the public internet.\n');
    } else {
      console.log('\n   Staff token is set. Library requests need the X-Staff-Token header.\n');
    }
  });
}

module.exports = { createPrompterServer };
