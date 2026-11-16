const { movePosition } = require('../navigation-model');

// WebSocket commands only. The live cue, slides, and revision stay in server.js.
// This module reads them when a message arrives and writes the cue back through
// updateCue. A second call does not add another connection listener.

const registeredServers = new WeakSet();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function registerLiveSocketHandlers(deps) {
  if (!deps || !deps.wss || registeredServers.has(deps.wss)) return;
  registeredServers.add(deps.wss);

  function currentSlide() {
    const slides = deps.getSlides();
    const state = deps.getState();
    return slides[state.slideIndex] || { title: '', lines: [] };
  }

  function handleNavigate(direction) {
    const next = movePosition(deps.getSlides(), deps.getState(), direction);
    deps.updateCue({
      slideIndex: next.slideIndex,
      lineIndex: next.lineIndex,
      showTitleImage: next.showTitleImage,
    });
    deps.broadcast({ type: 'state', state: deps.getState() });
  }

  deps.wss.on('connection', (ws) => {
    console.log('[ws] Client connected');
    const awaitingLive = typeof deps.getAwaitingLive === 'function' && deps.getAwaitingLive() === true;
    const scriptMessage = {
      type: 'script',
      slides: deps.getSlides(),
      revision: deps.getScriptRevision(),
      liveScriptId: deps.getLiveScriptId(),
    };
    const stateMessage = {
      type: 'state',
      state: deps.getState(),
    };
    if (awaitingLive) {
      scriptMessage.awaitingLive = true;
      scriptMessage.slides = [];
      scriptMessage.revision = null;
      scriptMessage.liveScriptId = null;
      stateMessage.awaitingLive = true;
    }
    ws.send(JSON.stringify(scriptMessage));
    ws.send(JSON.stringify(stateMessage));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'navigate':
          handleNavigate(msg.direction);
          break;
        case 'goto':
          if (deps.getSlides().length) {
            if (msg.slideIndex !== undefined) {
              deps.updateCue({
                slideIndex: clamp(msg.slideIndex, 0, deps.getSlides().length - 1),
              });
            }
            if (msg.lineIndex !== undefined) {
              deps.updateCue({
                lineIndex: clamp(msg.lineIndex, 0, Math.max(0, currentSlide().lines.length - 1)),
              });
            }
            deps.updateCue({
              showTitleImage: !!(currentSlide().titleImage && deps.getState().lineIndex === 0),
            });
          }
          deps.broadcast({ type: 'state', state: deps.getState() });
          break;
        case 'reloadScript': {
          let result;
          try {
            result = deps.loadScript();
          } catch (err) {
            result = {
              ok: false,
              code: err && err.code ? err.code : 'reload-failed',
              error: 'The live script could not be reloaded.',
            };
          }
          if (result && result.ok === false) {
            try {
              ws.send(JSON.stringify({
                type: 'error',
                code: result.code || 'reload-failed',
                error: result.error || 'The live script could not be reloaded.',
              }));
            } catch (err) { /* The client may already be gone. */ }
          }
          break;
        }
        default:
          break;
      }
    });

    ws.on('close', () => console.log('[ws] Client disconnected'));
  });
}

module.exports = { registerLiveSocketHandlers };
