const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { parseScript, positionAfterScriptReplace } = require('./script-format');
const { stagePublishedScript } = require('./script-editor-model');

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

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  let slides = [];
  let scriptRevision = '';
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
    slides = parseScript(raw);
    scriptRevision = createHash('sha256').update(raw).digest('hex');

    if (preservePosition) {
      // Keep the scene and line numbers when they still exist. The words
      // at those numbers may be different after a publish.
      const next = positionAfterScriptReplace(state, slides);
      state.slideIndex = next.slideIndex;
      state.lineIndex = next.lineIndex;
    } else {
      state.slideIndex = 0;
      state.lineIndex = 0;
    }

    console.log(`[server] Loaded ${slides.length} slide(s)`);
    broadcast({ type: 'script', slides, revision: scriptRevision });
    broadcast({ type: 'state', state });
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
    ws.send(JSON.stringify({ type: 'script', slides, revision: scriptRevision }));
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

  // The controller page is not server-side authorization. This is the same
  // unauthenticated upload Replace Script already used.
  app.use(express.text({ type: 'text/plain', limit: '5mb' }));
  app.use(express.json());
  app.use(express.static(__dirname));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
  });

  app.post('/script', (req, res) => {
    const body = req.body;
    let currentText = '';
    let previousText = '';
    try {
      if (fs.existsSync(scriptFile)) currentText = fs.readFileSync(scriptFile, 'utf8');
      if (fs.existsSync(previousFile)) previousText = fs.readFileSync(previousFile, 'utf8');
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Could not read the script' });
    }

    const staged = stagePublishedScript(currentText, body, previousText);
    if (!staged.ok) {
      return res.status(400).json({ ok: false, error: staged.error });
    }

    try {
      if (staged.changed) {
        if (staged.previousText) fs.writeFileSync(previousFile, staged.previousText, 'utf8');
        fs.writeFileSync(scriptFile, staged.text, 'utf8');
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Could not save the script' });
    }

    if (staged.changed) {
      try {
        loadScript(true);
      } catch (err) {
        // The file is already saved. A broadcast problem must not turn that into a failed publish.
        console.error(err);
      }
    }

    return res.json({
      ok: true,
      slides: slides.length,
      revision: scriptRevision,
      unchanged: !staged.changed,
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

  loadScript();
  return { app, server, wss, loadScript };
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
    console.log('   Audience:  ?role=audience (default)\n');
  });
}

module.exports = { createPrompterServer };
