(function (root, factory) {
  const actorModeModel = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = actorModeModel;
  } else {
    root.ActorModeModel = actorModeModel;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MODES = Object.freeze({
    FOLLOW_LIVE: 'FOLLOW_LIVE',
    BROWSING: 'BROWSING',
  });

  function followLive() {
    return {
      mode: MODES.FOLLOW_LIVE,
      localPosition: null,
    };
  }

  function browse(position) {
    return {
      mode: MODES.BROWSING,
      localPosition: { ...position },
    };
  }

  function effectivePosition(readingState, liveState) {
    if (
      readingState.mode === MODES.BROWSING
      && readingState.localPosition
    ) {
      return readingState.localPosition;
    }

    return liveState;
  }

  return { MODES, browse, effectivePosition, followLive };
}));
