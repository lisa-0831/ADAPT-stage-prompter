const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { parseScript, positionAfterScriptReplace } = require('./script-format');
const { stagePublishedScript } = require('./script-editor-model');
const {
  createScriptLibrary,
  hashText,
  isValidScriptId,
} = require('./script-library');
const { registerHttpRoutes } = require('./server/http-routes');
const { registerLiveSocketHandlers } = require('./server/live-socket');
const {
  commitLiveFiles,
  recoverLiveFiles,
  readBackupMeta,
} = require('./live-script-store');

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
  const journalDir = options.journalDir
    || path.join(path.dirname(scriptFile), 'data', 'live-journal');
  let libraryReady = false;
  const livePaths = {
    scriptFile,
    previousFile,
    metaFile: previousMetaFile,
    journalDir,
    identityMatches(liveId, text) {
      if (!libraryReady) return true;
      if (!isValidScriptId(liveId)) return false;
      const record = library.read(liveId);
      return Boolean(record.ok && record.text === text);
    },
  };

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

  function updateCue(fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'slideIndex')) state.slideIndex = fields.slideIndex;
    if (Object.prototype.hasOwnProperty.call(fields, 'lineIndex')) state.lineIndex = fields.lineIndex;
    if (Object.prototype.hasOwnProperty.call(fields, 'showTitleImage')) state.showTitleImage = fields.showTitleImage;
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
    const meta = readBackupMeta(previousMetaFile, previousFile);
    const liveId = isValidScriptId(meta.liveId) ? meta.liveId.toLowerCase() : null;
    return { liveId };
  }

  function healLiveFiles() {
    const healed = recoverLiveFiles(livePaths);
    if (healed.scriptChanged) loadScript(false);
    return healed;
  }

  function writeLiveScript(nextText, preservePosition) {
    let currentText = '';
    let previousText = '';
    try {
      healLiveFiles();
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
        commitLiveFiles({
          ...livePaths,
          nextText: staged.text,
          nextPreviousText: staged.previousText || null,
          nextPreviousLiveId: staged.previousText ? library.getLiveId() : null,
          onStage: options.onLiveWriteStage,
        });
      }
    } catch (err) {
      // Fault-injection tests throw this code on purpose. A real save error is still logged.
      if (!err || err.code !== 'injected-stop') console.error(err);
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

  registerLiveSocketHandlers({
    wss,
    getSlides() { return slides; },
    getState() { return state; },
    updateCue,
    getScriptRevision() { return scriptRevision; },
    getLiveScriptId() { return library.getLiveId(); },
    broadcast,
    loadScript,
  });

  // HTTP routes live in server/http-routes.js. WebSocket commands live in
  // server/live-socket.js. The cue object above stays the one they update.
  // Live writes still go through writeLiveScript, which owns the journal.
  registerHttpRoutes({
    app,
    staticRoot: __dirname,
    libraryDir,
    journalDir,
    staffToken,
    imageMaxBytes,
    library,
    writeLiveScript,
    broadcast,
    rememberLiveScript,
    getScriptRevision() { return scriptRevision; },
    getSlides() { return slides; },
    getLiveRaw() { return liveRaw; },
    readLiveScript() { return fs.readFileSync(scriptFile, 'utf8'); },
    previousScriptExists() { return fs.existsSync(previousFile); },
    readPreviousScript() { return fs.readFileSync(previousFile, 'utf8'); },
    readPreviousText() { return readTextFile(previousFile); },
  });

  try {
    library.open();
    libraryReady = true;
  } catch (err) {
    console.error('[library] The current script could not be added to the library');
    console.error(err);
  }
  try {
    recoverLiveFiles(livePaths);
  } catch (err) {
    console.error('[server] The live script backup could not be recovered');
    console.error(err);
  }
  try {
    if (!fs.existsSync(scriptFile)) {
      fs.writeFileSync(scriptFile, defaultScript(), 'utf8');
      console.log('[server] Created default script.txt');
    }
    library.adoptLiveText(fs.readFileSync(scriptFile, 'utf8'));
  } catch (err) {
    console.error('[library] The current script could not be added to the library');
    console.error(err);
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
