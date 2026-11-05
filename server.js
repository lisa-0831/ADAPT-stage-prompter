const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const SCRIPT_FILE = path.join(__dirname, 'script.txt');

// ── State ──────────────────────────────────────────────────────────────
let slides = [];       // array of { title, lines[] }
let scriptRevision = '';
let state = {
  slideIndex: 0,
  lineIndex: 0,
  showLine: true,      // false = show full slide
  showTitleImage: false,
};

// ── Script loading ─────────────────────────────────────────────────────
// function loadScript() {
//   if (!fs.existsSync(SCRIPT_FILE)) {
//     fs.writeFileSync(SCRIPT_FILE, defaultScript());
//     console.log('[server] Created default script.txt');
//   }
//   const raw = fs.readFileSync(SCRIPT_FILE, 'utf8');
//   slides = parseScript(raw);
//   state.slideIndex = 0;
//   state.lineIndex = 0;
//   console.log(`[server] Loaded ${slides.length} slide(s)`);
//   broadcast({ type: 'script', slides });
//   broadcast({ type: 'state', state });
// }

function loadScript(preservePosition = false) {
  if (!fs.existsSync(SCRIPT_FILE)) {
    fs.writeFileSync(SCRIPT_FILE, defaultScript());
    console.log('[server] Created default script.txt');
  }
  const raw = fs.readFileSync(SCRIPT_FILE, 'utf8');
  slides = parseScript(raw);
  scriptRevision = createHash('sha256').update(raw).digest('hex');

  if (preservePosition) {
    // Clamp to new script bounds in case it got shorter
    state.slideIndex = clamp(state.slideIndex, 0, slides.length - 1);
    state.lineIndex  = clamp(state.lineIndex, 0, currentSlide().lines.length - 1);
  } else {
    state.slideIndex = 0;
    state.lineIndex  = 0;
  }

  console.log(`[server] Loaded ${slides.length} slide(s)`);
  broadcast({ type: 'script', slides, revision: scriptRevision });
  broadcast({ type: 'state', state });
}

function parseScript(text) {
  // Slides separated by "---" on its own line
  const blocks = text.split(/\n---\n/);
  return blocks.map((block) => {
    const rawLines = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '');
    if (rawLines.length === 0) return null;
    const title = rawLines[0].startsWith('#') ? rawLines[0].replace(/^#+\s*/, '') : rawLines[0];
    const rest   = rawLines[0].startsWith('#') ? rawLines.slice(1) : rawLines;

    // Attach speaker to each content line; drop standalone [NAME] rows
    const lines = [];
    let speaker = '';
    let inLyric = false;
    let inSingalong = false;
    let titleImage = null;

    for (const raw of rest) {
      if (raw.trim() === '') continue;

      if (/^\s*@image:\s*/.test(raw)) {
        titleImage = raw.replace(/^\s*@image:\s*/, '').trim();
        continue;
      }

      const nameMatch = raw.match(/^\s*\[([^\]]+)\](?:\s*&\s*\[([^\]]+)\])?\s*$/);
      if (nameMatch) {
        speaker = nameMatch[2] ? `${nameMatch[1]} & ${nameMatch[2]}` : nameMatch[1];
        continue;
      }

      const startsLyric    = /^\s*##/.test(raw);
      const endsLyric      = /##\s*$/.test(raw);
      const startsSingalong = /^\s*</.test(raw);
      const endsSingalong   = />[\s]*$/.test(raw);

      if (startsLyric)    inLyric = true;
      if (startsSingalong) inSingalong = true;

      let text;
      if (inLyric) {
        text = '## ' + raw.replace(/^\s*##\s*/, '').replace(/\s*##\s*$/, '').trim();
      } else if (inSingalong) {
        text = '<' + raw.replace(/^\s*<\s*/, '').replace(/\s*>\s*$/, '').trim();
      } else {
        text = raw;
      }

      lines.push({ text, speaker });
      speaker = '';
      if (endsLyric)     inLyric = false;
      if (endsSingalong) inSingalong = false;
    }
    return { title, lines, titleImage };
  }).filter(Boolean);
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

// ── WebSocket broadcast ────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ── WebSocket handling ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[ws] Client connected');

  // Send full state to new joiner
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
    }
  });

  ws.on('close', () => console.log('[ws] Client disconnected'));
});

function currentSlide() {
  return slides[state.slideIndex] || { title: '', lines: [] };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// function handleNavigate(dir) {
//   const slide = currentSlide();
//   const maxLine = slide.lines.length - 1;

//   if (dir === 'next') {
//     if (state.lineIndex < maxLine) {
//       state.lineIndex++;
//     } else if (state.slideIndex < slides.length - 1) {
//       state.slideIndex++;
//       state.lineIndex = 0;
//     }
//   } else if (dir === 'prev') {
//     if (state.lineIndex > 0) {
//       state.lineIndex--;
//     } else if (state.slideIndex > 0) {
//       state.slideIndex--;
//       state.lineIndex = currentSlide().lines.length - 1;
//       // re-read after changing slide
//       const newSlide = slides[state.slideIndex];
//       state.lineIndex = newSlide.lines.length - 1;
//     }
//   } else if (dir === 'nextSlide') {
//     if (state.slideIndex < slides.length - 1) {
//       state.slideIndex++;
//       state.lineIndex = 0;
//     }
//   } else if (dir === 'prevSlide') {
//     if (state.slideIndex > 0) {
//       state.slideIndex--;
//       state.lineIndex = 0;
//     }
//   }

//   broadcast({ type: 'state', state });
// }

function handleNavigate(dir) {
  const slide = currentSlide();
  const maxLine = slide.lines.length - 1;

  if (dir === 'next') {
    if (state.showTitleImage) {
      state.showTitleImage = false; // advance past image into first line
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

// ── HTTP routes ────────────────────────────────────────────────────────
app.use(express.text({ type: 'text/plain', limit: '5mb' }));
app.use(express.json());
app.use(express.static(__dirname));

// Serve the single-page app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

// Upload new script via POST /script  (Content-Type: text/plain)
app.post('/script', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'string' || body.trim() === '') {
    return res.status(400).json({ error: 'Empty script' });
  }
  fs.writeFileSync(SCRIPT_FILE, body, 'utf8');
  loadScript(true); // preserve current position if possible
  res.json({ ok: true, slides: slides.length });
});

// Download current script
app.get('/script', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(fs.readFileSync(SCRIPT_FILE, 'utf8'));
});

// ── Start ──────────────────────────────────────────────────────────────
loadScript();
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
