(function (root, factory) {
  const createLiveShow = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = { createLiveShow };
  } else {
    root.PrompterLiveShow = createLiveShow();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createLiveShow() {
    let slides = [];
    let liveState = null;
    let scriptRevision = null;
    let liveScriptId = null;
    let awaitingLive = false;

    function getSlides() {
      return slides;
    }

    function getLiveState() {
      return liveState;
    }

    function getRevision() {
      return scriptRevision;
    }

    function getLiveScriptId() {
      return liveScriptId;
    }

    // Callers decide when an id should be written. A missing library field
    // must not call this. Empty string is stored as null, matching the socket.
    function setLiveScriptId(id) {
      liveScriptId = id || null;
    }

    // Stores a server script message. Does not clear the live cue and does
    // not decide whether an Actor returns to Follow Live. An omitted
    // liveScriptId leaves the current id in place. null clears it.
    function setAwaitingLive(value) {
      awaitingLive = value === true;
    }

    function isAwaitingLive() {
      return awaitingLive;
    }

    function applyScript(message) {
      const scriptChanged = scriptRevision !== null && message.revision !== scriptRevision;
      slides = message.slides;
      scriptRevision = message.revision;
      if (typeof message.liveScriptId === 'string' || message.liveScriptId === null) {
        liveScriptId = message.liveScriptId || null;
      }
      return { scriptChanged };
    }

    function applyState(state) {
      liveState = state;
    }

    return {
      getSlides,
      getLiveState,
      getRevision,
      getLiveScriptId,
      setLiveScriptId,
      setAwaitingLive,
      isAwaitingLive,
      applyScript,
      applyState,
    };
  }

  return createLiveShow;
}));
