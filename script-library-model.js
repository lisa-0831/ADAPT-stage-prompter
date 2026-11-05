(function (root, factory) {
  const scriptLibrary = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = scriptLibrary;
  } else {
    root.ScriptLibrary = scriptLibrary;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function displayTitle(title, fallback) {
    const text = typeof title === 'string' ? title.trim() : '';
    return text || fallback;
  }

  function liveSwitchConfirmContent(currentTitle, nextTitle) {
    return {
      title: 'Set this script as Live?',
      message: 'All connected Controller, Actor, and Audience screens will receive this script.',
      notes: [
        `Current live script: ${displayTitle(currentTitle, 'Unsaved live script')}`,
        `New live script: ${displayTitle(nextTitle, 'Untitled script')}`,
        'Actors browsing the current live script may be returned to Live.',
        'The cue starts at the beginning of the selected script, because this is a different production.',
      ],
    };
  }

  function setLiveRequestState(inFlight) {
    if (inFlight) {
      return { label: 'Setting as Live...', busy: true, allowDismiss: false };
    }
    return { label: 'Set as Live', busy: false, allowDismiss: true };
  }

  function setLiveOutcome(httpOk, body) {
    if (!httpOk || !body || body.ok !== true) {
      const message = body && typeof body.error === 'string' && body.error
        ? body.error
        : 'The live script was not changed.';
      return { ok: false, closeConfirm: false, message };
    }
    const resetPosition = body.resetPosition === true;
    let message = body.unchanged
      ? 'That script is already the live script. Connected screens were not given a new script.'
      : 'This script is now live. Connected screens have it.';
    if (resetPosition) {
      message += ' The cue is at the beginning.';
    }
    return {
      ok: true,
      closeConfirm: true,
      resetPosition,
      message,
    };
  }

  return {
    liveSwitchConfirmContent,
    setLiveRequestState,
    setLiveOutcome,
  };
}));
